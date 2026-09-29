import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export interface PathCompletion {
  /** Text shown in the popup (basename, with a trailing "/" for folders). */
  label: string;
  /** Replacement for the typed token after "@" (keeps the user's form: relative, ~/, or absolute). */
  insert: string;
  /** Secondary text (the path relative to the working folder). */
  detail?: string;
  dir: boolean;
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "out", "build", ".next", ".venv", "__pycache__"]);

function expand(p: string, cwd: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

/**
 * Completions for an `@` mention.
 *
 * - With a path separator (`src/co`, `~/Pro`, `/etc/ho`, `../x`) it lists the
 *   typed folder like shell completion: folders first, then files. A hidden
 *   entry is included only when the prefix starts with ".".
 * - A bare word (`@contr`) combines entries of the working folder that start with
 *   it and a fuzzy workspace search (files whose path contains it).
 */
export async function completePath(query: string, cwd: string, limit = 40): Promise<PathCompletion[]> {
  const slash = query.lastIndexOf("/");
  const isPath = slash >= 0 || query.startsWith("~") || query.startsWith(".");

  if (isPath) {
    const dirPart = slash >= 0 ? query.slice(0, slash + 1) : query === "~" ? "~/" : "";
    const prefix = slash >= 0 ? query.slice(slash + 1) : query === "~" ? "" : query;
    const dirAbs = expand(dirPart || ".", cwd);
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return [];
    }
    const lower = prefix.toLowerCase();
    const showHidden = prefix.startsWith(".");
    return entries
      .filter((e) => (showHidden || !e.name.startsWith(".")) && e.name.toLowerCase().startsWith(lower))
      .map((e) => {
        const dir = e.isDirectory() || (e.isSymbolicLink() && isDirSync(path.join(dirAbs, e.name)));
        const insert = dirPart + e.name + (dir ? "/" : "");
        return { label: e.name + (dir ? "/" : ""), insert, detail: dirPart || "./", dir };
      })
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.label.localeCompare(b.label))
      .slice(0, limit);
  }

  // Bare word: working-folder entries first, then fuzzy workspace matches.
  const out: PathCompletion[] = [];
  const seen = new Set<string>();
  const lower = query.toLowerCase();
  try {
    for (const e of await fs.promises.readdir(cwd, { withFileTypes: true })) {
      if (e.name.startsWith(".") || !e.name.toLowerCase().startsWith(lower)) continue;
      const dir = e.isDirectory();
      const insert = e.name + (dir ? "/" : "");
      seen.add(insert.replace(/\/$/, ""));
      out.push({ label: insert, insert, detail: "./", dir });
    }
  } catch {}
  out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.label.localeCompare(b.label));

  if (query && vscode.workspace.workspaceFolders?.length) {
    const q = query.replace(/[\[\]{}*?]/g, "");
    const uris = await vscode.workspace.findFiles(`**/*${q}*`, `**/{${[...IGNORED_DIRS].join(",")}}/**`, 200);
    const rels = uris
      .map((u) => vscode.workspace.asRelativePath(u, false))
      .filter((r) => r.toLowerCase().includes(lower) && !seen.has(r))
      .sort((a, b) => a.length - b.length);
    for (const r of rels) out.push({ label: path.basename(r), insert: r, detail: path.dirname(r) === "." ? "./" : path.dirname(r) + "/", dir: false });
  }
  return out.slice(0, limit);
}

function isDirSync(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
