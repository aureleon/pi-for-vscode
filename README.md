# Pi for VS Code

Use the [Pi coding agent](https://pi.dev) in the VS Code sidebar, in a UI like Claude Code for VS Code.

The extension starts your installed `pi` in RPC mode (`pi --mode rpc`) in the workspace folder. Your Pi setup applies without changes: settings, models, auth, **extensions**, skills, prompt templates, MCP adapters, and sessions.

## Features

- **Chat in the sidebar.** Text, thinking, and tool calls stream live and show as a timeline. Tool cards show `IN`/`OUT` for bash, read, write, and grep. Edits show an inline diff.
- **Pi extensions.** Commands from `pi.registerCommand` show in `/` autocomplete. `ctx.ui.select/confirm/input/editor` show as inline dialogs, with timeout support. `notify` shows as a VS Code notification. `setStatus` shows in the status line and `setWidget` shows above or below the input, both with ANSI colors. `set_editor_text` fills the input.
- **Prompting while Pi works.** <kbd>Enter</kbd> steers, <kbd>⌥ Enter</kbd> queues a follow-up, and <kbd>Esc</kbd> or the red button stops. When you stop, queued messages go back into the input.
- **Autocomplete.** Type `/` for commands (extension commands, prompt templates, skills, and built-ins) and `@` to mention workspace files.
- **Shell.** `!cmd` runs a command and adds its output to the context. `!!cmd` runs it without adding output to the context.
- **Images.** Paste, drag and drop, or use the image button.
- **Sessions.** Start a new session, resume one from the history picker, `/fork`, `/clone`, `/name`, `/compact`, and `/export`. The sidebar reopens the last session of the workspace.
- **Model and effort picker.** Click the model chip in the toolbar to open a picker above the input. It has a search field, a list of recent models, and details for each model (context size, reasoning, cost). A slider at the bottom sets the effort (thinking level). Use ↑/↓ and Enter to select a model. Use ←/→ or Tab to change the effort. `/model [query]` also opens the picker. The toolbar also shows context use and cost.
- **Editor integration.** *Pi: Add Selection to Chat* (<kbd>⌘⌥L</kbd>) inserts `@file:10-20`. Right-click a file in the Explorer and select *Pi: Add File to Chat*. Click a file path in a tool card or inline code to open it.
- **More sessions.** *Pi: Open in New Tab* opens another chat panel with its own pi process.

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

Extensions can check `process.env.PI_VSCODE === "1"` to know that they run inside VS Code.

## Limitations (from RPC mode)

TUI-only extension APIs do not work in RPC mode. These are `ctx.ui.custom()`, custom editors, footers and headers, and `onTerminalInput`. See Pi's [RPC Extension UI docs](https://pi.dev) for more information. Tree navigation (`/tree`) is not available in RPC mode.

## Development

```bash
npm install
npm run build        # or: npm run watch
npm run typecheck
npm run package      # creates pi-for-vscode-<version>.vsix
code --install-extension pi-for-vscode-0.1.0.vsix
```

To debug, press <kbd>F5</kbd> with `.vscode/launch.json` ("Run Extension"). Logs from pi's stderr go to the **Pi** output channel.
