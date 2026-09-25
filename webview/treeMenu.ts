/**
 * Session tree navigator: the webview version of the pi TUI's /tree.
 *
 * - Shows every branch of the session. Linear chains stay flat; only branch
 *   points indent their children, using ├─ └─ │ guides like the TUI.
 * - Entries on the active path (root → current leaf) are shown normally,
 *   abandoned branches are muted, and the current leaf is marked.
 * - Selecting an entry and pressing Enter moves the leaf there (via the pi
 *   bridge's /vscode:tree). A user prompt moves to its parent and puts the
 *   prompt back into the composer, so an edited resend starts a new branch.
 * - Shift+Enter summarizes the branch being left. Instructions for the
 *   summary and labels (bookmarks) can be edited inline.
 */

export interface TreeNode {
  id: string;
  parentId: string | null;
  kind: string;
  text: string;
  meta?: string;
  label?: string;
  time?: string;
  hidden: boolean;
  children: string[];
}

export interface TreeDeps {
  post(m: any): void;
  escapeHtml(s: string): string;
  onClose(): void;
  onOpen(): void;
}

interface Row {
  node: TreeNode;
  guide: string;
  onPath: boolean;
}

const KIND_MARK: Record<string, string> = {
  user: "›",
  assistant: "•",
  summary: "≡",
  compaction: "⧉",
  bash: "$",
  custom: "◆",
  tool: "↳",
  model: "⚙",
  thinking: "⚙",
};

function relTime(iso?: string): string {
  if (!iso) return "";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export class TreeMenu {
  open = false;
  private root: HTMLElement;
  private search: HTMLInputElement;
  private list: HTMLElement;
  private footer: HTMLElement;
  private nodes = new Map<string, TreeNode>();
  private roots: string[] = [];
  private leafId: string | null = null;
  private path = new Set<string>();
  private rows: Row[] = [];
  private sel = 0;
  private showAll = false;
  private mode: "idle" | "instructions" | "label" = "idle";
  private busy = "";

  constructor(private deps: TreeDeps, mount: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "list-menu tree-menu hidden";
    this.root.innerHTML = `
      <input class="mp-search" spellcheck="false" placeholder="Session tree · search entries">
      <div class="mp-list tm-list"></div>
      <div class="tm-footer"></div>`;
    mount.appendChild(this.root);
    this.search = this.root.querySelector(".mp-search")!;
    this.list = this.root.querySelector(".tm-list")!;
    this.footer = this.root.querySelector(".tm-footer")!;
    this.search.addEventListener("input", () => {
      this.sel = 0;
      this.renderList();
    });
    this.search.addEventListener("keydown", (e) => this.onKey(e));
    this.root.addEventListener("mousedown", (e) => e.stopPropagation());
    document.addEventListener("mousedown", () => this.open && !this.busy && this.hide());
  }

  // ------------------------------------------------------------ data

  show(data: { nodes: TreeNode[]; leafId: string | null; roots: string[]; query?: string; selectId?: string; refresh?: boolean }) {
    this.nodes = new Map(data.nodes.map((n) => [n.id, n]));
    this.roots = data.roots;
    this.leafId = data.leafId;
    this.path.clear();
    for (let id = this.leafId; id; id = this.nodes.get(id)?.parentId ?? null) this.path.add(id);
    if (!data.refresh) {
      this.search.value = data.query ?? "";
      this.mode = "idle";
    }
    this.open = true;
    this.root.classList.remove("hidden");
    this.deps.onOpen();
    this.renderList(data.selectId ?? this.visibleAncestor(this.leafId));
    this.search.focus();
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add("hidden");
    this.deps.onClose();
  }

  setBusy(text: string) {
    this.busy = text;
    if (!text && this.open) this.hide();
    else this.renderFooter();
  }

  private visible(n: TreeNode | undefined) {
    return !!n && (this.showAll || !n.hidden);
  }

  private visibleAncestor(id: string | null): string | undefined {
    for (let cur = id; cur; cur = this.nodes.get(cur)?.parentId ?? null) if (this.visible(this.nodes.get(cur))) return cur;
    return undefined;
  }

  /** Children as displayed: hidden entries are skipped and their children adopted. */
  private visChildren(ids: string[]): string[] {
    const out: string[] = [];
    const stack = [...ids].reverse();
    while (stack.length) {
      const id = stack.pop()!;
      const n = this.nodes.get(id);
      if (!n) continue;
      if (this.visible(n)) out.push(id);
      else for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
    return out;
  }

  // ------------------------------------------------------------ rendering

  private renderList(selectId?: string) {
    const q = this.search.value.trim().toLowerCase();
    let rows = this.flatten();
    if (q) {
      const words = q.split(/\s+/);
      rows = rows.filter((r) => words.every((w) => `${r.node.text} ${r.node.label ?? ""} ${r.node.kind}`.toLowerCase().includes(w)));
    }
    this.rows = rows;
    if (selectId) this.sel = Math.max(0, rows.findIndex((r) => r.node.id === selectId));
    this.sel = Math.min(this.sel, Math.max(0, rows.length - 1));

    const { escapeHtml } = this.deps;
    this.list.innerHTML = "";
    if (!rows.length) {
      this.list.innerHTML = `<div class="mp-empty">${q ? "No entries match" : "This session has no entries yet"}</div>`;
    }
    rows.forEach((r, i) => {
      const n = r.node;
      const isLeaf = n.id === this.leafId;
      const row = document.createElement("div");
      row.className = `mp-item tm-item${i === this.sel ? " active" : ""}${r.onPath ? " on-path" : " off-path"}${isLeaf ? " leaf" : ""} kind-${n.kind}`;
      row.title = `${n.kind}${n.time ? ` · ${new Date(n.time).toLocaleString()}` : ""}\n${n.text}`;
      row.innerHTML =
        `<span class="tm-guide">${escapeHtml(q ? "" : r.guide)}</span>` +
        `<span class="tm-mark">${KIND_MARK[n.kind] ?? "·"}</span>` +
        `<span class="tm-text">${n.label ? `<span class="tm-label">${escapeHtml(n.label)}</span>` : ""}${escapeHtml(n.text || `(${n.kind})`)}</span>` +
        `<span class="tm-meta">${isLeaf ? `<span class="tm-current">current</span>` : escapeHtml(n.meta ?? relTime(n.time))}</span>`;
      row.addEventListener("mousemove", () => {
        if (this.sel === i) return;
        this.sel = i;
        this.list.querySelectorAll(".tm-item").forEach((x, j) => x.classList.toggle("active", j === i));
        this.renderFooter();
      });
      row.addEventListener("click", () => {
        this.sel = i;
        this.list.querySelectorAll(".tm-item").forEach((x, j) => x.classList.toggle("active", j === i));
        this.renderFooter();
        this.search.focus();
      });
      row.addEventListener("dblclick", () => this.go(false));
      this.list.appendChild(row);
    });
    (this.list.querySelectorAll(".tm-item")[this.sel] as HTMLElement | undefined)?.scrollIntoView({ block: "center" });
    this.renderFooter();
  }

  private current(): TreeNode | undefined {
    return this.rows[this.sel]?.node;
  }

  private renderFooter() {
    const { escapeHtml } = this.deps;
    const n = this.current();
    const f = this.footer;
    f.innerHTML = "";
    if (this.busy) {
      f.innerHTML = `<div class="tm-hint"><span class="spinner">✱</span> ${escapeHtml(this.busy)}</div>`;
      return;
    }
    if (this.mode !== "idle" && n) {
      const isLabel = this.mode === "label";
      const box = document.createElement("div");
      box.className = "tm-edit";
      box.innerHTML = `<input class="tm-input" spellcheck="false" placeholder="${isLabel ? "Label for this entry (empty clears it)" : "Summary instructions, e.g. focus on the API decisions"}">`;
      const inp = box.querySelector("input")!;
      if (isLabel) inp.value = n.label ?? "";
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (isLabel) this.deps.post({ type: "treeLabel", id: n.id, label: inp.value });
          else this.navigate(n, true, inp.value);
          this.mode = "idle";
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.mode = "idle";
          this.renderFooter();
          this.search.focus();
        }
      });
      f.appendChild(box);
      setTimeout(() => inp.focus(), 0);
      return;
    }
    const hint = document.createElement("div");
    hint.className = "tm-hint";
    hint.textContent = !n
      ? ""
      : n.id === this.leafId
        ? "You are here"
        : n.kind === "user"
          ? "Branch before this prompt and put it back in the input to edit and resend"
          : "Continue the conversation from this point";
    const actions = document.createElement("div");
    actions.className = "tm-actions";
    const btn = (label: string, title: string, fn: () => void, primary = false) => {
      const b = document.createElement("button");
      b.className = primary ? "sp-btn primary" : "sp-btn";
      b.textContent = label;
      b.title = title;
      b.disabled = !n;
      b.addEventListener("click", fn);
      actions.appendChild(b);
    };
    const atLeaf = n?.id === this.leafId;
    btn("Go", "Move here (Enter)", () => this.go(false), true);
    btn("Summarize & go", "Summarize the branch you are leaving, then move here (Shift+Enter)", () => this.go(true));
    btn("…", "Summarize with custom instructions (Alt+Enter)", () => this.setMode("instructions"));
    btn("Label", "Set or clear a label (Ctrl+L)", () => this.setMode("label"));
    if (atLeaf) actions.querySelectorAll("button").forEach((b, i) => i < 3 && (b.disabled = true));
    const toggle = document.createElement("button");
    toggle.className = "link tm-toggle";
    toggle.textContent = this.showAll ? "Hide tool/system entries" : "Show all entries";
    toggle.addEventListener("click", () => {
      const id = this.current()?.id;
      this.showAll = !this.showAll;
      this.renderList(id);
      this.search.focus();
    });
    f.append(hint, actions, toggle);
  }

  private setMode(mode: "instructions" | "label") {
    if (!this.current()) return;
    this.mode = mode;
    this.renderFooter();
  }

  private go(summarize: boolean) {
    const n = this.current();
    if (!n || n.id === this.leafId) return;
    this.navigate(n, summarize);
  }

  private navigate(n: TreeNode, summarize: boolean, instructions?: string) {
    this.deps.post({ type: "treeNavigate", id: n.id, summarize, instructions });
  }

  private onKey(e: KeyboardEvent) {
    const n = this.rows.length;
    if (this.busy) {
      e.preventDefault();
      return;
    }
    if (e.key === "ArrowDown" && n) { this.sel = (this.sel + 1) % n; this.renderList(); e.preventDefault(); }
    else if (e.key === "ArrowUp" && n) { this.sel = (this.sel - 1 + n) % n; this.renderList(); e.preventDefault(); }
    else if (e.key === "PageDown" && n) { this.sel = Math.min(n - 1, this.sel + 10); this.renderList(); e.preventDefault(); }
    else if (e.key === "PageUp" && n) { this.sel = Math.max(0, this.sel - 10); this.renderList(); e.preventDefault(); }
    else if (e.key === "Enter" && e.altKey) { this.setMode("instructions"); e.preventDefault(); }
    else if (e.key === "Enter") { this.go(e.shiftKey); e.preventDefault(); }
    else if ((e.key === "l" || e.key === "L") && e.ctrlKey) { this.setMode("label"); e.preventDefault(); }
    else if (e.key === "Escape") { this.hide(); e.preventDefault(); e.stopPropagation(); }
  }

  // ------------------------------------------------------------ flatten

  /**
   * Depth-first flatten with TUI-style guides. Uses an explicit stack of
   * "sibling cursors" so very long sessions don't overflow the call stack.
   */
  private flatten(): Row[] {
    const rows: Row[] = [];
    type Frame = { ids: string[]; i: number; prefix: string; branched: boolean };
    const top = this.visChildren(this.roots);
    const stack: Frame[] = [{ ids: top, i: 0, prefix: "", branched: top.length > 1 }];
    while (stack.length) {
      const f = stack[stack.length - 1];
      if (f.i >= f.ids.length) {
        stack.pop();
        continue;
      }
      const id = f.ids[f.i++];
      const node = this.nodes.get(id)!;
      const last = f.i === f.ids.length;
      const guide = f.branched ? f.prefix + (last ? "└─ " : "├─ ") : f.prefix;
      rows.push({ node, guide, onPath: this.path.has(id) });
      const kids = this.visChildren(node.children);
      if (!kids.length) continue;
      const childPrefix = f.branched ? f.prefix + (last ? "   " : "│  ") : f.prefix;
      stack.push({ ids: kids, i: 0, prefix: childPrefix, branched: kids.length > 1 });
    }
    return rows;
  }
}
