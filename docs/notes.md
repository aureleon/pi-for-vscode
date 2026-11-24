# Implementation notes

Details behind the features in the [README](../README.md).

## VS Code extension

- **Nested sessions** use the `parentSession` field of the session header, the same as pi's `/resume`. A session whose parent is not in the list shows at the top level.
- **Times** come from the `timestamp` of each message. pi does not save when a tool starts, so after a reload a tool call shows when it finished, and no run time.
- **Nested tool calls** come from `parentToolCallId` on `tool_execution_*` events. After a reload, pi keeps only a record of them (`nestedCalls`: names, arguments, status, errors), so their outputs are not shown.
- **The session viewer** reads the session file and checks it for changes every second. It shows the branch of the last entry in the file.
- **Renaming from the session list** goes through the pi process that has the session open, in any chat. If no process has it open, the extension adds the name to the session file, the same as a rename in the pi TUI's `/resume` list. A session that is open in the terminal or runs as a subagent can't be renamed until it is free.
- **Archived sessions** stay on disk. Only the list in VS Code hides them, so the pi TUI can still resume them.
- **`/tree`** needs a command that RPC mode does not have. The extension adds it by loading a small bridge extension into pi (`dist/pi-bridge.mjs`).
- **Queue edits** take the whole queue out of pi and queue it again, because RPC mode can only add to the queue or clear it. Images in queued messages are not kept. **Send now** stops the run and sends the message as the next run.
- **Factory widgets** (for example todo lists and agent bars) are dropped by RPC mode. A workaround renders them to text lines at the width of the chat view and sends them again when they change (at most 4 times a second).
- **Running child sessions** are not in RPC events. A workaround counts the prompts that run on other agent sessions in the process and reports them, with their session files, in a hidden status. The titles come from the session files. Sessions that an extension keeps only in memory have no title. pi-btw side threads also count while they answer.
- **Tiles** are chats in one webview: `mountChat` (webview/chat.ts) builds each one in its own element. They are not iframes, because VS Code ignores keys from nested frames, so its shortcuts would not work in a tile.
- **Session tabs** keep the pi process of up to `pi.warmTabs` idle tabs per tile. A few seconds after a tab opens, the tile starts processes for the tabs next to it, one at a time. Other idle tabs have no process; opening one switches the tile's process to its file (about a second). A busy tab that you leave keeps its process, the same as a background session. A new session that you leave before its first message has no file, so its tab closes.
- **Kept views:** the chat keeps the transcripts of the last 8 tabs that you left in the page (hidden). A click on such a tab shows it at once, at the same scroll position. pi's snapshot follows; if it has the same messages, nothing is drawn again. A session that works is drawn again from pi when you come back.
- **Session titles** (`pi.autoTitle`) come from the bridge extension. It sends the first prompt (4000 characters at most) to the title model and saves the answer as the session name, so the pi TUI shows it too. It does not replace a name that the session has. The setting applies to pi processes that start after you change it.
- **A spare process** with a new, empty session waits in each tile while `pi.warmTabs` is more than 0, so + needs no wait. If you close the tab of a new session before its first message, its process becomes the spare again.
- **New sessions without a message** have no file: pi writes it with the first message. Their tab keeps the session id and opens it again with `--session-id`.
- **Startup:** the chat starts pi as soon as the sidebar opens, not when the webview is ready, and the login shell environment is read when the extension activates. Until pi answers, the chat shows the session from its file (the same reader as the session viewer). Tabs get their own processes only after all chats have started.
- **Moving a tab** to another tile moves its pi process too, so nothing restarts and only one process has the file. A session that works moves with its turn, open dialogs, queued messages, widgets and the running child sessions; the other tile shows the turn from where it is. The same goes for merging tiles.
- **The session daemon** runs apart from the extension host. In a Remote-SSH workspace, it runs on the remote host. The client reuses the daemon on `~/.pi/vscode-daemon/daemon.sock` (a named pipe on Windows with the legacy daemon). It does not replace a running daemon just because the extension was updated. Pi keeps its own session files.
- **The daemon and logout:** a host that stops all processes of a user at logout (systemd `KillUserProcesses=yes`) also stops the daemon. Run `loginctl enable-linger` on such a host.
- **One chat per session:** a chat that would open a session that another chat has open (for example after a reload) starts a new session. A session that runs in a chat's background stays in that chat.
- **Terminal hand-off** stops the chat's pi process while the terminal has the session, so that two processes never write to the same file.
- **Integrations** add support for one pi extension beyond pi's RPC protocol. Each one is in `integrations/<name>/`, and `integrations/host.ts` and `integrations/web.ts` list them. An integration is active only in sessions that load its pi extension. It can also load a small pi extension of its own (`integrations/<name>/pi.ts`), for example the pi-btw workaround for notes that arrive during a run. See [integrations/README.md](../integrations/README.md).
- **Workarounds** fill gaps in pi's RPC mode for every extension, for example factory widgets and running child sessions. Each one is in `workarounds/<name>/` and loads its own small pi extension. The child-runs workaround uses pi internals; if a pi update breaks one, turn it off with `pi.workarounds`. See [workarounds/README.md](../workarounds/README.md).

## Native daemon

- **Compatibility:** VS Code attaches to a running daemon that speaks protocol 3 through 6. It never replaces a running daemon. Restart an older daemon when its sessions are done to get new features such as revealing chats in other windows.
- **Legacy daemon:** `pimuxd shutdown` stops a protocol 3 daemon after its sessions close. `--force` stops its agents now and discards its in-memory ACP history.
- **ACP checkpoints** store recent messages (8 MiB at most) and omit images. After a crash, **Reopen Saved Chat** starts a new agent session. It can load the earlier agent context only when the agent supports `session/load` and the profile still uses the same executable and arguments. It never resends a prompt or an approval.
- **Control:** one client controls a session. Other socket clients can observe it read-only. They cannot send prompts or answer permissions.
- **`inspect`** shows saved ACP messages, which can contain private data. `logs` shows only daemon lifecycle events.
- **Release builds:** run `npm run package:native` on each target host. It builds a target-specific VSIX and `dist/pimuxd-<target>.tar.gz`. Build Linux binaries on a host whose glibc is no newer than the oldest supported host.
