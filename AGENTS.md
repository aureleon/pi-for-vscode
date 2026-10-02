# AGENTS.md

Notes for coding agents that work on Pi for VS Code.

## Layout

- `src/extension.ts`: activation, commands, sidebar view and editor tabs. Each chat gets one `PiController`.
- `src/controller.ts`: the host side of one chat. It runs `pi --mode rpc` processes (one per session; busy sessions can run in the background), sends snapshots and events to the webview, and handles the built-in slash commands that RPC mode does not have.
- `src/piProcess.ts`: JSONL RPC client. Split stdout only on `\n`.
- `src/sessionViewer.ts`, `src/sessionView.ts`: read-only session tab. It reads the session file and starts no pi process.
- `src/bridge/piBridge.ts`: pi extension loaded with `pi -e`. It adds hidden `vscode:*` commands (tree navigation, labels). Keep it free of dependencies.
- `webview/main.ts`: the chat UI, in plain TypeScript and DOM (no framework). `webview/styles.css` holds all styles.
- `webview/treeMenu.ts`, `webview/streamMd.ts`: `/tree` navigator, streaming markdown.
- `src/integrations.ts`, `webview/integrations.ts`: hooks for integrations and workarounds. The two sides talk with `{ type: "ext", id, payload }`.
- `integrations/<name>/`: one integration (`host.ts`, `web.ts`, styles). `integrations/host.ts` and `integrations/web.ts` list them. Put code for one pi extension here, never in `src/` or `webview/`. Code in `integrations/` can import from the core; the core imports only the two lists.
- `workarounds/<name>/`: one workaround for a gap in pi's RPC mode that affects every extension (same hooks, no `matches`). Each has a `pi.ts` and a README that says which gap it fills and when to remove it. Put RPC gap fillers here, never in `src/bridge/piBridge.ts`.
- `tools/build-icon-font.mjs`: builds `media/pi-icons.woff`. Run `npm run build:icons`.

## Checks

Run these before you commit:

```bash
npm run typecheck
npm run build
```

There are no unit tests. If a change is visual or depends on timing, check it in headless Chromium or in VS Code (F5, "Run Extension"). Say in the commit message what you checked.

## Code style

- Two-space indent, double quotes, semicolons, trailing commas. Lines can be long (about 140 characters).
- Use a short JSDoc comment (`/** … */`) on classes, fields and methods that are not obvious. Say why, not what.
- Split long files into sections with the existing divider comments:
  - TS: `// ------------------------------------------------------------------ name`
  - CSS: `/* ---------------------------------------------------------------- name */`
- The host and the webview talk with `{ type: "…" }` messages. The handlers are `onWebviewMessage` in `controller.ts` and the `window.addEventListener("message", …)` switch in `main.ts`. If you add a message, add it to both sides.
- Do not send large data to the webview. For example, `slimTree()` sends previews, not full tool outputs.
- Never let two pi processes write to the same session file (see the terminal hand-off and `withoutSessionArgs`).
- Remote-SSH: build file URIs on the extension host (`vscode.Uri.file`). Open files with `vscode.open`. Do not open a local browser for a remote file.

## Design style

The UI looks like Claude Code for VS Code and uses the VS Code theme.

- Colours: use only `--vscode-*` theme variables, through the tokens in `:root` (`--border`, `--muted`, `--accent`, `--card-bg`, `--ok`, `--err`, `--mono`). Give a fallback when a theme variable can be missing. Do not use fixed colours.
- Sizes: `--gap: 10px` and `--radius: 8px`. Rows in menus and lists are compact (about 20–28px). Toolbar rows match VS Code's 28px header height.
- Icons: 16×16 inline SVG with `fill="currentColor"`, in the `I` object in `main.ts`, or VS Code codicons (`$(name)`) in native UI. The busy indicator is the pulsing block π (`SPINNER` in `webview/spinner.ts`). Do not add other spinners.
- Menus and navigators (sessions, fork, tree, model picker) are anchored to the header and look the same: a search field with a close (X) button, `mp-item` rows, `lm-group` group headings, and a `menu-footer` with a key hint. Reuse these classes when you add a list.
- Prefer native VS Code UI where it fits (status bar, notifications, quick picks for files). Use the webview for chat and navigators.
- Notices: errors and warnings from pi go to VS Code notifications. An integration can keep its own notices in the webview (`filterNotice`).
- Keep chrome quiet: use subdued text (`--muted`) for metadata, and show actions on hover where possible.

## Writing style (README, UI text, comments)

Use plain, Simplified Technical English (see the `simple-english` skill if you have it): short sentences, active voice, simple tenses, one word for one meaning. The README has short sections with one-line items. Put implementation details in its **Notes** section.

## Commits

- Subject: imperative, sentence case, no trailing period, about 70 characters or less. Describe the change from the user's view (for example "Keep queued messages when a run is stopped"). Join related small changes with `;` ("Add close buttons to navigators; fix folder links and export under Remote-SSH").
- Small changes can have a subject only.
- Other changes get a body, wrapped at about 70 columns:
  1. A short paragraph about the problem or the old behaviour.
  2. A `- ` list of the changes. Indent continuation lines by two spaces. Give file or function names in the list where they help.
  3. Optional: a paragraph about how you checked the change ("Checked in headless Chromium: …").
- One commit for each logical change. Do not commit `dist/` or `*.vsix`.
