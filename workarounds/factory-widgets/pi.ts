/**
 * Pi side of the factory-widgets workaround: a pi extension that the VS Code extension loads with
 * `pi --mode rpc -e dist/workarounds/factory-widgets.mjs`.
 *
 * Gap: RPC mode drops factory widgets (`ctx.ui.setWidget(key, (tui, theme) => component)`); it
 * forwards only `string[]` widgets. Extensions such as todo lists and agent bars use factories.
 * This extension renders them to text lines and sends them as `string[]` widgets.
 * Remove it when pi's RPC mode renders factory widgets itself.
 *
 * Kept dependency-free: only the few API shapes used here are typed locally.
 */

type WidgetPlacement = "aboveEditor" | "belowEditor";
interface WidgetOptions { placement?: WidgetPlacement }
interface WidgetComponent { render(width: number): string[]; invalidate?(): void; dispose?(): void }
type WidgetFactory = (tui: unknown, theme: unknown) => WidgetComponent;

interface UiContext {
  setWidget(key: string, content: string[] | WidgetFactory | undefined, options?: WidgetOptions): void;
  theme?: unknown;
}

interface EventContext {
  ui: UiContext;
  mode?: string;
  hasUI?: boolean;
}

interface PiApi {
  registerCommand(name: string, spec: { description?: string; handler: (args: string, ctx: EventContext) => Promise<void> }): void;
  on(event: string, handler: (event: any, ctx: EventContext) => unknown): void;
}

/** Same cap as interactive mode uses for `string[]` widgets, raised a little: factory widgets are not capped in the TUI. */
const MAX_WIDGET_LINES = 25;
/** Spinners call requestRender() every ~80 ms; the webview does not need more than a few frames a second. */
const RENDER_THROTTLE_MS = 250;
const DEFAULT_COLUMNS = 80;

/** Marks a UI context whose setWidget this extension already wrapped (pi makes a new one on rebind). */
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
 * The RPC host's own session. Extensions can load this extension into child sessions too
 * (subagents); those have no UI (`hasUI` false) and must not take over the shared state.
 */
const isRpcHost = (ctx: EventContext) => ctx.mode === "rpc" || (ctx.mode === undefined && ctx.hasUI === true);

/**
 * All extensions share one UI context object, so wrapping its `setWidget` once covers every
 * extension. This extension loads before installed ones (`-e` paths come first), so this runs
 * before other extensions register widgets in their own session_start handlers.
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
    if (typeof content === "function") return host.set(key, content, options);
    host.drop(key);
    original(key, content, options);
  };
  ui[PATCHED] = host;
  widgetHost = host;
}

function parse<T>(args: string): T {
  try {
    return JSON.parse(args) as T;
  } catch {
    throw new Error("factory widgets: invalid JSON payload");
  }
}

export default function factoryWidgets(pi: PiApi) {
  pi.on("session_start", (_e, ctx) => installWidgetHost(ctx));
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
}
