import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PiProcess, type RpcRecord } from "./piProcess";
import { defaultSessionDir, listSessions, relativeTime } from "./sessions";
import { getShellEnv } from "./shellEnv";

const LAST_SESSION_KEY = "pi.lastSessionFile";
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
export const stripAnsi = (s: string) => (s ?? "").replace(ANSI_RE, "");

/** Anything that can host the chat webview (sidebar view or editor panel). */
export interface ChatHost {
  webview: vscode.Webview;
  setTitle(title: string | undefined): void;
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
      const [state, commands, messages] = await Promise.all([
        this.req({ type: "get_state" }),
        this.req({ type: "get_commands" }).catch(() => ({ commands: [] })),
        this.req({ type: "get_messages" }).catch(() => ({ messages: [] })),
      ]);
      this.state = state;
      if (state.sessionFile && this.options.primary) {
        this.context.workspaceState.update(LAST_SESSION_KEY, state.sessionFile);
      }
      this.post({ type: kind, state, commands: commands.commands, messages: messages.messages, cwd: this.cwd });
      this.updateTitle();
      this.refreshStats();
    } catch (err: any) {
      this.output.appendLine(`[pi] init failed: ${err.message}`);
    }
  }

  private updateTitle() {
    this.host.setTitle(this.state.sessionName);
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
        if (!messages?.length) return void vscode.window.showInformationMessage("Pi: nothing to fork from yet.");
        const pick = await vscode.window.showQuickPick(
          [...messages].reverse().map((m: any) => ({ label: m.text.split("\n")[0].slice(0, 120), detail: m.text.slice(0, 300), entryId: m.entryId, text: m.text })),
          { placeHolder: "Fork a new session from a previous message" },
        );
        if (!pick) return;
        const r = await this.req({ type: "fork", entryId: pick.entryId });
        if (!r?.cancelled) {
          await this.sendInit("reset");
          this.post({ type: "insertText", text: r.text ?? pick.text, replace: true });
        }
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
    if (!sessions.length) return void vscode.window.showInformationMessage("Pi: no previous sessions for this folder.");
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: (s.file === this.state.sessionFile ? "$(circle-filled) " : "") + (s.name || s.firstMessage?.split("\n")[0].slice(0, 100) || "(empty session)"),
        description: `${relativeTime(s.mtime)} · ${s.messageCount} msgs`,
        detail: s.name && s.firstMessage ? s.firstMessage.slice(0, 160) : undefined,
        file: s.file,
      })),
      { placeHolder: "Resume a Pi session", matchOnDescription: true, matchOnDetail: true },
    );
    if (!pick || pick.file === this.state.sessionFile) return;
    const r = await this.req({ type: "switch_session", sessionPath: pick.file });
    if (!r?.cancelled) await this.sendInit("reset");
  }

  async pickModel(query = "") {
    const { models } = await this.req({ type: "get_available_models" });
    const current = this.state.model;
    const byProvider = new Map<string, any[]>();
    for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
    const items: any[] = [];
    for (const [provider, list] of byProvider) {
      items.push({ label: provider, kind: vscode.QuickPickItemKind.Separator });
      for (const m of list) {
        const isCur = current && m.id === current.id && m.provider === current.provider;
        items.push({
          label: `${isCur ? "$(check) " : ""}${m.name ?? m.id}`,
          description: m.id,
          detail: [m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : "", m.reasoning ? "reasoning" : "", m.cost ? `$${m.cost.input}/$${m.cost.output} per M` : ""].filter(Boolean).join(" · "),
          model: m,
        });
      }
    }
    const qp = vscode.window.createQuickPick<any>();
    qp.items = items;
    qp.value = query;
    qp.placeholder = "Select a model";
    qp.matchOnDescription = true;
    const picked = await new Promise<any>((resolve) => {
      qp.onDidAccept(() => resolve(qp.selectedItems[0]));
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    qp.dispose();
    if (!picked?.model) return;
    await this.req({ type: "set_model", provider: picked.model.provider, modelId: picked.model.id });
    await this.refreshState();
    this.refreshStats();
  }

  async pickThinking(arg = "") {
    const { levels } = await this.req({ type: "get_available_thinking_levels" });
    let level = levels.includes(arg) ? arg : undefined;
    if (!level) {
      const pick = await vscode.window.showQuickPick(
        levels.map((l: string) => ({ label: `${l === this.state.thinkingLevel ? "$(check) " : ""}${l}`, level: l })),
        { placeHolder: "Thinking level" },
      );
      level = (pick as any)?.level;
    }
    if (!level) return;
    await this.req({ type: "set_thinking_level", level });
    await this.refreshState();
  }

  dispose() {
    this.pi?.stop();
    this.pi = undefined;
    for (const d of this.disposables) d.dispose();
  }
}
