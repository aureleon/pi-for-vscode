import type { HostIntegration, PiCommand } from "../../src/integrations";

/** pi-subagents is loaded: one of its commands comes from the package. */
export function hasPiSubagents(commands: PiCommand[]): boolean {
  return commands.some((c) => c.source === "extension" && /pi-subagents/.test(`${c.sourceInfo?.source ?? ""} ${c.sourceInfo?.path ?? ""}`));
}

/**
 * Host side of the pi-subagents integration. Its `fleet` widget is the ↑↓/Enter agent picker
 * below the editor. It reads keys with `onTerminalInput` and opens a TUI overlay, and RPC mode
 * has neither, so the chat would show a dead menu next to the `agents` widget, which has the
 * same rows. The integration hides it.
 */
export const subagentsHost: HostIntegration = {
  id: "pi-subagents",
  matches: hasPiSubagents,
  hiddenWidgets: ["fleet"],
  create: () => ({}),
};
