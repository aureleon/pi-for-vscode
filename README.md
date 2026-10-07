# Pi for VS Code

Use the [Pi coding agent](https://pi.dev) in the VS Code sidebar, in a UI like Claude Code for VS Code.

The extension starts your installed `pi` in RPC mode (`pi --mode rpc`) in the workspace folder. Your Pi setup applies without changes: settings, models, auth, **extensions**, skills, prompt templates, MCP adapters, and sessions.

## Features

### Chat
- Replies, thinking and tool calls stream in as a timeline. Tool cards show input and output, and edits show a diff.
- Tool calls that a tool makes (for example from codemode or a subagent tool) show under that tool's card.
- Cards of extension tools also show the tool's `details` (DATA), including partial results while the tool runs.
- Markdown renders in replies and in your sent prompts. It is also styled live as you type.
- While Pi works: <kbd>Enter</kbd> steers, <kbd>⌥ Enter</kbd> queues a follow-up, <kbd>Esc</kbd> stops.
- Queued messages show at the end of the chat. Drag to reorder them, or remove or send one now.
- `/` for commands, `@` for file paths, `!cmd` for shell commands. Paste or drop images.
- The context pill shows how full the context is. Click it to compact.
- A π with a count shows next to the context pill while sessions run inside the chat (for example subagents or workflow agents). Click it to see them.

### Models
- The model menu lists the models in Pi's `enabledModels`, or all models if the setting is empty.
- The effort (thinking level) slider is at the bottom of the same menu.

### Sessions
- Resume or fork from a searchable list. Archive a session to hide it from the list.
- Forks and sessions that extensions start (for example subagents) are nested under the session they came from. They are collapsed until you expand them.
- Sessions run in parallel. If you start a new session or open another one while Pi works, the busy session continues in the background. It shows at the top of the session list, and a notification tells you when it finishes or needs an answer.
- *View* (the eye button in the session list, or *Pi: View Session File*) opens a session read-only in a new tab. It starts no pi process and shows new messages as pi writes them. Use it to follow a session that an extension runs, for example a subagent.
- `/tree` moves between branches of a session. It can summarize the branch you leave and label entries.
- The last session reopens automatically. *Open in New Tab* starts another chat.

### Pi extensions
- Extension commands, dialogs, notifications, status text and widgets work in the chat. Minimize a widget to its first line with its chevron button.
- The core uses only pi's RPC protocol. Support for one pi extension is a separate integration in `integrations/`.
- **pi-btw:** `/btw` and the other pi-btw commands open a side panel next to the chat. The panel shows the side thread, restores it from the session, and has Inject, Summarize and Clear buttons. A toggle button shows when the session loads pi-btw. See [integrations/pi-btw](integrations/pi-btw/README.md).

### Terminal
- *Pi: Open in Terminal* starts a new pi TUI session.
- *Continue Session in Terminal* moves the current session into the TUI. The chat pauses and picks the session back up when you close the terminal.

### Editor
- <kbd>⌘⌥L</kbd> adds the selection to the chat. The Explorer context menu adds a file.
- Click a file path in the chat to open it.

## Notes

- **Nested sessions** use the `parentSession` field of the session header, the same as pi's `/resume`. A session whose parent is not in the list shows at the top level.
- **Nested tool calls** come from `parentToolCallId` on `tool_execution_*` events. After a reload, pi keeps only a record of them (`nestedCalls`: names, arguments, status, errors), so their outputs are not shown.
- **The session viewer** reads the session file and checks it for changes every second. It shows the branch of the last entry in the file.
- **Archived sessions** stay on disk. Only the list in VS Code hides them, so the pi TUI can still resume them.
- **`/tree`** needs a command that RPC mode does not have. The extension adds it by loading a small bridge extension into pi (`dist/pi-bridge.mjs`).
- **Queue edits** take the whole queue out of pi and queue it again, because RPC mode can only add to the queue or clear it. Images in queued messages are not kept. **Send now** stops the run and sends the message as the next run.
- **Factory widgets** (for example todo lists and agent bars) are dropped by RPC mode. A workaround renders them to text lines at the width of the chat view and sends them again when they change (at most 4 times a second).
- **Running child sessions** are not in RPC events. A workaround counts the prompts that run on other agent sessions in the process and reports them, with their session files, in a hidden status. The titles come from the session files. Sessions that an extension keeps only in memory have no title. pi-btw side threads also count while they answer.
- **Terminal hand-off** stops the chat's pi process while the terminal has the session, so that two processes never write to the same file.
- **Integrations** add support for one pi extension beyond pi's RPC protocol. Each one is in `integrations/<name>/`, and `integrations/host.ts` and `integrations/web.ts` list them. An integration is active only in sessions that load its pi extension. It can also load a small pi extension of its own (`integrations/<name>/pi.ts`), for example the pi-btw workaround for notes that arrive during a run. See [integrations/README.md](integrations/README.md).
- **Workarounds** fill gaps in pi's RPC mode for every extension, for example factory widgets and running child sessions. Each one is in `workarounds/<name>/` and loads its own small pi extension. The child-runs workaround uses pi internals; if a pi update breaks one, turn it off with `pi.workarounds`. See [workarounds/README.md](workarounds/README.md).

## Built-in slash commands

These commands come from the pi TUI. The extension does them itself, because RPC mode does not have them. `/new`, `/resume`, `/model`, `/thinking`, `/compact [instructions]`, `/name <name>`, `/fork`, `/clone`, `/session`, `/copy`, `/export [path]`, `/restart` (restarts pi and reloads extensions).

If an extension registers a command with the same name, the extension command runs.

## Requirements

- `pi` installed (`npm i -g @earendil-works/pi-coding-agent`) and set up (you ran `pi` once and logged in).
- VS Code 1.90 or later.

VS Code apps opened from the Dock often do not get your shell `PATH`. For this reason, the extension reads the environment of your login shell (mise, nvm, Homebrew, and exported API keys) before it starts pi. To turn this off, use `pi.useLoginShellEnv`, or set `pi.path` to the full path of `pi`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `pi.path` | `""` | Path to the `pi` executable. |
| `pi.args` | `[]` | More CLI arguments, for example `["--model", "sonnet"]`. |
| `pi.resumeLastSession` | `true` | Reopen the last session of the workspace. |
| `pi.useLoginShellEnv` | `true` | Load the environment of your login shell. |
| `pi.terminalLocation` | `"editor"` | Where terminals open: as an editor tab or in the terminal panel. |
| `pi.workarounds` | `{}` | Turn off a workaround for a gap in RPC mode, for example `{ "child-runs": false }`. All are on by default. |

Extensions can check `process.env.PI_VSCODE === "1"` to know that they run inside VS Code.

## Limitations (from RPC mode)

TUI-only extension APIs do not work in RPC mode. These are `ctx.ui.custom()`, custom editors, footers and headers, and `onTerminalInput`. Commands that open a composer or overlay in the TUI show their notice instead. See Pi's [RPC Extension UI docs](https://pi.dev) for more information. `/tree` works through the bridge extension, and factory widgets through a workaround. Widgets are read-only, but you can minimize them. The pi-subagents integration hides its fleet list (the agent picker below the editor), because its keys do nothing here. The agents widget shows the top-level agents, and the running-sessions count in the composer includes workflow agents. For everything else, open the session in the terminal.

## Development

```bash
npm install
npm run build        # or: npm run watch
npm run typecheck
npm run package      # creates pi-for-vscode-<version>.vsix
code --install-extension pi-for-vscode-0.2.0.vsix
```

To debug, press <kbd>F5</kbd> with `.vscode/launch.json` ("Run Extension"). Logs from pi's stderr go to the **Pi** output channel.
