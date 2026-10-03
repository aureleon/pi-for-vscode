# pi-subagents integration

Support for [pi-subagents](https://www.npmjs.com/package/@strayge/pi-subagents), the pi extension that runs agents in the background.

## What it does

- Hides the `fleet` widget, the ↑↓/Enter agent picker below the editor. It needs terminal keys and a TUI overlay, which RPC mode does not have. The `agents` widget shows the same rows.

The core shows the rest without an integration: factory widgets such as the `agents` bars, and the subagent sessions that run inside the chat.

## Files

- `host.ts`: detection and the hidden widget.

## Notes

- The integration is active when an extension command comes from a package or path that contains `pi-subagents`.
- It has no webview side.
