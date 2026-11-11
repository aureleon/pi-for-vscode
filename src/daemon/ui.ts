import * as path from "node:path";
import * as vscode from "vscode";
import type { DaemonFinished, DaemonSession, DialogPolicy } from "./protocol";
import { daemonCall, daemonList, type DaemonOptions } from "./client";

/**
 * The session daemon in the status bar: an item that shows that sessions keep running without
 * VS Code, with the list of the sessions that the daemon runs. Reports the sessions that finished
 * while no window had them.
 */

/** How pi processes reach the daemon, or undefined when the setting `pi.keepSessionsAlive` is off for this window. */
export function daemonOptions(context: vscode.ExtensionContext): DaemonOptions | undefined {
  const cfg = vscode.workspace.getConfiguration("pi");
  const mode = cfg.get<string>("keepSessionsAlive", "off");
  if (mode !== "always" && !(mode === "remote" && vscode.env.remoteName)) return undefined;
  return { script: path.join(context.extensionPath, "dist", "pi-daemon.js"), policy: cfg.get<DialogPolicy>("detachedDialogs", "wait") };
}

/** Session files that detached processes in the daemon have open. Another process must not open them: start them, and the daemon gives the process back. */
export async function detachedFiles(context: vscode.ExtensionContext): Promise<Set<string>> {
  if (!daemonOptions(context)) return new Set();
  const list = await daemonList();
  return new Set((list?.sessions ?? []).filter((s) => !s.attached && s.file).map((s) => path.resolve(s.file!)));
}

export function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "less than a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/** What the status bar needs from the chats. */
export interface DaemonUiHost {
  cwd(): string;
  /** Open the session file in a chat. */
  open(file: string): void;
  /** Show the chat that has the session file, if one has. */
  show(file: string): boolean;
}

export function initDaemonUi(context: vscode.ExtensionContext, host: DaemonUiHost) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.command = "pi.daemonSessions";
  const here = (cwd: string) => path.resolve(cwd) === path.resolve(host.cwd());
  const title = (s: { name?: string; file?: string }) => s.name || (s.file ? path.basename(s.file, ".jsonl") : "Untitled session");

  /** Tell the user about sessions of this folder that finished without a window, once. */
  const report = async (finished: DaemonFinished[]) => {
    const mine = finished.filter((f) => here(f.cwd));
    if (!mine.length) return;
    await daemonCall({ op: "ack", files: mine.map((f) => f.file) });
    for (const f of mine.slice(0, 5)) {
      const auto = f.auto.length ? ` ${f.auto.length} question${f.auto.length === 1 ? " was" : "s were"} answered automatically.` : "";
      const msg = f.code === undefined
        ? `Pi finished "${title(f)}" while VS Code was disconnected.${auto}`
        : `Pi: "${title(f)}" exited (code ${f.code}) while VS Code was disconnected.${auto}`;
      (f.code === undefined ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(msg, "Open").then((pick) => pick === "Open" && host.open(f.file));
    }
    if (mine.length > 5) vscode.window.showInformationMessage(`Pi finished ${mine.length - 5} more sessions while VS Code was disconnected. See the session list.`);
  };

  let refreshing = false;
  const refresh = async () => {
    if (!daemonOptions(context)) return item.hide();
    if (refreshing) return;
    refreshing = true;
    try {
      const list = await daemonList();
      const sessions = list?.sessions ?? [];
      const detached = sessions.filter((s) => !s.attached);
      const waiting = detached.filter((s) => s.waiting).length;
      item.text = detached.length ? `$(debug-disconnect) Pi: ${detached.length} detached` : "$(server-process) Pi daemon";
      item.backgroundColor = waiting ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
      item.tooltip = [
        "Pi sessions run in a daemon. A session that works keeps working when VS Code closes or disconnects.",
        detached.length ? `${detached.length} session${detached.length === 1 ? " runs" : "s run"} without a VS Code window${waiting ? ` (${waiting} wait for your answer)` : ""}.` : "",
        "Click to show the sessions of the daemon.",
      ].filter(Boolean).join("\n");
      item.show();
      if (list?.finished.length) await report(list.finished);
    } finally {
      refreshing = false;
    }
  };

  const describe = (s: DaemonSession) => [
    s.waiting ? "waits for your answer" : s.busy ? "working" : "idle",
    s.attached ? "in a VS Code window" : `detached for ${duration(Date.now() - (s.detachedAt ?? Date.now()))}`,
    here(s.cwd) ? "" : s.cwd,
  ].filter(Boolean).join(" · ");

  const pick = async () => {
    const list = await daemonList();
    const sessions = (list?.sessions ?? []).filter((s) => s.file || s.busy || s.waiting);
    if (!sessions.length) {
      vscode.window.showInformationMessage("Pi: the session daemon runs no sessions.");
      return;
    }
    type Item = vscode.QuickPickItem & { s: DaemonSession };
    const qp = vscode.window.createQuickPick<Item>();
    const stopButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("debug-stop"), tooltip: "Stop this session" };
    const toItem = (s: DaemonSession): Item => ({
      label: `${s.waiting ? "$(question)" : s.busy ? "$(loading~spin)" : "$(circle-outline)"} ${title(s)}`,
      description: describe(s),
      buttons: [stopButton],
      s,
    });
    // Detached sessions first: they are the ones that need a look.
    qp.items = [...sessions].sort((a, b) => Number(a.attached) - Number(b.attached)).map(toItem);
    qp.placeholder = "Pi sessions in the daemon. Select one to open it.";
    qp.onDidTriggerItemButton(async (e) => {
      const yes = await vscode.window.showWarningMessage(`Pi: stop "${title(e.item.s)}"?`, { modal: true }, "Stop");
      if (yes !== "Stop") return;
      await daemonCall({ op: "kill", key: e.item.s.key });
      void refresh();
    });
    qp.onDidAccept(() => {
      const s = qp.selectedItems[0]?.s;
      qp.hide();
      if (!s?.file) return;
      if (s.attached) {
        if (!host.show(s.file)) vscode.window.showInformationMessage("Pi: this session is open in another VS Code window.");
      } else if (here(s.cwd)) host.open(s.file);
      else vscode.window.showInformationMessage(`Pi: this session belongs to ${s.cwd}. Open that folder to get it back.`);
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  };

  const timer = setInterval(refresh, 10_000);
  context.subscriptions.push(
    item,
    { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand("pi.daemonSessions", pick),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("pi.keepSessionsAlive") && refresh()),
  );
  void refresh();
  return { refresh };
}
