import * as vscode from "vscode";
import { getShellEnv } from "./shellEnv";

/** Quote an argument for a POSIX shell command line. */
export const shellQuote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

/**
 * Open an integrated terminal running the pi TUI, carrying the Pi logo
 * (the `pi-logo` product icon from media/pi-icons.woff) in the tab.
 */
export async function createPiTerminal(extraArgs: string[], opts: { name?: string; cwd?: string } = {}): Promise<vscode.Terminal> {
  const cfg = vscode.workspace.getConfiguration("pi");
  const command = cfg.get<string>("path")?.trim() || "pi";
  const args = [...(cfg.get<string[]>("args") ?? []).filter((a) => a !== "--no-session"), ...extraArgs];
  const env = await getShellEnv(cfg.get<boolean>("useLoginShellEnv", true));
  const terminal = vscode.window.createTerminal({
    name: opts.name ?? "Pi",
    cwd: opts.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    iconPath: new vscode.ThemeIcon("pi-logo"),
    env: { PATH: env.PATH ?? process.env.PATH ?? "", PI_VSCODE: "1", PI_VSCODE_TERMINAL: "1" },
    location:
      cfg.get<string>("terminalLocation", "editor") === "panel"
        ? vscode.TerminalLocation.Panel
        : { viewColumn: vscode.ViewColumn.Active },
  });
  terminal.sendText([command, ...args].map(shellQuote).join(" "), true);
  terminal.show();
  return terminal;
}
