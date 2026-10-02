import type { ExtSession, HostIntegration } from "../../src/integrations";

/** The command that `pi.ts` registers. */
const COMMAND = "vscode:widget-columns";

/**
 * Host side of the factory-widgets workaround: tells `pi.ts` how wide the widget box is, so the
 * rendered lines fit the view. A new process gets the width in `PI_VSCODE_WIDGET_COLUMNS`; a
 * running one gets the hidden `/vscode:widget-columns` command when the view is resized.
 */
export const factoryWidgetsHost: HostIntegration = {
  id: "factory-widgets",
  piExtension: "workarounds/factory-widgets.mjs",
  create(api) {
    /** Widget width in characters, measured by the webview. */
    let columns: number | undefined;
    /** For each process: the width it renders at, and whether `pi.ts` is loaded (seen in `get_commands`). */
    const sessions = new WeakMap<ExtSession, { columns?: number; canSet: boolean }>();
    let shown: ExtSession | undefined;

    /**
     * Tell `s` the width. Only when its commands show `pi.ts`: an unknown slash command would
     * go to the model as a prompt.
     */
    const sync = (s: ExtSession | undefined) => {
      const st = s && sessions.get(s);
      if (!s || !st || !columns || st.columns === columns || !st.canSet || !s.running) return;
      st.columns = columns;
      s.request({ type: "prompt", message: `/${COMMAND} ${JSON.stringify({ columns })}` }).catch(() => {});
    };

    let envColumns: number | undefined;
    return {
      env() {
        envColumns = columns;
        return columns ? { PI_VSCODE_WIDGET_COLUMNS: String(columns) } : {};
      },
      onCommands(s, commands) {
        // The process started with the width of the last env() call.
        const st = sessions.get(s) ?? { columns: envColumns, canSet: false };
        st.canSet = commands.some((c) => c?.name === COMMAND);
        sessions.set(s, st);
        sync(s);
      },
      onShown(s) {
        shown = s;
      },
      onMessage(m) {
        if (m?.op !== "columns") return;
        columns = Math.max(20, Math.round(Number(m.columns) || 0)) || undefined;
        sync(shown);
      },
    };
  },
};
