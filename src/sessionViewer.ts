import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { readSessionView } from "./sessionView";
import { openPath } from "./openPath";

/** How often the viewer checks the session file for new entries. */
const POLL_MS = 1000;

/**
 * Read-only view of a session file in an editor tab. It starts no pi process, so it is
 * safe to use on a session that another process writes, for example a session that an
 * extension (such as a subagent) runs. New entries show as pi appends them to the file.
 */
export class SessionViewer implements vscode.Disposable {
  private shownIds: string[] = [];
  private disposables: vscode.Disposable[] = [];
  private listener = () => this.scheduleRefresh();
  private refreshing = false;
  private again = false;

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly file: string,
    private readonly cwd: string,
    private readonly openInChat: (file: string) => void,
  ) {
    this.disposables.push(panel.webview.onDidReceiveMessage((m) => this.onMessage(m)));
    // Polling (not fs.watch): it works the same on every platform and under Remote-SSH.
    fs.watchFile(file, { interval: POLL_MS }, this.listener);
  }

  private async onMessage(m: any) {
    switch (m.type) {
      case "ready":
        this.shownIds = [];
        await this.refresh();
        break;
      case "openFile":
        await openPath(m.path, m.line, this.cwd);
        break;
      case "openExternal":
        if (/^(https?|mailto):/i.test(String(m.url))) await vscode.env.openExternal(vscode.Uri.parse(String(m.url)));
        break;
      case "copy":
        await vscode.env.clipboard.writeText(String(m.text ?? ""));
        vscode.window.setStatusBarMessage("Pi: copied to clipboard", 1500);
        break;
      case "openInChat":
        this.openInChat(this.file);
        break;
    }
  }

  private scheduleRefresh() {
    if (this.refreshing) {
      this.again = true;
      return;
    }
    this.refresh();
  }

  /** Send new messages if the branch only grew, else the whole transcript. */
  private async refresh() {
    this.refreshing = true;
    try {
      const view = await readSessionView(this.file);
      this.panel.title = `${view.name || firstLine(view.messages) || path.basename(this.file)} (read-only)`;
      const old = this.shownIds;
      const grew = old.length > 0 && old.length <= view.ids.length && old.every((id, i) => view.ids[i] === id);
      if (grew) {
        if (view.ids.length > old.length) this.panel.webview.postMessage({ type: "appendMessages", messages: view.messages.slice(old.length) });
      } else {
        this.panel.webview.postMessage({
          type: "init",
          state: { sessionFile: this.file, sessionName: view.name },
          commands: [],
          messages: view.messages,
          cwd: view.header?.cwd ?? this.cwd,
        });
      }
      this.shownIds = view.ids;
    } catch (err: any) {
      this.panel.webview.postMessage({ type: "error", message: `Cannot read the session file: ${err.message ?? err}` });
    } finally {
      this.refreshing = false;
      if (this.again) {
        this.again = false;
        this.refresh();
      }
    }
  }

  dispose() {
    fs.unwatchFile(this.file, this.listener);
    for (const d of this.disposables) d.dispose();
  }
}

function firstLine(messages: any[]): string | undefined {
  const m = messages.find((x) => x.role === "user");
  const c = m?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((b: any) => b.type === "text")?.text : undefined;
  return text?.split("\n")[0].slice(0, 60) || undefined;
}
