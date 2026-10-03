/**
 * pi-side bridge loaded by the VS Code extension with `pi --mode rpc -e <this file>`.
 *
 * RPC mode has no command for moving within the session tree (the TUI's /tree),
 * but extension command contexts get `ctx.navigateTree()` in every mode. This
 * bridge exposes that (plus entry labels) as hidden slash commands whose argument
 * is a JSON payload. The VS Code webview hides `vscode:*` commands from autocomplete.
 *
 * It also works around extension behaviour that breaks in RPC hosts (each one is
 * also drafted as an upstream PR; remove the workaround when that lands):
 *  - factory widgets (`ctx.ui.setWidget(key, (tui, theme) => component)`) are dropped
 *    by RPC mode. The bridge renders them to text lines (see `RpcWidgetHost`).
 *  - pi-btw queues its display-only note as a follow-up that starts a model turn with
 *    no new user message (see `patchBtwFollowUp`).
 *
 * And it reports work that RPC events do not show: agent sessions that extensions run in
 * this process, such as subagents (see `trackChildRuns`). The host keeps such a process.
 *
 * Kept dependency-free: only the few API shapes used here are typed locally.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface NavigateOptions {
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

type WidgetPlacement = "aboveEditor" | "belowEditor";
interface WidgetOptions { placement?: WidgetPlacement }
interface WidgetComponent { render(width: number): string[]; invalidate?(): void; dispose?(): void }
type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;

interface UiContext {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: WidgetOptions): void;
  setStatus(key: string, text: string | undefined): void;
  theme?: unknown;
}

interface EventContext {
  ui: UiContext;
  sessionManager?: unknown;
  mode?: string;
  hasUI?: boolean;
}

interface CommandContext extends EventContext {
  navigateTree(targetId: string, options?: NavigateOptions): Promise<{ cancelled: boolean }>;
  isIdle(): boolean;
}

interface PiApi {
  registerCommand(name: string, spec: { description?: string; handler: (args: string, ctx: CommandContext) => Promise<void> }): void;
  setLabel(entryId: string, label: string | undefined): void;
  on(event: string, handler: (event: any, ctx: EventContext) => unknown): void;
}

function parse<T>(args: string): T {
  try {
    return JSON.parse(args) as T;
  } catch {
    throw new Error("vscode bridge: invalid JSON payload");
  }
}

// ------------------------------------------------------------------ factory widgets

/** Same cap as interactive mode uses for `string[]` widgets, raised a little: factory widgets are not capped in the TUI. */
const MAX_WIDGET_LINES = 25;
/** Spinners call requestRender() every ~80 ms; the webview does not need more than a few frames a second. */
const RENDER_THROTTLE_MS = 250;
const DEFAULT_COLUMNS = 80;

/**
 * Factory widgets that are only a key-driven menu (they read `onTerminalInput`, which RPC mode does
 * not have). They are not sent, because another widget already shows the same data:
 *  - `fleet` (pi-subagents): the ↑↓/Enter agent picker below the editor. The `agents` widget shows the same rows.
 */
const TERMINAL_ONLY_WIDGETS = new Set(["fleet"]);

/** Marks a UI context whose setWidget the bridge already wrapped (pi makes a new one on rebind). */
const PATCHED = Symbol.for("pi-vscode.widgetHost");

/**
 * Renders factory widgets to text lines and sends them with the original `setWidget`, which RPC
 * mode forwards as `widgetLines`. The stub TUI has only what widget extensions use in practice:
 * `requestRender()` and `terminal.columns/rows`.
 */
class RpcWidgetHost {
  private widgets = new Map<string, { component: WidgetComponent; options?: WidgetOptions; last?: string }>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly tui: { terminal: { columns: number; rows: number }; requestRender: (force?: boolean) => void };

  constructor(private send: UiContext["setWidget"], private theme: () => unknown, columns: number) {
    this.tui = { terminal: { columns, rows: 40 }, requestRender: () => this.schedule() };
  }

  set(key: string, factory: WidgetFactory, options?: WidgetOptions) {
    this.drop(key);
    let component: WidgetComponent;
    try {
      component = factory(this.tui, this.theme());
    } catch (err) {
      console.error(`[pi-vscode] widget "${key}" factory failed:`, err);
      return;
    }
    this.widgets.set(key, { component, options });
    this.render(key);
  }

  /** Forget a factory widget because the extension replaced or cleared it. */
  drop(key: string) {
    const w = this.widgets.get(key);
    if (!w) return;
    this.widgets.delete(key);
    try {
      w.component.dispose?.();
    } catch {
      /* ignore */
    }
  }

  setColumns(columns: number) {
    if (columns === this.tui.terminal.columns) return;
    this.tui.terminal.columns = columns;
    for (const w of this.widgets.values()) w.component.invalidate?.();
    this.schedule();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const key of [...this.widgets.keys()]) this.drop(key);
  }

  private render(key: string) {
    const w = this.widgets.get(key);
    if (!w) return;
    let lines: string[];
    try {
      lines = w.component.render(this.tui.terminal.columns);
    } catch (err) {
      console.error(`[pi-vscode] widget "${key}" render failed:`, err);
      return;
    }
    if (lines.length > MAX_WIDGET_LINES) lines = [...lines.slice(0, MAX_WIDGET_LINES), "... (widget truncated)"];
    const sig = lines.join("\n");
    if (sig === w.last) return;
    w.last = sig;
    this.send(key, lines.length ? lines : undefined, w.options);
  }

  private schedule() {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      for (const key of [...this.widgets.keys()]) this.render(key);
    }, RENDER_THROTTLE_MS);
  }
}

let widgetHost: RpcWidgetHost | undefined;
let widgetColumns = Math.max(20, Number(process.env.PI_VSCODE_WIDGET_COLUMNS) || DEFAULT_COLUMNS);

/**
 * The RPC host's own session. Extensions can load the bridge into child sessions too (subagents);
 * those have no UI (`hasUI` false) and must not take over the shared state.
 */
const isRpcHost = (ctx: EventContext) => ctx.mode === "rpc" || (ctx.mode === undefined && ctx.hasUI === true);

/**
 * All extensions share one UI context object, so wrapping its `setWidget` once covers every
 * extension. The bridge loads first (`-e` paths come before installed ones), so this runs before
 * other extensions register widgets in their own session_start handlers.
 */
function installWidgetHost(ctx: EventContext) {
  if (!isRpcHost(ctx)) return;
  const ui = ctx.ui as UiContext & { [PATCHED]?: RpcWidgetHost };
  if (!ui || typeof ui.setWidget !== "function") return;
  if (ui[PATCHED]) {
    widgetHost = ui[PATCHED];
    widgetHost.setColumns(widgetColumns);
    return;
  }
  widgetHost?.dispose();
  const original = ui.setWidget.bind(ui);
  const host = new RpcWidgetHost(original, () => ui.theme, widgetColumns);
  ui.setWidget = (key, content, options) => {
    if (typeof content === "function") return TERMINAL_ONLY_WIDGETS.has(key) ? undefined : host.set(key, content, options);
    host.drop(key);
    original(key, content, options);
  };
  ui[PATCHED] = host;
  widgetHost = host;
}

// ------------------------------------------------------------------ pi-btw follow-up

const BTW_NOTE_TYPE = "btw-note";
/** Marks the AgentSession prototype as patched, so a reloaded bridge does not wrap it twice. */
const BTW_PATCHED = Symbol.for("pi-vscode.btwFollowUp");

/**
 * pi-btw (0.7.1) queues its display-only `btw-note` with `deliverAs: "followUp"` while the main
 * agent runs. pi then starts a model turn for it, and pi-btw's own context hook removes the note,
 * so the request ends with an assistant message. Providers without assistant prefill reject it.
 * Force `triggerTurn: false`: pi then appends the note at the end of the turn with no model call.
 */
function patchBtwFollowUp(mod: any) {
  const proto = mod?.AgentSession?.prototype;
  if (!proto || typeof proto.sendCustomMessage !== "function" || proto[BTW_PATCHED]) return;
  const original = proto.sendCustomMessage;
  proto.sendCustomMessage = function (this: unknown, message: any, options?: any) {
    if (message?.customType === BTW_NOTE_TYPE && options?.deliverAs === "followUp" && options.triggerTurn === undefined) {
      options = { ...options, triggerTurn: false };
    }
    return original.call(this, message, options);
  };
  proto[BTW_PATCHED] = true;
}

// ------------------------------------------------------------------ child runs

/** Status key the host reads (and does not show): `{ count, files }` of running child sessions. */
const WORK_KEY = "vscode:work";
const RUNS_PATCHED = Symbol.for("pi-vscode.childRuns");

/** Shared on globalThis, so a bridge loaded again by /reload keeps counting the same runs. */
interface RunState {
  runs: Map<any, number>;
  main?: unknown;
  ui?: UiContext;
  last?: string;
}
const runState: RunState = ((globalThis as any)[RUNS_PATCHED] ??= { runs: new Map() });

/**
 * Extensions run their own AgentSessions in this process (subagents, side threads). RPC events
 * only describe the main session, so the host saw the process as idle while they worked, and
 * stopped it on a session switch. Count prompts that are in flight on other AgentSessions
 * and report them, with their session files, through a hidden status.
 */
function trackChildRuns(mod: any) {
  const proto = mod?.AgentSession?.prototype;
  if (!proto || typeof proto.prompt !== "function" || proto[RUNS_PATCHED]) return;
  const original = proto.prompt;
  proto.prompt = async function (this: any, ...args: unknown[]) {
    runState.runs.set(this, (runState.runs.get(this) ?? 0) + 1);
    reportChildRuns();
    try {
      return await original.apply(this, args);
    } finally {
      const n = (runState.runs.get(this) ?? 1) - 1;
      if (n > 0) runState.runs.set(this, n);
      else runState.runs.delete(this);
      reportChildRuns();
    }
  };
  proto[RUNS_PATCHED] = true;
}

function reportChildRuns() {
  let count = 0;
  const files: string[] = [];
  for (const session of runState.runs.keys()) {
    if (!runState.main || session.sessionManager === runState.main) continue;
    count++;
    try {
      const file = session.sessionFile;
      if (typeof file === "string" && file) files.push(file);
    } catch {
      /* ignore */
    }
  }
  const text = count ? JSON.stringify({ count, files }) : undefined;
  if (text === runState.last) return;
  runState.last = text;
  try {
    runState.ui?.setStatus(WORK_KEY, text);
  } catch {
    /* the UI context may be stale after a session switch */
  }
}

// ------------------------------------------------------------------ pi module

/**
 * A plain `import("@earendil-works/pi-coding-agent")` does not resolve from this file. pi's own
 * entry (`dist/.../cli.js`) sits next to `index.js`, and importing that file URL gives the same
 * module instance that the running session uses. Undefined when pi runs some other way.
 */
async function loadPiModule(): Promise<any> {
  try {
    const cli = process.argv[1] ? realpathSync(process.argv[1]) : "";
    if (!/cli\.[cm]?js$/.test(cli)) return undefined;
    return await import(new URL("./index.js", pathToFileURL(cli)).href);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ commands

export default function piVscodeBridge(pi: PiApi) {
  void loadPiModule().then((mod) => {
    patchBtwFollowUp(mod);
    trackChildRuns(mod);
  });

  pi.on("session_start", (_e, ctx) => {
    if (!isRpcHost(ctx)) return;
    installWidgetHost(ctx);
    runState.main = ctx.sessionManager;
    runState.ui = ctx.ui;
    runState.last = undefined;
    reportChildRuns();
  });
  // Drop the old session's widgets; the wrapper stays on the UI context in case pi reuses it.
  pi.on("session_shutdown", () => widgetHost?.dispose());

  pi.registerCommand("vscode:widget-columns", {
    description: "(VS Code) Set the width that factory widgets render at",
    handler: async (args) => {
      const p = parse<{ columns: number }>(args);
      const columns = Math.round(Number(p.columns));
      if (!Number.isFinite(columns) || columns < 20) return;
      widgetColumns = columns;
      widgetHost?.setColumns(columns);
    },
  });

  pi.registerCommand("vscode:tree", {
    description: "(VS Code) Navigate the session tree",
    handler: async (args, ctx) => {
      const p = parse<{ targetId: string } & NavigateOptions>(args);
      try {
        if (!ctx.isIdle()) throw new Error("Wait for the current response to finish before navigating the session tree.");
        const r = await ctx.navigateTree(p.targetId, {
          summarize: !!p.summarize,
          customInstructions: p.customInstructions || undefined,
          replaceInstructions: p.replaceInstructions,
          label: p.label || undefined,
        });
        if (r.cancelled) ctx.ui.notify("Tree navigation was cancelled.", "warning");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  pi.registerCommand("vscode:label", {
    description: "(VS Code) Set or clear a label on a session entry",
    handler: async (args, ctx) => {
      const p = parse<{ entryId: string; label?: string }>(args);
      try {
        pi.setLabel(p.entryId, p.label?.trim() || undefined);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
