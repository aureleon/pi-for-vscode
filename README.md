# Pi for VS Code

Use the [Pi coding agent](https://pi.dev) in the VS Code sidebar, in a UI like Claude Code for VS Code.

The extension starts your installed `pi` in RPC mode (`pi --mode rpc`) in the workspace folder. Your Pi setup applies without changes: settings, models, auth, **extensions**, skills, prompt templates, MCP adapters, and sessions.

## Features

### Chat
- Replies, thinking and tool calls stream in as a timeline. Tool cards show input and output, and edits show a diff.
- Markdown renders in replies and in your sent prompts. It is also styled live as you type.
- While Pi works: <kbd>Enter</kbd> steers, <kbd>⌥ Enter</kbd> queues a follow-up, <kbd>Esc</kbd> stops.
- `/` for commands, `@` for file paths, `!cmd` for shell commands. Paste or drop images.
- The context pill shows how full the context is. Click it to compact.

### Models
- The model menu lists the models in Pi's `enabledModels`, or all models if the setting is empty.
- The effort (thinking level) slider is at the bottom of the same menu.

### Sessions
- Resume or fork from a searchable list. Archive a session to hide it from the list.
- Forks and sessions that extensions start (for example subagents) are nested under the session they came from. They are collapsed until you expand them.
- Sessions run in parallel. If you start a new session or open another one while Pi works, the busy session continues in the background. It shows at the top of the session list, and a notification tells you when it finishes or needs an answer.
- `/tree` moves between branches of a session. It can summarize the branch you leave and label entries.
- The last session reopens automatically. *Open in New Tab* starts another chat.

### Pi extensions
- Extension commands, dialogs, notifications, status text and widgets work in the chat.
- `/btw` and other extensions that open a composer in the TUI get a side panel next to the chat.

### Terminal
- *Pi: Open in Terminal* starts a new pi TUI session.
- *Continue Session in Terminal* moves the current session into the TUI. The chat pauses and picks the session back up when you close the terminal.

### Editor
- <kbd>⌘⌥L</kbd> adds the selection to the chat. The Explorer context menu adds a file.
- Click a file path in the chat to open it.

## Notes

- **Nested sessions** use the `parentSession` field of the session header, the same as pi's `/resume`. A session whose parent is not in the list shows at the top level.
- **Archived sessions** stay on disk. Only the list in VS Code hides them, so the pi TUI can still resume them.
- **`/tree`** needs a command that RPC mode does not have. The extension adds it by loading a small bridge extension into pi (`dist/pi-bridge.mjs`).
- **Terminal hand-off** stops the chat's pi process while the terminal has the session, so that two processes never write to the same file.
- **The side panel** opens for any command that replies "cannot open its composer outside Pi's TUI". A profile (`webview/sideProfiles.ts`, or `pi.sidePanels`) adds thread modes, header actions, and a thread that is restored from session entries. The entry data uses the fields `question`, `answer`, `thinking`, `model` and `usage`, the same as pi-btw.

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
| `pi.sidePanels` | `[]` | Side-panel profiles for side-conversation extensions. pi-btw is built in. Use `id: "btw"` to change it, or a new `id` to add an extension. |
| `pi.sidePanelCommands` | `{}` | Deprecated: use `pi.sidePanels`. Slash commands that run in the side panel, with an optional `followUp` command and a `title`. |

Extensions can check `process.env.PI_VSCODE === "1"` to know that they run inside VS Code.

## Limitations (from RPC mode)

TUI-only extension APIs do not work in RPC mode. These are `ctx.ui.custom()`, custom editors, footers and headers, and `onTerminalInput`. See Pi's [RPC Extension UI docs](https://pi.dev) for more information. `/tree` works through the bridge extension. For everything else, open the session in the terminal.

## Development

```bash
npm install
npm run build        # or: npm run watch
npm run typecheck
npm run package      # creates pi-for-vscode-<version>.vsix
code --install-extension pi-for-vscode-0.1.0.vsix
```

To debug, press <kbd>F5</kbd> with `.vscode/launch.json` ("Run Extension"). Logs from pi's stderr go to the **Pi** output channel.
