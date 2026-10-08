# pi-btw integration

Support for [pi-btw](https://github.com/dbachelder/pi-btw), the pi extension for side conversations (`/btw`).

In Pi's TUI, pi-btw opens an overlay composer. In RPC mode it cannot open it. This integration shows a side panel next to the chat instead.

## What it does

- `/btw`, `/side`, `/btw:new`, `/btw:tangent` and `/btw:ask` open the side panel. With text, they also send it.
- Follow-ups typed in the panel go to the command of the thread's mode.
- Inject, Summarize and Clear in the panel header run `/btw:inject`, `/btw:summarize` and `/btw:clear`. Text in the panel's input box is sent as instructions.
- The thread fills from pi-btw's session entries (`btw-thread-entry`, `btw-thread-reset`). It is restored after a reload or a session switch.
- `btw-note` messages show in the main transcript as a link to the panel.
- Notices of panel commands show in the panel, not as VS Code notifications.
- A toggle button shows when the session loads pi-btw. It shows the number of unread side-thread answers, and so does the Pi view badge.

## Files

- `profile.ts`: pi-btw's commands, modes, actions, entry types and notice texts.
- `host.ts`: runs panel commands in pi and filters their notices.
- `web.ts`: the toggle button, the badge and the transcript links.
- `sidePanel.ts`: the panel.
- `styles.css`: styles of the panel, the button and the links.

## Notes

- The integration is active when the session has the extension commands `/btw` and `/btw:inject`.
- The panel sends each command as a normal prompt. pi responds when the command is done, so the response marks the end of a side request.
