# pi-subagents integration

Support for [pi-subagents](https://www.npmjs.com/package/@strayge/pi-subagents), the pi extension that runs agents in the background.

## What it does

- Hides the `fleet` widget, the ↑↓/Enter agent picker below the editor. It needs terminal keys and a TUI overlay, which RPC mode does not have. The `agents` widget shows the same rows.
- Shows the times in the `agents` widget in whole seconds (`12s`, not `12.3s`), so the counter changes once a second.
- Names agent sessions after their task, for example `Find auth code` instead of `general-purpose#1a2b3c4d`. The name shows in the list of running sessions and in the session history.

The core shows the rest without an integration: factory widgets such as the `agents` bars, and the subagent sessions that run inside the chat.

## Files

- `host.ts`: detection and the hidden widget.
- `pi.ts`: pi extension that renames agent sessions.

## Notes

- The integration is active when an extension command comes from a package or path that contains `pi-subagents`.
- It has no webview side.
- `pi.ts` listens to `subagents:started` and finds the session with the `Symbol.for("pi-subagents:manager")` registry. Both are public in pi-subagents. It replaces only the name that pi-subagents gave (`…#<id>`).
- Workflow children and nested agents send no `subagents:started` event, so they keep the `<type>#<id>` name.
- The new name is written to the session file, so the pi TUI (`/resume`) shows it too.
