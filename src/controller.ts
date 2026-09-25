import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PiProcess, type RpcRecord } from "./piProcess";
import { defaultSessionDir, listSessions, relativeTime } from "./sessions";
import { getShellEnv } from "./shellEnv";
import { agentDir, scopeModels } from "./modelScope";

const LAST_SESSION_KEY = "pi.lastSessionFile";
const RECENT_MODELS_KEY = "pi.recentModels";
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
export const stripAnsi = (s: string) => (s ?? "").replace(ANSI_RE, "");

/**
 * Extensions that open a composer/overlay in the TUI usually refuse in RPC
 * mode with a notice like "/btw cannot open its composer outside Pi's TUI".
 * The webview reacts to these by opening its side panel instead, so the
 * host must not also show them as toasts.
 */
export const COMPOSER_REFUSAL_RE = /(composer|overlay|modal|editor)[^.]*outside (of )?pi'?s? tui|requires (pi'?s? )?(the )?tui|only (available|works) in (the )?tui|pass the (question|prompt|text) inline/i;

/** Custom-entry prefixes whose entries are forwarded to the webview side panel on init. */
const SIDE_ENTRY_PREFIXES = ["btw-"];

/** Bucket a timestamp into Today / Yesterday / This week / Older for list grouping. */
function dayGroup(ms: number): string {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  if (ms >= startOfToday.getTime()) return "Today";
  if (ms >= startOfToday.getTime() - day) return "Yesterday";
  if (ms >= startOfToday.getTime() - 6 * day) return "This week";
  return "Older";
}

/** Anything that can host the chat webview (sidebar view or editor panel). */
export interface ChatHost {
  webview: vscode.Webview;
  setTitle(title: string | undefined): void;
  /** Optional: reflect side-panel state in native chrome. */
  setSideState?(open: boolean, count: number): void;
  reveal(): void;
}

/** One pi RPC process bound to one webview. */
export class PiController implements vscode.Disposable {
  private pi?: PiProcess;
  private state: any = {};
  private disposables: vscode.Disposable[] = [];
  private webviewReady = false;
  private outbox: any[] = [];
  private statusItem: vscode.StatusBarItem;
  private starting?: Promise<void>;
  private env: NodeJS.ProcessEnv = process.env;
  private args: string[] = [];
  /** Number of in-flight prompts issued from the side panel; notices are routed there meanwhile. */
  private sidePending = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: ChatHost,
    private readonly output: vscode.OutputChannel,
    private readonly options: { primary: boolean; sessionFile?: string },
  ) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = "pi.focus";
    this.disposables.push(this.statusItem);
    this.disposables.push(host.webview.onDidReceiveMessage((m) => this.onWebviewMessage(m)));
  }

  get cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  get isRunning(): boolean {
    return !!this.state.isStreaming;
  }

  // ---------------------------------------------------------------- process

  async start(sessionFile?: string): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doStart(sessionFile).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async doStart(sessionFile?: string) {
    this.pi?.stop();
    const cfg = vscode.workspace.getConfiguration("pi");
    const env = await getShellEnv(cfg.get<boolean>("useLoginShellEnv", true));
    env.PI_VSCODE = "1";
    this.env = env;
    const command = cfg.get<string>("path")?.trim() || "pi";
    const args = [...(cfg.get<string[]>("args") ?? [])];

    const resume = sessionFile ?? this.options.sessionFile ??
      (this.options.primary && cfg.get<boolean>("resumeLastSession", true)
        ? this.context.workspaceState.get<string>(LAST_SESSION_KEY)
        : undefined);
    this.options.sessionFile = undefined;
    if (resume && fs.existsSync(resume) && !args.some((a) => ["--session", "--continue", "-c", "--no-session"].includes(a))) {
      args.push("--session", resume);
    }

    this.args = args;
    this.output.appendLine(`[pi] starting: ${command} --mode rpc ${args.join(" ")} (cwd ${this.cwd})`);
    const pi = new PiProcess(command, args, this.cwd, env);
    this.pi = pi;
    pi.on("event", (e: RpcRecord) => this.onPiEvent(e));
    pi.on("stderr", (t: string) => this.output.append(t));
    pi.on("exit", (code: number | null, signal: string | null, err?: Error) => {
      if (this.pi !== pi) return;
      this.output.appendLine(`[pi] exited code=${code} signal=${signal} ${err?.message ?? ""}`);
      const hint = (err as any)?.code === "ENOENT"
        ? `Could not find the \`${command}\` executable. Install pi or set "pi.path" in settings.`
        : undefined;
      this.post({ type: "exited", code, signal, hint, stderr: stripAnsi(pi.stderrTail).slice(-3000) });
      this.statusItem.hide();
    });
    pi.start();
    this.post({ type: "starting" });
    await this.sendInit("init");
  }

  restart() {
    return this.start(this.state.sessionFile);
  }

  private req<T = any>(cmd: RpcRecord): Promise<T> {
    if (!this.pi) return Promise.reject(new Error("pi is not running"));
    return this.pi.request<T>(cmd);
  }

  private async refreshState() {
    try {
      this.state = await this.req({ type: "get_state" });
      if (this.state.sessionFile && this.options.primary) {
        this.context.workspaceState.update(LAST_SESSION_KEY, this.state.sessionFile);
      }
      this.post({ type: "state", state: this.state });
      this.updateTitle();
    } catch {}
  }

  private async refreshStats() {
    try {
      const stats = await this.req({ type: "get_session_stats" });
      this.post({ type: "stats", stats });
    } catch {}
  }

  /** Send full snapshot (state, commands, transcript) to the webview. */
  private async sendInit(kind: "init" | "reset") {
    try {
      const [state, commands, messages, sideEntries] = await Promise.all([
        this.req({ type: "get_state" }),
        this.req({ type: "get_commands" }).catch(() => ({ commands: [] })),
        this.req({ type: "get_messages" }).catch(() => ({ messages: [] })),
        this.getSideEntries(),
      ]);
      this.state = state;
      if (state.sessionFile && this.options.primary) {
        this.context.workspaceState.update(LAST_SESSION_KEY, state.sessionFile);
      }
      this.post({
        type: kind,
        state,
        commands: commands.commands,
        messages: messages.messages,
        sideEntries,
        sideCommands: vscode.workspace.getConfiguration("pi").get("sidePanelCommands", {}),
        cwd: this.cwd,
      });
      this.updateTitle();
      this.refreshStats();
    } catch (err: any) {
      this.output.appendLine(`[pi] init failed: ${err.message}`);
    }
  }

  /**
   * Custom entries on the active branch that belong to side-conversation
   * extensions (e.g. pi-btw's thread entries), oldest first, so the side
   * panel can restore its thread after a reload or session switch.
   */
  private async getSideEntries(): Promise<any[]> {
    try {
      const { entries, leafId } = await this.req({ type: "get_entries" });
      const byId = new Map<string, any>(entries.map((e: any) => [e.id, e]));
      const branch: any[] = [];
      for (let id = leafId; id && byId.has(id); id = byId.get(id).parentId) branch.push(byId.get(id));
      return branch
        .reverse()
        .filter((e) => e.type === "custom" && SIDE_ENTRY_PREFIXES.some((p) => String(e.customType).startsWith(p)));
    } catch {
      return [];
    }
  }

  /** Title reported by the webview (session name, else first prompt). */
  private webTitle?: string;

  private updateTitle() {
    this.host.setTitle(this.state.sessionName || this.webTitle);
  }

  // ---------------------------------------------------------------- pi -> ui

  private onPiEvent(e: RpcRecord) {
    switch (e.type) {
      case "extension_ui_request":
        this.handleExtensionUi(e);
        break;
      case "agent_start":
        this.state.isStreaming = true;
        this.statusItem.text = "$(loading~spin) Pi";
        this.statusItem.tooltip = "Pi is working…";
        this.statusItem.show();
        break;
      case "agent_settled":
        this.state.isStreaming = false;
        this.statusItem.hide();
        this.refreshStats();
        this.refreshState();
        break;
      case "session_info_changed":
        this.state.sessionName = e.name;
        this.updateTitle();
        break;
      case "thinking_level_changed":
        this.state.thinkingLevel = e.level;
        break;
      case "extension_error":
        this.output.appendLine(`[pi] extension error in ${e.extensionPath} (${e.event}): ${e.error}`);
        break;
    }
    this.post({ type: "event", event: e });
  }

  private handleExtensionUi(e: RpcRecord) {
    switch (e.method) {
      case "notify": {
        const msg = stripAnsi(e.message);
        // Side-panel requests show their notices inline; composer refusals open the panel.
        if (this.sidePending > 0 || COMPOSER_REFUSAL_RE.test(msg)) break;
        const fn = e.notifyType === "error"
          ? vscode.window.showErrorMessage
          : e.notifyType === "warning"
            ? vscode.window.showWarningMessage
            : vscode.window.showInformationMessage;
        fn(`Pi: ${msg}`);
        break;
      }
      case "setTitle":
        break; // terminal title; the webview shows session names instead
    }
  }

  // ---------------------------------------------------------------- ui -> pi

  private post(msg: any) {
    if (!this.webviewReady && msg.type !== "init") {
      this.outbox.push(msg);
      return;
    }
    this.host.webview.postMessage(msg);
  }

  /** Called when the webview (re)loads its DOM. */
  private async onReady() {
    this.webviewReady = true;
    this.outbox = [];
    if (!this.pi?.running) await this.start();
    else await this.sendInit("init");
  }

  private async onWebviewMessage(m: any) {
    try {
      switch (m.type) {
        case "ready":
          await this.onReady();
          break;
        case "prompt":
          await this.prompt(m.text, m.images, m.mode);
          break;
        case "abort":
          await this.abort();
          break;
        case "uiResponse":
          this.pi?.write({ type: "extension_ui_response", ...m.response });
          break;
        case "builtin":
          await this.runBuiltin(m.name, m.arg ?? "");
          break;
        case "bash":
          await this.bash(m.command, m.exclude);
          break;
        case "openFile":
          await this.openFile(m.path, m.line);
          break;
        case "searchFiles":
          await this.searchFiles(m.query, m.requestId);
          break;
        case "restart":
          await this.restart();
          break;
        case "getModels":
          await this.sendModels(m.refresh);
          break;
        case "setModel":
          await this.setModel(m.provider, m.id);
          break;
        case "title":
          this.webTitle = m.title;
          this.updateTitle();
          break;
        case "sideState":
          this.host.setSideState?.(m.open, m.count);
          break;
        case "listPick":
          await this.onListPick(m.kind, m.id);
          break;
        case "sidePrompt":
          await this.sidePrompt(m.text, m.requestId);
          break;
        case "editEnabledModels":
          await this.editEnabledModels();
          break;
        case "setThinking":
          await this.setThinking(m.level);
          break;
        case "pickImage":
          await this.pickImage();
          break;
        case "clearQueue": {
          const q = await this.req({ type: "clear_queue" });
          this.post({ type: "restoreQueue", text: [...q.steering, ...q.followUp].join("\n\n") });
          break;
        }
      }
    } catch (err: any) {
      this.post({ type: "error", message: err.message ?? String(err) });
    }
  }

  async prompt(text: string, images: any[] | undefined, mode?: "steer" | "followUp") {
    if (!this.pi?.running) await this.start();
    const cmd: RpcRecord = { type: "prompt", message: text };
    if (images?.length) cmd.images = images;
    if (this.state.isStreaming) cmd.streamingBehavior = mode ?? "steer";
    const res = await this.req(cmd);
    if (res?.disposition === "handled") this.sendCommandsSoon();
  }

  /**
   * Run a slash command on behalf of the side panel. Extension commands run
   * to completion before pi responds, so the response marks the end of the
   * side request (pi-btw resolves only after its side answer is ready).
   */
  private async sidePrompt(text: string, requestId: number) {
    this.sidePending++;
    try {
      if (!this.pi?.running) await this.start();
      const res = await this.req({ type: "prompt", message: text });
      this.post({ type: "sideDone", requestId, disposition: res?.disposition });
    } catch (err: any) {
      this.post({ type: "sideDone", requestId, error: err.message ?? String(err) });
    } finally {
      // Late notices from the same command can trail the response slightly.
      setTimeout(() => this.sidePending--, 250);
    }
  }

  private sendCommandsSoon() {
    // Extension commands may change session/model/commands; refresh lightly.
    setTimeout(async () => {
      await this.refreshState();
      try {
        const c = await this.req({ type: "get_commands" });
        this.post({ type: "commands", commands: c.commands });
      } catch {}
    }, 300);
  }

  async abort() {
    try {
      const q = await this.req({ type: "clear_queue" });
      const text = [...(q?.steering ?? []), ...(q?.followUp ?? [])].join("\n\n");
      if (text) this.post({ type: "restoreQueue", text });
    } catch {}
    await this.req({ type: "abort" }).catch(() => {});
  }

  private async bash(command: string, exclude: boolean) {
    const id = this.pi!.nextId();
    this.post({ type: "bashStart", id, command });
    try {
      const res = await this.pi!.request({ type: "bash", command, excludeFromContext: exclude }, id);
      this.post({ type: "bashEnd", id, result: res });
    } catch (err: any) {
      this.post({ type: "bashEnd", id, result: { output: err.message, exitCode: 1 } });
    }
  }

  private async openFile(p: string, line?: number) {
    const abs = path.isAbsolute(p) ? p : path.join(this.cwd, p.replace(/^~(?=\/)/, os.homedir()));
    const file = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : abs;
    if (!fs.existsSync(file)) return;
    const doc = await vscode.workspace.openTextDocument(file);
    const opts: vscode.TextDocumentShowOptions = { preview: true, viewColumn: vscode.ViewColumn.One };
    if (line && line > 0) opts.selection = new vscode.Range(line - 1, 0, line - 1, 0);
    await vscode.window.showTextDocument(doc, opts);
  }

  private async searchFiles(query: string, requestId: number) {
    const q = query.replace(/[\[\]{}*?]/g, "");
    const glob = q ? `**/*${q.split("/").pop()}*` : "**/*";
    const uris = await vscode.workspace.findFiles(glob, "**/{node_modules,.git,dist,out,build}/**", 200);
    const rels = uris
      .map((u) => vscode.workspace.asRelativePath(u, false))
      .filter((r) => r.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => a.length - b.length)
      .slice(0, 30);
    this.post({ type: "fileResults", requestId, files: rels });
  }

  private async pickImage() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
    });
    for (const uri of uris ?? []) {
      const data = (await vscode.workspace.fs.readFile(uri)) as Uint8Array;
      const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
      const mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      this.post({ type: "addImage", image: { type: "image", data: Buffer.from(data).toString("base64"), mimeType }, name: path.basename(uri.fsPath) });
    }
  }

  toggleSidePanel() {
    this.host.reveal();
    this.post({ type: "toggleSide" });
  }

  insertText(text: string) {
    this.host.reveal();
    this.post({ type: "insertText", text });
  }

  // ---------------------------------------------------------------- builtins

  async runBuiltin(name: string, arg: string) {
    if (!this.pi?.running && name !== "restart") await this.start();
    switch (name) {
      case "new": {
        const r = await this.req({ type: "new_session" });
        if (!r?.cancelled) await this.sendInit("reset");
        break;
      }
      case "resume":
        await this.pickSession();
        break;
      case "model":
        await this.pickModel(arg);
        break;
      case "thinking":
        await this.pickThinking(arg);
        break;
      case "compact":
        this.req({ type: "compact", customInstructions: arg || undefined })
          .then(() => this.refreshStats())
          .catch((e) => this.post({ type: "error", message: `Compaction failed: ${e.message}` }));
        break;
      case "name": {
        const name = arg || (await vscode.window.showInputBox({ prompt: "Session name", value: this.state.sessionName ?? "" }));
        if (name) await this.req({ type: "set_session_name", name });
        await this.refreshState();
        break;
      }
      case "export": {
        const r = await this.req({ type: "export_html", outputPath: arg || undefined });
        const open = await vscode.window.showInformationMessage(`Exported session to ${r.path}`, "Open");
        if (open) vscode.env.openExternal(vscode.Uri.file(r.path));
        break;
      }
      case "fork": {
        const { messages } = await this.req({ type: "get_fork_messages" });
        this.host.reveal();
        this.post({
          type: "openList",
          kind: "fork",
          placeholder: "Fork from a previous message",
          empty: "No messages to fork from",
          items: [...(messages ?? [])].reverse().map((m: any) => ({
            id: m.entryId,
            label: m.text.split("\n")[0].slice(0, 200),
            search: m.text.slice(0, 2000),
          })),
        });
        break;
      }
      case "clone": {
        const r = await this.req({ type: "clone" });
        if (!r?.cancelled) await this.sendInit("reset");
        break;
      }
      case "session": {
        const s = await this.req({ type: "get_session_stats" });
        const ctx = s.contextUsage?.percent != null ? `${Math.round(s.contextUsage.percent)}% of ${s.contextUsage.contextWindow}` : "n/a";
        vscode.window.showInformationMessage(
          `Pi session ${s.sessionId}: ${s.userMessages} prompts, ${s.toolCalls} tool calls, ${s.tokens.total.toLocaleString()} tokens, $${s.cost.toFixed(3)}, context ${ctx}`,
          { modal: false },
        );
        break;
      }
      case "restart":
        await this.restart();
        break;
      case "copy": {
        const r = await this.req({ type: "get_last_assistant_text" });
        if (r?.text) {
          await vscode.env.clipboard.writeText(r.text);
          vscode.window.setStatusBarMessage("Pi: copied last response", 2000);
        }
        break;
      }
    }
  }

  async pickSession() {
    const dir = this.state.sessionFile ? path.dirname(this.state.sessionFile) : defaultSessionDir(this.cwd);
    const sessions = (await listSessions(dir)).filter((s) => s.messageCount > 0 || s.file === this.state.sessionFile);
    this.host.reveal();
    this.post({
      type: "openList",
      kind: "session",
      placeholder: "Resume a Pi session",
      empty: "No previous sessions for this folder",
      items: sessions.map((s) => ({
        id: s.file,
        label: s.name || s.firstMessage?.split("\n")[0].slice(0, 200) || "(empty session)",
        cols: [relativeTime(s.mtime), `${s.messageCount} msg${s.messageCount === 1 ? "" : "s"}`],
        group: dayGroup(s.mtime),
        search: [s.name, s.firstMessage?.slice(0, 500)].filter(Boolean).join(" "),
        current: s.file === this.state.sessionFile,
      })),
    });
  }

  /** The user picked an entry in a webview dropdown list. */
  private async onListPick(kind: string, id: string) {
    if (kind === "session") {
      if (id === this.state.sessionFile) return;
      const r = await this.req({ type: "switch_session", sessionPath: id });
      if (!r?.cancelled) await this.sendInit("reset");
    } else if (kind === "fork") {
      const r = await this.req({ type: "fork", entryId: id });
      if (!r?.cancelled) {
        await this.sendInit("reset");
        if (r?.text) this.post({ type: "insertText", text: r.text, replace: true });
      }
    }
  }

  /** Open the inline model picker in the webview. */
  async pickModel(query = "") {
    this.host.reveal();
    await this.sendModels();
    this.post({ type: "openModelPicker", query });
  }

  async pickThinking(arg = "") {
    const { levels } = await this.req({ type: "get_available_thinking_levels" });
    if (levels.includes(arg)) return this.setThinking(arg);
    this.host.reveal();
    await this.sendModels();
    this.post({ type: "openEffortPicker" });
  }

  private modelsCache?: any[];

  /** Send slim model list + thinking levels + recents to the webview. */
  async sendModels(refresh = false) {
    if (!this.modelsCache || refresh) {
      const { models } = await this.req({ type: "get_available_models" });
      this.modelsCache = models.map((m: any) => ({
        provider: m.provider,
        id: m.id,
        name: m.name ?? m.id,
        reasoning: !!m.reasoning,
        contextWindow: m.contextWindow,
        cost: m.cost ? { input: m.cost.input, output: m.cost.output } : undefined,
        images: Array.isArray(m.input) && m.input.includes("image"),
      }));
    }
    const { levels } = await this.req({ type: "get_available_thinking_levels" }).catch(() => ({ levels: ["off"] }));
    // Re-read enabledModels every time so edits to settings.json apply immediately.
    const scope = scopeModels(this.cwd, this.args, this.modelsCache!, this.env);
    this.post({
      type: "models",
      models: this.modelsCache,
      enabled: scope.models?.map((m: any) => `${m.provider}/${m.id}`),
      scopeSource: scope.source,
      unmatched: scope.unmatched,
      levels,
      recent: this.context.globalState.get<string[]>(RECENT_MODELS_KEY, []),
    });
  }

  /** Open the settings.json that controls `enabledModels` (project if it defines it, else global). */
  private async editEnabledModels() {
    const project = path.join(this.cwd, ".pi", "settings.json");
    const global = path.join(agentDir(this.env), "settings.json");
    let file = global;
    try {
      if (Array.isArray(JSON.parse(fs.readFileSync(project, "utf8")).enabledModels)) file = project;
    } catch {}
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ enabledModels: [] }, null, 2) + "\n");
    }
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
    const idx = doc.getText().indexOf('"enabledModels"');
    if (idx >= 0) {
      const pos = doc.positionAt(idx);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  async setModel(provider: string, id: string) {
    await this.req({ type: "set_model", provider, modelId: id });
    const key = `${provider}/${id}`;
    const recent = [key, ...this.context.globalState.get<string[]>(RECENT_MODELS_KEY, []).filter((k) => k !== key)].slice(0, 5);
    await this.context.globalState.update(RECENT_MODELS_KEY, recent);
    await this.refreshState();
    await this.sendModels();
    this.refreshStats();
  }

  async setThinking(level: string) {
    await this.req({ type: "set_thinking_level", level });
    await this.refreshState();
  }

  dispose() {
    this.pi?.stop();
    this.pi = undefined;
    for (const d of this.disposables) d.dispose();
  }
}
