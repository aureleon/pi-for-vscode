import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PiProcess, type RpcRecord } from "./piProcess";
import { defaultSessionDir, listSessions, relativeTime } from "./sessions";
import { getShellEnv } from "./shellEnv";
import { agentDir, scopeModels } from "./modelScope";
import { slimTree } from "./treeData";
import { createPiTerminal, piTerminalName } from "./piTerminal";
import { completePath } from "./pathComplete";

const LAST_SESSION_KEY = "pi.lastSessionFile";
const RECENT_MODELS_KEY = "pi.recentModels";
const ARCHIVED_SESSIONS_KEY = "pi.archivedSessions";
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
  /** Integrated terminal running the pi TUI on this chat's session, while it owns the session. */
  private terminal?: vscode.Terminal;
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

  async start(sessionFile?: string, sessionId?: string): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doStart(sessionFile, sessionId).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async doStart(sessionFile?: string, sessionId?: string) {
    this.pi?.stop();
    const cfg = vscode.workspace.getConfiguration("pi");
    const env = await getShellEnv(cfg.get<boolean>("useLoginShellEnv", true));
    env.PI_VSCODE = "1";
    this.env = env;
    const command = cfg.get<string>("path")?.trim() || "pi";
    const args = [...(cfg.get<string[]>("args") ?? [])];
    // Bridge extension: adds tree navigation (/tree) and labels, which RPC lacks.
    args.push("-e", path.join(this.context.extensionPath, "dist", "pi-bridge.mjs"));

    const resume = sessionFile ?? this.options.sessionFile ??
      (this.options.primary && cfg.get<boolean>("resumeLastSession", true)
        ? this.context.workspaceState.get<string>(LAST_SESSION_KEY)
        : undefined);
    this.options.sessionFile = undefined;
    const pinned = args.some((a) => ["--session", "--session-id", "--continue", "-c", "--no-session"].includes(a));
    if (sessionId && !pinned) {
      // Exact session (resumes it, or creates it if it was never written).
      args.push("--session-id", sessionId);
    } else if (resume && fs.existsSync(resume) && !pinned) {
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
    if (this.terminal) {
      this.post({ type: "terminalAttached", title: this.terminal.name });
      return;
    }
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
        case "openExternal":
          if (/^(https?|mailto):/i.test(String(m.url))) await vscode.env.openExternal(vscode.Uri.parse(String(m.url)));
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
        case "runCommand":
          // Overflow menu of the sidebar header row; only our own commands.
          if (["pi.newTerminal", "pi.openInTab"].includes(m.command)) await vscode.commands.executeCommand(m.command);
          break;
        case "openTerminal":
          await this.openInTerminal();
          break;
        case "reattach":
          await this.reattach();
          break;
        case "showTerminal":
          this.terminal?.show();
          break;
        case "treeNavigate":
          await this.treeNavigate(m.id, !!m.summarize, m.instructions);
          break;
        case "treeLabel":
          await this.req({ type: "prompt", message: `/vscode:label ${JSON.stringify({ entryId: m.id, label: m.label ?? "" })}` });
          await this.openTree("", m.id, true);
          break;
        case "copy":
          await vscode.env.clipboard.writeText(String(m.text ?? ""));
          vscode.window.setStatusBarMessage("Pi: copied to clipboard", 1500);
          break;
        case "listAction":
          if (m.kind === "session" && (m.action === "archive" || m.action === "unarchive")) {
            await this.setArchived(m.id, m.action === "archive");
            await this.pickSession(true);
          }
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
    if (this.terminal) throw new Error("This session is open in the terminal. Reattach to continue here.");
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

  /**
   * Stop the current run. By default, queued messages are not lost: pi would
   * drop them on abort, so take them out first and send them as the next run
   * (steering first, then follow-ups). With `resumeQueue: false`, they go
   * back into the input box instead.
   */
  async abort(resumeQueue = true) {
    let steering: string[] = [];
    let followUp: string[] = [];
    try {
      const q = await this.req({ type: "clear_queue" });
      steering = q?.steering ?? [];
      followUp = q?.followUp ?? [];
    } catch {}
    await this.req({ type: "abort" }).catch(() => {});
    if (!steering.length && !followUp.length) return;
    if (!resumeQueue || this.terminal || !this.pi?.running) {
      this.post({ type: "restoreQueue", text: [...steering, ...followUp].join("\n\n") });
      return;
    }
    const [first, ...rest] = steering.length ? [steering.join("\n\n"), ...followUp] : followUp;
    try {
      // abort resolves once pi is idle, so the first message starts a new run.
      await this.req({ type: "prompt", message: first });
      for (const message of rest) await this.req({ type: "prompt", message, streamingBehavior: "followUp" });
    } catch (err: any) {
      this.post({ type: "error", message: err.message ?? String(err) });
    }
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
    const expanded = p.replace(/^~(?=\/|$)/, os.homedir()).replace(/(.)\/+$/, "$1");
    const file = path.isAbsolute(expanded) ? expanded : path.join(this.cwd, expanded);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      vscode.window.setStatusBarMessage(`Pi: not found: ${p}`, 3000);
      return;
    }
    // Build the URI on the extension host, so under Remote-SSH it points at the remote file.
    const uri = vscode.Uri.file(file);
    if (stat.isDirectory()) return this.openDirectory(uri);
    const opts: vscode.TextDocumentShowOptions = { preview: true, viewColumn: vscode.ViewColumn.One };
    if (line && line > 0) opts.selection = new vscode.Range(line - 1, 0, line - 1, 0);
    // vscode.open (not openTextDocument) so images and binaries get their proper editor.
    await vscode.commands.executeCommand("vscode.open", uri, opts);
  }

  /**
   * Folders can't be opened in an editor. Inside the workspace, reveal them in the
   * Explorer; elsewhere, show a quick pick of the folder's entries to open or descend into.
   */
  private async openDirectory(uri: vscode.Uri, reveal?: vscode.Uri): Promise<void> {
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      await vscode.commands.executeCommand("revealInExplorer", reveal ?? uri);
      return;
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Pi: cannot read ${uri.fsPath}: ${err.message}`);
      return;
    }
    const isDir = (t: vscode.FileType) => (t & vscode.FileType.Directory) !== 0;
    entries.sort(([a, at], [b, bt]) => Number(isDir(bt)) - Number(isDir(at)) || a.localeCompare(b));
    const items = [
      ...(path.dirname(uri.fsPath) !== uri.fsPath ? [{ label: "$(arrow-up) ..", name: "..", dir: true }] : []),
      ...entries.map(([name, t]) => ({ label: `${isDir(t) ? "$(folder)" : "$(file)"} ${name}`, name, dir: isDir(t) })),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: uri.fsPath, placeHolder: "Open a file or folder" });
    if (!pick) return;
    const target = vscode.Uri.file(path.join(uri.fsPath, pick.name));
    if (pick.dir) return this.openDirectory(target);
    await vscode.commands.executeCommand("vscode.open", target, { preview: true, viewColumn: vscode.ViewColumn.One });
  }

  /** Render a self-contained HTML file (a session export) in a webview tab. */
  private showHtmlFile(file: string) {
    let html: string;
    try {
      html = fs.readFileSync(file, "utf8");
    } catch (err: any) {
      vscode.window.showErrorMessage(`Pi: cannot read ${file}: ${err.message}`);
      return;
    }
    const panel = vscode.window.createWebviewPanel("pi.export", path.basename(file), vscode.ViewColumn.Active, {
      enableScripts: true,
      enableFindWidget: true,
      localResourceRoots: [],
    });
    panel.webview.html = html;
  }

  /** @-mention completion: folder listing for paths, fuzzy workspace search for bare words. */
  private async searchFiles(query: string, requestId: number) {
    const items = await completePath(query, this.cwd).catch(() => []);
    this.post({ type: "fileResults", requestId, items });
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

  /**
   * Continue this chat's session in the pi TUI inside an integrated terminal
   * (like Claude Code / Codex "open in terminal").
   *
   * Two pi processes appending to one session file would interleave entries, so
   * the RPC process is stopped while the terminal owns the session. When the
   * terminal closes (or the user clicks Reattach), the RPC process restarts on
   * the same session file and the transcript reloads with everything done in the TUI.
   */
  async openInTerminal() {
    if (this.terminal && vscode.window.terminals.includes(this.terminal)) {
      this.terminal.show();
      return;
    }
    if (this.state.isStreaming) {
      const choice = await vscode.window.showWarningMessage(
        "Pi is still working. Stop it and continue in the terminal?",
        { modal: true },
        "Stop and Open",
      );
      if (choice !== "Stop and Open") return;
      await this.abort(false);
    }
    // Refresh state for the current session id (it may have changed via /new, /resume, /tree…).
    try {
      this.state = await this.req({ type: "get_state" });
    } catch {}
    // Hand over by exact session id: `--session-id` resumes that session, or creates it
    // under the same id if nothing was written yet, so reattaching finds the same session.
    const sessionId: string | undefined = this.state.sessionId;
    // Release the session: stop the RPC process before the TUI opens it.
    const pi = this.pi;
    this.pi = undefined;
    pi?.stop();
    this.statusItem.hide();

    const title = piTerminalName();
    const terminal = await createPiTerminal(sessionId ? ["--session-id", sessionId] : [], { name: title, cwd: this.cwd });
    this.terminal = terminal;
    this.terminalSessionId = sessionId;
    this.post({ type: "terminalAttached", title });

    const sub = vscode.window.onDidCloseTerminal(async (t) => {
      if (t !== terminal) return;
      sub.dispose();
      if (this.terminal === terminal) await this.reattach();
    });
    this.disposables.push(sub);
  }

  /** Session id handed to the terminal; reattaching resumes exactly this session. */
  private terminalSessionId?: string;

  /** Take the session back from the terminal and reload the transcript. */
  async reattach() {
    const t = this.terminal;
    const id = this.terminalSessionId;
    this.terminal = undefined;
    this.terminalSessionId = undefined;
    if (t && vscode.window.terminals.includes(t)) t.dispose();
    this.post({ type: "terminalDetached" });
    await this.start(undefined, id);
  }

  get terminalAttached() {
    return !!this.terminal;
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
      case "tree":
        await this.openTree(arg);
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
          .catch(() => {}); // failures arrive as compaction_end { errorMessage } and are shown there
        break;
      case "name": {
        const name = arg || (await vscode.window.showInputBox({ prompt: "Session name", value: this.state.sessionName ?? "" }));
        if (name) await this.req({ type: "set_session_name", name });
        await this.refreshState();
        break;
      }
      case "export": {
        const r = await this.req({ type: "export_html", outputPath: arg || undefined });
        // Under Remote-SSH the file is on the remote host, so a local browser can't open it.
        // "Open" renders it in a VS Code tab instead (works everywhere); a real browser
        // is offered only when the extension host is local.
        const actions = vscode.env.remoteName ? ["Open", "Reveal"] : ["Open", "Open in Browser", "Reveal"];
        const pick = await vscode.window.showInformationMessage(`Exported session to ${r.path}`, ...actions);
        const uri = vscode.Uri.file(r.path);
        if (pick === "Open") this.showHtmlFile(r.path);
        else if (pick === "Open in Browser") vscode.env.openExternal(uri);
        else if (pick === "Reveal") this.openDirectory(vscode.Uri.file(path.dirname(r.path)), uri);
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
          `Pi session ${s.sessionId}: ${s.userMessages} prompts, ${s.toolCalls} tool calls, ${s.tokens.total.toLocaleString()} tokens, context ${ctx}`,
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

  /** Full text of prompt-like entries, for putting back into the composer after navigation. */
  private treeTexts = new Map<string, string>();

  /**
   * Open the session tree (the TUI's /tree). Sends a slimmed-down tree: one
   * node per entry with a kind, a one-line preview, label and children, so the
   * webview never receives full tool outputs.
   */
  async openTree(query = "", selectId?: string, refresh = false) {
    const { tree, leafId } = await this.req({ type: "get_tree" });
    const { nodes, texts } = slimTree(tree);
    this.treeTexts = texts;
    this.host.reveal();
    this.post({ type: "openTree", nodes, leafId, roots: tree.map((r: any) => r.entry.id), query, selectId, refresh });
  }

  private async treeNavigate(id: string, summarize: boolean, instructions?: string) {
    if (this.state.isStreaming) {
      this.post({ type: "error", message: "Wait for the current response to finish before navigating the session tree." });
      return;
    }
    const text = this.treeTexts.get(id);
    this.post({ type: "treeBusy", text: summarize ? "Summarizing the branch you are leaving…" : "Switching branch…" });
    try {
      await this.req({
        type: "prompt",
        message: `/vscode:tree ${JSON.stringify({ targetId: id, summarize, customInstructions: instructions || undefined })}`,
      });
    } finally {
      this.post({ type: "treeBusy", text: "" });
    }
    await this.sendInit("reset");
    // Like the TUI: selecting a prompt moves to its parent and puts the prompt back in the editor.
    if (text) this.post({ type: "insertText", text, replace: true });
  }

  /** Session files hidden from the resume list (VS Code-only; the files stay on disk). */
  private get archivedSessions(): Set<string> {
    return new Set(this.context.globalState.get<string[]>(ARCHIVED_SESSIONS_KEY, []));
  }

  private async setArchived(file: string, archived: boolean) {
    const set = this.archivedSessions;
    if (archived) set.add(file);
    else set.delete(file);
    await this.context.globalState.update(ARCHIVED_SESSIONS_KEY, [...set]);
  }

  async pickSession(refresh = false) {
    const dir = this.state.sessionFile ? path.dirname(this.state.sessionFile) : defaultSessionDir(this.cwd);
    const sessions = (await listSessions(dir, 150)).filter((s) => s.messageCount > 0 || s.file === this.state.sessionFile);
    const archived = this.archivedSessions;
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
        archived: s.file !== this.state.sessionFile && archived.has(s.file),
      })),
      refresh,
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
    this.terminal = undefined; // leave a user's terminal session running
    this.pi?.stop();
    this.pi = undefined;
    for (const d of this.disposables) d.dispose();
  }
}
