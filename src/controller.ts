import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PiProcess, type RpcRecord } from "./piProcess";
import { appendSessionName, defaultSessionDir, listSessions, relativeTime, SessionSummary } from "./sessions";
import { getShellEnv } from "./shellEnv";
import { readSessionView } from "./sessionView";
import { agentDir, scopeModels } from "./modelScope";
import { slimTree } from "./treeData";
import { createPiTerminal, piTerminalName } from "./piTerminal";
import { completePath } from "./pathComplete";
import { openDirectory, openPath } from "./openPath";
import { daemonOptions, detachedFiles, duration } from "./daemon/ui";
import { daemonList } from "./daemon/client";
import { activeModules, hiddenWidgets, hostModules, moduleEntryTypes, modulePiExtensions, type ExtSession, type HostIntegration, type HostIntegrationInstance } from "./integrations";

const LAST_SESSION_KEY = "pi.lastSessionFile";
/** Model, effort and commands of the last snapshot, for the preview while pi starts. */
const PREVIEW_KEY = "pi.previewState";
const RECENT_MODELS_KEY = "pi.recentModels";
export const ARCHIVED_SESSIONS_KEY = "pi.archivedSessions";
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
export const stripAnsi = (s: string) => (s ?? "").replace(ANSI_RE, "");

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

/** Image types that pi sends to models as image content. Other files are attached as "@path" references. */
const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** A `prompt` command for a message. The mode is always set: pi ignores it when idle. */
function promptCmd(m: { text: string; images?: any[]; mode: "steer" | "followUp" }): RpcRecord {
  const cmd: RpcRecord = { type: "prompt", message: m.text, streamingBehavior: m.mode };
  if (m.images?.length) cmd.images = m.images;
  return cmd;
}

/** The text of a user message, as pi's queue holds it (text parts joined, images left out). */
function userText(content: any): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("") : "";
}

/** A message that waits in the chat's own queue (see `Session.compactionQueue`). */
interface HeldMessage {
  text: string;
  images?: any[];
  mode: "steer" | "followUp";
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
  /** While a queue edit takes the queue out and puts it back, its in-between queue updates are not shown. */
  queueBusy?: boolean;
  /**
   * Messages sent while pi compacts. pi refuses prompts during a manual compaction, so they wait
   * here and go to pi when compaction ends (like the pi TUI). Set from `compaction_start` to
   * `compaction_end`: an empty list still means "compacting".
   */
  compactionQueue?: HeldMessage[];
  /** Last `queue_update` from pi. The webview gets it with the compaction queue added. */
  piQueue?: RpcRecord;
  /**
   * Messages with images that went to pi's queue. pi's queue (and `clear_queue`) has text only, so
   * the images are kept here to show them and to queue them again. Matched to pi's queue by mode and
   * text; removed when pi delivers the message.
   */
  queuedImages?: HeldMessage[];
  /** Names of extension commands. pi runs them at once, also during compaction, so they are not held. */
  extCommands?: Set<string>;
  /** Ids of the active modules: integrations whose pi extension this session loaded (from `get_commands`), and the workarounds. */
  ext: Set<string>;
  /** Widget keys that the active modules hide. */
  hiddenWidgets?: Set<string>;
  /** What the hooks of integrations and workarounds see of this session. */
  handle: ExtSession;
  /** Session file the process was started with. It counts as open before pi reports `sessionFile`. */
  claim?: string;
  /**
   * Last `setStatus` text per key that a module consumed (for example the child-runs count). A chat
   * that takes the session over gives them to its own modules (see `adopt`).
   */
  hookStatus: Map<string, string | undefined>;
  /** A snapshot of this session reached the webview (after it was ready). */
  delivered?: boolean;
}

/** How a chat starts. */
export interface ChatOptions {
  /** The sidebar chat: it resumes the last session of the workspace. */
  primary: boolean;
  sessionFile?: string;
  /** Show session tabs in the header, and keep them in workspace state under this key. */
  tabsKey?: string;
  /** Tabs to start with instead of the saved ones (a tab dragged out into a new tile). */
  tabs?: Tab[];
}

/** A pi process that moves from one chat to another with its tab. */
export interface Handover {
  pi: PiProcess;
  file?: string;
  state: any;
  webTitle?: string;
  /** What the chat knows of the session beyond pi's state: a running turn, dialogs, queues, widgets. */
  live: LiveState;
}

/** The parts of a Session that a session that works needs in another chat (see `Session`). */
type LiveState = Pick<Session, "tail" | "dialogs" | "ui" | "hookStatus" | "runStartedAt" | "compactionQueue" | "piQueue" | "extCommands" | "ext" | "hiddenWidgets">;

/** A session tab in the header. Tabs of idle sessions have no process; opening one resumes its file. */
export interface Tab {
  /** Session key (see `sessionKey`): the session file, or `bg:<id>` without a file. */
  key: string;
  title: string;
  /**
   * Session id of a new session that has no message yet. pi writes the file only with the first
   * message, so the tab opens it again with `--session-id`.
   */
  id?: string;
}

interface StartOptions {
  /** Keep the current session running in the background if it is busy. */
  keepRunning?: boolean;
  /** Start a new session instead of resuming one. */
  fresh?: boolean;
}

/** Anything that can host the chat webview (sidebar view or editor panel). */
export interface ChatHost {
  /** The chat's channel to its webview. A sidebar tile shares the view's webview with the other tiles. */
  webview: Pick<vscode.Webview, "postMessage" | "onDidReceiveMessage">;
  /** `busy`: the shown session works (editor tabs mark their title). */
  setTitle(title: string | undefined, busy?: boolean): void;
  /** Optional: a badge on the native view (integrations use it for unread items). */
  setBadge?(count: number, tooltip?: string): void;
  reveal(): void;
  /** Open a session file in a new chat tab beside this chat. */
  openBeside?(file: string): void;
  /** Where the chat is, for lists of chats ("sidebar", "tab"). */
  kind: string;
  /** Close the chat (a sidebar tile, when there are others). Returns false if it can't. */
  closeChat?(): boolean;
}

/**
 * The pi RPC processes of one webview. The webview shows the active session;
 * sessions that the user switched away from while they were working keep
 * running in the background until they finish.
 */
export class PiController implements vscode.Disposable {
  /** All open chats. A rename in one chat's session list goes to the chat whose process has the session. */
  private static readonly all = new Set<PiController>();
  /** Called when the sessions that work change. The status bar item (src/daemon/ui.ts) counts them. */
  static onStatusChanged?: () => void;
  /** The session shown in the webview. */
  private active?: Session;
  /** Busy sessions the user switched away from. */
  private background = new Set<Session>();
  /**
   * Idle sessions of other tabs that keep their pi process, most recent first, so that a switch to
   * their tab is quick. A pi process takes seconds to start and `switch_session` about a second.
   */
  private warm: Session[] = [];
  /** An idle process with a new, unwritten session, so that + shows a new session at once. */
  private spare?: Session;
  private disposables: vscode.Disposable[] = [];
  private webviewReady = false;
  private outbox: any[] = [];
  private starting?: Promise<void>;
  private env: NodeJS.ProcessEnv = process.env;
  private args: string[] = [];
  /** Integrated terminal running the pi TUI on this chat's session, while it owns the session. */
  private terminal?: vscode.Terminal;
  /** Integrations and the enabled workarounds. */
  private modules: HostIntegration[];
  /** The hooks of each module for this chat. */
  private integrations = new Map<string, HostIntegrationInstance>();
  private sessionOf = new WeakMap<ExtSession, Session>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: ChatHost,
    private readonly output: vscode.OutputChannel,
    private readonly options: ChatOptions,
  ) {
    if (options.tabsKey) this.tabs = (options.tabs ?? context.workspaceState.get<Tab[]>(options.tabsKey) ?? []).filter((t) => typeof t?.key === "string");
    this.disposables.push(host.webview.onDidReceiveMessage((m) => this.onWebviewMessage(m)));
    const enabled = vscode.workspace.getConfiguration("pi").get<Record<string, boolean>>("workarounds", {}) ?? {};
    this.modules = hostModules((id) => enabled[id] !== false);
    for (const i of this.modules) {
      this.integrations.set(i.id, i.create({
        prompt: async (text) => {
          if (!this.pi?.running) await this.start();
          return this.req({ type: "prompt", message: text });
        },
        post: (payload) => this.post({ type: "ext", id: i.id, payload }),
        emit: (handle, payload) => {
          const s = this.sessionOf.get(handle);
          if (s) this.emit(s, { type: "ext", id: i.id, payload });
        },
        setBadge: (count, tooltip) => this.host.setBadge?.(count, tooltip),
        busyChanged: (handle) => {
          const s = this.sessionOf.get(handle);
          if (s) this.onBusyChanged(s);
        },
      }));
    }
    PiController.all.add(this);
    // Start pi now, not when the webview is ready: pi needs seconds to start, and the webview loads
    // in the meantime. A tile that gets a process handed over (adoptFirst, right after this) starts none.
    queueMicrotask(() => {
      if (!this.active && !this.disposed && !this.terminal) this.start().catch((err) => this.output.appendLine(`[pi] start failed: ${err.message ?? err}`));
    });
  }

  /** The hooks of the modules that are active in session `s`. */
  private hooks(s: Session): HostIntegrationInstance[] {
    return [...s.ext].map((id) => this.integrations.get(id)).filter((h): h is HostIntegrationInstance => !!h);
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

  /** A session of this chat works: the shown one or one in the background. */
  get hasWork(): boolean {
    return [this.active, ...this.background].some((s) => !!s && this.isBusy(s));
  }

  get isRunning(): boolean {
    return !!this.active && this.isBusy(this.active);
  }

  /**
   * The main agent runs, pi compacts, or a module reports work in the process (for example agent sessions that extensions run).
   * Stopping the process, or switching it to another session, loses that work.
   */
  private isBusy(s: Session): boolean {
    return !!s.state.isStreaming || !!s.compactionQueue || this.hooks(s).some((h) => h.isBusy?.(s.handle));
  }

  /** Session files that a running process of this chat writes to apart from its own session (reported by modules). */
  private filesInUse(): Set<string> {
    const files = new Set<string>();
    for (const h of this.integrations.values()) for (const f of h.filesInUse?.() ?? []) files.add(path.resolve(f));
    return files;
  }

  /** A module's busy state of `s` changed. A background session that is no longer busy is done. */
  private onBusyChanged(s: Session) {
    if (this.background.has(s) && !this.isBusy(s)) {
      this.onBackgroundSettled(s);
      return;
    }
    this.updateStatus();
  }

  /** Id of a session in the session list: its file, else (for `--no-session`) its id. */
  private sessionKey(s: Session): string {
    // `claim`: a process that is still starting already has its session (a warm tab, see prewarm).
    return s.state.sessionFile ?? s.claim ?? `bg:${s.state.sessionId}`;
  }

  /** Tab titles that stand for "no title". A tab with a real title does not go back to one of these. */
  private static readonly NO_TITLE = new Set(["New session", "Untitled session"]);

  private titleOf(s: Session): string {
    if (s.state.sessionName || s.webTitle) return s.state.sessionName || s.webTitle;
    // pi writes the file with the first message: without one it is a new session (the webview says the same).
    const f = s.state.sessionFile;
    return f && !fs.existsSync(f) ? "New session" : "Untitled session";
  }

  // ---------------------------------------------------------------- one chat per session

  /** Session file of `s`: the file that pi reports, or the file it was started with until pi reports one. */
  private static fileOf(s: Session): string | undefined {
    const f = s.state.sessionFile ?? s.claim;
    return f ? path.resolve(f) : undefined;
  }

  /**
   * The chat that has the session file open: in a running process (shown or in the background),
   * or in the terminal. A second chat must not open the same file, so that only one process writes it.
   */
  static ownerOf(file: string, except?: PiController): PiController | undefined {
    const f = path.resolve(file);
    for (const c of PiController.all) {
      if (c === except) continue;
      if (c.active && PiController.fileOf(c.active) === f && (c.active.pi.running || c.terminal)) return c;
      if ([...c.background, ...c.warm].some((b) => b.pi.running && PiController.fileOf(b) === f)) return c;
    }
    return undefined;
  }

  /** Bring this chat to the front and show the session file, if it is one of its background sessions. */
  async showSession(file: string) {
    this.host.reveal();
    const f = path.resolve(file);
    const bg = [...this.background, ...this.warm].find((b) => PiController.fileOf(b) === f);
    if (bg) await this.showProcess(bg);
  }

  // ---------------------------------------------------------------- warm tabs

  /** How many idle tabs keep their process (setting `pi.warmTabs`). */
  private get warmLimit(): number {
    if (!this.options.tabsKey) return 0;
    return Math.max(0, Math.min(8, vscode.workspace.getConfiguration("pi").get<number>("warmTabs", 3) ?? 3));
  }

  /**
   * Put away the session that was shown: a busy one keeps running in the background, an idle one
   * with a tab keeps its process (up to `warmLimit`), and any other stops.
   */
  private park(s: Session) {
    if (!s.pi.running) return;
    if (this.isBusy(s)) return this.sendToBackground(s);
    const key = this.sessionKey(s);
    if (!this.tabs.some((t) => t.key === key)) {
      // No tab (it was closed): a new session without a message becomes the spare again.
      const unwritten = !!s.state.sessionFile && !fs.existsSync(s.state.sessionFile);
      if (unwritten && !this.spare && this.warmLimit) this.spare = s;
      else s.pi.stop();
      return;
    }
    if (this.warmLimit && s.state.sessionFile) {
      this.warm = [s, ...this.warm.filter((w) => w !== s)];
      for (const old of this.warm.splice(this.warmLimit)) old.pi.stop();
      return;
    }
    s.pi.stop();
  }

  private prewarmTimer?: ReturnType<typeof setTimeout>;
  private prewarming = false;

  /**
   * A while after a session is shown, start processes for the tabs next to it, one at a time, so
   * that the first switch to them is quick too.
   */
  private schedulePrewarm(delay = this.prewarmedOnce ? 2500 : 8000) {
    if (!this.warmLimit || this.disposed) return;
    clearTimeout(this.prewarmTimer);
    this.prewarmTimer = setTimeout(() => {
      // Do not slow down chats that start (for example all tiles when VS Code opens).
      if ([...PiController.all].some((c) => c.starting)) return this.schedulePrewarm(2000);
      this.prewarmedOnce = true;
      void this.prewarm();
    }, delay);
  }
  private prewarmedOnce = false;

  private async prewarm() {
    if (this.prewarming || this.disposed) return;
    this.prewarming = true;
    try {
      const cfg = vscode.workspace.getConfiguration("pi");
      const user = cfg.get<string[]>("args") ?? [];
      if (user.some((a) => ["--session-id", "--no-session"].includes(a))) return;
      const command = cfg.get<string>("path")?.trim() || "pi";
      if (!this.spare && this.active && !this.disposed) {
        const s = this.spawn(command, [...withoutSessionArgs(user), ...this.extensionArgs()], this.env);
        this.spare = s;
        try {
          s.state = await s.pi.request({ type: "get_state" });
        } catch {
          if (this.spare === s) this.spare = undefined;
          s.pi.stop();
        }
      }
      // A session that works in the daemon without a window is not a warm tab: it opens when you ask for it.
      const detached = await detachedFiles(this.context);
      const shown = this.tabs.findIndex((t) => t.key === this.shownKey);
      // The nearest tabs first: the ones you are most likely to open next.
      const order = this.tabs
        .map((t, i) => ({ t, d: Math.abs(i - shown) + (i < shown ? 0.5 : 0) }))
        .sort((a, b) => a.d - b.d)
        .map((x) => x.t.key);
      for (const key of order) {
        if (this.disposed || this.warm.length >= this.warmLimit || !this.active || this.terminal) break;
        if (key.startsWith("bg:") || this.sessionOfTab(key) || !fs.existsSync(key)) continue;
        if (PiController.ownerOf(key) || this.filesInUse().has(path.resolve(key)) || detached.has(path.resolve(key))) continue;
        const args = [...withoutSessionArgs(user), ...this.extensionArgs(), "--session", key];
        const s = this.spawn(command, args, this.env);
        s.claim = key;
        this.warm.push(s);
        try {
          s.state = await s.pi.request({ type: "get_state" });
        } catch {
          this.warm = this.warm.filter((w) => w !== s);
          s.pi.stop();
          break;
        }
        this.syncTabs();
      }
    } finally {
      this.prewarming = false;
    }
  }

  /** `-e` arguments for the bridge and the pi sides of the modules. */
  private extensionArgs(): string[] {
    const args = ["-e", path.join(this.context.extensionPath, "dist", "pi-bridge.mjs")];
    for (const p of modulePiExtensions(this.modules)) args.push("-e", path.join(this.context.extensionPath, "dist", p));
    return args;
  }

  // ---------------------------------------------------------------- process

  /**
   * Start pi on a session. A start without a target joins the one that runs. A start with a target
   * (open a tab, a new session) replaces it: the older start stops where it is (`openGen`).
   */
  async start(sessionFile?: string, sessionId?: string, opts: StartOptions = {}): Promise<void> {
    if (this.starting && !sessionFile && !sessionId && !opts.fresh) return this.starting;
    const gen = ++this.openGen;
    const p = this.doStart(gen, sessionFile, sessionId, opts).finally(() => {
      if (this.starting === p) this.starting = undefined;
    });
    this.starting = p;
    return p;
  }

  // ---------------------------------------------------------------- opening a session

  /** Counts the opens (starts and switches). An open whose number is no longer the last one stops. */
  private openGen = 0;
  /** A `switch_session` that runs, so that a move of its tab can wait for it. */
  private switching?: Promise<unknown>;

  /** The tab that is opening: its key, or "" for a new session that pi has not reported yet. */
  private openingKey(): string | undefined {
    if (!this.starting && !this.switching) return undefined;
    const f = this.pendingKey ?? this.startingFile;
    if (f) return this.tabs.find((t) => path.resolve(t.key) === path.resolve(f))?.key ?? f;
    return this.active?.state.sessionFile ? undefined : "";
  }

  /** The tab that was shown last (saved), if it is still a tab. A closed tab is not opened again. */
  private savedShownTab(): string | undefined {
    if (!this.options.tabsKey) return undefined;
    const k = this.context.workspaceState.get<string>(`${this.options.tabsKey}:shown`);
    return k && this.tabs.some((t) => t.key === k) ? k : undefined;
  }

  private isOpening(key: string): boolean {
    const k = this.openingKey();
    return k !== undefined && (k === key || (!!k && !!key && path.resolve(k) === path.resolve(key)));
  }

  /** Stop opening a tab (it was closed): a process that is starting for it stops. */
  private cancelOpening() {
    this.openGen++;
    this.pendingKey = undefined;
    if (this.starting && this.active && !this.active.delivered) {
      this.active.pi.stop();
      this.active = undefined;
    }
  }

  private async doStart(gen: number, sessionFile?: string, sessionId?: string, opts: StartOptions = {}) {
    // The file that this start resumes, for the preview (onReady) while the shell env loads.
    this.startingFile = opts.fresh ? undefined : sessionFile ?? this.options.sessionFile ??
      this.savedShownTab() ??
      (this.options.primary && vscode.workspace.getConfiguration("pi").get<boolean>("resumeLastSession", true)
        ? this.context.workspaceState.get<string>(LAST_SESSION_KEY)
        : undefined);
    const prev = this.active;
    if (prev) {
      if (opts.keepRunning) this.park(prev);
      else prev.pi.stop();
      this.active = undefined;
    }
    const cfg = vscode.workspace.getConfiguration("pi");
    const env = await getShellEnv(cfg.get<boolean>("useLoginShellEnv", true));
    // A newer open (or a close of this tab) came while the environment loaded.
    if (gen !== this.openGen) return;
    env.PI_VSCODE = "1";
    // Short titles for new sessions, written by the bridge (src/bridge/sessionTitle.ts).
    if (cfg.get<boolean>("autoTitle", false)) env.PI_VSCODE_AUTO_TITLE = "1";
    const titleModel = cfg.get<string>("titleModel")?.trim();
    if (titleModel) env.PI_VSCODE_TITLE_MODEL = titleModel;
    for (const h of this.integrations.values()) Object.assign(env, h.env?.());
    this.env = env;
    const command = cfg.get<string>("path")?.trim() || "pi";
    let args = [...(cfg.get<string[]>("args") ?? [])];
    // A second process must not continue the session the background one is writing to.
    if (opts.keepRunning) args = withoutSessionArgs(args);
    // Bridge extension (tree navigation and labels, which RPC lacks) and the pi sides of integrations.
    args.push(...this.extensionArgs());

    const resume = opts.fresh ? undefined : sessionFile ?? this.options.sessionFile ??
      this.savedShownTab() ??
      (this.options.primary && cfg.get<boolean>("resumeLastSession", true)
        ? this.context.workspaceState.get<string>(LAST_SESSION_KEY)
        : undefined);
    const asked = !!(sessionFile ?? this.options.sessionFile);
    this.options.sessionFile = undefined;
    const pinned = args.some((a) => ["--session", "--session-id", "--continue", "-c", "--no-session"].includes(a));
    // The tab of a new session without a message: it has no file yet, so open it by its id.
    if (!sessionId && resume && !fs.existsSync(resume)) sessionId = this.tabs.find((t) => t.key === resume && t.id)?.id;
    let claim: string | undefined;
    if (sessionId && !pinned) {
      // Exact session (resumes it, or creates it if it was never written).
      args.push("--session-id", sessionId);
    } else if (resume && fs.existsSync(resume) && !pinned) {
      // Another chat has the session open (for example a restored tab and the sidebar after a reload): start a new one.
      if (PiController.ownerOf(resume, this)) {
        if (asked) vscode.window.showInformationMessage("Pi: this session is open in another chat. This chat starts a new session.");
      } else {
        args.push("--session", resume);
        claim = resume;
      }
    }

    this.args = args;
    this.pendingKey = claim ?? (sessionId ? this.tabs.find((t) => t.id === sessionId)?.key : undefined);
    this.active = this.spawn(command, args, env);
    this.active.claim = claim;
    void this.adoptDetached(command, env);
    this.updateStatus();
    // After a preview of this file, "starting" would replace it with "Loading session".
    if (!(claim && this.previewFile === claim)) this.post({ type: "starting", fresh: !claim && !sessionId });
    await this.sendInit("init");
  }

  private spawn(command: string, args: string[], env: NodeJS.ProcessEnv): Session {
    this.output.appendLine(`[pi] starting: ${command} --mode rpc ${args.join(" ")} (cwd ${this.cwd})`);
    // With the session daemon, the process runs there and outlives this window (setting `pi.keepSessionsAlive`).
    const pi = new PiProcess(command, args, this.cwd, env, daemonOptions(this.context));
    const s = this.wrap(pi, command);
    pi.start();
    return s;
  }

  /** A Session for the process `pi`, with this chat's listeners. Also used for a process that another chat hands over. */
  private wrap(pi: PiProcess, command = "pi"): Session {
    const controller = this;
    const s: Session = {
      pi, state: {}, tail: [], dialogs: new Map(), ui: new Map(), hookStatus: new Map(),
      // Workarounds are active from the start; integrations once `get_commands` shows their extension.
      ext: activeModules(this.modules, undefined),
      handle: {
        get shown() {
          return controller.active === s;
        },
        get running() {
          return pi.running;
        },
        request: (cmd) => pi.request(cmd),
      },
    };
    this.sessionOf.set(s.handle, s);
    pi.on("event", (e: RpcRecord) => this.onPiEvent(s, e));
    pi.on("stderr", (t: string) => this.output.append(t));
    pi.on("attached", (info: any) => this.onAttached(s, info));
    pi.on("exit", (code: number | null, signal: string | null, err?: Error) => {
      this.output.appendLine(`[pi] exited code=${code} signal=${signal} ${err?.message ?? ""}`);
      s.state.isStreaming = false;
      for (const h of this.hooks(s)) h.onExit?.(s.handle);
      if (this.spare === s) {
        this.spare = undefined;
        return;
      }
      const wi = this.warm.indexOf(s);
      if (wi >= 0) {
        this.warm.splice(wi, 1);
        this.syncTabs();
        return;
      }
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
    return s;
  }

  /** The daemon gave this chat a session that ran without a VS Code window: say what happened in the meantime. */
  private onAttached(s: Session, info: any) {
    this.output.appendLine(`[pi] took a detached session from the daemon (detached for ${duration(info.detachedMs ?? 0)})`);
    if (info.runStartedAt) s.runStartedAt = info.runStartedAt;
    const auto: { title: string; answer: string }[] = info.auto ?? [];
    for (const a of auto) this.output.appendLine(`[pi] answered automatically: "${a.title}" -> ${a.answer}`);
    // A window reload is no news; a long time without a window, or an answer that the user did not give, is.
    if (!auto.length && (info.detachedMs ?? 0) < 60_000) return;
    const answers = auto.length ? ` ${auto.length} question${auto.length === 1 ? " was" : "s were"} answered automatically (see the Pi output).` : "";
    const msg = `Pi: "${info.name || s.webTitle || "A session"}" kept working for ${duration(info.detachedMs ?? 0)} without VS Code.${answers}`;
    vscode.window.showInformationMessage(msg, ...(auto.length ? ["Show Output"] : [])).then((pick) => pick && this.output.show());
  }

  /** The first chat that starts takes the detached sessions that are in no chat's tabs. */
  private static restAdopter?: PiController;
  private adopted = false;

  /**
   * Once for each chat, after its first start: take the sessions of this folder that work in the
   * daemon without a window. They go on in the background of the chat that has their tab.
   */
  private async adoptDetached(command: string, env: NodeJS.ProcessEnv) {
    if (this.adopted || !daemonOptions(this.context)) return;
    this.adopted = true;
    const list = await daemonList();
    const user = withoutSessionArgs(vscode.workspace.getConfiguration("pi").get<string[]>("args") ?? []);
    if (user.some((a) => ["--session-id", "--no-session"].includes(a))) return;
    const hasTab = (c: PiController, f: string) => c.tabs.some((t) => path.resolve(t.key) === f);
    for (const d of list?.sessions ?? []) {
      if (this.disposed) return;
      if (d.attached || !d.file || !(d.busy || d.waiting) || path.resolve(d.cwd) !== path.resolve(this.cwd)) continue;
      const f = path.resolve(d.file);
      if (PiController.ownerOf(f)) continue;
      if (!hasTab(this, f)) {
        if ([...PiController.all].some((c) => c !== this && hasTab(c, f))) continue;
        if ((PiController.restAdopter ??= this) !== this) continue;
      }
      // The daemon answers the start of this file with the process that has it.
      const s = this.spawn(command, [...user, ...this.extensionArgs(), "--session", f], env);
      s.claim = f;
      s.state = { sessionFile: f, sessionName: d.name, isStreaming: true };
      this.background.add(s);
      s.pi.request({ type: "get_commands" }).then((r: any) => this.setActiveModules(s, r?.commands), () => {});
      s.pi.request({ type: "get_state" }).then((state: any) => {
        this.setSessionState(s, state);
        this.onBusyChanged(s);
      }, () => {});
    }
    this.updateStatus();
  }

  /** Show the session file in this chat (from the status bar list of the daemon's sessions). */
  async open(file: string) {
    this.host.reveal();
    await this.openSession(file);
  }

  /** Keep a busy session running while the webview shows another one. */
  private sendToBackground(s: Session) {
    this.background.add(s);
    this.updateStatus();
    vscode.window.setStatusBarMessage(`Pi: "${this.titleOf(s)}" keeps running in the background`, 4000);
  }

  /** Show a background session in the webview again. */
  private showBackground(s: Session) {
    return this.showProcess(s);
  }

  /** Show a session that has a process: a background or a warm one. The shown one is parked. */
  private async showProcess(s: Session) {
    // A newer open: a start or a switch that runs for another tab stops where it is.
    this.openGen++;
    this.pendingKey = undefined;
    const prev = this.active;
    this.background.delete(s);
    this.warm = this.warm.filter((w) => w !== s);
    if (prev && prev !== s) this.park(prev);
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
    this.unread.add(this.sessionKey(s));
    this.updateStatus();
    const title = this.titleOf(s);
    vscode.window.showInformationMessage(`Pi finished "${title}" in the background.`, "Open").then((pick) => {
      if (pick !== "Open") return;
      this.host.reveal();
      this.openSession(file ?? this.sessionKey(s)).catch((err) => this.post({ type: "error", message: err.message ?? String(err) }));
    });
  }

  /** Show the spinner while any session of any chat is working. */
  private updateStatus() {
    this.updateTitle();
    PiController.updateSharedStatus();
  }

  /** Sessions that work, in all chats. */
  private static working(): { chat: PiController; s: Session; background: boolean }[] {
    return [...PiController.all].flatMap((chat) =>
      [chat.active, ...chat.background]
        .filter((s): s is Session => !!s && chat.isBusy(s))
        .map((s) => ({ chat, s, background: s !== chat.active })));
  }

  private static updateSharedStatus() {
    PiController.onStatusChanged?.();
  }

  /** The sessions that work in this window, for the status bar item and its list. */
  static running(): { title: string; where: string; file?: string; show(): void }[] {
    return PiController.working().map((b) => ({
      title: b.chat.titleOf(b.s),
      where: b.background ? `${b.chat.host.kind} · in the background` : b.chat.host.kind,
      file: PiController.fileOf(b.s),
      show: () => {
        b.chat.host.reveal();
        if (b.background) void b.chat.showBackground(b.s);
      },
    }));
  }

  restart() {
    return this.start(this.state.sessionFile);
  }

  private req<T = any>(cmd: RpcRecord): Promise<T> {
    if (!this.pi) return Promise.reject(new Error("pi is not running"));
    return this.pi.request<T>(cmd);
  }

  /** Take pi's state of `s`. A process that has another session now (new_session) loses the title of the one it had. */
  private setSessionState(s: Session, state: any) {
    if (s.state.sessionFile && state?.sessionFile !== s.state.sessionFile) s.webTitle = undefined;
    s.state = state;
  }

  private async refreshState() {
    const s = this.active;
    if (!s) return;
    try {
      const state = await this.req({ type: "get_state" });
      if (this.active !== s) return;
      this.setSessionState(s, state);
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

  /** Counts the snapshots that went to the webview (see `openTab`). */
  private snapshots = 0;

  /**
   * Open a tab that the webview shows already (a click on a tab, a close of the shown tab). The webview
   * waits for a snapshot. An open that sends none (the session is the shown one already, another chat
   * has it, an older open took over) sends the shown session, so that the webview does not wait forever.
   */
  private async openTab(key: string) {
    const n = this.snapshots;
    await this.openSession(key);
    const s = this.active;
    // `s.queue`: a snapshot is on its way.
    if (n !== this.snapshots || !s?.pi.running || s.queue || this.starting || this.switching || this.terminal) return;
    await this.sendInit("reset");
  }

  /** Send full snapshot (state, commands, transcript) to the webview. */
  private async sendInit(kind: "init" | "reset") {
    const s = this.active;
    if (!s) return;
    const gen = this.openGen;
    // Hold live events until the snapshot is out, then send what the snapshot misses.
    s.queue = [];
    let replay: RpcRecord[] = [];
    try {
      const [state, commands, messages, extEntries] = await Promise.all([
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
        this.getIntegrationEntries(),
      ]);
      if (this.active !== s) return;
      // A newer switch of this process runs (a quick click on another tab): it sends its own snapshot.
      if (gen !== this.openGen && this.switching) return;
      this.setSessionState(s, state);
      this.setActiveModules(s, commands.commands);
      if (state.sessionFile && this.options.primary) {
        this.context.workspaceState.update(LAST_SESSION_KEY, state.sessionFile);
      }
      if (this.webviewReady) s.delivered = true;
      // The title that the webview shows (its first prompt), so the tab has it before the webview reports it.
      if (!s.webTitle) {
        const first = (messages.messages ?? []).find((x: any) => x.role === "user");
        const text = typeof first?.content === "string" ? first.content : (first?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
        if (text?.trim()) s.webTitle = text.trim().split("\n")[0].slice(0, 80);
      }
      // For the preview at the next start (sendPreview): the model and the commands.
      this.context.workspaceState.update(PREVIEW_KEY, { model: state.model, thinkingLevel: state.thinkingLevel, commands: commands.commands });
      this.snapshots++;
      this.post({
        type: kind,
        state,
        commands: commands.commands,
        messages: messages.messages,
        extEntries,
        cwd: this.cwd,
        runStartedAt: s.runStartedAt,
      });
      for (const e of [...s.ui.values(), ...s.dialogs.values(), ...replay]) this.post({ type: "event", event: e });
      for (const h of this.hooks(s)) h.onShown?.(s.handle);
      this.updateTitle();
      this.updateStatus();
      this.refreshStats();
      this.schedulePrewarm();
    } catch (err: any) {
      this.output.appendLine(`[pi] init failed: ${err.message}`);
      // Ends the webview's loading state, which otherwise waits for the snapshot.
      if (this.active === s) this.post({ type: "error", message: `Could not load the session: ${err.message}` });
    } finally {
      const queued = s.queue ?? [];
      s.queue = undefined;
      if (this.active === s) for (const m of queued) if (!(m.type === "event" && this.isHiddenWidget(s, m.event))) this.post(m);
    }
  }

  /**
   * Update the modules that are active in session `s`, from its commands. Widgets that an active
   * module hides can arrive before the first `get_commands` answer; forget them.
   */
  private setActiveModules(s: Session, commands: any[] | undefined) {
    s.ext = activeModules(this.modules, commands);
    s.hiddenWidgets = hiddenWidgets(this.modules, s.ext);
    s.extCommands = new Set((commands ?? []).filter((c) => c.source === "extension").map((c) => String(c.name)));
    for (const key of s.hiddenWidgets) {
      // Outside a snapshot (for example after /reload), also clear a widget the webview shows already.
      if (s.ui.delete(`widget:${key}`) && s === this.active && !s.queue) {
        this.post({ type: "event", event: { type: "extension_ui_request", method: "setWidget", widgetKey: key } });
      }
    }
    for (const h of this.hooks(s)) h.onCommands?.(s.handle, commands ?? []);
  }

  private isHiddenWidget(s: Session, e: RpcRecord | undefined) {
    return e?.type === "extension_ui_request" && e.method === "setWidget" && !!s.hiddenWidgets?.has(e.widgetKey);
  }

  /**
   * Let the active modules change the lines of a widget. Returns undefined when the result equals
   * the lines shown already, so a widget that pi re-renders often does not flood the webview.
   */
  private rewriteWidget(s: Session, e: RpcRecord): RpcRecord | undefined {
    let lines: string[] = e.widgetLines;
    let changed = false;
    for (const h of this.hooks(s)) {
      const next = h.onWidget?.(s.handle, e.widgetKey, lines);
      if (next) (lines = next), (changed = true);
    }
    if (!changed) return e;
    const prev = s.ui.get(`widget:${e.widgetKey}`);
    if (prev && prev.widgetPlacement === e.widgetPlacement && JSON.stringify(prev.widgetLines) === JSON.stringify(lines)) return undefined;
    return { ...e, widgetLines: lines };
  }

  /** Send a message for session `s` to the webview, if it is the one shown. */
  private emit(s: Session, msg: any) {
    if (s !== this.active) return;
    if (s.queue) s.queue.push(msg);
    else this.post(msg);
  }

  /**
   * Custom entries on the active branch that integrations asked for, oldest
   * first, so they can restore their state after a reload or session switch.
   */
  private async getIntegrationEntries(): Promise<any[]> {
    const types = moduleEntryTypes(this.modules);
    if (!types.size) return [];
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
    this.host.setTitle(this.state.sessionName || this.active?.webTitle, !!this.active && this.isBusy(this.active));
    this.syncTabs();
  }

  // ---------------------------------------------------------------- tabs

  /** Session tabs of the header, in order. */
  private tabs: Tab[] = [];
  /** Tabs whose session finished in the background and that the user has not looked at yet. */
  private unread = new Set<string>();
  /** Key of the tab shown last. */
  private shownKey?: string;
  /** Session file that the shown process opens, until pi reports it: its tab shows as the shown one. */
  private pendingKey?: string;
  /** The last tab click that this chat has had (its number from the webview), sent with the tabs. */
  private pickSeq = 0;
  private lastTabs = "";
  private lastSavedTabs = "";

  /** The session of a tab, if it has a process. */
  private sessionOfTab(key: string): Session | undefined {
    if (this.active && this.sessionKey(this.active) === key) return this.active;
    return [...this.background, ...this.warm].find((b) => this.sessionKey(b) === key);
  }

  /**
   * Add tabs for the shown session and the background sessions, update the titles and send the tabs to
   * the webview. A tab of a session that was never written (an empty new session) goes away when you leave it.
   */
  private syncTabs() {
    if (!this.options.tabsKey) return;
    const a = this.active;
    const key = a && (a.state.sessionFile || a.state.sessionId) ? this.sessionKey(a) : undefined;
    // While pi switches the shown process to another tab, the process still reports the session it leaves.
    const switchingTo = this.switching ? this.pendingKey : undefined;
    if (key && !this.tabs.some((t) => t.key === key)) {
      // A new session opened again with --session-id gets a new file name: keep its tab.
      const id = a?.state.sessionId;
      const same = id && this.tabs.find((t) => t.id === id);
      if (same) same.key = key;
      // A new tab goes after all the tabs.
      else this.tabs.push({ key, title: "" });
    }
    for (const b of this.background) {
      const k = this.sessionKey(b);
      if (!this.tabs.some((t) => t.key === k)) this.tabs.push({ key: k, title: "" });
    }
    if (key && !switchingTo) {
      if (key !== this.shownKey && !key.startsWith("bg:")) this.context.workspaceState.update(`${this.options.tabsKey}:shown`, key);
      this.shownKey = key;
      this.pendingKey = undefined;
      this.unread.delete(key);
    }
    // The tab of a session that is opening counts as shown, and so does the shown one while it loads.
    // Before pi reports the session (also before the process exists): the file that this start opens.
    const opening = this.pendingKey ?? (this.starting ? this.startingFile : undefined);
    const tabOf = (f: string | undefined) => (f ? this.tabs.find((t) => path.resolve(t.key) === path.resolve(f))?.key : undefined);
    const shownTab = tabOf(switchingTo) ?? key ?? tabOf(opening) ?? undefined;
    this.tabs = this.tabs.filter((t) => {
      const s = this.sessionOfTab(t.key);
      if (s) {
        // A process that has just started for the tab (prewarm) knows no title yet: the tab keeps its own.
        const own = s.state.sessionName || s.webTitle;
        if (own) t.title = own;
        else if (!t.title || PiController.NO_TITLE.has(t.title)) t.title = this.titleOf(s);
        t.id = s.state.sessionFile && !fs.existsSync(s.state.sessionFile) ? s.state.sessionId : undefined;
      }
      return !!s || t.key === shownTab || !!t.id || (!t.key.startsWith("bg:") && fs.existsSync(t.key));
    });
    const tabs = this.tabs.map((t) => {
      const s = this.sessionOfTab(t.key);
      return { key: t.key, title: t.title || "Untitled session", shown: t.key === shownTab, busy: !!s && this.isBusy(s), unread: this.unread.has(t.key) };
    });
    // A new session that pi has not reported yet: a placeholder tab after all the tabs.
    if (a && !tabs.some((t) => t.shown)) tabs.push({ key: "", title: "", shown: true, busy: false, unread: false });
    // pi reports state often (titles, busy changes); send and save only what changed.
    const json = JSON.stringify({ tabs, pick: this.pickSeq });
    if (json !== this.lastTabs) {
      this.lastTabs = json;
      this.post({ type: "tabs", tabs, pick: this.pickSeq });
    }
    const saved = this.tabs.filter((t) => !t.key.startsWith("bg:"));
    const savedJson = JSON.stringify(saved);
    if (savedJson !== this.lastSavedTabs) {
      this.lastSavedTabs = savedJson;
      this.context.workspaceState.update(this.options.tabsKey, saved);
    }
  }

  /** Number of tabs, for the tile manager. */
  get tabCount(): number {
    return this.tabs.length;
  }

  /** The tabs and the shown one, for a tile that is merged into another. */
  tabList(): { tabs: Tab[]; shown?: string } {
    return { tabs: this.tabs.filter((t) => !t.key.startsWith("bg:")).map((t) => ({ ...t })), shown: this.shownKey };
  }

  /** Move a tab to position `to` (a drag in the tab strip). */
  moveTab(key: string, to: number) {
    const i = this.tabs.findIndex((t) => t.key === key);
    if (i < 0) return;
    const [t] = this.tabs.splice(i, 1);
    this.tabs.splice(Math.max(0, Math.min(this.tabs.length, to > i ? to - 1 : to)), 0, t);
    this.syncTabs();
  }

  /**
   * Take a tab out of this chat, so that another chat can open it. Its process stops, so that only
   * one process has the file. A session that works can't move. Returns the tab, and whether the
   * chat has no tabs left (the caller closes the tile).
   */
  async releaseTab(key: string): Promise<{ tab: Tab; empty: boolean; handover?: Handover } | undefined> {
    // pi switches this chat's process to the tab right now: let it finish, then the process moves with the tab.
    let switched: Session | undefined;
    if (this.switching && this.isOpening(key)) {
      await this.switching.catch(() => {});
      // The process has the tab's session now, before its snapshot came: it is the one that moves.
      if (this.active && this.pendingKey && path.resolve(this.pendingKey) === path.resolve(key)) {
        switched = this.active;
        this.openGen++;
        this.pendingKey = undefined;
        switched.claim = key;
        switched.state = { ...switched.state, sessionFile: key, sessionName: undefined };
        switched.webTitle = undefined;
      }
    }
    let i = this.tabs.findIndex((t) => t.key === key);
    if (i < 0 || key.startsWith("bg:")) return undefined;
    // A process that starts for the tab moves with it; the start here stops. Without a process yet, the other chat starts one.
    if (!switched && this.starting && this.isOpening(key)) {
      const loading = this.active;
      this.openGen++;
      this.pendingKey = undefined;
      if (loading && !loading.delivered) {
        loading.claim ??= key;
        const [tab] = this.tabs.splice(i, 1);
        const handover = loading.pi.running ? this.detach(loading) : undefined;
        this.showNextAfter(i);
        this.syncTabs();
        return { tab, empty: !this.tabs.length, handover };
      }
      i = this.tabs.findIndex((t) => t.key === key);
      if (!loading) {
        const [tab] = this.tabs.splice(i, 1);
        this.showNextAfter(i);
        this.syncTabs();
        return { tab, empty: !this.tabs.length };
      }
    }
    const s = switched ?? this.sessionOfTab(key);
    if (s && s === this.active) this.assertNoTerminal();
    const [tab] = this.tabs.splice(i, 1);
    this.unread.delete(key);
    const shown = !!s && s === this.active;
    const handover = s?.pi.running ? this.detach(s) : undefined;
    if (shown) this.showNextAfter(i);
    this.syncTabs();
    return { tab, empty: !this.tabs.length, handover };
  }

  /** The shown tab left (moved to another chat): show the tab at its place. Does not wait. */
  private showNextAfter(i: number) {
    const next = this.tabs[Math.min(i, this.tabs.length - 1)];
    if (!next) return;
    this.post({ type: "starting" });
    this.openSession(next.key).catch((err) => this.post({ type: "error", message: err.message ?? String(err) }));
  }

  /**
   * Add tabs that come from another chat at `index` (default: the end), and show `show`. `handovers`:
   * the processes of those tabs. They move with the tabs, so nothing restarts.
   */
  async adoptTabs(tabs: Tab[], index: number | undefined, show?: string, handovers: Handover[] = []) {
    const fresh = tabs.filter((t) => !this.tabs.some((x) => x.key === t.key));
    const at = index === undefined ? this.tabs.length : Math.max(0, Math.min(this.tabs.length, index));
    this.tabs.splice(at, 0, ...fresh);
    let shown: Session | undefined;
    for (const h of handovers) {
      const s = this.adopt(h);
      if (h.file && h.file === show) shown = s;
      // A session that works keeps working, in this chat's background.
      else if (this.isBusy(s)) this.background.add(s);
      else if (this.warm.length < this.warmLimit) this.warm.push(s);
      else s.pi.stop();
    }
    this.syncTabs();
    this.updateStatus();
    if (shown) await this.showProcess(shown);
    else if (show) await this.openSession(show);
  }

  /** Before the webview is ready: show this process first (a tab dragged out into a new tile). */
  /** Give away the spare process (a new session that is ready), for a new tile. */
  takeSpare(): Handover | undefined {
    const s = this.spare;
    if (!s?.pi.running || !s.state.sessionFile) return undefined;
    this.spare = undefined;
    this.schedulePrewarm(2500);
    return this.detach(s);
  }

  adoptFirst(h: Handover) {
    this.active = this.adopt(h);
    this.syncTabs();
  }

  /**
   * Take up a session from another chat with all that the chat knew of it, so that a turn that
   * runs, an open dialog or a queue goes on here. The modules of this chat get the statuses that
   * the other chat's modules consumed (for example the running child sessions).
   */
  private adopt(h: Handover): Session {
    const s = this.wrap(h.pi);
    Object.assign(s, h.live);
    s.state = { ...h.state };
    s.claim = h.file;
    s.webTitle = h.webTitle;
    for (const [key, text] of s.hookStatus) for (const m of this.hooks(s)) if (m.onStatus?.(s.handle, key, text)) break;
    return s;
  }

  /** Take the process of `s` out of this chat. The integrations forget the session; the other chat's take it up. */
  private detach(s: Session): Handover {
    s.pi.removeAllListeners();
    this.background.delete(s);
    this.warm = this.warm.filter((w) => w !== s);
    if (this.active === s) this.active = undefined;
    // After the session left (it is not shown), so the modules send nothing about it to this webview.
    for (const h of this.hooks(s)) h.onExit?.(s.handle);
    this.updateStatus();
    const { tail, dialogs, ui, hookStatus, runStartedAt, compactionQueue, piQueue, extCommands, ext, hiddenWidgets } = s;
    return {
      pi: s.pi, file: s.state.sessionFile ?? s.claim, state: s.state, webTitle: s.webTitle,
      live: { tail, dialogs, ui, hookStatus, runStartedAt, compactionQueue, piQueue, extCommands, ext, hiddenWidgets },
    };
  }

  /** The processes of all sessions of this chat (also the ones that work), for a tile that is merged into another. */
  detachAll(): Handover[] {
    const all = [this.active, ...this.background, ...this.warm].filter((s): s is Session => !!s?.pi.running);
    return all.map((s) => this.detach(s));
  }

  /** Close a tab. A session that works stops (after a question). Closing the shown tab shows its neighbour. */
  private async closeTab(key: string) {
    const i = this.tabs.findIndex((t) => t.key === key);
    // A tab that is still opening closes too: its start stops, nothing waits for it to load.
    const opening = this.isOpening(key);
    if (i < 0 && !opening) return;
    const s = opening ? undefined : this.sessionOfTab(key);
    const shown = opening || (!!s && s === this.active);
    if (shown) this.assertNoTerminal();
    if (s && this.isBusy(s)) {
      const pick = await vscode.window.showWarningMessage(`Pi: "${this.titleOf(s)}" is still working. Stop it and close the tab?`, { modal: true }, "Stop and Close");
      if (pick !== "Stop and Close") return;
      s.pi.stop();
      s.state.isStreaming = false;
    }
    const at = this.tabs.findIndex((t) => t.key === key);
    if (at >= 0) this.tabs.splice(at, 1);
    this.unread.delete(key);
    if (opening) this.cancelOpening();
    if (!shown) {
      if (s) {
        this.background.delete(s);
        if (this.warm.includes(s)) {
          this.warm = this.warm.filter((w) => w !== s);
          s.pi.stop();
        }
      }
      this.updateStatus();
      // No tab left: close the tile, as for the shown tab below.
      if (!this.tabs.length) this.host.closeChat?.();
      return;
    }
    const next = this.tabs[Math.min(Math.max(at, 0), this.tabs.length - 1)];
    if (next) return this.openTab(next.key);
    // The last tab of a sidebar tile closes the tile, like the last editor of an editor group.
    if (this.host.closeChat?.()) return;
    if (this.pi?.running) {
      const r = await this.req({ type: "new_session" });
      if (!r?.cancelled) await this.sendInit("reset");
    } else await this.start(undefined, undefined, { fresh: true });
  }


  // ---------------------------------------------------------------- pi -> ui

  private onPiEvent(s: Session, e: RpcRecord) {
    if (TAIL_EVENTS.has(e.type)) s.tail.push(e);
    switch (e.type) {
      case "extension_ui_request":
        if (e.method === "setStatus" && this.hooks(s).some((h) => h.onStatus?.(s.handle, e.statusKey, e.statusText))) {
          s.hookStatus.set(e.statusKey, e.statusText);
          return;
        }
        if (this.isHiddenWidget(s, e)) return;
        if (e.method === "setWidget" && Array.isArray(e.widgetLines)) {
          const w = this.rewriteWidget(s, e);
          if (!w) return;
          e = w;
        }
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
        s.piQueue = undefined;
        s.queuedImages = undefined;
        if (s.compactionQueue?.length) s.ui.set("queue", this.queueRecord(s));
        else s.ui.delete("queue");
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
      case "message_start":
        // pi takes a delivered message out of its queue by text; do the same with its images.
        if (e.message?.role === "user" && s.queuedImages?.length) {
          const text = userText(e.message.content);
          const i = s.queuedImages.findIndex((x) => x.text === text);
          if (i >= 0) s.queuedImages.splice(i, 1);
        }
        break;
      case "message_end":
        s.tail = [];
        break;
      case "queue_update":
        s.piQueue = e;
        e = this.queueRecord(s);
        s.ui.set("queue", e);
        if (s.queueBusy) return;
        break;
      case "compaction_start":
        s.ui.set("compaction", e);
        s.compactionQueue ??= [];
        // A warm session that compacts (a compaction that the session itself starts) works: it must not stop.
        if (this.warm.includes(s)) {
          this.warm = this.warm.filter((w) => w !== s);
          this.background.add(s);
        }
        this.updateStatus();
        break;
      case "compaction_end":
        s.ui.delete("compaction");
        // pi's messages are now the summary and the kept messages. Show them at once, so that the transcript is
        // the same as after a switch to another tab and back. The event waits (`s.queue`) and follows the snapshot.
        if (e.result && s === this.active && !s.queue) void this.sendInit("reset");
        void this.flushCompactionQueue(s, !!e.willRetry).then((runFollows) => {
          // No run follows (its `agent_settled` would do this): the session is not busy any more.
          if (!runFollows) this.onBusyChanged(s);
          else this.updateStatus();
        });
        break;
      case "session_info_changed":
        s.state.sessionName = e.name;
        if (s === this.active) this.updateTitle();
        else this.syncTabs();
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
        if (shown && [...s.ext].some((id) => this.integrations.get(id)?.filterNotice?.(msg, e.notifyType ?? "info"))) break;
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
    this.lastTabs = "";
    if (this.terminal) {
      this.post({ type: "terminalAttached", title: this.terminal.name });
      return;
    }
    for (const s of [this.active, ...this.background, ...this.warm]) if (s) s.delivered = false;
    this.syncTabs();
    // While pi starts, show the session from its file: the transcript is there at once.
    // Start now if the chat has not started yet, so that the preview below shows while pi starts.
    if (!this.pi?.running && !this.starting) this.start().catch(() => {});
    // Keep the promise: the start can end while the preview loads (a session that the daemon gives
    // back answers at once), and `this.starting` is then empty.
    const starting = this.starting;
    if (starting) {
      const file = this.active?.state.sessionFile ?? this.active?.claim ?? this.startingFile;
      // A session file: show it from the file. None (a new session): show the new session, not "Loading session".
      if (file && fs.existsSync(file)) await this.sendPreview(file);
      else this.post({ type: "starting", fresh: true });
      await starting.catch(() => {});
    }
    if (!this.pi?.running) await this.start();
    else if (!this.active?.delivered) await this.sendInit("init");
  }

  /**
   * Show a session read from its file, before its pi process answers. The snapshot from pi
   * follows and takes over; the webview keeps the transcript if it has the same messages.
   */
  private startingFile?: string;
  private previewFile?: string;

  private async sendPreview(file: string) {
    this.previewFile = file;
    try {
      const view = await readSessionView(file);
      const last = this.context.workspaceState.get<any>(PREVIEW_KEY) ?? {};
      if (this.active?.delivered) return;
      this.post({
        type: "init",
        preview: true,
        state: { sessionFile: file, sessionName: view.name, model: last.model, thinkingLevel: last.thinkingLevel },
        commands: last.commands ?? [],
        messages: view.messages,
        cwd: this.cwd,
      });
    } catch {}
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
        case "continue":
          // RPC mode has no command to resume a run without a new message, so send a short prompt.
          await this.prompt(vscode.workspace.getConfiguration("pi").get<string>("continuePrompt")?.trim() || "Continue as you left off.", undefined, "steer");
          break;
        case "abort":
          await this.abort();
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
          await openPath(m.path, m.line, this.cwd);
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
        case "title": {
          // Only for the session that the title is of: after a click on a tab, the webview shows (and
          // reports) that tab before this chat has switched to it. A title without a file is of a new session that
          // pi has not reported yet (a click on +): it is not the title of the session that the process still has.
          const s = m.file
            ? [this.active, ...this.background, ...this.warm].find((x) => x && PiController.fileOf(x) === path.resolve(m.file))
            : this.active && !PiController.fileOf(this.active) ? this.active : undefined;
          // An empty title does not take a title away: a session gets a new one only with a new file (setSessionState).
          if (s && m.title) s.webTitle = m.title;
          this.updateTitle();
          break;
        }
        case "rename": {
          // The session that the rename box was opened for: the chat can show another one by now.
          const name = String(m.name ?? "").replace(/[\r\n]+/g, " ").trim();
          if (!name) break;
          if (!m.file) {
            await this.runBuiltin("name", name);
            break;
          }
          await this.renameSession(String(m.file), name);
          const tab = this.tabs.find((t) => path.resolve(t.key) === path.resolve(String(m.file)));
          if (tab) tab.title = name;
          this.syncTabs();
          break;
        }
        case "tabPick":
          // Tabs sent from now on know of this click (the webview keeps its own choice until then).
          this.pickSeq = Math.max(this.pickSeq, Number(m.seq) || 0);
          await this.openTab(String(m.key));
          this.syncTabs();
          // The click is done: the webview stops waiting, also when no snapshot went out.
          this.post({ type: "tabShown", seq: Number(m.seq) || 0 });
          break;
        case "tabClose":
          await this.closeTab(String(m.key));
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
        case "treeFork":
          await this.treeFork(m.id);
          break;
        case "treeLabel":
          await this.req({ type: "prompt", message: `/vscode:label ${JSON.stringify({ entryId: m.id, label: m.label ?? "" })}` });
          await this.openTree("", m.id, true);
          break;
        case "copy":
          await vscode.env.clipboard.writeText(String(m.text ?? ""));
          if (!m.quiet) vscode.window.setStatusBarMessage("Pi: copied to clipboard", 1500);
          break;
        case "listAction":
          if (m.kind === "session" && m.action === "view") {
            await vscode.commands.executeCommand("pi.viewSession", vscode.Uri.file(m.id));
          } else if (m.kind === "session" && m.action === "side") {
            await this.openBeside(m.id);
          } else if (m.kind === "session" && m.action === "rename") {
            try {
              await this.renameSession(m.id, String(m.name ?? ""));
            } finally {
              await this.pickSession(true);
            }
          } else if (m.kind === "session" && (m.action === "archive" || m.action === "unarchive")) {
            await this.setArchived(m.id, m.action === "archive");
            await this.pickSession(true);
          }
          break;
        case "listPick":
          await this.onListPick(m.kind, m.id);
          break;
        case "ext":
          await this.onIntegrationMessage(String(m.id), m.payload);
          break;
        case "editEnabledModels":
          await this.editEnabledModels();
          break;
        case "setThinking":
          await this.setThinking(m.level);
          break;
        case "pickAttachments":
          await this.pickAttachments();
          break;
        case "saveAttachment":
          await this.saveAttachment(m.name, m.data);
          break;
        case "queueOp":
          await this.queueOp(m);
          break;
        case "clearQueue": {
          const s = this.active;
          if (!s) break;
          const q = await this.takeQueue(s);
          this.restoreQueue([...q.steering, ...q.followUp]);
          this.showQueue(s);
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
    const s = this.active;
    if (s?.compactionQueue && !this.isExtensionCommand(s, text)) {
      s.compactionQueue.push({ text, images: images?.length ? images : undefined, mode: mode ?? "steer" });
      this.showQueue(s);
      return;
    }
    // Always set the mode: pi ignores it when idle. Our isStreaming can lag behind pi (a get_state reply
    // from before a run started, or a run that a queued message just started), and without it pi
    // refuses the prompt with "Agent is already processing".
    const res = s ? await this.sendPrompt(s, { text, images, mode: mode ?? "steer" }) : await this.req(promptCmd({ text, images, mode: mode ?? "steer" }));
    if (res?.disposition === "handled") this.sendCommandsSoon();
  }

  /** Pass a payload from the webview side of an integration to its host side. */
  private async onIntegrationMessage(id: string, payload: any) {
    await this.integrations.get(id)?.onMessage?.(payload);
  }

  private sendCommandsSoon() {
    // Extension commands may change session/model/commands; refresh lightly.
    setTimeout(async () => {
      await this.refreshState();
      try {
        const s = this.active;
        const c = await this.req({ type: "get_commands" });
        if (s) this.setActiveModules(s, c.commands);
        this.post({ type: "commands", commands: c.commands });
      } catch {}
    }, 300);
  }

  /**
   * Change one queued message. RPC can only add to the queue or clear all of it, so take the queue
   * out, change it, and queue the messages again in the new order. The webview sends the text it
   * shows, so the edit finds the right message even when pi delivered one in the meantime.
   * During compaction, all messages go back into the compaction queue, and "send now" puts the
   * message first: stopping would also stop the compaction. "edit" takes the message out and puts
   * its text in the input box.
   */
  private async queueOp(m: { op: "remove" | "sendNow" | "move" | "edit"; kind: "steer" | "followUp"; index: number; text: string; to?: number }) {
    const s = this.active;
    if (!s || !this.pi?.running) return;
    s.queueBusy = true;
    try {
      const { steering, followUp } = await this.takeQueue(s);
      const list = m.kind === "steer" ? steering : followUp;
      const i = list[m.index]?.text === m.text ? m.index : list.findIndex((x) => x.text === m.text);
      let item: HeldMessage | undefined;
      if (i >= 0) {
        [item] = list.splice(i, 1);
        if (m.op === "move") list.splice(Math.max(0, Math.min(m.to ?? i, list.length)), 0, item);
        if (m.op === "edit") this.post({ type: "restoreQueue", text: item.text, images: item.images });
      }
      if (item && m.op === "sendNow") {
        if (s.compactionQueue) steering.unshift({ ...item, mode: "steer" });
        else {
          // abort resolves once pi is idle, so this prompt starts the next run.
          await this.req({ type: "abort" }).catch(() => {});
          await this.sendPrompt(s, { ...item, mode: "steer" });
        }
      }
      if (s.compactionQueue) s.compactionQueue.push(...steering, ...followUp);
      // If the run ended meanwhile, the first message starts a new run and the rest queue behind it.
      else for (const x of [...steering, ...followUp]) await this.sendPrompt(s, x);
    } finally {
      s.queueBusy = false;
      this.showQueue(s);
    }
  }

  /**
   * Stop the current run. By default, queued messages are not lost: pi would
   * drop them on abort, so take them out first and send them as the next run
   * (steering first, then follow-ups). With `resumeQueue: false`, they go
   * back into the input box instead. A stop during compaction also stops the
   * compaction; the messages that waited for it are handled the same way.
   */
  async abort(resumeQueue = true) {
    const s = this.active;
    let steering: HeldMessage[] = [];
    let followUp: HeldMessage[] = [];
    if (s) ({ steering, followUp } = await this.takeQueue(s));
    await this.req({ type: "abort" }).catch(() => {});
    if (!steering.length && !followUp.length) return;
    if (s) this.showQueue(s);
    if (!resumeQueue || this.terminal || !this.pi?.running) {
      this.restoreQueue([...steering, ...followUp]);
      return;
    }
    const joined: HeldMessage = {
      text: steering.map((x) => x.text).join("\n\n"),
      images: steering.flatMap((x) => x.images ?? []),
      mode: "steer",
    };
    const [first, ...rest] = steering.length ? [joined, ...followUp] : followUp;
    try {
      // abort resolves once pi is idle, so the first message starts a new run.
      await this.sendPrompt(s!, first);
      for (const x of rest) await this.sendPrompt(s!, { ...x, mode: "followUp" });
    } catch (err: any) {
      this.post({ type: "error", message: err.message ?? String(err) });
    }
  }

  // ---------------------------------------------------------------- queue

  /**
   * Take all queued messages out: pi's queue (which has text only) and the compaction queue.
   * The compaction queue stays set (empty) while pi compacts.
   */
  private async takeQueue(s: Session): Promise<{ steering: HeldMessage[]; followUp: HeldMessage[] }> {
    const held = s.compactionQueue?.splice(0) ?? [];
    let q: any;
    try {
      q = await s.pi.request({ type: "clear_queue" });
    } catch {}
    const images = this.matchImages(s, q?.steering ?? [], q?.followUp ?? []);
    s.queuedImages = undefined;
    const fromPi = (texts: string[], imgs: (any[] | undefined)[], mode: HeldMessage["mode"]): HeldMessage[] =>
      texts.map((text, i) => ({ text, images: imgs[i], mode }));
    return {
      steering: [...fromPi(q?.steering ?? [], images.steering, "steer"), ...held.filter((x) => x.mode === "steer")],
      followUp: [...fromPi(q?.followUp ?? [], images.followUp, "followUp"), ...held.filter((x) => x.mode === "followUp")],
    };
  }

  /**
   * Send a message to pi. If it has images, keep them in `queuedImages` first: pi's queue update
   * comes before the reply, and the queue shows only what pi reports.
   */
  private async sendPrompt(s: Session, m: HeldMessage, cmd: RpcRecord = promptCmd(m)): Promise<any> {
    const rec = m.images?.length ? { ...m } : undefined;
    if (rec) (s.queuedImages ??= []).push(rec);
    try {
      return await s.pi.request(cmd);
    } catch (err) {
      if (rec) s.queuedImages = s.queuedImages?.filter((x) => x !== rec);
      throw err;
    }
  }

  /** The images of each message in pi's queue, in order. Each kept message matches one queue entry. */
  private matchImages(s: Session, steering: string[], followUp: string[]) {
    const pool = [...(s.queuedImages ?? [])];
    const take = (text: string, mode: HeldMessage["mode"]) => {
      const i = pool.findIndex((x) => x.mode === mode && x.text === text);
      return i >= 0 ? pool.splice(i, 1)[0].images : undefined;
    };
    return { steering: steering.map((t) => take(t, "steer")), followUp: followUp.map((t) => take(t, "followUp")) };
  }

  /** Put queued messages back into the input box: the texts joined, the images as attachments. */
  private restoreQueue(items: HeldMessage[]) {
    this.post({ type: "restoreQueue", text: items.map((x) => x.text).join("\n\n"), images: items.flatMap((x) => x.images ?? []) });
  }

  /** The queue that the webview shows: pi's queue, then the messages that wait for compaction to end. */
  private queueRecord(s: Session): RpcRecord {
    const held = s.compactionQueue ?? [];
    const of = (mode: HeldMessage["mode"]) => held.filter((x) => x.mode === mode);
    const steering: string[] = s.piQueue?.steering ?? [];
    const followUp: string[] = s.piQueue?.followUp ?? [];
    const images = this.matchImages(s, steering, followUp);
    return {
      type: "queue_update",
      steering: [...steering, ...of("steer").map((x) => x.text)],
      followUp: [...followUp, ...of("followUp").map((x) => x.text)],
      // Images of each message, in the same order. The webview shows them as thumbnails.
      steeringImages: [...images.steering, ...of("steer").map((x) => x.images)],
      followUpImages: [...images.followUp, ...of("followUp").map((x) => x.images)],
    };
  }

  private showQueue(s: Session) {
    const e = this.queueRecord(s);
    s.ui.set("queue", e);
    if (!s.queueBusy) this.emit(s, { type: "event", event: e });
  }

  private isExtensionCommand(s: Session, text: string): boolean {
    const name = /^\/(\S+)/.exec(text)?.[1];
    return !!name && !!s.extCommands?.has(name);
  }

  /**
   * Compaction ended: send the messages that waited for it, in order. If pi retries the run
   * (after an overflow), queue them into that run; else the first one starts a new run.
   * Messages that pi refuses go back into the input box. Returns true if a run follows.
   */
  private async flushCompactionQueue(s: Session, willRetry: boolean): Promise<boolean> {
    const held = s.compactionQueue ?? [];
    s.compactionQueue = undefined;
    if (!held.length) return willRetry;
    let runFollows = willRetry;
    s.queueBusy = true;
    let i = 0;
    try {
      for (; i < held.length; i++) {
        const x = held[i];
        if (willRetry && !this.isExtensionCommand(s, x.text)) {
          await this.sendPrompt(s, x, { type: x.mode === "steer" ? "steer" : "follow_up", message: x.text, ...(x.images?.length ? { images: x.images } : {}) });
        } else if ((await this.sendPrompt(s, x))?.disposition !== "handled") runFollows = true;
      }
    } catch (err: any) {
      if (s === this.active) {
        this.post({ type: "error", message: `Could not send the queued message: ${err.message ?? String(err)}` });
        this.restoreQueue(held.slice(i));
      } else this.output.appendLine(`[pi] could not send messages queued during compaction: ${err.message ?? String(err)}`);
    } finally {
      s.queueBusy = false;
      this.showQueue(s);
    }
    return runFollows;
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

  /** Attach files. Images pi supports go as image content; other files go as "@path" references. */
  private async pickAttachments() {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Attach", defaultUri: vscode.Uri.file(this.cwd) });
    for (const uri of uris ?? []) {
      const name = path.basename(uri.fsPath);
      const mimeType = IMAGE_MIME[path.extname(uri.fsPath).slice(1).toLowerCase()];
      if (!mimeType) {
        this.post({ type: "addFile", ref: this.fileRef(uri.fsPath), name });
        continue;
      }
      const data = (await vscode.workspace.fs.readFile(uri)) as Uint8Array;
      this.post({ type: "addImage", image: { type: "image", data: Buffer.from(data).toString("base64"), mimeType }, name });
    }
  }

  /**
   * A pasted or dropped file has no path in the webview. Save a copy in a temp
   * folder on the extension host (where pi runs) and attach that path.
   */
  private async saveAttachment(name: string, data: string) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-vscode-attach-"));
    const file = path.join(dir, path.basename(name || "file"));
    await fs.promises.writeFile(file, Buffer.from(data ?? "", "base64"));
    this.post({ type: "addFile", ref: file, name: path.basename(file) });
  }

  /** Path relative to the session cwd when the file is inside it, else absolute. */
  private fileRef(file: string) {
    const rel = path.relative(this.cwd, file);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
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

  insertText(text: string) {
    this.host.reveal();
    this.post({ type: "insertText", text });
  }

  // ---------------------------------------------------------------- builtins

  async runBuiltin(name: string, arg: string) {
    // The TUI owns the session file while it is open in the terminal.
    if (name === "name" && this.terminal) throw new Error("This session is open in the terminal. Rename it there, or reattach first.");
    if (!this.pi?.running && name !== "restart") await this.start();
    switch (name) {
      case "new": {
        this.assertNoTerminal();
        // The spare process has a new session ready: show it, and park the session that was shown.
        const spare = this.spare;
        if (spare?.pi.running && spare.state.sessionFile) {
          this.spare = undefined;
          await this.showProcess(spare);
          break;
        }
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
      case "title":
        // The bridge asks the title model and names the session; pi reports the name (session_info_changed).
        vscode.window.setStatusBarMessage("Pi: writing a session title…", 4000);
        await this.req({ type: "prompt", message: "/vscode:title" });
        break;
      case "name": {
        const value = this.state.sessionName || this.active?.webTitle || "";
        const name = (arg || (await vscode.window.showInputBox({ title: "Rename Session", prompt: "Session name", value })))?.trim();
        if (name && name !== this.state.sessionName) await this.req({ type: "set_session_name", name });
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
        else if (pick === "Reveal") openDirectory(vscode.Uri.file(path.dirname(r.path)), uri);
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
  /** User prompts in the tree that the navigator shows. */
  private treePrompts = new Set<string>();

  /**
   * Open the session tree (the TUI's /tree). Sends a slimmed-down tree: one
   * node per entry with a kind, a one-line preview, label and children, so the
   * webview never receives full tool outputs.
   */
  async openTree(query = "", selectId?: string, refresh = false) {
    const { tree, leafId } = await this.req({ type: "get_tree" });
    const { nodes, texts } = slimTree(tree);
    this.treeTexts = texts;
    this.treePrompts = new Set(nodes.filter((n) => n.kind === "user").map((n) => n.id));
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

  /**
   * Start a new session from entry `id` (pi's fork). The old session file does not change.
   * Like "Go", a user prompt is left out and put back in the composer.
   */
  private async treeFork(id: string) {
    if (this.state.isStreaming) {
      this.post({ type: "error", message: "Wait for the current response to finish before you start a new session." });
      return;
    }
    const prompt = this.treePrompts.has(id);
    const text = prompt ? this.treeTexts.get(id) : undefined;
    const before = this.state.sessionFile;
    this.post({ type: "treeBusy", text: "Starting a new session…" });
    try {
      await this.req({ type: "prompt", message: `/vscode:fork ${JSON.stringify({ entryId: id, position: prompt ? "before" : "at" })}` });
    } finally {
      this.post({ type: "treeBusy", text: "" });
    }
    await this.sendInit("reset");
    if (text && this.state.sessionFile !== before) this.post({ type: "insertText", text, replace: true });
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

  /**
   * Rename the session `id` (a session file or a background session key) from the session list.
   * A session that a pi process has open is renamed through that process, so the process keeps
   * the name and no second writer touches its file. Otherwise the name is appended to the file,
   * the same as a rename in the pi TUI's /resume list.
   */
  private async renameSession(id: string, name: string) {
    name = name.replace(/[\r\n]+/g, " ").trim();
    if (!name) return;
    const bg = [...this.background].find((b) => this.sessionKey(b) === id);
    if (bg) {
      await bg.pi.request({ type: "set_session_name", name });
      return;
    }
    if (id.startsWith("bg:")) return;
    const file = path.resolve(id);
    for (const c of PiController.all) {
      const sessions = [c.active, ...c.background, ...c.warm].filter((x): x is Session => !!x?.state.sessionFile && path.resolve(x.state.sessionFile) === file);
      if (c.terminal && sessions.includes(c.active!)) throw new Error("This session is open in the terminal. Rename it there, or reattach first.");
      const live = sessions.find((x) => x.pi.running);
      if (live) {
        await live.pi.request({ type: "set_session_name", name });
        if (c === this && live === this.active) await this.refreshState();
        return;
      }
    }
    if ([...PiController.all].some((c) => c.filesInUse().has(file))) {
      throw new Error("This session is still running inside another session (for example as a subagent). Rename it when it finishes.");
    }
    await appendSessionName(file, name);
  }

  async pickSession(refresh = false) {
    const dir = this.state.sessionFile ? path.dirname(this.state.sessionFile) : defaultSessionDir(this.cwd);
    const listed = await listSessions(dir, 150);
    const archived = this.archivedSessions;
    const bgByFile = new Map([...this.background].filter((b) => b.state.sessionFile).map((b) => [path.resolve(b.state.sessionFile!), b]));
    const inUse = this.filesInUse();
    const current = this.state.sessionFile && path.resolve(this.state.sessionFile);
    const sessions = listed.filter((s) => s.messageCount > 0 || path.resolve(s.file) === current || bgByFile.has(path.resolve(s.file)));
    const msgs = (n?: number) => (n != null ? `${n} msg${n === 1 ? "" : "s"}` : "");
    // Background sessions that have no listed file yet (or no file at all) get a row of their own.
    const listedFiles = new Set(sessions.map((s) => path.resolve(s.file)));
    const unlisted = [...this.background].filter((b) => !b.state.sessionFile || !listedFiles.has(path.resolve(b.state.sessionFile))).map((b) => ({
      id: this.sessionKey(b),
      label: this.titleOf(b),
      name: b.state.sessionName,
      cols: [this.isBusy(b) ? "working" : "idle", ""],
      group: "Running in background",
      search: this.titleOf(b),
      running: this.isBusy(b),
      busy: true,
    }));
    // Split the nested list into trees (a root and its descendants), so a tree moves as one block.
    const trees: ReturnType<typeof nestSessions>[] = [];
    for (const e of nestSessions(sessions)) {
      if (!e.depth || !trees.length) trees.push([]);
      trees[trees.length - 1].push(e);
    }
    const rank = (t: ReturnType<typeof nestSessions>) =>
      t.some((e) => path.resolve(e.s.file) === current) ? 0 : t.some((e) => bgByFile.has(path.resolve(e.s.file))) ? 1 : 2;
    // The tree with the current session comes first, then trees with background sessions, then the rest by date.
    const ordered = trees.map((t, i) => ({ t, i, r: rank(t) })).sort((a, b) => a.r - b.r || a.i - b.i);
    // Rows are keyed by sessionKey() for background sessions, so parent links must use the same ids.
    const idOf = (f: string) => {
      const b = bgByFile.get(path.resolve(f));
      return b ? this.sessionKey(b) : f;
    };
    const treeItems = ordered.flatMap(({ t, r }) => t.map(({ s, depth, parent, latest }) => {
      const file = path.resolve(s.file);
      const b = bgByFile.get(file);
      const isCurrent = file === current;
      const elsewhere = !isCurrent && !b && !!PiController.ownerOf(file, this);
      return {
        id: idOf(s.file),
        label: s.name || b?.state.sessionName || b?.webTitle || s.firstMessage?.split("\n")[0].slice(0, 200) || "(empty session)",
        name: b ? b.state.sessionName : s.name,
        cols: [b ? (this.isBusy(b) ? "working" : "idle") : elsewhere ? "other chat" : relativeTime(s.mtime), msgs(s.messageCount)],
        group: r === 0 ? "Current session" : r === 1 ? "Running in background" : dayGroup(latest),
        search: [s.name, b && this.titleOf(b), s.firstMessage?.slice(0, 500)].filter(Boolean).join(" "),
        current: isCurrent,
        archived: !isCurrent && !b && !elsewhere && archived.has(s.file),
        elsewhere: elsewhere || undefined,
        running: (isCurrent && !!this.state.isStreaming) || (!!b && this.isBusy(b)) || inUse.has(file),
        busy: !!b || undefined,
        parent: parent && idOf(parent),
        depth,
      };
    }));
    const split = treeItems.findIndex((it) => it.group !== "Current session");
    const head = split < 0 ? treeItems : treeItems.slice(0, split);
    const tail = split < 0 ? [] : treeItems.slice(split);
    this.host.reveal();
    this.post({
      type: "openList",
      kind: "session",
      placeholder: "Resume a Pi session",
      empty: "No previous sessions for this folder",
      items: [...head, ...unlisted, ...tail],
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
    // pi switches this process to another tab now (a quick click there and back): let the switch end
    // without its snapshot, then open from the session that pi has then.
    let waited = false;
    if (this.switching) {
      const gen = ++this.openGen;
      this.pendingKey = id;
      await this.switching.catch(() => {});
      if (gen !== this.openGen) return;
      this.pendingKey = undefined;
      waited = true;
    }
    const bg = [...this.background, ...this.warm].find((b) => this.sessionKey(b) === id);
    if (bg) return this.showProcess(bg);
    if (id === this.state.sessionFile && this.pi?.running) return waited ? this.sendInit("reset") : undefined;
    if (id.startsWith("bg:")) return; // a background session without a file that has since gone away
    const unwritten = this.tabs.find((t) => t.key === id && t.id && !fs.existsSync(id));
    if (unwritten) return this.start(undefined, unwritten.id, { keepRunning: true });
    const owner = PiController.ownerOf(id, this);
    if (owner) return owner.showSession(id);
    // Another pi process must not write to a file that a running child session (a subagent) writes to.
    if (this.filesInUse().has(path.resolve(id))) {
      vscode.window.showWarningMessage("Pi: this session is still running inside another session (for example as a subagent). Open it when it finishes.");
      return;
    }
    if (!this.pi?.running) return this.start(id);
    // A process in the daemon works on this session without a window. A start of the file gets that
    // process; a switch of this process to the file would make a second writer.
    if (!this.isRunning && daemonOptions(this.context)) {
      const gen = ++this.openGen;
      this.pendingKey = id;
      const detached = await detachedFiles(this.context);
      if (gen !== this.openGen) return;
      this.pendingKey = undefined;
      if (detached.has(path.resolve(id))) return this.start(id, undefined, { keepRunning: true });
    }
    // switch_session would end the extensions' work (session_shutdown), so a busy process gets replaced instead.
    if (this.isRunning) return this.start(id, undefined, { keepRunning: true });
    // A tab that has no process yet: switch this process to it. The tab left behind gets a process
    // again later (prewarm), so that switching back is quick.
    this.pendingKey = id;
    const gen = ++this.openGen;
    const s = this.active;
    const sw = this.req({ type: "switch_session", sessionPath: id });
    this.switching = sw;
    let r: any;
    try {
      r = await sw;
    } finally {
      if (this.switching === sw) this.switching = undefined;
    }
    // The process has this session now, also when a newer open skips its snapshot (it may be parked).
    // Until pi reports it, the tab's own title stands for the session, so the tab keeps its title.
    if (s && !r?.cancelled) {
      const title = this.tabs.find((t) => t.key === id)?.title;
      s.state = { ...s.state, sessionFile: id, sessionName: undefined };
      s.webTitle = title && !PiController.NO_TITLE.has(title) ? title : undefined;
    }
    // A newer open, or a close of this tab, came while pi switched: it shows the next session.
    if (gen !== this.openGen) {
      if (s && s !== this.active && !r?.cancelled) void s.pi.request({ type: "get_state" }).then((st: any) => {
        this.setSessionState(s, st);
        this.syncTabs();
      }, () => {});
      return;
    }
    if (r?.cancelled) this.pendingKey = undefined;
    await this.sendInit("reset");
  }

  /** Open the session file in a new chat tab beside this chat, or show the chat that has it open. */
  private async openBeside(id: string) {
    if (id.startsWith("bg:")) return;
    const owner = PiController.ownerOf(id);
    if (owner) return owner.showSession(id);
    if (this.filesInUse().has(path.resolve(id))) {
      vscode.window.showWarningMessage("Pi: this session is still running inside another session (for example as a subagent). Open it when it finishes.");
      return;
    }
    this.host.openBeside?.(id);
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

  private disposed = false;

  /**
   * Close the chat. `stop`: the user closed it and agreed to stop its work. Else (the window closes,
   * VS Code shuts down) a session that works goes on in the session daemon, if the daemon is in use.
   */
  dispose(stop = false) {
    // Before the chat leaves the list: `isBusy` asks the modules.
    const leave = (s: Session) => (!stop && this.isBusy(s) ? s.pi.detach(true) : s.pi.stop());
    if (PiController.restAdopter === this) PiController.restAdopter = undefined;
    this.disposed = true;
    clearTimeout(this.prewarmTimer);
    for (const s of this.warm) s.pi.stop();
    this.warm = [];
    this.spare?.pi.stop();
    this.spare = undefined;
    PiController.all.delete(this);
    this.terminal = undefined; // leave a user's terminal session running
    if (this.active) leave(this.active);
    this.active = undefined;
    for (const s of this.background) leave(s);
    this.background.clear();
    for (const d of this.disposables) d.dispose();
    PiController.updateSharedStatus();
  }
}
