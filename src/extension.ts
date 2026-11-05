import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PiController, type ChatHost, type Tab } from "./controller";
import { createPiTerminal } from "./piTerminal";
import { SessionViewer } from "./sessionViewer";
import { defaultSessionDir } from "./sessions";

let output: vscode.OutputChannel;
const controllers = new Set<PiController>();
let sidebar: PiController | undefined;
let lastActive: PiController | undefined;

/**
 * `tiles`: the sidebar, which holds one or more chats in tiles, each with its header row.
 * `readonly`: the session viewer, with no composer. Editor tabs use their own title bar.
 */
function html(webview: vscode.Webview, extUri: vscode.Uri, opts: { tiles?: boolean; readonly?: boolean } = {}): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "dist", "webview.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "webview", "styles.css"));
  const logo = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "media", "pi-logo.svg"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: https:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Pi</title>
</head>
<body data-logo="${logo}"${opts.tiles ? ' data-tiles="1"' : ""}${opts.readonly ? ' data-readonly="1"' : ""}>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

function webviewOptions(extUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extUri, "dist"), vscode.Uri.joinPath(extUri, "webview"), vscode.Uri.joinPath(extUri, "media")],
  };
}

// ------------------------------------------------------------------ sidebar tiles

/** Most tiles in the sidebar (also `MAX_TILES` in webview/chat.ts). */
const MAX_TILES = 4;
const TILES_KEY = "pi.sidebarTiles";

interface TileState {
  id: string;
  /** Share of the space (flex-grow in the webview). */
  size: number;
}

/**
 * The chats in the sidebar view, one per tile. Each tile has its own PiController. The tiles share the
 * view's webview: messages carry the tile id (`{ tile, msg }`), and `tiles:*` messages change the layout.
 * The first tile is the primary chat (it resumes the workspace's last session); each tile keeps its own tabs.
 */
class SidebarTiles implements vscode.Disposable {
  private tiles: TileState[];
  private chats = new Map<string, { c: PiController; inbox: vscode.EventEmitter<any>; badge: number; tooltip?: string }>();
  private subs: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly view: vscode.WebviewView) {
    const saved = context.workspaceState.get<TileState[]>(TILES_KEY) ?? [];
    this.tiles = saved.filter((t) => typeof t?.id === "string").slice(0, MAX_TILES);
    if (!this.tiles.length) this.tiles = [{ id: "t1", size: 1 }];
    for (const t of this.tiles) this.createChat(t.id);
    this.subs.push(view.webview.onDidReceiveMessage((m) => this.onMessage(m)));
  }

  /** The chat of the first tile, for commands when no tile had focus yet. */
  get first(): PiController | undefined {
    return this.chats.get(this.tiles[0]?.id)?.c;
  }

  /** `start`: tabs for a new tile (a tab dragged out of another tile) and the session to show. */
  private createChat(id: string, start?: { tabs: Tab[]; shown: string }) {
    const inbox = new vscode.EventEmitter<any>();
    const host: ChatHost = {
      webview: {
        postMessage: (msg) => this.view.webview.postMessage({ tile: id, msg }),
        onDidReceiveMessage: inbox.event,
      },
      // The native title is just "Pi Coding Agent"; each tile's header shows its session tabs.
      setTitle: () => {},
      setBadge: (count, tooltip) => {
        const e = this.chats.get(id);
        if (e) (e.badge = count), (e.tooltip = tooltip);
        this.updateBadge();
      },
      reveal: () => {
        this.view.show(true);
        this.view.webview.postMessage({ type: "tiles:focus", tile: id });
      },
      openBeside: (file) => openPanel(this.context, file, { column: vscode.ViewColumn.Beside }),
      kind: "sidebar",
      closeChat: () => {
        if (this.tiles.length < 2) return false;
        // After the controller's own call returns.
        setTimeout(() => this.removeTile(id), 0);
        return true;
      },
    };
    const first = id === "t1";
    const c = new PiController(this.context, host, output, {
      primary: first && !start,
      tabsKey: first ? "pi.sidebarTabs" : `pi.sidebarTabs:${id}`,
      tabs: start?.tabs,
      sessionFile: start?.shown,
    });
    this.chats.set(id, { c, inbox, badge: 0 });
    controllers.add(c);
    if (!sidebar) sidebar = c;
    lastActive ??= c;
  }

  /** One badge on the view: the sum of the tiles' badges. */
  private updateBadge() {
    const all = [...this.chats.values()];
    const count = all.reduce((n, e) => n + e.badge, 0);
    const tooltip = all.filter((e) => e.badge).map((e) => e.tooltip).filter(Boolean).join("\n");
    this.view.badge = count > 0 ? { value: count, tooltip: tooltip || String(count) } : undefined;
  }

  /** A split or a close gives all tiles the same size. A drag on a sash can change it after that. */
  private evenSizes() {
    for (const t of this.tiles) t.size = 1;
  }

  private save() {
    this.context.workspaceState.update(TILES_KEY, this.tiles);
  }

  private sendLayout() {
    this.view.webview.postMessage({ type: "tiles:layout", tiles: this.tiles });
  }

  private onMessage(m: any) {
    if (m?.tile && !m.type) {
      this.chats.get(m.tile)?.inbox.fire(m.msg);
      return;
    }
    switch (m?.type) {
      case "tiles:ready":
        this.sendLayout();
        break;
      case "tiles:split":
        this.split(String(m.tile));
        break;
      case "tiles:close":
        void this.closeTile(String(m.tile));
        break;
      case "tiles:sizes":
        for (const t of this.tiles) if (typeof m.sizes?.[t.id] === "number") t.size = m.sizes[t.id];
        this.save();
        break;
      case "tiles:moveTab":
        this.moveTab(String(m.from), String(m.key), String(m.to), typeof m.index === "number" ? m.index : undefined, m.side).catch((err) =>
          vscode.window.showWarningMessage(`Pi: ${err.message ?? err}`));
        break;
      case "tiles:merge":
        this.merge(String(m.from), String(m.to)).catch((err) => vscode.window.showWarningMessage(`Pi: ${err.message ?? err}`));
        break;
      case "tiles:moveTile":
        this.moveTile(String(m.from), String(m.to), m.side === "before" ? "before" : "after");
        break;
      case "tiles:focus": {
        const c = this.chats.get(m.tile)?.c;
        if (c) sidebar = lastActive = c;
        break;
      }
    }
  }

  /** Add a tile after `id` with a new session. All tiles get the same size again. */
  private split(id: string) {
    this.addTile(id, "after");
  }

  /** Add a tile before or after `id`. `start`: its tabs (a tab dragged out); else a new session. */
  private addTile(id: string, side: "before" | "after", start?: { tabs: Tab[]; shown: string }) {
    if (this.tiles.length >= MAX_TILES) return;
    const i = Math.max(0, this.tiles.findIndex((t) => t.id === id));
    let n = 2;
    while (this.tiles.some((t) => t.id === `t${n}`)) n++;
    const tile = { id: `t${n}`, size: 1 };
    this.tiles.splice(side === "before" ? i : i + 1, 0, tile);
    this.evenSizes();
    // A tile id can come back after a close: start it without the old tile's tabs.
    this.context.workspaceState.update(`pi.sidebarTabs:${tile.id}`, undefined);
    this.context.workspaceState.update(`pi.sidebarTabs:${tile.id}:shown`, undefined);
    this.createChat(tile.id, start);
    this.save();
    this.sendLayout();
    this.view.webview.postMessage({ type: "tiles:focus", tile: tile.id });
  }

  /**
   * A tab was dropped. In its own tile without `side`: reorder. On another tile: move it there at
   * `index`. With `side`: a new tile before or after `to` with that tab. A tile that loses its last
   * tab closes.
   */
  private async moveTab(from: string, key: string, to: string, index: number | undefined, side?: "before" | "after") {
    const src = this.chats.get(from)?.c;
    const dst = this.chats.get(to)?.c;
    if (!src || !dst) return;
    if (from === to && !side) return src.moveTab(key, index ?? src.tabCount);
    if (side && this.tiles.length >= MAX_TILES) throw new Error(`the sidebar has room for ${MAX_TILES} tiles.`);
    if (side && from === to && src.tabCount < 2) return;
    const out = await src.releaseTab(key);
    if (!out) return;
    if (side) this.addTile(to, side, { tabs: [out.tab], shown: out.tab.key });
    else await dst.adoptTabs([out.tab], index, out.tab.key);
    if (out.empty && this.tiles.length > 1) this.removeTile(from);
  }

  /** A tile was dropped on another one: its tabs join that tile, and it closes. */
  private async merge(from: string, to: string) {
    const src = this.chats.get(from)?.c;
    const dst = this.chats.get(to)?.c;
    if (!src || !dst || from === to) return;
    if (src.hasWork) throw new Error("a session in this tile is still working. Merge the tile when it finishes.");
    const { tabs, shown } = src.tabList();
    // Closing the tile stops its processes, so the other tile can open the files.
    this.removeTile(from);
    await dst.adoptTabs(tabs, undefined, shown && tabs.some((t) => t.key === shown) ? shown : undefined);
  }

  /** A tile was dropped on the edge of another one: move it there. */
  private moveTile(from: string, to: string, side: "before" | "after") {
    const i = this.tiles.findIndex((t) => t.id === from);
    if (i < 0 || from === to) return;
    const [tile] = this.tiles.splice(i, 1);
    const j = this.tiles.findIndex((t) => t.id === to);
    this.tiles.splice(j < 0 ? this.tiles.length : side === "before" ? j : j + 1, 0, tile);
    this.save();
    this.sendLayout();
  }

  /** Close a tile from its menu. A tile whose sessions work asks first. */
  private async closeTile(id: string) {
    const e = this.chats.get(id);
    if (!e || this.tiles.length < 2) return;
    if (e.c.hasWork) {
      const pick = await vscode.window.showWarningMessage("Pi: a session in this tile is still working. Stop it and close the tile?", { modal: true }, "Stop and Close");
      if (pick !== "Stop and Close") return;
    }
    this.removeTile(id);
  }

  private removeTile(id: string) {
    const i = this.tiles.findIndex((t) => t.id === id);
    const e = this.chats.get(id);
    if (i < 0 || !e || this.tiles.length < 2) return;
    this.tiles.splice(i, 1);
    this.evenSizes();
    const nb = this.tiles[Math.max(0, i - 1)];
    this.chats.delete(id);
    e.c.dispose();
    e.inbox.dispose();
    controllers.delete(e.c);
    const next = this.chats.get(nb.id)?.c;
    if (sidebar === e.c) sidebar = next;
    if (lastActive === e.c) lastActive = next;
    this.context.workspaceState.update(`pi.sidebarTabs:${id}`, undefined);
    this.context.workspaceState.update(`pi.sidebarTabs:${id}:shown`, undefined);
    this.updateBadge();
    this.save();
    this.sendLayout();
    this.view.webview.postMessage({ type: "tiles:focus", tile: nb.id });
  }

  dispose() {
    for (const e of this.chats.values()) {
      e.c.dispose();
      e.inbox.dispose();
      controllers.delete(e.c);
      if (sidebar === e.c) sidebar = undefined;
      if (lastActive === e.c) lastActive = undefined;
    }
    this.chats.clear();
    for (const d of this.subs) d.dispose();
  }
}

class SidebarProvider implements vscode.WebviewViewProvider {
  private tiles?: SidebarTiles;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = webviewOptions(this.context.extensionUri);
    // A re-resolved view (e.g. moved to another container) gets fresh chats bound to the new
    // webview; the previous ones are disposed with their processes.
    this.tiles?.dispose();
    const tiles = new SidebarTiles(this.context, view);
    this.tiles = tiles;
    view.onDidChangeVisibility(() => view.visible && (lastActive = sidebar ?? tiles.first));
    view.onDidDispose(() => {
      tiles.dispose();
      if (this.tiles === tiles) this.tiles = undefined;
    });
    view.webview.html = html(view.webview, this.context.extensionUri, { tiles: true });
  }
}

interface PanelOptions {
  /** Editor column for a new tab. */
  column?: vscode.ViewColumn;
  /** A panel that VS Code restored after a reload (see the serializer in `activate`). */
  panel?: vscode.WebviewPanel;
  preserveFocus?: boolean;
}

/**
 * Open a chat in an editor tab. A session file that another chat has open is shown there instead,
 * so that only one process writes it. A restored panel always gets a chat; it starts a new session
 * if its old one is taken.
 */
function openPanel(context: vscode.ExtensionContext, sessionFile?: string, opts: PanelOptions = {}) {
  if (sessionFile && !opts.panel) {
    const owner = PiController.ownerOf(sessionFile);
    if (owner) return void owner.showSession(sessionFile);
  }
  const panel = opts.panel ?? vscode.window.createWebviewPanel(
    "pi.panel",
    "Pi",
    { viewColumn: opts.column ?? vscode.ViewColumn.Beside, preserveFocus: opts.preserveFocus },
    { ...webviewOptions(context.extensionUri), retainContextWhenHidden: true },
  );
  if (opts.panel) panel.webview.options = webviewOptions(context.extensionUri);
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "pi-logo.svg");
  const host: ChatHost = {
    webview: panel.webview,
    // "●" marks a tab whose session works, like the dot of an unsaved file.
    setTitle: (t, busy) => (panel.title = `${busy ? "● " : ""}${t ?? "Pi"}`),
    reveal: () => panel.reveal(),
    openBeside: (file) => openPanel(context, file, { column: vscode.ViewColumn.Beside }),
    kind: "tab",
  };
  const c = new PiController(context, host, output, { primary: false, sessionFile });
  controllers.add(c);
  if (!opts.preserveFocus) lastActive = c;
  panel.onDidChangeViewState(() => panel.active && (lastActive = c));
  panel.onDidDispose(() => {
    c.dispose();
    controllers.delete(c);
    if (lastActive === c) lastActive = sidebar;
  });
  panel.webview.html = html(panel.webview, context.extensionUri);
}

const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

/** Open a session file read-only in a new tab. The tab shows new entries as pi writes them. */
function openSessionViewer(context: vscode.ExtensionContext, file: string) {
  const panel = vscode.window.createWebviewPanel("pi.sessionView", path.basename(file), vscode.ViewColumn.Beside, {
    ...webviewOptions(context.extensionUri),
    retainContextWhenHidden: true,
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "pi-logo.svg");
  const viewer = new SessionViewer(panel, file, workspaceCwd(), async (f) => {
    // A session that changed a moment ago probably has a pi process that still writes it.
    const recent = Date.now() - fs.statSync(f).mtimeMs < 10_000;
    if (recent) {
      const pick = await vscode.window.showWarningMessage(
        "This session changed a few seconds ago. Another pi process can still write it. Open it in a chat anyway?",
        { modal: true },
        "Open",
      );
      if (pick !== "Open") return;
    }
    openPanel(context, f);
  });
  panel.onDidDispose(() => viewer.dispose());
  panel.webview.html = html(panel.webview, context.extensionUri, { readonly: true });
}

async function target(): Promise<PiController | undefined> {
  if (lastActive && controllers.has(lastActive)) return lastActive;
  await vscode.commands.executeCommand("pi.chat.focus");
  return sidebar;
}

function refFor(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, false);
  return rel.includes(" ") ? `@"${rel}"` : `@${rel}`;
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Pi");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("pi.chat", new SidebarProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const cmd = (id: string, fn: (...a: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd("pi.focus", () => vscode.commands.executeCommand("pi.chat.focus"));
  cmd("pi.openInTab", () => openPanel(context));
  cmd("pi.showRunning", () => PiController.pickRunning());
  // Editor tabs come back after a reload. The webview keeps its session file in its state (see `persistSession` in webview/main.ts).
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("pi.panel", {
      async deserializeWebviewPanel(panel, state: any) {
        const file = typeof state?.sessionFile === "string" && fs.existsSync(state.sessionFile) ? state.sessionFile : undefined;
        openPanel(context, file, { panel });
      },
    }),
  );
  cmd("pi.newSession", async () => (await target())?.runBuiltin("new", ""));
  cmd("pi.history", async () => (await target())?.runBuiltin("resume", ""));
  cmd("pi.renameSession", async () => (await target())?.runBuiltin("name", ""));
  cmd("pi.tree", async () => (await target())?.runBuiltin("tree", ""));
  cmd("pi.openInTerminal", async () => (await target())?.openInTerminal());
  // "Pi: Open in Terminal": a fresh pi TUI session in a terminal, no chat attached.
  cmd("pi.newTerminal", () => createPiTerminal([]));
  cmd("pi.restart", async () => (await target())?.restart());
  cmd("pi.selectModel", async () => (await target())?.runBuiltin("model", ""));
  cmd("pi.selectThinking", async () => (await target())?.runBuiltin("thinking", ""));
  cmd("pi.abort", async () => (await target())?.abort());
  // Webview context menu on a link (see the "contextmenu" listener in webview/main.ts).
  cmd("pi.copyLinkAddress", (ctx?: { href?: string }) => ctx?.href && vscode.env.clipboard.writeText(ctx.href));
  cmd("pi.viewSession", async (arg?: vscode.Uri | string) => {
    let file = typeof arg === "string" ? arg : arg?.fsPath;
    if (!file) {
      const picked = await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.file(defaultSessionDir(workspaceCwd())),
        filters: { "Pi sessions": ["jsonl"] },
        openLabel: "View Session",
      });
      file = picked?.[0]?.fsPath;
    }
    if (file) openSessionViewer(context, file);
  });

  cmd("pi.addSelection", async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const sel = ed.selection;
    let text = refFor(ed.document.uri);
    if (!sel.isEmpty) {
      const a = sel.start.line + 1;
      const b = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      text += a === b ? `:${a}` : `:${a}-${b}`;
    }
    (await target())?.insertText(text + " ");
  });

  cmd("pi.addFile", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const list = uris?.length ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
    if (!list.length) return;
    (await target())?.insertText(list.map(refFor).join(" ") + " ");
  });

  output.appendLine(`[pi] extension activated (${path.basename(context.extensionPath)})`);
}

export function deactivate() {
  for (const c of controllers) c.dispose();
  controllers.clear();
}
