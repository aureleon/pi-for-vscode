import type { HostIntegration, PiCommand } from "../../src/integrations";

/** pi-subagents is loaded: one of its commands comes from the package. */
export function hasPiSubagents(commands: PiCommand[]): boolean {
  return commands.some((c) => c.source === "extension" && /pi-subagents/.test(`${c.sourceInfo?.source ?? ""} ${c.sourceInfo?.path ?? ""}`));
}

/**
 * The `agents` widget shows times under a minute in tenths (`12.3s`). pi re-renders it often, so the
 * counter flickers. Show whole seconds (`12s`), like the longer times (`1m05s`).
 */
const TENTHS = /(?<![\d.])(\d+)\.\ds\b/g;

/**
 * Host side of the pi-subagents integration. Its `fleet` widget is the ↑↓/Enter agent picker
 * below the editor. It reads keys with `onTerminalInput` and opens a TUI overlay, and RPC mode
 * has neither, so the chat would show a dead menu next to the `agents` widget, which has the
 * same rows. The integration hides it, and rounds the times in the `agents` widget to seconds.
 */
export const subagentsHost: HostIntegration = {
  id: "pi-subagents",
  matches: hasPiSubagents,
  hiddenWidgets: ["fleet"],
  create: () => ({
    onWidget: (_s, key, lines) => (key === "agents" ? lines.map((l) => l.replace(TENTHS, "$1s")) : undefined),
  }),
};
