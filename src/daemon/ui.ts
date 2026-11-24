import * as path from "node:path";
import * as vscode from "vscode";
import { LEGACY_PROTOCOL, PREVIOUS_PROTOCOL, type DaemonFinished, type DaemonSession, type DialogPolicy } from "./protocol";
import { daemonCall, daemonExecutable, daemonList, isCompatible, type DaemonOptions } from "./client";

/**
 * The one Pi item in the status bar. It shows the sessions that work in this window and the
 * sessions that run in the daemon without a window. Its list opens a session and changes the
 * settings of the daemon. It also reports the sessions that finished while no window had them.
 */

/** How pi processes reach the daemon, or undefined when the setting `pi.keepSessionsAlive` is off for this window. */
export function daemonOptions(context: vscode.ExtensionContext, attach = false): DaemonOptions | undefined {
  const cfg = vscode.workspace.getConfiguration("pi");
  const mode = cfg.get<string>("keepSessionsAlive", "off");
  if (!attach && mode !== "always" && !(mode === "remote" && vscode.env.remoteName)) return undefined;
  return { script: daemonExecutable(context.extensionPath, cfg.get<string>("daemonPath"), cfg.get<boolean>("experimental.nativeDaemon", false)),
    policy: cfg.get<DialogPolicy>("detachedDialogs", "wait") };
}

/**
 * Session files that processes in the daemon have open: detached ones, and the ones of other clients
 * (another window, or an extension host that stayed after a reload). A second process must not open
 * such a file: start it, and the daemon gives the process that has it.
 */
export async function daemonFiles(context: vscode.ExtensionContext): Promise<Set<string>> {
  if (!daemonOptions(context)) return new Set();
  const list = await daemonList();
  return new Set((list?.sessions ?? []).filter((s) => s.file).map((s) => path.resolve(s.file!)));
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
  /** The sessions that work in this window. */
  running(): { title: string; where: string; file?: string; show(): void }[];
  /** The session files that the processes of this window have open. */
  files(): Set<string>;
  /** Write a line to the Pi output. */
  log(line: string): void;
  /** Open the session file in a chat. */
  open(file: string): void;
  /** Reattach to a live ACP process without opening a Pi session file. */
  openAcp(session: DaemonSession): void;
  /** Show the chat that has the session file, if one has. */
  show(file: string): boolean;
}

export function initDaemonUi(context: vscode.ExtensionContext, host: DaemonUiHost) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
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

  /** The daemon's sessions at the last look. */
  let known: DaemonSession[] = [];

  /** Draw the item from the sessions of this window and the last list of the daemon. */
  const render = () => {
    const working = host.running().length + known.filter((s) => s.backend === "acp" && s.attached && s.busy).length;
    const detached = known.filter((s) => !s.attached);
    const waiting = detached.filter((s) => s.waiting).length;
    const on = !!daemonOptions(context);
    // The logo alone; a spinner beside it while a session works.
    const parts = [working ? "$(loading~spin)" + (working > 1 ? ` ${working}` : "") : "", detached.length ? `${detached.length} detached` : ""].filter(Boolean);
    item.text = ["$(server-process)", parts.join(" · ")].filter(Boolean).join(" ");
    item.name = "Agent Sessions";
    item.accessibilityInformation = { label: `Agent sessions${working ? `, ${working} working` : ""}${detached.length ? `, ${detached.length} detached` : ""}` };
    item.backgroundColor = waiting ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    item.tooltip = [
      working ? `Agents are working… (${working} session${working === 1 ? "" : "s"})` : "",
      detached.length ? `${detached.length} detached session${detached.length === 1 ? "" : "s"}${waiting ? ` (${waiting} wait for your answer)` : ""}.` : "",
      on ? "Sessions keep working when VS Code closes or disconnects." : "Sessions stop when VS Code closes or disconnects.",
      "Click to show the sessions and the settings.",
    ].filter(Boolean).join("\n");
    item.show();
  };

  let warned = false;

  let refreshing = false;
  /** Ask the daemon for its sessions, then draw the item. */
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const list = await daemonList();
      if (list && !isCompatible(list) && daemonOptions(context) && !warned) {
        warned = true;
        const stop = "Stop Legacy Daemon";
        const pick = await vscode.window.showWarningMessage(
          "A daemon with another protocol is running. PiMux will not replace it while it has sessions.",
          ...(list.protocol <= LEGACY_PROTOCOL ? [stop] : []),
        );
        if (pick === stop && await vscode.window.showWarningMessage(
          "Stop the legacy daemon? Its running turns and in-memory ACP history will be lost.", { modal: true }, stop,
        ) === stop) {
          const latest = await daemonList();
          if (latest?.pid === list.pid && latest.protocol === list.protocol) await daemonCall({ op: "retire" });
        }
      }
      known = list?.sessions ?? [];
      render();
      if (list?.finished.length) await report(list.finished);
    } finally {
      refreshing = false;
    }
  };

  const describe = (s: DaemonSession) => [
    s.backend === "acp" ? s.acpBackend?.name || "ACP" : "Pi",
    s.waiting ? "waits for your answer" : s.busy ? "working" : s.failed ? "agent stopped" : "idle",
    s.attached ? "in another VS Code window" : `detached for ${duration(Date.now() - (s.detachedAt ?? Date.now()))}`,
    here(s.cwd) ? "" : s.cwd,
  ].filter(Boolean).join(" · ");

  /** The settings of the daemon, as rows of the list. */
  const SETTINGS = [
    {
      key: "keepSessionsAlive", label: "Keep sessions alive", fallback: "off",
      values: [
        { value: "off", label: "Off", detail: "Sessions stop when the VS Code window closes or disconnects" },
        { value: "remote", label: "Remote windows only", detail: "Sessions run in a daemon on the remote host (for example Remote-SSH)" },
        { value: "always", label: "Always", detail: "Sessions always run in a daemon, also on the local machine" },
      ],
    },
    {
      key: "detachedDialogs", label: "Pi questions without a window", fallback: "wait",
      values: [
        { value: "wait", label: "Wait", detail: "Hold the question until you reconnect" },
        { value: "deny", label: "Deny", detail: "Cancel the question and keep going" },
        { value: "acceptRecommended", label: "Accept the recommended option", detail: "Answer yes, or pick the recommended option" },
      ],
    },
  ];
  type Setting = (typeof SETTINGS)[number];
  const valueOf = (st: Setting) => vscode.workspace.getConfiguration("pi").get<string>(st.key, st.fallback);

  /** Select a value for a setting of the daemon. It goes to the user settings. */
  const change = async (st: Setting) => {
    const now = valueOf(st);
    const picked = await vscode.window.showQuickPick(
      st.values.map((v) => ({ label: `${v.value === now ? "$(check)" : "$(blank)"} ${v.label}`, detail: v.detail, value: v.value })),
      { placeHolder: `${st.label} (applies to sessions that start after the change)` },
    );
    if (!picked || picked.value === now) return;
    await vscode.workspace.getConfiguration("pi").update(st.key, picked.value, vscode.ConfigurationTarget.Global);
    void refresh();
  };

  const pick = async () => {
    const list = await daemonList();
    known = list?.sessions ?? known;
    const running = host.running();
    const mine = host.files();
    // From the daemon: the sessions without a window, and the ones of other clients (another window, or an
    // extension host that stayed after a reload), also idle ones: they block the session here until they stop.
    // This window's own sessions are in `running`, or idle (warm tabs) and not listed.
    const sessions = known.filter((s) => s.backend === "acp" ? !s.attached
      : s.file ? !(s.attached && mine.has(path.resolve(s.file))) : !s.attached && (s.busy || !!s.waiting));
    type Item = vscode.QuickPickItem & { s?: DaemonSession; setting?: Setting; show?: () => void };
    const qp = vscode.window.createQuickPick<Item>();
    const stopButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("debug-stop"), tooltip: "Stop this session" };
    const forgetButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("trash"), tooltip: "Remove saved chat" };
    const toItem = (s: DaemonSession): Item => ({
      label: `${s.waiting ? "$(question)" : s.busy ? "$(loading~spin)" : "$(circle-outline)"} ${title(s)}`,
      description: describe(s),
      buttons: s.backend === "acp" && s.failed && (list?.protocol ?? 0) >= PREVIOUS_PROTOCOL ? [forgetButton] : [stopButton],
      s,
    });
    const separator = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
    qp.items = [
      separator("Sessions"),
      ...running.map((r): Item => ({ label: `$(loading~spin) ${r.title}`, description: `working · ${r.where}`, show: r.show })),
      // Detached sessions before the ones of other windows: they are the ones that need a look.
      ...[...sessions].sort((a, b) => Number(a.attached) - Number(b.attached)).map(toItem),
      ...(running.length || sessions.length ? [] : [{ label: "$(blank) No sessions to show" }]),
      separator("Settings"),
      ...SETTINGS.map((st): Item => ({
        label: `$(gear) ${st.label}`,
        description: st.values.find((v) => v.value === valueOf(st))?.label ?? valueOf(st),
        setting: st,
      })),
    ];
    qp.placeholder = "Select a session to show it, or a setting to change it";
    qp.onDidTriggerItemButton(async (e) => {
      const s = e.item.s;
      if (!s) return;
      const forget = e.button === forgetButton;
      const action = forget ? "Remove" : "Stop";
      const yes = await vscode.window.showWarningMessage(`${action} "${title(s)}"?`, { modal: true }, action);
      if (yes !== action) return;
      await daemonCall({ op: !forget && (list?.protocol ?? 0) >= PREVIOUS_PROTOCOL ? "stop" : "kill", key: s.key });
      qp.hide();
      void refresh();
    });
    qp.onDidAccept(() => {
      const { s, setting, show } = qp.selectedItems[0] ?? {};
      qp.hide();
      if (show) return show();
      if (setting) return void change(setting);
      if (s?.backend === "acp") {
        if (here(s.cwd) || vscode.workspace.workspaceFolders?.some((folder) => path.resolve(folder.uri.fsPath) === path.resolve(s.cwd))) host.openAcp(s);
        else void vscode.window.showInformationMessage(`Pi: this session belongs to ${s.cwd}. Open that folder to reconnect.`);
        return;
      }
      if (!s?.file) return;
      // A session of this window is shown. Another one comes to this window (the daemon takes it from the client that has it).
      if (host.show(s.file)) return;
      if (here(s.cwd)) host.open(s.file);
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
  return { refresh, render };
}
