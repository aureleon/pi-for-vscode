import { MAX_TILES, mountChat, type ChatApi, type ChatInstance } from "./chat";

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

  initDrag();

  // ---------------------------------------------------------------- drag tabs and tiles

  type Drop =
    | { kind: "tabs"; tile: string; index: number }
    | { kind: "into"; tile: string }
    | { kind: "edge"; tile: string; side: "before" | "after" };

  /**
   * Pointer drags (not HTML drag and drop, which VS Code takes for drops into the editor).
   * A tab: to its strip (reorder), another tile's strip or middle (move), or a tile's edge (new tile).
   * A tile, by the empty part of its header: another tile's middle or header (merge), or an edge (move).
   */
  function initDrag() {
    let press: { x: number; y: number; id: number; tile: string; key?: string; label: string } | undefined;
    let active = false;
    let ghost: HTMLElement | undefined;
    let zone: HTMLElement | undefined;
    let line: HTMLElement | undefined;
    let drop: Drop | undefined;
    let dropKey = "";
    /** Rectangles of the tiles, their headers and their tabs, measured when the drag starts. */
    let geo: { id: string; rect: DOMRect; bar: DOMRect; strip: DOMRect; tabs: { left: number; right: number }[] }[] = [];
    let suppressClickUntil = 0;
    /** The last pointer position; one frame handles the moves in between. */
    let at: { x: number; y: number } | undefined;
    let frameReq = 0;

    const tabCount = (tile: string) => tiles.get(tile)?.el.querySelectorAll('.tab[data-key]:not([data-key=""])').length ?? 0;

    root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      const tileEl = t.closest<HTMLElement>(".tile");
      if (!tileEl || !t.closest(".topbar") || t.closest("button, input, .tb-menu")) return;
      const tab = t.closest<HTMLElement>(".tab");
      if (tab && !tab.dataset.key) return;
      // No text selection while dragging. (A user-select rule during the drag would restyle the whole page.)
      e.preventDefault();
      press = {
        x: e.clientX, y: e.clientY, id: e.pointerId, tile: tileEl.dataset.id ?? "", key: tab?.dataset.key,
        label: (tab ?? tileEl.querySelector(".tab.active"))?.querySelector(".tab-label, .topbar-title")?.textContent ?? "Pi",
      };
    });
    root.addEventListener("pointermove", (e) => {
      if (!press || e.pointerId !== press.id) return;
      if (!active) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5) return;
        // Dragging a tile needs another tile to go to.
        if (!press.key && tiles.size < 2) return;
        begin();
      }
      at = { x: e.clientX, y: e.clientY };
      frameReq ||= requestAnimationFrame(update);
    });
    /** Once per frame: move the ghost, and redraw the drop marker only when the drop changes. */
    function update() {
      frameReq = 0;
      if (!active || !at) return;
      ghost!.style.transform = `translate(${at.x + 12}px, ${at.y + 10}px)`;
      drop = target(at.x, at.y);
      const key = JSON.stringify(drop ?? null);
      if (key === dropKey) return;
      dropKey = key;
      show(drop);
    }
    const finish = (e: PointerEvent, ok: boolean) => {
      if (!press || e.pointerId !== press.id) return;
      const p = press;
      press = undefined;
      if (!active) return;
      const d = drop;
      end();
      suppressClickUntil = performance.now() + 400;
      if (ok && d) send(p, d);
    };
    root.addEventListener("pointerup", (e) => finish(e, true));
    root.addEventListener("pointercancel", (e) => finish(e, false));
    window.addEventListener("keydown", (e) => {
      if (active && e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        press = undefined;
        end();
      }
    }, true);
    // The click after a drag must not select a tab.
    window.addEventListener("click", (e) => {
      if (performance.now() < suppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
        suppressClickUntil = 0;
      }
    }, true);

    function begin() {
      active = true;
      try { root.setPointerCapture(press!.id); } catch {}
      root.classList.add("dragging");
      const src = tiles.get(press!.tile)?.el;
      if (press!.key) src?.querySelector(`.tab[data-key="${CSS.escape(press!.key)}"]`)?.classList.add("drag-source");
      measure();
      ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = press!.key ? press!.label : `${press!.label} (tile)`;
      document.body.appendChild(ghost);
      zone = document.createElement("div");
      zone.className = "drop-zone";
      line = document.createElement("div");
      line.className = "drop-line";
    }

    function end() {
      active = false;
      drop = undefined;
      dropKey = "";
      at = undefined;
      cancelAnimationFrame(frameReq);
      frameReq = 0;
      root.classList.remove("dragging");
      root.querySelectorAll(".drag-source").forEach((x) => x.classList.remove("drag-source"));
      ghost?.remove();
      zone?.remove();
      line?.remove();
    }

    function measure() {
      geo = [...tiles.values()].map((t) => {
        const bar = t.el.querySelector<HTMLElement>(".topbar")!;
        return {
          id: t.id,
          rect: t.el.getBoundingClientRect(),
          bar: bar.getBoundingClientRect(),
          strip: (bar.querySelector(".tb-tabs") ?? bar).getBoundingClientRect(),
          tabs: [...t.el.querySelectorAll<HTMLElement>('.tab[data-key]:not([data-key=""])')].map((el) => {
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right };
          }),
        };
      });
    }

    const inside = (r: DOMRect, x: number, y: number) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;

    /** What a drop at (x, y) would do. Uses the measured rectangles: no hit test on each move. */
    function target(x: number, y: number): Drop | undefined {
      const p = press!;
      const g = geo.find((t) => inside(t.rect, x, y));
      if (!g) return undefined;
      const tile = g.id;
      const canSplit = tiles.size < MAX_TILES && !(tile === p.tile && tabCount(p.tile) < 2);
      if (inside(g.bar, x, y)) {
        if (!p.key) return tile === p.tile ? undefined : { kind: "into", tile };
        return { kind: "tabs", tile, index: g.tabs.filter((t) => (t.left + t.right) / 2 < x).length };
      }
      const r = g.rect;
      const row = root.classList.contains("row");
      const f = row ? (x - r.left) / r.width : (y - r.top) / r.height;
      if (!p.key) {
        if (tile === p.tile) return undefined;
        if (f < 0.25) return { kind: "edge", tile, side: "before" };
        if (f > 0.75) return { kind: "edge", tile, side: "after" };
        return { kind: "into", tile };
      }
      if (canSplit && f < 0.25) return { kind: "edge", tile, side: "before" };
      if (canSplit && f > 0.75) return { kind: "edge", tile, side: "after" };
      return tile === p.tile ? undefined : { kind: "into", tile };
    }

    /** Draw the drop marker. It is a fixed layer on the body, so the tiles do not lay out again. */
    function show(d: Drop | undefined) {
      zone!.remove();
      line!.remove();
      const g = d && geo.find((t) => t.id === d.tile);
      if (!d || !g) return;
      const box = (el: HTMLElement, r: { left: number; top: number; width: number; height: number }) => {
        el.style.left = `${r.left}px`;
        el.style.top = `${r.top}px`;
        el.style.width = `${r.width}px`;
        el.style.height = `${r.height}px`;
        document.body.appendChild(el);
      };
      const t = g.rect;
      if (d.kind === "tabs") {
        const strip = g.strip;
        const x = g.tabs[d.index]?.left ?? (g.tabs.length ? g.tabs[g.tabs.length - 1].right : strip.left);
        box(line!, { left: x - 1, top: strip.top + 4, width: 2, height: strip.height - 8 });
        return;
      }
      const row = root.classList.contains("row");
      let r = { left: t.left, top: t.top, width: t.width, height: t.height };
      if (d.kind === "edge") {
        if (row) r = { ...r, width: t.width / 2, left: d.side === "before" ? t.left : t.left + t.width / 2 };
        else r = { ...r, height: t.height / 2, top: d.side === "before" ? t.top : t.top + t.height / 2 };
      }
      box(zone!, r);
    }

    function send(p: NonNullable<typeof press>, d: Drop) {
      if (p.key) {
        if (d.kind === "tabs") vscode.postMessage({ type: "tiles:moveTab", from: p.tile, key: p.key, to: d.tile, index: d.index });
        else if (d.kind === "into") vscode.postMessage({ type: "tiles:moveTab", from: p.tile, key: p.key, to: d.tile });
        else vscode.postMessage({ type: "tiles:moveTab", from: p.tile, key: p.key, to: d.tile, side: d.side });
      } else if (d.kind === "edge") vscode.postMessage({ type: "tiles:moveTile", from: p.tile, to: d.tile, side: d.side });
      else vscode.postMessage({ type: "tiles:merge", from: p.tile, to: d.tile });
    }
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


