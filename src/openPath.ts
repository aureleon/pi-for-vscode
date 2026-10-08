import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/** Open a path from the chat: a file in an editor, a folder in the Explorer or a quick pick. */
export async function openPath(p: string, line: number | undefined, cwd: string) {
  const expanded = p.replace(/^~(?=\/|$)/, os.homedir()).replace(/(.)\/+$/, "$1");
  const file = path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    vscode.window.setStatusBarMessage(`Pi: not found: ${p}`, 3000);
    return;
  }
  // Build the URI on the extension host, so under Remote-SSH it points at the remote file.
  const uri = vscode.Uri.file(file);
  if (stat.isDirectory()) return openDirectory(uri);
  const opts: vscode.TextDocumentShowOptions = { preview: true, viewColumn: vscode.ViewColumn.One };
  if (line && line > 0) opts.selection = new vscode.Range(line - 1, 0, line - 1, 0);
  // vscode.open (not openTextDocument) so images and binaries get their proper editor.
  await vscode.commands.executeCommand("vscode.open", uri, opts);
}

/**
 * Folders can't be opened in an editor. Inside the workspace, reveal them in the
 * Explorer; elsewhere, show a quick pick of the folder's entries to open or descend into.
 */
export async function openDirectory(uri: vscode.Uri, reveal?: vscode.Uri): Promise<void> {
  if (vscode.workspace.getWorkspaceFolder(uri)) {
    await vscode.commands.executeCommand("revealInExplorer", reveal ?? uri);
    return;
  }
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(uri);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Pi: cannot read ${uri.fsPath}: ${err.message}`);
    return;
  }
  const isDir = (t: vscode.FileType) => (t & vscode.FileType.Directory) !== 0;
  entries.sort(([a, at], [b, bt]) => Number(isDir(bt)) - Number(isDir(at)) || a.localeCompare(b));
  const items = [
    ...(path.dirname(uri.fsPath) !== uri.fsPath ? [{ label: "$(arrow-up) ..", name: "..", dir: true }] : []),
    ...entries.map(([name, t]) => ({ label: `${isDir(t) ? "$(folder)" : "$(file)"} ${name}`, name, dir: isDir(t) })),
  ];
  const pick = await vscode.window.showQuickPick(items, { title: uri.fsPath, placeHolder: "Open a file or folder" });
  if (!pick) return;
  const target = vscode.Uri.file(path.join(uri.fsPath, pick.name));
  if (pick.dir) return openDirectory(target);
  await vscode.commands.executeCommand("vscode.open", target, { preview: true, viewColumn: vscode.ViewColumn.One });
}
