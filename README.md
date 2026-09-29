# Pi for VS Code

Use the [Pi coding agent](https://pi.dev) in the VS Code sidebar, in a UI like Claude Code for VS Code.

The extension starts your installed `pi` in RPC mode (`pi --mode rpc`) in the workspace folder. Your Pi setup applies without changes: settings, models, auth, **extensions**, skills, prompt templates, MCP adapters, and sessions.

## Features

- **One native header.** The standard VS Code view header shows "Pi Coding Agent", a "Session" subtitle, and the session name in a subdued font (the name you set, else the first prompt). It also has the Continue in terminal, Side panel, Tree, Resume, and New session buttons, with *Open in New Tab* and *Restart* in the ••• menu. Chats in editor tabs show the same buttons in the editor title bar. The webview does not add its own header.
- **Chat in the sidebar.** Text, thinking, and tool calls stream live and show as a timeline. Tool cards show `IN`/`OUT` for bash, read, write, and grep. Edits show an inline diff.
- **Pi extensions.** Commands from `pi.registerCommand` show in `/` autocomplete. `ctx.ui.select/confirm/input/editor` show as inline dialogs, with timeout support. `notify` shows as a VS Code notification. `setStatus` shows in the status line and `setWidget` shows above or below the input, both with ANSI colors. `set_editor_text` fills the input.
- **Prompting while Pi works.** <kbd>Enter</kbd> steers, <kbd>⌥ Enter</kbd> queues a follow-up, and <kbd>Esc</kbd> or the red button stops. When you stop, queued messages go back into the input.
- **Autocomplete.** Type `/` for commands (extension commands, prompt templates, skills, and built-ins).
  - Type `@` to complete file paths as in a shell. `@src/` lists that folder, with folders first. Picking a folder moves into it, and picking a file inserts `@path`.
  - Relative, `./`, `../`, `~/`, and absolute paths all work. Hidden entries show when the prefix starts with `.`.
  - A bare word (`@contr`) also searches the whole workspace.
- **Markdown in the input.** Markdown is styled as you type: **bold**, *italic*, `code`, ~~strike~~, headings, lists, quotes, links, fenced code blocks, `@mentions`, and a leading `/command` or `!shell`. The markup characters stay visible (dimmed), and the text stays plain and editable.
- **Shell.** `!cmd` runs a command and adds its output to the context. `!!cmd` runs it without adding output to the context.
- **Images.** Paste, drag and drop, or use the image button.
- **Sessions.** Start a new session, `/clone`, `/name`, `/compact`, and `/export`. To resume a session (the history button or `/resume`) or to `/fork` from an earlier message, pick it from a searchable dropdown under the header. The extension does not use VS Code's global QuickPick. The sidebar reopens the last session of the workspace.
- **Session tree (`/tree`).** Use the tree button in the header, `/tree`, or *Pi: Session Tree*. The tree shows every branch of the session, as in the pi TUI: chains stay flat, branch points get `├─ └─` guides, abandoned branches are muted, and the current entry is marked.
  - Select an entry and press **Enter** (or click *Go*) to continue from there. If you select a prompt, the chat moves to the point before it and puts the prompt back in the input, so you can edit it and send it as a new branch.
  - **Shift+Enter** (*Summarize & go*) summarizes the branch you are leaving. **Alt+Enter** asks for summary instructions first.
  - **Ctrl+L** sets or clears a label (a bookmark). *Show all entries* also shows tool results and model changes. Type to search.
  - RPC mode has no tree commands, so the extension loads a small bridge extension into pi (`pi -e dist/pi-bridge.mjs`). The bridge calls `ctx.navigateTree()`. Its internal `vscode:*` commands do not appear in autocomplete.
- **Terminal.** The terminal tabs show the Pi logo.
  - **Pi: Open in Terminal** (in the ••• menu) starts a new pi TUI session in a terminal.
  - **Continue Session in Terminal** (the terminal button in the header) moves the current chat's session into the TUI. The session continues in the full pi TUI in an integrated terminal, as an editor tab by default (`pi.terminalLocation`). The TUI gives you every TUI-only feature (custom extension UIs, overlays, keybindings).
  - While the terminal has the session, the chat is paused, so that two pi processes do not write to the same session file. The session is handed over by its exact id (`--session-id`). When you close the terminal or click *Reattach Here*, the chat resumes exactly that session, with everything you did in the TUI, even if newer sessions exist in the folder.
- **Side panel for side conversations (`/btw`, and composer extensions).**
  - In the pi TUI, extensions such as [pi-btw](https://github.com/dbachelder/pi-btw) open an overlay composer. In RPC mode they refuse to do so. The extension opens a side panel for them instead. It splits the view with the chat, so the main conversation stays visible: top/bottom in a narrow sidebar and left/right in a wide view (640px or more). Drag the divider to resize the panel, and double-click it to reset the size. The size is saved.
  - A bare `/btw` opens the panel's composer. `/btw question` opens the panel and sends the question. You type follow-ups in the panel, and the thread continues. The mode stays the same (`/btw:tangent` threads continue as tangents and `/btw:ask` threads as read-only).
  - pi-btw's thread entries fill the panel as soon as each answer is ready, even while the main agent is working. After a reload or a session switch, the panel restores the thread from the session.
  - The panel has **Inject** and **Summarize** buttons and a **Clear** (trash) button, which also starts a fresh thread. For Inject and Summarize, text in the panel box becomes the instructions.
  - In the main chat, pi-btw notes show only as a compact `BTW` link that opens the panel.
  - Any other extension that answers a bare command with *"cannot open its composer outside Pi's TUI"* is detected. The panel then opens for that command, and the next bare use opens it directly.
  - To route more commands to the panel, use `pi.sidePanelCommands`. To open the panel, use the side-panel button in the view header or *Pi: Toggle Side Panel*. When the panel is closed, a badge on the Pi view shows the number of side-thread messages.
- **Model picker.** Click the model chip in the toolbar to open a model list above the input.
  - The list follows Pi's `enabledModels` setting. It uses the same rules as the pi CLI: exact IDs, `provider/id`, fuzzy names, globs, and `:thinking` suffixes. The order follows your patterns.
  - The setting comes from `--models` in `pi.args`, then `<workspace>/.pi/settings.json`, then `~/.pi/agent/settings.json`. If `enabledModels` is empty, the list shows all models, with your recent models first.
  - The search also finds models that are not enabled. It lists them under "Other models".
  - The footer tells you where the list comes from and how many patterns match no model. Click *Show all* to see all models. Click *Edit* to open the settings file at `enabledModels`. The picker reads the file again each time it opens.
  - `/model [query]` also opens the picker.
- **Effort (thinking level).** The last row of the model menu shows the effort label on the left and a stepped slider on the right. The slider has a fixed width and position, so it does not move when the label changes. It only appears for reasoning models.
  - Click or drag anywhere on or near the slider to set the level. You can also use ←/→ (when the search box is empty) or Tab/Shift+Tab. The level is sent to pi when you release the slider.
  - The model chip shows the current effort, for example "Claude Opus 5.5 (Global)  Medium".
  - `/thinking [level]` sets the level directly. Without a level, it opens the menu with the slider focused.
  - Each model row shows its context size and capabilities. The tooltip shows the full `provider/id`.
  - The toolbar shows context use as a pill with a ring gauge and a percentage. The pill turns amber from 70% and red from 90%. Hovering reveals "Compact" and the token counts. Clicking compacts the conversation (the same as `/compact`).
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
| `pi.terminalLocation` | `"editor"` | Where *Open in Terminal* opens the TUI: an editor tab or the terminal panel. |
| `pi.sidePanelCommands` | pi-btw commands | Slash commands that run in the side panel, with an optional `followUp` command and a `title`. |

Extensions can check `process.env.PI_VSCODE === "1"` to know that they run inside VS Code.

## Limitations (from RPC mode)

TUI-only extension APIs do not work in RPC mode. These are `ctx.ui.custom()`, custom editors, footers and headers, and `onTerminalInput`. See Pi's [RPC Extension UI docs](https://pi.dev) for more information. `/tree` works through the bridge extension, and *Open in Terminal* gives you everything else from the TUI.

## Development

```bash
npm install
npm run build        # or: npm run watch
npm run typecheck
npm run package      # creates pi-for-vscode-<version>.vsix
code --install-extension pi-for-vscode-0.1.0.vsix
```

To debug, press <kbd>F5</kbd> with `.vscode/launch.json` ("Run Extension"). Logs from pi's stderr go to the **Pi** output channel.
