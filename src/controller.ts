import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PiProcess, type RpcRecord } from "./piProcess";
import { defaultSessionDir, listSessions, relativeTime, SessionSummary } from "./sessions";
import { getShellEnv } from "./shellEnv";
import { agentDir, scopeModels } from "./modelScope";
import { slimTree } from "./treeData";
import { createPiTerminal, piTerminalName } from "./piTerminal";
import { completePath } from "./pathComplete";
import { mergeProfiles, threadEntryTypes, type SideProfile } from "../webview/sideProfiles";

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

/**
 * Order sessions as a tree, as pi's /resume does: a session whose header names a listed parent
 * session (forks, clones, sessions that extensions start, such as subagents) goes under it.
 * Roots and siblings are sorted by the newest activity in their subtree, so a parent with a
 * fresh child moves up. A session whose parent is not listed is a root.
 */
function nestSessions(sessions: SessionSummary[]) {
  const key = (f: string) => path.resolve(f);
  const byFile = new Map(sessions.map((s) => [key(s.file), s]));
  const children = new Map<string, SessionSummary[]>();
  const roots: SessionSummary[] = [];
  for (const s of sessions) {
    const p = s.parent && key(s.parent);
    if (p && p !== key(s.file) && byFile.has(p)) {
      if (!children.has(p)) children.set(p, []);
      children.get(p)!.push(s);
    } else roots.push(s);
  }
  const latest = new Map<string, number>();
  const latestOf = (s: SessionSummary, seen = new Set<string>()): number => {
    const k = key(s.file);
    if (latest.has(k)) return latest.get(k)!;
    seen.add(k);
    let t = s.mtime;
    for (const c of children.get(k) ?? []) if (!seen.has(key(c.file))) t = Math.max(t, latestOf(c, seen));
    latest.set(k, t);
    return t;
  };
  const byLatest = (a: SessionSummary, b: SessionSummary) => latestOf(b) - latestOf(a);
  const out: { s: SessionSummary; depth: number; parent?: string; latest: number }[] = [];
  const visited = new Set<string>();
  const walk = (s: SessionSummary, depth: number, parent: string | undefined, rootLatest: number) => {
    const k = key(s.file);
    if (visited.has(k)) return;
    visited.add(k);
    const kids = [...(children.get(k) ?? [])].sort(byLatest);
    out.push({ s, depth, parent, latest: rootLatest });
    for (const c of kids) walk(c, depth + 1, s.file, rootLatest);
  };
  for (const r of [...roots].sort(byLatest)) walk(r, 0, undefined, latestOf(r));
  // Parent loops have no root; list what is left at the top level.
  for (const s of sessions) if (!visited.has(key(s.file))) walk(s, 0, undefined, latestOf(s));
  return out;
}

/** Hidden status key the bridge uses to report child sessions (see `trackChildRuns` in piBridge.ts). */
const CHILD_RUNS_KEY = "vscode:work";

/** Event types that make up in-progress output; replayed after a transcript snapshot. */
const TAIL_EVENTS = new Set(["message_start", "message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end"]);

/** Extension UI requests that wait for an answer from the user. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** Remove arguments that pin pi to one session, so a new process can open a different one. */
function withoutSessionArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--continue" || a === "-c" || a.startsWith("--session=") || a.startsWith("--session-id=")) continue;
    if (a === "--session" || a === "--session-id") {
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * One pi RPC process and the UI state the webview needs to show it. A chat
 * shows one session at a time; others can keep running in the background.
 */
interface Session {
  pi: PiProcess;
  state: any;
  /** Events since the last completed message: the part of a run that `get_messages` does not include yet. */
  tail: RpcRecord[];
  /** While a snapshot is being sent, messages for the webview wait here. */
  queue?: any[];
  /** Open dialogs (select/confirm/input/editor) by request id. */
  dialogs: Map<string, RpcRecord>;
  /** Last status/widget/queue/compaction record per key, replayed when the session is shown again. */
  ui: Map<string, RpcRecord>;
  runStartedAt?: number;
  /** Title reported by the webview (first prompt), used when there is no session name. */
  webTitle?: string;
  /** Number of in-flight prompts issued from the side panel; notices are routed there meanwhile. */
  sidePending: number;
  /** Width the bridge renders factory widgets at, as last told to this process. */
  widgetColumns?: number;
  /** The bridge's `vscode:widget-columns` command is loaded (seen in `get_commands`). */
  canSetColumns?: boolean;
  /**
   * Agent sessions that extensions run inside this process (for example subagents), as the
   * bridge reports them. RPC events do not show them, so the process can look idle while they work.
   */
  childRuns?: { count: number; files: string[] };
}

interface StartOptions {
  /** Keep the current session running in the background if it is busy. */
  keepRunning?: boolean;
  /** Start a new session instead of resuming one. */
  fresh?: boolean;
}

/** Anything that can host the chat webview (sidebar view or editor panel). */
export interface ChatHost {
  webview: vscode.Webview;
  setTitle(title: string | undefined): void;
  /** Optional: reflect side-panel state in native chrome. */
  setSideState?(open: boolean, count: number): void;
  reveal(): void;
}

/**
 * The pi RPC processes of one webview. The webview shows the active session;
 * sessions that the user switched away from while they were working keep
 * running in the background until they finish.
 */
export class PiController implements vscode.Disposable {
  /** The session shown in the webview. */
  private active?: Session;
  /** Busy sessions the user switched away from. */
  private background = new Set<Session>();
  private disposables: vscode.Disposable[] = [];
  private webviewReady = false;
  private outbox: any[] = [];
  private statusItem: vscode.StatusBarItem;
  private starting?: Promise<void>;
  private env: NodeJS.ProcessEnv = process.env;
  private args: string[] = [];
  /** Widget width in characters, measured by the webview. */
  private widgetColumns?: number;
  /** Integrated terminal running the pi TUI on this chat's session, while it owns the session. */
  private terminal?: vscode.Terminal;

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

  private get pi(): PiProcess | undefined {
    return this.active?.pi;
  }

  private get state(): any {
    return this.active?.state ?? {};
  }

  get isRunning(): boolean {
    return !!this.active && this.isBusy(this.active);
  }

  /** The main agent runs, or extensions run agent sessions in the process. Stopping it loses that work. */
  private isBusy(s: Session): boolean {
    return !!s.state.isStreaming || (s.childRuns?.count ?? 0) > 0;
  }

  /** Session files that a running child session writes to, in any of this chat's processes. */
  private childRunFiles(): Set<string> {
    const files = new Set<string>();
    for (const s of [this.active, ...this.background]) for (const f of s?.childRuns?.files ?? []) files.add(path.resolve(f));
    return files;
  }

  /** Id of a session in the session list: its file, else (for `--no-session`) its id. */
  private sessionKey(s: Session): string {
    return s.state.sessionFile ?? `bg:${s.state.sessionId}`;
  }

  private titleOf(s: Session): string {
    return s.state.sessionName || s.webTitle || "Untitled session";
  }

  // ---------------------------------------------------------------- process

  async start(sessionFile?: string, sessionId?: string, opts: StartOptions = {}): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doStart(sessionFile, sessionId, opts).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async doStart(sessionFile?: string, sessionId?: string, opts: StartOptions = {}) {
    const prev = this.active;
    if (prev) {
      if (opts.keepRunning && this.isBusy(prev) && prev.pi.running) this.sendToBackground(prev);
      else prev.pi.stop();
      this.active = undefined;
    }
    const cfg = vscode.workspace.getConfiguration("pi");
    const env = await getShellEnv(cfg.get<boolean>("useLoginShellEnv", true));
    env.PI_VSCODE = "1";
    if (this.widgetColumns) env.PI_VSCODE_WIDGET_COLUMNS = String(this.widgetColumns);
    this.env = env;
    const command = cfg.get<string>("path")?.trim() || "pi";
    let args = [...(cfg.get<string[]>("args") ?? [])];
    // A second process must not continue the session the background one is writing to.
    if (opts.keepRunning) args = withoutSessionArgs(args);
    // Bridge extension: adds tree navigation (/tree) and labels, which RPC lacks.
    args.push("-e", path.join(this.context.extensionPath, "dist", "pi-bridge.mjs"));

    const resume = opts.fresh ? undefined : sessionFile ?? this.options.sessionFile ??
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
    this.active = this.spawn(command, args, env);
    this.updateStatus();
    this.post({ type: "starting" });
    await this.sendInit("init");
  }

  private spawn(command: string, args: string[], env: NodeJS.ProcessEnv): Session {
    this.output.appendLine(`[pi] starting: ${command} --mode rpc ${args.join(" ")} (cwd ${this.cwd})`);
    const pi = new PiProcess(command, args, this.cwd, env);
    const s: Session = { pi, state: {}, tail: [], dialogs: new Map(), ui: new Map(), sidePending: 0, widgetColumns: this.widgetColumns };
    pi.on("event", (e: RpcRecord) => this.onPiEvent(s, e));
    pi.on("stderr", (t: string) => this.output.append(t));
    pi.on("exit", (code: number | null, signal: string | null, err?: Error) => {
      this.output.appendLine(`[pi] exited code=${code} signal=${signal} ${err?.message ?? ""}`);
      s.state.isStreaming = false;
      s.childRuns = undefined;
      if (this.background.delete(s)) {
        this.updateStatus();
        vscode.window.showWarningMessage(`Pi: the background session "${this.titleOf(s)}" exited (code ${code ?? signal}).`);
        return;
      }
      if (this.active !== s) return;
      const hint = (err as any)?.code === "ENOENT"
        ? `Could not find the \`${command}\` executable. Install pi or set "pi.path" in settings.`
        : undefined;
      this.post({ type: "exited", code, signal, hint, stderr: stripAnsi(pi.stderrTail).slice(-3000) });
      this.updateStatus();
    });
    pi.start();
    return s;
  }

  /** Keep a busy session running while the webview shows another one. */
  private sendToBackground(s: Session) {
    this.background.add(s);
    this.updateStatus();
    vscode.window.setStatusBarMessage(`Pi: "${this.titleOf(s)}" keeps running in the background`, 4000);
  }

  /** Show a background session in the webview again. */
  private async showBackground(s: Session) {
    const prev = this.active;
    this.background.delete(s);
    if (prev && prev !== s) {
      if (this.isBusy(prev) && prev.pi.running) this.sendToBackground(prev);
      else prev.pi.stop();
    }
    this.active = s;
    this.updateStatus();
    await this.sendInit("reset");
  }

  /** A background session finished its run: stop its process (the session is on disk) and tell the user. */
  private onBackgroundSettled(s: Session) {
    const file = s.state.sessionFile;
    // Without a session file (`--no-session`) the process is the only copy; keep it.
    if (file) {
      this.background.delete(s);
      s.pi.stop();
    }
    this.updateStatus();
    const title = this.titleOf(s);
    vscode.window.showInformationMessage(`Pi finished "${title}" in the background.`, "Open").then((pick) => {
      if (pick !== "Open") return;
      this.host.reveal();
      this.openSession(file ?? this.sessionKey(s)).catch((err) => this.post({ type: "error", message: err.message ?? String(err) }));
    });
  }

  /** Show the spinner while any session of this chat is working. */
  private updateStatus() {
    const busy = [this.active, ...this.background].filter((s) => s && this.isBusy(s)).length;
    if (!busy) {
      this.statusItem.hide();
      return;
    }
    const bg = [...this.background].filter((s) => this.isBusy(s)).length;
    this.statusItem.text = busy > 1 ? `$(loading~spin) Pi (${busy})` : "$(loading~spin) Pi";
    this.statusItem.tooltip = bg
      ? `Pi is working… (${bg} session${bg === 1 ? "" : "s"} in the background)`
      : "Pi is working…";
    this.statusItem.show();
  }

  restart() {
    return this.start(this.state.sessionFile);
  }

  private req<T = any>(cmd: RpcRecord): Promise<T> {
    if (!this.pi) return Promise.reject(new Error("pi is not running"));
    return this.pi.request<T>(cmd);
  }

  private async refreshState() {
    const s = this.active;
    if (!s) return;
    try {
      const state = await this.req({ type: "get_state" });
      if (this.active !== s) return;
      s.state = state;
      if (this.state.sessionFile && this.options.primary) {
        this.context.workspaceState.update(LAST_SESSION_KEY, this.state.sessionFile);
      }
      this.post({ type: "state", state: this.state });
      this.updateTitle();
    } catch {}
  }

  private async refreshStats() {
    const s = this.active;
    try {
      const stats = await this.req({ type: "get_session_stats" });
      if (this.active !== s) return;
      this.post({ type: "stats", stats });
    } catch {}
  }

  /** Send full snapshot (state, commands, transcript) to the webview. */
  private async sendInit(kind: "init" | "reset") {
    const s = this.active;
    if (!s) return;
    // Hold live events until the snapshot is out, then send what the snapshot misses.
    s.queue = [];
    let replay: RpcRecord[] = [];
    try {
      const [state, commands, messages, sideEntries] = await Promise.all([
        this.req({ type: "get_state" }),
        this.req({ type: "get_commands" }).catch(() => ({ commands: [] })),
        this.req({ type: "get_messages" })
          .then((r) => {
            // Completed messages are in the snapshot; the unfinished rest of the run is in the tail.
            replay = [...s.tail];
            s.queue = (s.queue ?? []).filter((m) => !(m.type === "event" && TAIL_EVENTS.has(m.event?.type)));
            return r;
          })
          .catch(() => ({ messages: [] })),
        this.getSideEntries(),
      ]);
      if (this.active !== s) return;
      s.state = state;
      if (state.sessionFile && this.options.primary) {
        this.context.workspaceState.update(LAST_SESSION_KEY, state.sessionFile);
      }
      this.post({
        type: kind,
        state,
        commands: commands.commands,
        messages: messages.messages,
        sideEntries,
        sideProfiles: this.sideProfiles(),
        cwd: this.cwd,
        runStartedAt: s.runStartedAt,
      });
      for (const e of [...s.ui.values(), ...s.dialogs.values(), ...replay]) this.post({ type: "event", event: e });
      this.updateTitle();
      this.updateStatus();
      this.refreshStats();
      s.canSetColumns = (commands.commands ?? []).some((c: any) => c?.name === "vscode:widget-columns");
      this.syncWidgetColumns(s);
    } catch (err: any) {
      this.output.appendLine(`[pi] init failed: ${err.message}`);
    } finally {
      const queued = s.queue ?? [];
      s.queue = undefined;
      if (this.active === s) for (const m of queued) this.post(m);
    }
  }

  /** Send a message for session `s` to the webview, if it is the one shown. */
  private emit(s: Session, msg: any) {
    if (s !== this.active) return;
    if (s.queue) s.queue.push(msg);
    else this.post(msg);
  }

  /** Side-panel profiles: built-in ones changed by `pi.sidePanels`, plus legacy `pi.sidePanelCommands`. */
  private sideProfiles(): SideProfile[] {
    const cfg = vscode.workspace.getConfiguration("pi");
    return mergeProfiles(cfg.get<Partial<SideProfile>[]>("sidePanels", []), cfg.get("sidePanelCommands", {}));
  }

  /**
   * Custom entries on the active branch that belong to side-conversation
   * extensions (e.g. pi-btw's thread entries), oldest first, so the side
   * panel can restore its thread after a reload or session switch.
   */
  private async getSideEntries(): Promise<any[]> {
    const types = new Set(threadEntryTypes(this.sideProfiles()));
    try {
      const { entries, leafId } = await this.req({ type: "get_entries" });
      const byId = new Map<string, any>(entries.map((e: any) => [e.id, e]));
      const branch: any[] = [];
      for (let id = leafId; id && byId.has(id); id = byId.get(id).parentId) branch.push(byId.get(id));
      return branch
        .reverse()
        .filter((e) => e.type === "custom" && types.has(String(e.customType)));
    } catch {
      return [];
    }
  }

  private updateTitle() {
    this.host.setTitle(this.state.sessionName || this.active?.webTitle);
  }

  // ---------------------------------------------------------------- pi -> ui

  private onPiEvent(s: Session, e: RpcRecord) {
    if (TAIL_EVENTS.has(e.type)) s.tail.push(e);
    switch (e.type) {
      case "extension_ui_request":
        if (e.method === "setStatus" && e.statusKey === CHILD_RUNS_KEY) return this.onChildRuns(s, e.statusText);
        this.handleExtensionUi(s, e);
        break;
      case "agent_start":
        s.state.isStreaming = true;
        s.runStartedAt = Date.now();
        s.tail = [];
        this.updateStatus();
        break;
      case "agent_settled":
        s.state.isStreaming = false;
        s.runStartedAt = undefined;
        s.tail = [];
        s.ui.delete("queue");
        if (this.background.has(s) && !this.isBusy(s)) {
          this.onBackgroundSettled(s);
          return;
        }
        this.updateStatus();
        if (s === this.active) {
          this.refreshStats();
          this.refreshState();
        }
        break;
      case "message_end":
        s.tail = [];
        break;
      case "queue_update":
        s.ui.set("queue", e);
        break;
      case "compaction_start":
        s.ui.set("compaction", e);
        break;
      case "compaction_end":
        s.ui.delete("compaction");
        break;
      case "session_info_changed":
        s.state.sessionName = e.name;
        if (s === this.active) this.updateTitle();
        break;
      case "thinking_level_changed":
        s.state.thinkingLevel = e.level;
        break;
      case "extension_error":
        this.output.appendLine(`[pi] extension error in ${e.extensionPath} (${e.event}): ${e.error}`);
        break;
    }
    this.emit(s, { type: "event", event: e });
  }

  /** The bridge's hidden status: child sessions that run in the process. Not shown in the webview. */
  private onChildRuns(s: Session, text: string | undefined) {
    let runs: Session["childRuns"];
    try {
      const p = text ? JSON.parse(text) : undefined;
      if (p && p.count > 0) runs = { count: Number(p.count), files: Array.isArray(p.files) ? p.files.map(String) : [] };
    } catch {}
    s.childRuns = runs;
    if (this.background.has(s) && !this.isBusy(s)) {
      this.onBackgroundSettled(s);
      return;
    }
    this.updateStatus();
  }

  private handleExtensionUi(s: Session, e: RpcRecord) {
    const shown = s === this.active;
    if (DIALOG_METHODS.has(e.method)) {
      s.dialogs.set(e.id, e);
      if (!shown) {
        vscode.window.showInformationMessage(`Pi: "${this.titleOf(s)}" is waiting for your answer.`, "Open").then((pick) => {
          if (pick !== "Open" || !this.background.has(s)) return;
          this.host.reveal();
          this.showBackground(s);
        });
      }
      return;
    }
    switch (e.method) {
      case "notify": {
        const msg = stripAnsi(e.message);
        // Side-panel requests show their notices inline; composer refusals open the panel.
        if (shown && (s.sidePending > 0 || COMPOSER_REFUSAL_RE.test(msg))) break;
        const fn = e.notifyType === "error"
          ? vscode.window.showErrorMessage
          : e.notifyType === "warning"
            ? vscode.window.showWarningMessage
            : vscode.window.showInformationMessage;
        fn(shown ? `Pi: ${msg}` : `Pi ("${this.titleOf(s)}"): ${msg}`);
        break;
      }
      case "setStatus":
        s.ui.set(`status:${e.statusKey}`, e);
        break;
      case "setWidget":
        s.ui.set(`widget:${e.widgetKey}`, e);
        break;
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
        case "widgetColumns":
          this.widgetColumns = Math.max(20, Math.round(Number(m.columns) || 0)) || undefined;
          if (this.active) this.syncWidgetColumns(this.active);
          break;
        case "uiResponse":
          this.active?.dialogs.delete(m.response?.id);
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
          if (this.active) this.active.webTitle = m.title;
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
    if (!this.pi?.running) await this.start();
    const s = this.active!;
    s.sidePending++;
    try {
      const res = await this.req({ type: "prompt", message: text });
      this.post({ type: "sideDone", requestId, disposition: res?.disposition });
    } catch (err: any) {
      this.post({ type: "sideDone", requestId, error: err.message ?? String(err) });
    } finally {
      // Late notices from the same command can trail the response slightly.
      setTimeout(() => s.sidePending--, 250);
    }
  }

  /**
   * Tell the bridge the widget width when the view was resized. Only when init showed that the
   * bridge command exists: an unknown slash command would go to the model as a prompt.
   */
  private syncWidgetColumns(s: Session) {
    const columns = this.widgetColumns;
    if (!columns || s.widgetColumns === columns || !s.canSetColumns || !s.pi.running) return;
    s.widgetColumns = columns;
    s.pi.request({ type: "prompt", message: `/vscode:widget-columns ${JSON.stringify({ columns })}` }).catch(() => {});
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
    if (this.isRunning) {
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
      const state = await this.req({ type: "get_state" });
      if (this.active) this.active.state = state;
    } catch {}
    // Hand over by exact session id: `--session-id` resumes that session, or creates it
    // under the same id if nothing was written yet, so reattaching finds the same session.
    const sessionId: string | undefined = this.state.sessionId;
    // Release the session: stop the RPC process before the TUI opens it.
    this.pi?.stop();
    this.state.isStreaming = false;
    this.updateStatus();

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
        this.assertNoTerminal();
        // A busy session keeps working in the background; the new one gets its own process.
        if (this.isRunning) {
          await this.start(undefined, undefined, { keepRunning: true, fresh: true });
          break;
        }
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
    const listed = await listSessions(dir, 150);
    const archived = this.archivedSessions;
    const bg = [...this.background];
    const bgKeys = new Set(bg.map((b) => this.sessionKey(b)));
    const childFiles = this.childRunFiles();
    const sessions = listed.filter((s) => (s.messageCount > 0 || s.file === this.state.sessionFile) && !bgKeys.has(s.file));
    const running = bg.map((b) => {
      const summary = listed.find((s) => s.file === b.state.sessionFile);
      const n = summary?.messageCount;
      return {
        id: this.sessionKey(b),
        label: this.titleOf(b),
        cols: [this.isBusy(b) ? "working" : "idle", n != null ? `${n} msg${n === 1 ? "" : "s"}` : ""],
        group: "Running in background",
        search: [this.titleOf(b), summary?.firstMessage?.slice(0, 500)].filter(Boolean).join(" "),
        running: this.isBusy(b),
        busy: true,
      };
    });
    this.host.reveal();
    this.post({
      type: "openList",
      kind: "session",
      placeholder: "Resume a Pi session",
      empty: "No previous sessions for this folder",
      items: [...running, ...nestSessions(sessions).map(({ s, depth, parent, latest }) => ({
        id: s.file,
        label: s.name || s.firstMessage?.split("\n")[0].slice(0, 200) || "(empty session)",
        cols: [relativeTime(s.mtime), `${s.messageCount} msg${s.messageCount === 1 ? "" : "s"}`],
        group: dayGroup(latest),
        search: [s.name, s.firstMessage?.slice(0, 500)].filter(Boolean).join(" "),
        current: s.file === this.state.sessionFile,
        archived: s.file !== this.state.sessionFile && archived.has(s.file),
        running: (s.file === this.state.sessionFile && !!this.state.isStreaming) || childFiles.has(path.resolve(s.file)),
        parent,
        depth,
      }))],
      refresh,
    });
  }

  /** The user picked an entry in a webview dropdown list. */
  private async onListPick(kind: string, id: string) {
    if (kind === "session") {
      await this.openSession(id);
    } else if (kind === "fork") {
      const r = await this.req({ type: "fork", entryId: id });
      if (!r?.cancelled) {
        await this.sendInit("reset");
        if (r?.text) this.post({ type: "insertText", text: r.text, replace: true });
      }
    }
  }

  private assertNoTerminal() {
    if (this.terminal) throw new Error("This session is open in the terminal. Reattach before switching sessions.");
  }

  /**
   * Show the session `id` (a session file, or a background session key). A busy
   * current session keeps running in the background instead of being interrupted.
   */
  private async openSession(id: string) {
    this.assertNoTerminal();
    const bg = [...this.background].find((b) => this.sessionKey(b) === id);
    if (bg) return this.showBackground(bg);
    if (id === this.state.sessionFile && this.pi?.running) return;
    if (id.startsWith("bg:")) return; // a background session without a file that has since gone away
    // Another pi process must not write to a file that a running child session (a subagent) writes to.
    if (this.childRunFiles().has(path.resolve(id))) {
      vscode.window.showWarningMessage("Pi: this session is still running inside another session (for example as a subagent). Open it when it finishes.");
      return;
    }
    if (!this.pi?.running) return this.start(id);
    // switch_session would end the extensions' work (session_shutdown), so a busy process gets replaced instead.
    if (this.isRunning) return this.start(id, undefined, { keepRunning: true });
    const r = await this.req({ type: "switch_session", sessionPath: id });
    if (!r?.cancelled) await this.sendInit("reset");
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
    this.active = undefined;
    for (const s of this.background) s.pi.stop();
    this.background.clear();
    for (const d of this.disposables) d.dispose();
  }
}
