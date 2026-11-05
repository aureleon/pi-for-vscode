import { mountChat, type ChatApi, type ChatInstance } from "./chat";

/**
 * Sidebar tiles: several chats in one webview. The host owns the list of tiles and sends it
 * (`tiles:layout`); this page draws them, resizes them with sashes and routes the messages of each
 * chat (`{ tile, msg }`). Tiles stack top to bottom, or sit side by side when each one has room.
 */

interface TileLayout {
  id: string;
  /** Share of the space (flex-grow). */
  size: number;
}

interface Tile {
  id: string;
  el: HTMLElement;
  chat: ChatInstance;
  size: number;
}

/** Width that each tile needs to sit side by side instead of stacked. */
const ROW_MIN = 320;
/** Smallest tile while a sash is dragged, in px: header and composer stay usable. */
const MIN_PX = { row: 240, col: 140 };

export function mountTiles(vscode: ChatApi, logo: string) {
  const root = document.createElement("div");
  root.className = "tiles";
  document.body.appendChild(root);
  const tiles = new Map<string, Tile>();
  let focused: string | undefined;

  /** A tile's share of the webview API: tagged messages and its own slot of the page state. */
  const apiFor = (id: string): ChatApi => ({
    postMessage: (msg) => vscode.postMessage({ tile: id, msg }),
    getState: () => vscode.getState()?.tiles?.[id],
    setState: (s) => {
      const st = vscode.getState() ?? {};
      vscode.setState({ ...st, tiles: { ...(st.tiles ?? {}), [id]: s } });
    },
  });

  const isRow = () => root.classList.contains("row");
  const updateDirection = () => root.classList.toggle("row", root.clientWidth >= ROW_MIN * Math.max(1, tiles.size));
  new ResizeObserver(updateDirection).observe(root);

  function create(t: TileLayout): Tile {
    const el = document.createElement("div");
    el.className = "tile";
    el.dataset.id = t.id;
    const frame = document.createElement("div");
    el.appendChild(frame);
    const chat = mountChat(frame, apiFor(t.id), {
      header: true,
      logo,
      tiles: {
        split: () => vscode.postMessage({ type: "tiles:split", tile: t.id }),
        close: () => vscode.postMessage({ type: "tiles:close", tile: t.id }),
      },
    });
    const sash = document.createElement("div");
    sash.className = "tile-sash";
    el.appendChild(sash);
    initSash(sash, t.id);
    el.addEventListener("focusin", () => setFocused(t.id, true));
    return { id: t.id, el, chat, size: t.size };
  }

  function setFocused(id: string, tell: boolean) {
    if (focused === id) return;
    focused = id;
    for (const t of tiles.values()) t.el.classList.toggle("focused", t.id === id);
    if (tell) vscode.postMessage({ type: "tiles:focus", tile: id });
  }

  /** Apply the host's list: keep the tiles that stay (so their scroll and input stay), add and remove the others. */
  function layout(list: TileLayout[]) {
    const ids = new Set(list.map((t) => t.id));
    for (const [id, t] of tiles) {
      if (ids.has(id)) continue;
      t.chat.dispose();
      t.el.remove();
      tiles.delete(id);
    }
    let prev: HTMLElement | null = null;
    for (const l of list) {
      let t = tiles.get(l.id);
      if (!t) {
        t = create(l);
        tiles.set(l.id, t);
      }
      t.size = l.size;
      t.el.style.flexGrow = String(l.size);
      // Insert in order without moving tiles that are in place: a moved element loses its scroll position.
      const want: ChildNode | null = prev ? prev.nextSibling : root.firstChild;
      if (want !== t.el) root.insertBefore(t.el, want);
      prev = t.el;
    }
    for (const t of tiles.values()) t.chat.setTileCount(tiles.size);
    updateDirection();
    if (!focused || !tiles.has(focused)) setFocused(list[0]?.id ?? "", false);
  }

  /** Drag the sash on the leading edge of a tile: the tile and the one before it share their space. */
  function initSash(sash: HTMLElement, id: string) {
    let drag: { start: number; a: Tile; b: Tile; pxA: number; pxB: number } | undefined;
    sash.addEventListener("pointerdown", (e) => {
      const b = tiles.get(id);
      const a = b?.el.previousElementSibling && tiles.get((b.el.previousElementSibling as HTMLElement).dataset.id ?? "");
      if (e.button !== 0 || !a || !b) return;
      e.preventDefault();
      const size = (t: Tile) => (isRow() ? t.el.getBoundingClientRect().width : t.el.getBoundingClientRect().height);
      drag = { start: isRow() ? e.clientX : e.clientY, a, b, pxA: size(a), pxB: size(b) };
      try { sash.setPointerCapture(e.pointerId); } catch {}
      sash.classList.add("dragging");
      root.classList.add("resizing");
    });
    sash.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const { a, b, pxA, pxB } = drag;
      const min = isRow() ? MIN_PX.row : MIN_PX.col;
      const total = pxA + pxB;
      const delta = (isRow() ? e.clientX : e.clientY) - drag.start;
      const nextA = Math.max(min, Math.min(total - min, pxA + delta));
      // Keep the sum of the two shares, so that the other tiles do not change.
      const shares = a.size + b.size;
      a.size = (shares * nextA) / total;
      b.size = shares - a.size;
      a.el.style.flexGrow = String(a.size);
      b.el.style.flexGrow = String(b.size);
    });
    const end = (e: PointerEvent) => {
      if (!drag) return;
      drag = undefined;
      try { sash.releasePointerCapture(e.pointerId); } catch {}
      sash.classList.remove("dragging");
      root.classList.remove("resizing");
      vscode.postMessage({ type: "tiles:sizes", sizes: Object.fromEntries([...tiles.values()].map((t) => [t.id, t.size])) });
    };
    sash.addEventListener("pointerup", end);
    sash.addEventListener("pointercancel", end);
    // Double-click: share the space equally.
    sash.addEventListener("dblclick", () => {
      for (const t of tiles.values()) {
        t.size = 1;
        t.el.style.flexGrow = "1";
      }
      vscode.postMessage({ type: "tiles:sizes", sizes: Object.fromEntries([...tiles.values()].map((t) => [t.id, 1])) });
    });
  }

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m?.type === "tiles:layout") layout(m.tiles ?? []);
    else if (m?.type === "tiles:focus") {
      const t = tiles.get(m.tile);
      if (t) {
        setFocused(t.id, false);
        t.chat.focus();
      }
    } else if (m?.tile) tiles.get(m.tile)?.chat.receive(m.msg);
  });
  vscode.postMessage({ type: "tiles:ready" });
}


