import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { AcpChat } from "./acp/chat";
import { acpProfiles, defaultAcpProfile, pickAcpProfile, pickDefaultBackend, type AcpProfile } from "./acp/config";
import { PiController, type ChatHost, type Handover, type Tab } from "./controller";
import { daemonOptions, initDaemonUi, revealSessionWindow, type AcpSessionRow } from "./daemon/ui";
import type { DaemonSession } from "./daemon/protocol";
import { createPiTerminal } from "./piTerminal";
import { SessionViewer } from "./sessionViewer";
import { getShellEnv, setShellEnvLog } from "./shellEnv";
import { defaultSessionDir } from "./sessions";

let output: vscode.OutputChannel;
const controllers = new Set<PiController>();
const acpPanels = new Map<AcpChat, vscode.WebviewPanel>();
let renderAgentSessions: (() => void) | undefined;
let sidebar: PiController | undefined;
let lastActive: PiController | undefined;
let activeAcp: AcpChat | undefined;

/**
 * `tiles`: the sidebar, which holds one or more chats in tiles, each with its header row.
 * `readonly`: the session viewer, with no composer. Editor tabs use their own title bar.
 */
function html(webview: vscode.Webview, extUri: vscode.Uri, opts: { tiles?: boolean; readonly?: boolean; acp?: boolean } = {}): string {
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
<body data-logo="${logo}"${opts.tiles ? ' data-tiles="1"' : ""}${opts.readonly ? ' data-readonly="1"' : ""}${opts.acp ? ' data-acp="1"' : ""}>
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

function acpSessionRow(chat: AcpChat, where: string, show: () => void): AcpSessionRow {
  return { title: chat.sessionTitle, cwd: chat.cwd, profile: chat.backendName, busy: chat.hasWork, key: chat.attachedDaemonKey, where, show };
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
 * Sidebar tiles share the webview. Each tile has a Pi chat and optional ACP session tabs.
 * Messages carry the tile ID and, for ACP tabs, the lane ID.
 */
class SidebarTiles implements vscode.Disposable {
  private tiles: TileState[];
  private chats = new Map<string, { c: PiController; inbox: vscode.EventEmitter<any>; badge: number; tooltip?: string }>();
  private acpChats = new Map<string, { c: AcpChat; inbox: vscode.EventEmitter<any>; tile: string; title: string; replacedPi?: string }>();
  private activeLanes = new Map<string, string>();
  private openingLanes = new Set<string>();
  private disposed = false;
  private activeTile?: string;
  private startupProfile?: AcpProfile;
  private acpTabId = 0;
  private subs: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly view: vscode.WebviewView) {
    const saved = context.workspaceState.get<TileState[]>(TILES_KEY) ?? [];
    this.tiles = saved.filter((t) => typeof t?.id === "string").slice(0, MAX_TILES);
    if (!this.tiles.length) this.tiles = [{ id: "t1", size: 1 }];
    this.startupProfile = defaultAcpProfile();
    for (const [i, t] of this.tiles.entries()) this.createChat(t.id, undefined, i === 0 && !!this.startupProfile);
    this.subs.push(view.webview.onDidReceiveMessage((m) => this.onMessage(m)),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("pi.acp")) this.sendProfiles(); }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.sendProfiles()));
  }

  /** The chat of the first tile, for commands when no tile had focus yet. */
  get first(): PiController | undefined {
    return this.tiles.map((t) => this.chats.get(t.id)?.c).find((c) => !!c);
  }

  acpSessionRows(): AcpSessionRow[] {
    return [...this.acpChats].map(([key, { c }]) => acpSessionRow(c, "sidebar", () => this.revealAcpTab(key)));
  }

  private revealAcpTab(key: string) {
    const entry = this.acpChats.get(key);
    if (!entry) return;
    this.view.show();
    this.selectLane(entry.tile, key);
  }

  /** `start`: tabs for a new tile (a tab dragged out of another tile) and the session to show. */
  private createChat(id: string, start?: { tabs: Tab[]; shown: string; handover?: Handover }, deferStart = false) {
    const inbox = new vscode.EventEmitter<any>();
    const host: ChatHost = {
      webview: {
        postMessage: (msg) => this.view.webview.postMessage({ tile: id, msg }),
        onDidReceiveMessage: inbox.event,
      },
      // The native title is PiMux. Each tile header shows its session tabs.
      setTitle: () => {},
      setBadge: (count, tooltip) => {
        const e = this.chats.get(id);
        if (e) (e.badge = count), (e.tooltip = tooltip);
        this.updateBadge();
      },
      reveal: () => {
        this.view.show(true);
        this.selectLane(id);
      },
      openBeside: (file) => openPanel(this.context, file, { column: vscode.ViewColumn.Beside }),
      kind: "sidebar",
      closeChat: () => {
        if (this.tiles.length < 2 || this.hasAcpTabs(id)) return false;
        // After the controller's own call returns.
        setTimeout(() => this.removeTile(id), 0);
        return true;
      },
    };
    const first = id === "t1";
    const c = new PiController(this.context, host, output, {
      primary: first && !start,
      deferStart,
      tabsKey: first ? "pi.sidebarTabs" : `pi.sidebarTabs:${id}`,
      tabs: start?.tabs,
      sessionFile: start?.handover ? undefined : start?.shown,
    });
    if (start?.handover) c.adoptFirst(start.handover);
    this.chats.set(id, { c, inbox, badge: 0 });
    controllers.add(c);
    if (!sidebar) sidebar = c;
    lastActive ??= c;
  }

  /** One badge on the view: the sum of the tiles' badges. */
  private updateBadge() {
    const all = [...this.chats.values()];
    const acpBusy = [...this.acpChats.values()].filter(({ c }) => c.hasWork).length;
    const count = all.reduce((n, e) => n + e.badge, acpBusy);
    const tooltip = all.filter((e) => e.badge).map((e) => e.tooltip);
    if (acpBusy) tooltip.push(`ACP chats working: ${acpBusy}`);
    this.view.badge = count > 0 ? { value: count, tooltip: tooltip.filter(Boolean).join("\n") || String(count) } : undefined;
  }

  private sendProfiles() {
    void this.view.webview.postMessage({
      type: "tiles:acpProfiles", names: acpProfiles().map((p) => p.name), defaultProfile: defaultAcpProfile()?.name,
    });
  }

  async newDefaultSession(profile: AcpProfile): Promise<void> {
    if (!this.startupProfile) await this.addAcpTab(this.activeTile ?? this.tiles[0].id, false, profile.name);
  }

  private async addAcpTab(tile: string, replaceEmpty = false, name?: string) {
    const pi = this.chats.get(tile);
    if (!pi || this.openingLanes.has(tile)) return;
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("Trust this workspace before starting an ACP agent.");
      return;
    }
    this.openingLanes.add(tile);
    const previousLane = this.activeLanes.get(tile);
    const emptyPi = replaceEmpty && !previousLane ? pi.c.emptySessionKey : undefined;
    try {
      const profile = name === undefined ? await pickAcpProfile() : acpProfiles().find((p) => p.name === name);
      if (!profile && name !== undefined) {
        this.sendProfiles();
        void vscode.window.showWarningMessage("This ACP profile is no longer configured.");
      }
      if (!profile || this.disposed || this.chats.get(tile) !== pi || this.activeLanes.get(tile) !== previousLane) return;
      const key = `acp-${++this.acpTabId}`;
      const inbox = new vscode.EventEmitter<any>();
      const c = new AcpChat({
        postMessage: (msg) => this.view.webview.postMessage({ tile, lane: key, msg }),
        onDidReceiveMessage: inbox.event,
      }, acpCwd(), output, (title) => {
        const entry = this.acpChats.get(key);
        if (entry) entry.title = title;
        this.sendLanes(tile);
        this.updateBadge();
        renderAgentSessions?.();
      }, daemonOptions(this.context), profile, undefined, undefined, () => revealSessionWindow(() => this.revealAcpTab(key)));
      const replacedPi = emptyPi && !this.activeLanes.has(tile) && pi.c.emptySessionKey === emptyPi ? emptyPi : undefined;
      this.acpChats.set(key, { c, inbox, tile, title: "New session", replacedPi });
      this.selectLane(tile, key, !!replacedPi);
    } catch (e) {
      void vscode.window.showErrorMessage(`Pi: ${String((e as Error)?.message ?? e)}`);
    } finally {
      this.openingLanes.delete(tile);
    }
  }

  private async pickBackend(tile: string, backend: unknown, replaceEmpty: boolean, name?: string) {
    const entry = this.chats.get(tile);
    if (!entry) return;
    const lane = this.activeLanes.get(tile);
    if (backend === "acp") {
      if (name === undefined && replaceEmpty && lane && this.acpChats.get(lane)?.c.isEmptySession) return this.focusTile(tile);
      await this.addAcpTab(tile, replaceEmpty, name);
    } else if (backend === "pi") {
      if (replaceEmpty && !lane && entry.c.emptySessionKey) return this.focusTile(tile);
      if (replaceEmpty && lane && this.acpChats.get(lane)?.c.isEmptySession) {
        const reusePi = !!entry.c.emptySessionKey;
        this.removeAcp(lane);
        this.selectLane(tile, undefined, true, reusePi);
        if (!reusePi) entry.inbox.fire({ type: "builtin", name: "new", arg: "" });
        return;
      }
      const emptyPi = entry.c.emptySessionKey;
      const parked = !!emptyPi && [...this.acpChats.values()].some((chat) => chat.tile === tile && chat.replacedPi === emptyPi);
      this.selectLane(tile, undefined, false, parked);
      if (!parked) entry.inbox.fire({ type: "builtin", name: "new", arg: "" });
    }
  }

  private hasAcpTabs(tile: string) {
    return [...this.acpChats.values()].some((entry) => entry.tile === tile);
  }

  private sendLanes(tile: string, transferDraft = false) {
    const tabs = [...this.acpChats].filter(([, entry]) => entry.tile === tile)
      .map(([key, entry]) => ({ key, title: entry.title, busy: entry.c.hasWork, replacedPi: entry.replacedPi }));
    void this.view.webview.postMessage({ type: "tiles:lanes", tile, tabs, active: this.activeLanes.get(tile), transferDraft });
  }

  private selectLane(tile: string, lane?: string, transferDraft = false, startPi = true) {
    const pi = this.chats.get(tile)?.c;
    if (!pi) return;
    if (lane) {
      if (this.acpChats.get(lane)?.tile !== tile) return;
      this.activeLanes.set(tile, lane);
    } else {
      if (startPi) pi.showDeferred();
      const key = pi.emptySessionKey;
      if (key) for (const entry of this.acpChats.values()) {
        if (entry.tile === tile && entry.replacedPi === key) entry.replacedPi = undefined;
      }
      this.activeLanes.delete(tile);
    }
    this.sendLanes(tile, transferDraft);
    this.focusTile(tile);
  }

  private async closeLane(tile: string, lane: string) {
    const entry = this.acpChats.get(lane);
    if (!entry || entry.tile !== tile) return;
    if (entry.c.hasWork) {
      const yes = await vscode.window.showWarningMessage("Pi: stop this ACP session and close its tab?", { modal: true }, "Stop and Close");
      if (yes !== "Stop and Close" || this.acpChats.get(lane) !== entry) return;
    }
    this.removeAcp(lane);
    if (this.activeLanes.get(tile) === lane) this.selectLane(tile);
    else this.sendLanes(tile);
    this.updateBadge();
  }

  private removeAcp(key: string, stop = true) {
    const entry = this.acpChats.get(key);
    if (!entry) return;
    this.acpChats.delete(key);
    if (activeAcp === entry.c) activeAcp = undefined;
    if (stop) entry.c.close();
    else entry.c.dispose();
    entry.inbox.dispose();
    renderAgentSessions?.();
  }

  private noteFocus(id: string) {
    this.activeTile = id;
    const lane = this.activeLanes.get(id);
    activeAcp = lane ? this.acpChats.get(lane)?.c : undefined;
    const c = this.chats.get(id)?.c;
    if (c && !activeAcp) sidebar = lastActive = c;
  }

  private focusTile(id: string) {
    this.noteFocus(id);
    this.view.webview.postMessage({ type: "tiles:focus", tile: id });
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
      if (m.lane) {
        const acp = this.acpChats.get(m.lane);
        if (acp?.tile === m.tile) acp?.inbox.fire(m.msg);
      } else this.chats.get(m.tile)?.inbox.fire(m.msg);
      return;
    }
    switch (m?.type) {
      case "tiles:ready":
        this.sendProfiles();
        this.sendLayout();
        for (const tile of this.tiles) if (this.hasAcpTabs(tile.id)) this.sendLanes(tile.id);
        if (this.startupProfile) {
          const tile = this.tiles[0].id;
          const profile = this.startupProfile;
          this.startupProfile = undefined;
          if (!this.hasAcpTabs(tile)) this.openDefaultLane(tile, profile);
        } else if (this.activeTile) this.focusTile(this.activeTile);
        break;
      case "tiles:split":
        this.split(String(m.tile));
        break;
      case "tiles:newDefault": {
        const tile = String(m.tile);
        const profile = defaultAcpProfile();
        if (profile) void this.addAcpTab(tile, false, profile.name);
        else void this.pickBackend(tile, "pi", false);
        break;
      }
      case "tiles:pickBackend":
        void this.pickBackend(String(m.tile), m.backend, m.replaceEmpty === true, typeof m.profile === "string" ? m.profile : undefined);
        break;
      case "tiles:pickDefaultBackend":
        void pickDefaultBackend().catch((e: Error) => vscode.window.showErrorMessage(`Could not change the default backend: ${e.message}`));
        break;
      case "tiles:configureAcpProfiles":
        void vscode.commands.executeCommand("workbench.action.openSettings", "@id:pi.acp.profiles");
        break;
      case "tiles:pickLane":
        this.selectLane(String(m.tile), typeof m.lane === "string" ? m.lane : undefined);
        break;
      case "tiles:closeLane":
        void this.closeLane(String(m.tile), String(m.lane));
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
        if (this.tiles.some((t) => t.id === m.tile)) this.noteFocus(m.tile);
        break;
      }
    }
  }

  private openDefaultLane(tile: string, profile: AcpProfile) {
    void this.addAcpTab(tile, false, profile.name).then(() => {
      if (!this.activeLanes.has(tile)) this.selectLane(tile);
    });
  }

  /** Add a tile after `id` with a new session. All tiles get the same size again. */
  private split(id: string) {
    const profile = defaultAcpProfile();
    // A Pi split can reuse the parent's spare process.
    const handover = profile ? undefined : this.chats.get(id)?.c.takeSpare();
    this.addTile(id, "after", handover ? { tabs: [], shown: handover.file ?? "", handover } : undefined, profile);
  }

  /** Add a tile before or after `id`. `start`: its tabs (a tab dragged out); else a new session. */
  private addTile(id: string, side: "before" | "after", start?: { tabs: Tab[]; shown: string; handover?: Handover }, profile?: AcpProfile) {
    if (this.tiles.length >= MAX_TILES) {
      start?.handover?.pi.stop();
      return;
    }
    const i = Math.max(0, this.tiles.findIndex((t) => t.id === id));
    let n = 2;
    while (this.tiles.some((t) => t.id === `t${n}`)) n++;
    const tile = { id: `t${n}`, size: 1 };
    this.tiles.splice(side === "before" ? i : i + 1, 0, tile);
    this.evenSizes();
    // A tile id can come back after a close: start it without the old tile's tabs.
    this.context.workspaceState.update(`pi.sidebarTabs:${tile.id}`, undefined);
    this.context.workspaceState.update(`pi.sidebarTabs:${tile.id}:shown`, undefined);
    this.createChat(tile.id, start, !!profile);
    this.save();
    this.sendLayout();
    if (profile) this.openDefaultLane(tile.id, profile);
    else this.focusTile(tile.id);
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
    // The process moves with the tab, so the session shows at once in the other tile.
    if (side) this.addTile(to, side, { tabs: [out.tab], shown: out.tab.key, handover: out.handover });
    else await dst.adoptTabs([out.tab], index, out.tab.key, out.handover ? [out.handover] : []);
    if (out.empty && this.tiles.length > 1 && !this.hasAcpTabs(from)) this.removeTile(from);
    if (!side) this.selectLane(to);
  }

  /** A tile was dropped on another one: its tabs join that tile, and it closes. */
  private async merge(from: string, to: string) {
    const src = this.chats.get(from)?.c;
    const dst = this.chats.get(to)?.c;
    if (!src || !dst || from === to || this.hasAcpTabs(from) || this.hasAcpTabs(to)) return;
    const { tabs, shown } = src.tabList();
    // The processes move to the other tile; closing this tile stops only what is left.
    const handovers = src.detachAll();
    this.removeTile(from);
    this.focusTile(to);
    await dst.adoptTabs(tabs, undefined, shown && tabs.some((t) => t.key === shown) ? shown : undefined, handovers);
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
    if (e.c.hasWork || [...this.acpChats.values()].some((a) => a.tile === id && a.c.hasWork)) {
      const pick = await vscode.window.showWarningMessage("Pi: a session in this tile is still working. Stop it and close the tile?", { modal: true }, "Stop and Close");
      if (pick !== "Stop and Close") return;
    }
    this.removeTile(id);
  }

  private removeTile(id: string) {
    const i = this.tiles.findIndex((t) => t.id === id);
    const pi = this.chats.get(id);
    if (i < 0 || !pi || this.tiles.length < 2) return;
    this.tiles.splice(i, 1);
    this.evenSizes();
    const nb = this.tiles[Math.max(0, i - 1)];
    // The user closed the tile (and agreed to stop its work).
    this.chats.delete(id);
    pi.c.dispose(true);
    pi.inbox.dispose();
    controllers.delete(pi.c);
    const next = this.chats.get(nb.id)?.c ?? this.first;
    if (sidebar === pi.c) sidebar = next;
    if (lastActive === pi.c) lastActive = next;
    this.context.workspaceState.update(`pi.sidebarTabs:${id}`, undefined);
    this.context.workspaceState.update(`pi.sidebarTabs:${id}:shown`, undefined);
    for (const [key, entry] of this.acpChats) if (entry.tile === id) this.removeAcp(key);
    this.activeLanes.delete(id);
    this.updateBadge();
    this.save();
    this.sendLayout();
    this.focusTile(nb.id);
  }

  dispose() {
    this.disposed = true;
    for (const e of this.chats.values()) {
      e.c.dispose();
      e.inbox.dispose();
      controllers.delete(e.c);
      if (sidebar === e.c) sidebar = undefined;
      if (lastActive === e.c) lastActive = undefined;
    }
    this.chats.clear();
    for (const key of this.acpChats.keys()) this.removeAcp(key, false);
    for (const d of this.subs.splice(0)) d.dispose();
  }
}

class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private tiles?: SidebarTiles;

  constructor(private readonly context: vscode.ExtensionContext) {}

  newDefaultSession(profile: AcpProfile) {
    return this.tiles?.newDefaultSession(profile);
  }

  acpSessionRows(): AcpSessionRow[] {
    return this.tiles?.acpSessionRows() ?? [];
  }

  dispose() {
    this.tiles?.dispose();
    this.tiles = undefined;
  }

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
  detached?: DaemonSession;
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
  const c = new PiController(context, host, output, {
    primary: false, sessionFile, cwd: opts.detached?.cwd, deferStart: !!opts.detached,
  });
  if (opts.detached) void c.start(sessionFile, undefined, { attachKey: opts.detached.key }).catch((err) => {
    void vscode.window.showErrorMessage(`Pi: ${err.message ?? err}`);
  });
  controllers.add(c);
  const noteFocus = () => {
    lastActive = c;
    activeAcp = undefined;
  };
  if (!opts.preserveFocus) noteFocus();
  panel.onDidChangeViewState(() => { if (panel.active) noteFocus(); });
  panel.onDidDispose(() => {
    c.dispose();
    controllers.delete(c);
    if (lastActive === c) lastActive = sidebar;
  });
  panel.webview.html = html(panel.webview, context.extensionUri);
}

const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

function acpCwd() {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return (uri && vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath) ?? workspaceCwd();
}

async function openAcpPanel(context: vscode.ExtensionContext, detached?: DaemonSession, name?: string) {
  let profile: AcpProfile | undefined;
  try {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage("Pi: trust this workspace before reconnecting to an ACP agent.");
      return;
    }
    if (!detached) {
      profile = name === undefined ? await pickAcpProfile() : acpProfiles().find((p) => p.name === name);
      if (!profile) {
        if (name !== undefined) void vscode.window.showWarningMessage("This ACP profile is no longer configured.");
        return;
      }
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`Pi: ${String((e as Error)?.message ?? e)}`);
    return;
  }
  const cwd = detached?.cwd ?? acpCwd();
  const panel = vscode.window.createWebviewPanel("pi.acpChat", detached?.name || "New session", vscode.ViewColumn.Beside, {
    ...webviewOptions(context.extensionUri),
    retainContextWhenHidden: true,
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "acp-logo.svg");
  const chat = new AcpChat(panel.webview, cwd, output, (title, busy) => {
    panel.title = `${busy ? "● " : ""}${title}`;
    renderAgentSessions?.();
  }, detached ? { ...daemonOptions(context, true)!, key: detached.key } : daemonOptions(context), profile, detached?.acpBackend, (backend, name) => {
    if (backend === "pi") openPanel(context);
    else void openAcpPanel(context, undefined, name);
  }, () => revealSessionWindow(() => {
    if (acpPanels.has(chat)) panel.reveal();
  }));
  acpPanels.set(chat, panel);
  activeAcp = chat;
  panel.onDidChangeViewState(() => { if (panel.active) activeAcp = chat; });
  panel.onDidDispose(() => {
    if (activeAcp === chat) activeAcp = undefined;
    acpPanels.delete(chat);
    // VS Code also disposes panels when its window closes. Stop daemon sessions from the session list.
    chat.dispose();
    renderAgentSessions?.();
  });
  panel.webview.html = html(panel.webview, context.extensionUri, { acp: true });
}

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
  if (activeAcp) return undefined;
  if (lastActive && controllers.has(lastActive)) return lastActive;
  await vscode.commands.executeCommand("pi.chat.focus");
  return activeAcp ? undefined : sidebar;
}

function refFor(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, false);
  return rel.includes(" ") ? `@"${rel}"` : `@${rel}`;
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Pi");
  context.subscriptions.push(output);
  setShellEnvLog((line) => output.appendLine(line));
  // Read the login shell's environment now (about a second); the first pi start needs it.
  void getShellEnv(vscode.workspace.getConfiguration("pi").get<boolean>("useLoginShellEnv", true));

  const provider = new SidebarProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider("pi.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const cmd = (id: string, fn: (...a: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd("pi.focus", () => vscode.commands.executeCommand("pi.chat.focus"));
  cmd("pi.openInTab", () => {
    const profile = defaultAcpProfile();
    if (profile) return openAcpPanel(context, undefined, profile.name);
    openPanel(context);
  });
  cmd("pi.newAcpChat", () => openAcpPanel(context));
  cmd("pi.showRunning", () => vscode.commands.executeCommand("pi.daemonSessions"));
  // Editor tabs come back after a reload. The webview keeps its session file in its state (see `persistSession` in webview/main.ts).
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("pi.panel", {
      async deserializeWebviewPanel(panel, state: any) {
        const file = typeof state?.sessionFile === "string" && fs.existsSync(state.sessionFile) ? state.sessionFile : undefined;
        openPanel(context, file, { panel });
      },
    }),
  );
  cmd("pi.newSession", async () => {
    const profile = defaultAcpProfile();
    if (!profile) return (await target())?.runBuiltin("new", "");
    if (activeAcp ? acpPanels.has(activeAcp) : lastActive?.isEditorChat) {
      return openAcpPanel(context, undefined, profile.name);
    }
    await vscode.commands.executeCommand("pi.chat.focus");
    return provider.newDefaultSession(profile);
  });
  cmd("pi.history", async () => (await target())?.runBuiltin("resume", ""));
  cmd("pi.renameSession", async () => activeAcp ? activeAcp.promptRename() : (await target())?.runBuiltin("name", ""));
  cmd("pi.generateTitle", async () => activeAcp ? activeAcp.generateTitle() : (await target())?.runBuiltin("title", ""));
  cmd("pi.find", async () => (await target())?.find());
  cmd("pi.tree", async () => (await target())?.runBuiltin("tree", ""));
  cmd("pi.openInTerminal", async () => (await target())?.openInTerminal());
  // "Pi: Open in Terminal": a fresh pi TUI session in a terminal, no chat attached.
  cmd("pi.newTerminal", () => createPiTerminal([]));
  cmd("pi.restart", async () => (await target())?.restart());
  cmd("pi.selectModel", async () => activeAcp ? activeAcp.openModelPicker() : (await target())?.runBuiltin("model", ""));
  cmd("pi.selectThinking", async () => activeAcp ? activeAcp.openModelPicker(true) : (await target())?.runBuiltin("thinking", ""));
  cmd("pi.abort", async () => activeAcp ? activeAcp.abort() : (await target())?.abort());
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

  // The session daemon in the status bar (setting `pi.keepSessionsAlive`).
  const daemonUi = initDaemonUi(context, {
    cwd: workspaceCwd,
    running: () => PiController.running(),
    acpSessions: () => [
      ...provider.acpSessionRows(),
      ...[...acpPanels].map(([chat, panel]) => acpSessionRow(chat, "tab", () => {
        if (acpPanels.has(chat)) panel.reveal();
      })),
    ],
    files: () => PiController.openFiles(),
    openAcp: (session) => void openAcpPanel(context, session),
    reconnectPi: (session) => openPanel(context, session.file, { detached: session }),
    isAcpActive: () => !!activeAcp,
    log: (line) => output.appendLine(line),
    open: (file) => void target().then((c) => c ? c.open(file) : openPanel(context, file))
      .then(() => daemonUi.refresh(), (err) => vscode.window.showErrorMessage(`Pi: ${err.message ?? err}`)),
    show: (file) => {
      const owner = PiController.ownerOf(file);
      void owner?.showSession(file);
      return !!owner;
    },
  });

  PiController.onStatusChanged = renderAgentSessions = daemonUi.render;
  context.subscriptions.push({ dispose: () => { PiController.onStatusChanged = renderAgentSessions = undefined; } });

  output.appendLine(`[pi] extension activated (${path.basename(context.extensionPath)})`);
}

export function deactivate() {
  for (const chat of acpPanels.keys()) chat.dispose();
  acpPanels.clear();
  for (const c of controllers) c.dispose();
  controllers.clear();
}
