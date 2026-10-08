import { marked } from "marked";
import { ansiToHtml, escapeHtml, stripAnsi } from "./ansi";
import { WEB_INTEGRATIONS, WEB_WORKAROUNDS, type PiCommand, type WebIntegration, type WebIntegrationInstance } from "./integrations";
import { TreeMenu } from "./treeMenu";
import { SPINNER } from "./spinner";
import { highlightMarkdown } from "./mdHighlight";
import { StreamingMarkdown } from "./streamMd";
import { fmtDuration } from "./duration";

declare function acquireVsCodeApi(): { postMessage(m: any): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const post = (m: any) => vscode.postMessage(m);

// ------------------------------------------------------------------ markdown

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    // Never render raw HTML from the model.
    html(token: any) {
      return escapeHtml(token.text ?? token.raw ?? "");
    },
  },
});
const md = (s: string) => marked.parse(s ?? "", { async: false }) as string;
/** Markdown for what the user typed: single newlines stay line breaks, like the input. */
const mdUser = (s: string) => marked.parse(s ?? "", { async: false, breaks: true }) as string;

// ------------------------------------------------------------------ icons

const I = {
  history: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 1-6.1 8.7l1-.4A5.5 5.5 0 1 0 3.3 5H5.5v1h-4V2h1v2.1A6.5 6.5 0 0 1 8 1.5zM7.5 4h1v3.8l2.6 1.5-.5.9-3.1-1.8V4z"/></svg>`,
  plus: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M7.5 2h1v5.5H14v1H8.5V14h-1V8.5H2v-1h5.5z"/></svg>`,
  newChat: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H6.2L3 13.8V11h.5-.0A1.5 1.5 0 0 1 2 9.5v-6zm1.5-.5a.5.5 0 0 0-.5.5v6c0 .28.22.5.5.5H4v1.6L5.8 10h6.7a.5.5 0 0 0 .5-.5v-6a.5.5 0 0 0-.5-.5h-9zM7.5 4.5h1v1.5H10v1H8.5v1.5h-1V7H6V6h1.5z"/></svg>`,
  slash: `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor"/><path d="M10 4.5 6 11.5" stroke="currentColor" stroke-width="1.2"/></svg>`,
  image: `<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/><circle cx="5.5" cy="6" r="1.2" fill="currentColor"/><path d="m2 12 4-4 3 3 2-2 3 3" fill="none" stroke="currentColor"/></svg>`,
  send: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 2.5 13.5 8l-.7.7L8.5 4.4V14h-1V4.4L3.2 8.7l-.7-.7z"/></svg>`,
  stop: `<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>`,
  grip: `<svg viewBox="0 0 16 16"><g fill="currentColor"><circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/><circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/><circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/></g></svg>`,
  chevron: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="m8 5.3 5 5-.7.7L8 6.7 3.7 11l-.7-.7z"/></svg>`,
  close: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="m8 7.3 3.6-3.6.7.7L8.7 8l3.6 3.6-.7.7L8 8.7l-3.6 3.6-.7-.7L7.3 8 3.7 4.4l.7-.7z"/></svg>`,
  terminal: `<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/><path d="m4 6 2 2-2 2M7.5 10.5h4" fill="none" stroke="currentColor"/></svg>`,
  tree: `<svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" d="M2.5 3.5h5M4.5 3.5v8h3M4.5 7.5h3M9.5 7.5h4M9.5 11.5h4"/></svg>`,
  more: `<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor"/></svg>`,
  brain: `<svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" d="M6 2.5a2 2 0 0 0-2 2 2 2 0 0 0-1.5 3 2 2 0 0 0 .5 3.5 2 2 0 0 0 3 2V2.5zM10 2.5a2 2 0 0 1 2 2 2 2 0 0 1 1.5 3 2 2 0 0 1-.5 3.5 2 2 0 0 1-3 2V2.5z"/></svg>`,
};

// ------------------------------------------------------------------ DOM

const app = document.getElementById("app")!;
app.innerHTML = `
  <header id="topbar" class="topbar hidden">
    <span id="topbar-title" class="topbar-title">New session</span>
    <span class="topbar-actions">
      <button class="sp-icon" id="tb-terminal" title="Continue Session in Terminal" aria-label="Continue session in terminal">${I.terminal}</button>
      <button class="sp-icon" id="tb-tree" title="Session Tree (/tree)" aria-label="Session tree">${I.tree}</button>
      <button class="sp-icon" id="tb-history" title="Resume Session…" aria-label="Resume session">${I.history}</button>
      <button class="sp-icon" id="tb-new" title="New Session" aria-label="New session">${I.plus}</button>
      <button class="sp-icon" id="tb-more" title="More Actions…" aria-label="More actions" aria-haspopup="menu">${I.more}</button>
    </span>
    <div id="tb-menu" class="tb-menu hidden" role="menu">
      <button role="menuitem" data-cmd="pi.newTerminal">Open in Terminal</button>
      <button role="menuitem" data-cmd="pi.openInTab">Open in New Tab</button>
      <button role="menuitem" data-msg="restart">Restart Agent Process</button>
    </div>
  </header>
  <div id="list-menu" class="list-menu hidden"></div>
  <div id="banner" class="banner hidden"></div>
  <main id="scroll" class="scroll">
    <div id="messages" class="messages"></div>
    <div id="queue" class="queue hidden"></div>
    <div id="empty" class="empty">
      <img class="logo" id="empty-logo" alt="pi">
      <div>Ask Pi anything about your code.</div>
      <div class="hint">Type <kbd>/</kbd> for commands, <kbd>@</kbd> to mention files, <kbd>!</kbd> to run a shell command.</div>
    </div>
    <div id="working" class="working hidden">${SPINNER}<span id="working-text">Working…</span></div>
  </main>
  <div id="dialogs"></div>
  <div class="bottom">
    <div id="widgets-above" class="widgets"></div>
    <div class="composer" id="composer">
      <div id="popup" class="popup hidden"></div>
      <div id="model-picker" class="model-picker hidden"></div>
      <div id="attachments" class="attachments hidden"></div>
      <div class="input-wrap">
        <div id="input-hl" class="input-hl" aria-hidden="true"></div>
        <textarea id="input" rows="1" spellcheck="true" placeholder="Ask Pi…  (/ commands, @ files, ! shell)"></textarea>
      </div>
      <div class="toolbar">
        <button class="icon-btn" id="btn-image" title="Attach image">${I.image}</button>
        <button class="icon-btn" id="btn-slash" title="Commands">${I.slash}</button>
        <button class="chip" id="btn-model" title="Select model and effort"><span id="model-name">…</span><span class="chip-level" id="thinking-level"></span></button>
        <span class="spacer"></span>
        <button class="ctx" id="ctx" title="Context usage · click to compact"></button>
        <button class="send" id="btn-send" title="Send (Enter)">${I.send}</button>
      </div>
    </div>
    <div id="widgets-below" class="widgets"></div>
    <div id="statusline" class="statusline"></div>
  </div>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LOGO = document.body.dataset.logo ?? "";
/** Read-only session viewer: no pi process and no composer. The host sends the transcript from the session file. */
const READONLY = !!document.body.dataset.readonly;
if (READONLY) {
  document.body.classList.add("readonly");
  $("empty").querySelector("div")!.textContent = "This session has no messages yet.";
}
$<HTMLImageElement>("empty-logo").src = LOGO;
const scrollEl = $("scroll");
const messagesEl = $("messages");
const input = $<HTMLTextAreaElement>("input");
const popup = $("popup");
const sendBtn = $("btn-send");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

// ------------------------------------------------------------------ state

interface Command { name: string; description?: string; source: string }
const BUILTINS: Command[] = [
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "resume", description: "Resume a previous session", source: "builtin" },
  { name: "model", description: "Select model", source: "builtin" },
  { name: "thinking", description: "Select thinking level", source: "builtin" },
  { name: "compact", description: "Compact context [instructions]", source: "builtin" },
  { name: "name", description: "Name this session", source: "builtin" },
  { name: "tree", description: "Navigate the session tree (branches, labels, summaries)", source: "builtin" },
  { name: "fork", description: "Fork from a previous message", source: "builtin" },
  { name: "clone", description: "Clone the current branch into a new session", source: "builtin" },
  { name: "session", description: "Show session stats", source: "builtin" },
  { name: "copy", description: "Copy last response", source: "builtin" },
  { name: "export", description: "Export session to HTML", source: "builtin" },
  { name: "restart", description: "Restart the pi process (reloads extensions)", source: "builtin" },
];

let commands: Command[] = [];
let state: any = {};
let running = false;
let runStart = 0;
let outputTokens = 0;
let images: { image: any; name: string }[] = [];
const statuses = new Map<string, string>();
const widgets = new Map<string, { lines: string[]; placement: string }>();
/** Widgets the user minimized to their first line. They stay minimized while their lines change. */
const minimizedWidgets = new Set<string>();
const toolCards = new Map<string, ToolCard>();
/** Integrations, with their hooks for this webview (see "integrations" at the end of the file). */
const integrations: { def: WebIntegration; hooks: WebIntegrationInstance; active: boolean }[] = [];
/** Hooks of the integrations whose pi extension is loaded. */
const activeHooks = () => integrations.filter((x) => x.active).map((x) => x.hooks);
const bashCards = new Map<string, ToolCard>();
let firstUserText = "";

// ------------------------------------------------------------------ scrolling

let stick = true;
scrollEl.addEventListener("scroll", () => {
  app.classList.toggle("scrolled", scrollEl.scrollTop > 0);
  stick = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 60;
});
let scrollQueued = false;
/** Scroll to the bottom now (same frame as a render), so content never jumps for a frame. */
function scrollNow() {
  if (stick) scrollEl.scrollTop = scrollEl.scrollHeight;
}
function autoscroll() {
  if (!stick || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    scrollEl.scrollTop = scrollEl.scrollHeight;
  });
}
function updateEmpty() {
  $("empty").classList.toggle("hidden", messagesEl.childElementCount > 0);
}

// ------------------------------------------------------------------ helpers

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => c?.type === "text").map((c) => c.text).join("\n");
  return "";
}
function imagesOf(content: any): any[] {
  return Array.isArray(content) ? content.filter((c) => c?.type === "image") : [];
}
function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
function shortPath(p: string): string {
  if (!p) return "";
  const cwd = state.cwd as string | undefined;
  if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  return p;
}
const isPathLike = (s: string) => /^(~|\.{1,2})?\/?[\w@.\-]+(\/[\w@.\-]+)*\/?(:\d+(-\d+)?)?$/.test(s) && s.includes("/") || /^[\w\-]+\.[a-z0-9]{1,6}(:\d+)?$/i.test(s);

/** Make inline code that looks like a path clickable. */
const COPY_ICON = `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M4 4V2.5A1.5 1.5 0 0 1 5.5 1h7A1.5 1.5 0 0 1 14 2.5v7a1.5 1.5 0 0 1-1.5 1.5H11v1.5A1.5 1.5 0 0 1 9.5 14h-7A1.5 1.5 0 0 1 1 12.5v-7A1.5 1.5 0 0 1 2.5 4H4zm1 0h4.5A1.5 1.5 0 0 1 11 5.5V10h1.5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5V4zM2.5 5a.5.5 0 0 0-.5.5v7c0 .28.22.5.5.5h7a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5h-7z"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M6.3 11.3 2.9 7.9l-.7.7 4.1 4.1 7.6-7.6-.7-.7z"/></svg>`;

function linkify(root: HTMLElement) {
  root.querySelectorAll("code").forEach((c) => {
    if (c.parentElement?.tagName === "PRE") return;
    const t = c.textContent ?? "";
    if (isPathLike(t)) {
      c.classList.add("file-link");
      c.title = "Open file";
    }
  });
  // Code blocks get a header bar (language + Copy) above the scrolling <pre>, so the
  // button never overlaps code and doesn't scroll away with long lines.
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.parentElement?.classList.contains("code-block")) return;
    const code = pre.querySelector("code");
    const lang = (code?.className.match(/language-([\w+#.-]+)/)?.[1] ?? "").toLowerCase();
    const wrap = el("div", "code-block");
    const head = el("div", "code-head");
    head.appendChild(el("span", "code-lang", escapeHtml(lang || "text")));
    const b = el("button", "copy-btn", `${COPY_ICON}<span>Copy</span>`);
    b.title = "Copy code";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const text = (code?.textContent ?? pre.textContent ?? "").replace(/\n$/, "");
      post({ type: "copy", text });
      b.classList.add("done");
      b.innerHTML = `${CHECK_ICON}<span>Copied</span>`;
      setTimeout(() => {
        b.classList.remove("done");
        b.innerHTML = `${COPY_ICON}<span>Copy</span>`;
      }, 1400);
    });
    head.appendChild(b);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  });
}
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const link = t.closest(".file-link") as HTMLElement | null;
  if (link) {
    const raw = link.dataset.path ?? link.textContent ?? "";
    const m = raw.match(/^(.*?)(?::(\d+)(?:-\d+)?)?$/)!;
    post({ type: "openFile", path: m[1], line: m[2] ? Number(m[2]) : undefined });
    return;
  }
  // Markdown links: web URLs open in the browser, anything else is treated as a path
  // (relative to the session cwd). Letting the webview follow a relative href resolves it
  // against the webview origin, which is wrong, especially under Remote-SSH.
  const a = t.closest("a[href]") as HTMLAnchorElement | null;
  if (a) {
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^[a-z][\w+.-]*:/i.test(href) && !/^file:/i.test(href)) post({ type: "openExternal", url: href });
    else {
      let p = decodeURI(href.replace(/^file:\/\//i, "").replace(/#.*$/, ""));
      const m = p.match(/^(.*?)(?::(\d+)(?:-\d+)?)?$/)!;
      p = m[1];
      if (p) post({ type: "openFile", path: p, line: m[2] ? Number(m[2]) : undefined });
    }
  }
});

// ------------------------------------------------------------------ timeline items

function addItem(kind: string, parent: HTMLElement = messagesEl): HTMLElement {
  const item = el("div", `item ${kind}`);
  parent.appendChild(item);
  updateEmpty();
  autoscroll();
  return item;
}

function renderUser(msg: any) {
  const text = textOf(msg.content);
  if (!firstUserText && text) {
    firstUserText = text;
    updateTitle();
  }
  const bubble = el("div", "user-msg");
  const body = el("div", "user-text md");
  body.innerHTML = mdUser(text);
  linkify(body);
  bubble.appendChild(body);
  const imgs = imagesOf(msg.content);
  if (imgs.length) {
    const row = el("div", "user-images");
    for (const im of imgs) {
      const img = el("img");
      img.src = `data:${im.mimeType};base64,${im.data}`;
      row.appendChild(img);
    }
    bubble.appendChild(row);
  }
  // Collapse long prompts.
  requestAnimationFrame(() => {
    if (body.scrollHeight > 140) {
      bubble.classList.add("collapsed");
      bubble.addEventListener("click", () => bubble.classList.toggle("collapsed"));
    }
  });
  messagesEl.appendChild(bubble);
  stick = true;
  updateEmpty();
  autoscroll();
}

function renderNote(text: string, cls = "") {
  const n = addItem(`note ${cls}`);
  n.innerHTML = md(text);
  return n;
}

// ------------------------------------------------------------------ assistant messages

interface Block { type: string; el: HTMLElement; text: string; id?: string; sm?: StreamingMarkdown }
class AssistantView {
  blocks = new Map<number, Block>();
  errorEl?: HTMLElement;
  private pendingRender = new Set<Block>();
  private rafQueued = false;

  block(index: number, type: string, id?: string, name?: string): Block {
    let b = this.blocks.get(index);
    if (b && b.type === type) return b;
    if (type === "text") {
      const item = addItem("text");
      item.appendChild(el("div", "md"));
      b = { type, el: item, text: "" };
    } else if (type === "thinking") {
      const item = addItem("thinking");
      item.innerHTML = `<details><summary>Thinking</summary><div class="thinking-body md"></div></details>`;
      item.classList.add("empty-thinking"); // hidden until the model sends thinking text
      b = { type, el: item, text: "" };
    } else {
      const card = getToolCard(id!, name ?? "tool");
      b = { type, el: card.item, text: "", id };
    }
    this.blocks.set(index, b);
    return b;
  }

  delta(b: Block, delta: string) {
    b.text += delta;
    this.pendingRender.add(b);
    if (this.rafQueued) return;
    this.rafQueued = true;
    requestAnimationFrame(() => {
      this.rafQueued = false;
      for (const x of this.pendingRender) this.renderBlock(x);
      this.pendingRender.clear();
      scrollNow();
    });
  }

  /** Incremental render: only markdown blocks whose source changed are rebuilt. */
  renderBlock(b: Block) {
    if (b.type === "text") {
      b.sm ??= new StreamingMarkdown(b.el.querySelector(".md") as HTMLElement, linkify);
      b.sm.update(b.text);
      b.el.classList.toggle("hidden", !b.text.trim());
    } else if (b.type === "thinking") {
      b.sm ??= new StreamingMarkdown(b.el.querySelector(".thinking-body") as HTMLElement, linkify);
      b.sm.update(b.text);
      b.el.classList.toggle("empty-thinking", !b.text.trim());
    }
  }

  /** Apply the authoritative final message. */
  finalize(msg: any) {
    (msg.content ?? []).forEach((c: any, i: number) => {
      if (c.type === "text") {
        const b = this.block(i, "text");
        b.text = c.text;
        this.renderBlock(b);
      } else if (c.type === "thinking") {
        if (!c.thinking?.trim()) return;
        const b = this.block(i, "thinking");
        b.text = c.thinking;
        this.renderBlock(b);
      } else if (c.type === "toolCall") {
        this.block(i, "toolCall", c.id, c.name);
        getToolCard(c.id, c.name).setArgs(c.arguments);
      }
    });
    if (msg.stopReason === "error") {
      const e = addItem("error");
      e.innerHTML = md(`**Error:** ${msg.errorMessage ?? "unknown error"}`);
    } else if (msg.stopReason === "aborted") {
      addItem("muted").textContent = "Interrupted by user";
    }
    autoscroll();
  }
}
let current: AssistantView | undefined;

// ------------------------------------------------------------------ tool cards

const TOOL_TITLES: Record<string, string> = { bash: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", find: "Find", ls: "List" };
/** pi's own tools. Their `details` are internal (diffs, truncation), so cards do not show them. */
const BUILTIN_TOOLS = new Set(Object.keys(TOOL_TITLES));
/** Rows of a tool card, top to bottom. */
const ROW_ORDER = ["in", "out", "data"] as const;
type RowKind = (typeof ROW_ORDER)[number];
const MAX_DETAILS_CHARS = 20_000;

class ToolCard {
  item: HTMLElement;
  private head: HTMLElement;
  private body: HTMLElement;
  private rows = new Map<RowKind, HTMLElement>();
  /** Tool calls that this tool made while it ran (`ctx.executeTool()`, for example from codemode). */
  private nestedBox?: HTMLElement;
  private nestedList?: HTMLElement;
  private nestedCount = 0;
  private nestedFailed = 0;
  private nestedIncomplete = false;
  /** The user opened or closed the nested calls; do not change that on completion. */
  private nestedToggled = false;
  /** Called once with the outcome, so a parent card can count failed nested calls. */
  onDone?: (isError: boolean) => void;
  args: any = {};
  done = false;

  constructor(public id: string, public name: string, parent?: HTMLElement) {
    this.item = addItem("tool pending", parent);
    this.head = el("div", "tool-head");
    this.body = el("div", "tool-body hidden");
    this.item.append(this.head, this.body);
    this.renderHead();
  }

  setArgs(args: any) {
    if (!args) return;
    this.args = args;
    this.renderHead();
    const n = this.name;
    let inText: string | undefined;
    if (n === "bash") inText = args.command;
    else if (n === "write") inText = args.content;
    else if (n === "edit") inText = undefined;
    else if (!["read", "ls", "find", "grep"].includes(n)) inText = JSON.stringify(args, null, 2);
    if (inText !== undefined) this.setRow("in", "IN", escapeHtml(inText));
    if (n === "edit" && !this.done && Array.isArray(args.edits)) {
      this.setRow("out", "", args.edits.map((e: any) => diffFromEdit(e.oldText, e.newText)).join('<div class="diff-sep">⋯</div>'), "diff");
    }
  }

  private renderHead() {
    const a = this.args ?? {};
    const title = TOOL_TITLES[this.name] ?? this.name;
    let sub = "";
    let pathAttr = "";
    const p = a.path ?? a.file_path;
    if (this.name === "bash") sub = escapeHtml(a.description ?? (a.command ?? "").split("\n")[0]);
    else if (p && ["read", "edit", "write", "ls"].includes(this.name)) {
      const range = this.name === "read" && a.offset ? `:${a.offset}${a.limit ? `-${a.offset + a.limit - 1}` : ""}` : "";
      pathAttr = `${p}${a.offset ? `:${a.offset}` : ""}`;
      sub = `<span class="file-link" data-path="${escapeHtml(pathAttr)}">${escapeHtml(shortPath(p))}${range}</span>`;
    } else if (this.name === "grep") sub = `<code>${escapeHtml(a.pattern ?? "")}</code>${a.path ? ` in ${escapeHtml(shortPath(a.path))}` : ""}`;
    else if (this.name === "find") sub = `<code>${escapeHtml(a.pattern ?? "")}</code>${a.path ? ` in ${escapeHtml(shortPath(a.path))}` : ""}`;
    else {
      const first = Object.values(a).find((v) => typeof v === "string") as string | undefined;
      sub = escapeHtml((first ?? "").split("\n")[0].slice(0, 120));
    }
    this.head.innerHTML = `<span class="tool-name">${escapeHtml(title)}</span><span class="tool-sub">${sub}</span>`;
  }

  private setRow(which: RowKind, label: string, html: string, cls = "") {
    this.body.classList.remove("hidden");
    let row = this.rows.get(which);
    if (!row) {
      row = el("div", `tool-row ${which}`);
      row.innerHTML = `<div class="tool-label"></div><div class="tool-content"><pre></pre></div>`;
      row.addEventListener("click", () => row!.classList.toggle("expanded"));
      const next = ROW_ORDER.slice(ROW_ORDER.indexOf(which) + 1).map((k) => this.rows.get(k)).find(Boolean);
      if (next) this.body.insertBefore(row, next);
      else if (this.rows.size) [...this.rows.values()].pop()!.after(row);
      else this.body.prepend(row);
      this.rows.set(which, row);
    }
    (row.querySelector(".tool-label") as HTMLElement).textContent = label;
    const pre = row.querySelector("pre")!;
    pre.className = cls;
    pre.innerHTML = html;
    requestAnimationFrame(() => row!.classList.toggle("overflowing", pre.scrollHeight > pre.clientHeight + 4));
    autoscroll();
  }

  setPartial(result: any) {
    const t = resultText(result);
    if (t) this.setRow("out", "OUT", escapeHtml(tail(t)));
    this.setDetails(result?.details);
  }

  /** Structured `details` of an extension tool, as JSON. Extensions often report progress here. */
  private setDetails(details: any) {
    if (BUILTIN_TOOLS.has(this.name) || details == null || details === "") return;
    if (typeof details === "object" && !Object.keys(details).length) return;
    let t = typeof details === "string" ? details : JSON.stringify(details, null, 2);
    if (t.length > MAX_DETAILS_CHARS) t = t.slice(0, MAX_DETAILS_CHARS) + "\n…";
    this.setRow("data", "DATA", escapeHtml(t));
  }

  /** Card for a tool call that this tool made. Nested calls show as a small timeline under the card. */
  nested(id: string, name: string): ToolCard {
    if (!this.nestedBox) {
      this.nestedBox = el("div", `tool-nested${this.done ? "" : " open"}`);
      const toggle = el("button", "tool-nested-toggle");
      toggle.addEventListener("click", () => {
        this.nestedToggled = true;
        this.nestedBox!.classList.toggle("open");
      });
      this.nestedList = el("div", "tool-nested-list");
      this.nestedBox.append(toggle, this.nestedList);
      this.item.appendChild(this.nestedBox);
    }
    const c = new ToolCard(id, name, this.nestedList);
    c.item.classList.add("nested");
    c.onDone = (isError) => {
      if (isError) this.nestedFailed++;
      this.updateNested();
    };
    this.nestedCount++;
    this.updateNested();
    return c;
  }

  private updateNested() {
    const t = this.nestedBox?.querySelector(".tool-nested-toggle");
    if (!t) return;
    const n = this.nestedCount;
    const parts = [`${n} tool call${n === 1 ? "" : "s"}`];
    if (this.nestedFailed) parts.push(`${this.nestedFailed} failed`);
    if (this.nestedIncomplete) parts.push("record incomplete");
    t.innerHTML = `${CHEVRON_ICON}<span>${escapeHtml(parts.join(" · "))}</span>`;
  }

  /**
   * After a reload, only the tool result's `nestedCalls` record is left: names, arguments,
   * status and errors, but no results. Live calls already have their cards.
   */
  private setNestedRecord(record: any) {
    if (this.nestedCount || !Array.isArray(record?.calls) || !record.calls.length) return;
    for (const r of record.calls) {
      const c = this.nested(`${this.id}/record-${r.id}`, String(r.name ?? "tool"));
      c.setArgs(r.arguments ?? (r.argumentsBytes ? { arguments: `(${r.argumentsBytes} bytes, not kept)` } : {}));
      c.done = true;
      c.item.classList.remove("pending");
      c.item.classList.add(r.status === "error" ? "failed" : r.status === "ok" ? "ok" : "unfinished");
      if (r.error) c.setRow("out", "ERR", escapeHtml(String(r.error)), "err");
      else if (r.status === "unfinished") c.setRow("out", "", "Still running when the calling tool finished.", "muted");
      if (r.status === "error") this.nestedFailed++;
    }
    this.nestedIncomplete = record.complete === false;
    this.updateNested();
  }

  setResult(result: any, isError: boolean) {
    const first = !this.done;
    this.done = true;
    this.item.classList.remove("pending");
    this.item.classList.add(isError ? "failed" : "ok");
    this.setNestedRecord(result?.nestedCalls);
    if (this.nestedBox && !this.nestedToggled) this.nestedBox.classList.remove("open");
    if (first) this.onDone?.(isError);
    this.setDetails(result?.details);
    const diff = result?.details?.diff;
    if (this.name === "edit" && diff && !isError) {
      this.setRow("out", "", renderDiff(diff), "diff");
      return;
    }
    if (this.name === "write" && !isError) return; // IN already shows the content
    const text = resultText(result);
    const imgs = imagesOf(result?.content);
    if (text || !imgs.length) this.setRow("out", isError ? "ERR" : "OUT", escapeHtml(text || "(no output)"), isError ? "err" : "");
    for (const im of imgs) {
      const img = el("img", "tool-image");
      img.src = `data:${im.mimeType};base64,${im.data}`;
      this.body.appendChild(img);
      this.body.classList.remove("hidden");
    }
  }
}

function tail(s: string, n = 400) {
  const lines = s.split("\n");
  return lines.length > n ? lines.slice(-n).join("\n") : s;
}
function resultText(result: any): string {
  return textOf(result?.content ?? "").replace(/\n+$/, "");
}
function renderDiff(diff: string): string {
  return diff
    .split("\n")
    .map((l) => {
      const c = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx";
      return `<span class="dl ${c}">${escapeHtml(l)}</span>`;
    })
    .join("");
}
function diffFromEdit(oldText = "", newText = ""): string {
  const del = oldText.split("\n").map((l) => `<span class="dl del">-${escapeHtml(l)}</span>`);
  const add = newText.split("\n").map((l) => `<span class="dl add">+${escapeHtml(l)}</span>`);
  return [...del, ...add].join("");
}

/** Card for a tool call. A nested call (`parentId` set) goes under the card of the call that made it. */
function getToolCard(id: string, name: string, parentId?: string): ToolCard {
  let c = toolCards.get(id);
  if (!c) {
    const parent = parentId ? toolCards.get(parentId) : undefined;
    c = parent ? parent.nested(id, name) : new ToolCard(id, name);
    toolCards.set(id, c);
  }
  return c;
}

// ------------------------------------------------------------------ transcript

function resetTranscript() {
  messagesEl.innerHTML = "";
  toolCards.clear();
  bashCards.clear();
  current = undefined;
  firstUserText = "";
  $("dialogs").innerHTML = "";
  updateEmpty();
}

function renderMessage(msg: any) {
  switch (msg.role) {
    case "user":
      renderUser(msg);
      break;
    case "assistant": {
      const v = new AssistantView();
      v.finalize(msg);
      break;
    }
    case "toolResult":
      getToolCard(msg.toolCallId, msg.toolName).setResult(msg, msg.isError);
      break;
    case "bashExecution": {
      const c = new ToolCard(`bash-${msg.timestamp}`, "bash");
      c.setArgs({ command: msg.command, description: `! ${msg.command.split("\n")[0]}` });
      c.setResult({ content: [{ type: "text", text: msg.output }] }, !!msg.exitCode && !msg.cancelled);
      break;
    }
    case "custom":
      if (activeHooks().some((i) => i.renderCustomMessage?.(msg))) break;
      if (msg.display) {
        const n = renderNote(textOf(msg.content), "custom");
        n.dataset.type = msg.customType;
      }
      break;
    case "compactionSummary":
      renderCollapsible("Context compacted", msg.summary);
      break;
    case "branchSummary":
      renderCollapsible("Branch summary", msg.summary);
      break;
  }
}

function renderCollapsible(title: string, body: string) {
  const item = addItem("note summary");
  item.innerHTML = `<details><summary>${escapeHtml(title)}</summary><div class="md">${md(body)}</div></details>`;
}

// ------------------------------------------------------------------ events

function onEvent(e: any) {
  switch (e.type) {
    case "agent_start":
      setRunning(true);
      break;
    case "agent_settled":
      setRunning(false);
      break;
    case "message_start":
      if (e.message.role === "assistant") current = new AssistantView();
      else if (e.message.role !== "toolResult" && e.message.role !== "bashExecution") renderMessage(e.message);
      break;
    case "message_update": {
      const ev = e.assistantMessageEvent;
      if (!current) current = new AssistantView();
      if (e.usage?.output) outputTokens = e.usage.output;
      switch (ev.type) {
        case "text_start":
          current.block(ev.contentIndex, "text");
          break;
        case "text_delta":
          current.delta(current.block(ev.contentIndex, "text"), ev.delta);
          break;
        case "thinking_start":
          current.block(ev.contentIndex, "thinking");
          break;
        case "thinking_delta":
          current.delta(current.block(ev.contentIndex, "thinking"), ev.delta);
          break;
        case "toolcall_start":
          current.block(ev.contentIndex, "toolCall", ev.id, ev.toolName);
          break;
        case "toolcall_end":
          current.block(ev.contentIndex, "toolCall", ev.toolCall.id, ev.toolCall.name);
          getToolCard(ev.toolCall.id, ev.toolCall.name).setArgs(ev.toolCall.arguments);
          break;
      }
      updateWorking();
      break;
    }
    case "message_end":
      if (e.message.role === "assistant") {
        (current ?? new AssistantView()).finalize(e.message);
        current = undefined;
      } else if (e.message.role === "toolResult") {
        getToolCard(e.message.toolCallId, e.message.toolName).setResult(e.message, e.message.isError);
      }
      break;
    case "tool_execution_start": {
      const c = getToolCard(e.toolCallId, e.toolName, e.parentToolCallId);
      if (e.args && !Object.keys(c.args).length) c.setArgs(e.args);
      break;
    }
    case "tool_execution_update":
      getToolCard(e.toolCallId, e.toolName, e.parentToolCallId).setPartial(e.partialResult);
      break;
    case "tool_execution_end":
      getToolCard(e.toolCallId, e.toolName, e.parentToolCallId).setResult(e.result, e.isError);
      break;
    case "queue_update":
      renderQueue(e.steering ?? [], e.followUp ?? []);
      break;
    case "compaction_start":
      compacting = true;
      updateStats();
      renderNote(`Compacting context (${e.reason})…`, "muted compaction");
      break;
    case "compaction_end":
      compacting = false;
      updateStats();
      if (e.result) renderNote(`Context compacted: ${fmtTokens(e.result.tokensBefore)} → ~${fmtTokens(e.result.estimatedTokensAfter ?? 0)} tokens`, "muted");
      else if (e.errorMessage) renderNote(`Compaction failed: ${e.errorMessage}`, "error");
      else if (e.aborted) renderNote("Compaction aborted", "muted");
      break;
    case "auto_retry_start":
      renderNote(`Retrying (${e.attempt}/${e.maxAttempts}) in ${Math.round(e.delayMs / 1000)}s — ${e.errorMessage}`, "muted");
      break;
    case "auto_retry_end":
      if (!e.success) renderNote(`Retry failed: ${e.finalError ?? ""}`, "error");
      break;
    case "session_info_changed":
      state.sessionName = e.name;
      updateTitle();
      break;
    case "thinking_level_changed":
      state.thinkingLevel = e.level;
      updateModel();
      break;
    case "extension_error":
      renderNote(`Extension error (${e.event}) in \`${shortPath(e.extensionPath)}\`: ${e.error}`, "error");
      break;
    case "bash_execution_update": {
      const c = bashCards.get(e.id);
      if (c) {
        (c as any)._out = ((c as any)._out ?? "") + e.delta;
        c.setPartial({ content: [{ type: "text", text: (c as any)._out }] });
      }
      break;
    }
    case "extension_ui_request":
      onExtensionUi(e);
      break;
    case "entry_appended":
      for (const i of activeHooks()) i.onEntry?.(e.entry);
      break;
  }
}

// ------------------------------------------------------------------ extension UI

function onExtensionUi(r: any) {
  switch (r.method) {
    case "setStatus":
      if (r.statusText === undefined || r.statusText === null || r.statusText === "") statuses.delete(r.statusKey);
      else statuses.set(r.statusKey, r.statusText);
      renderStatus();
      break;
    case "setWidget":
      if (!r.widgetLines) widgets.delete(r.widgetKey);
      else widgets.set(r.widgetKey, { lines: r.widgetLines, placement: r.widgetPlacement ?? "aboveEditor" });
      renderWidgets();
      break;
    case "set_editor_text":
      input.value = r.text ?? "";
      resizeInput();
      input.focus();
      break;
    case "setTitle":
      break;
    case "notify": {
      const text = stripAnsi(r.message ?? "");
      for (const i of activeHooks()) i.onNotice?.(text, r.notifyType ?? "info");
      break; // the host shows it as a VS Code notification
    }
    case "select":
    case "confirm":
    case "input":
    case "editor":
      showDialog(r);
      break;
  }
}

function renderStatus() {
  const s = $("statusline");
  s.innerHTML = [...statuses.values()].map((t) => `<span class="status-item">${ansiToHtml(t)}</span>`).join("");
}
/** One DOM box per widget key. Boxes are updated in place: a rebuild between mousedown and mouseup would drop the click. */
const widgetBoxes = new Map<string, { box: HTMLElement; body: HTMLElement; toggle: HTMLElement; html: string }>();
function renderWidgets() {
  const above = $("widgets-above");
  const below = $("widgets-below");
  for (const [key, v] of widgetBoxes) {
    if (widgets.has(key)) continue;
    v.box.remove();
    widgetBoxes.delete(key);
  }
  const order: Record<string, HTMLElement[]> = { above: [], below: [] };
  for (const [key, w] of widgets) {
    const min = minimizedWidgets.has(key);
    let v = widgetBoxes.get(key);
    if (!v) {
      const box = el("div", "widget");
      box.dataset.key = key;
      const body = el("div", "widget-body");
      const toggle = el("button", "widget-toggle", I.chevron);
      toggle.addEventListener("click", () => {
        if (minimizedWidgets.has(key)) minimizedWidgets.delete(key);
        else minimizedWidgets.add(key);
        renderWidgets();
      });
      box.append(body, toggle);
      v = { box, body, toggle, html: "" };
      widgetBoxes.set(key, v);
    }
    // TUI widgets pad themselves with blank rows; the box has its own padding. Minimized: only the first line.
    const blank = (l: string) => !stripAnsi(l).trim();
    let lines = w.lines.slice();
    while (lines.length > 1 && blank(lines[0])) lines.shift();
    while (lines.length > 1 && blank(lines[lines.length - 1])) lines.pop();
    if (min) lines = lines.slice(0, 1);
    const html = lines.map((l) => `<div>${ansiToHtml(l) || "&nbsp;"}</div>`).join("");
    if (html !== v.html) {
      v.body.innerHTML = html;
      v.html = html;
    }
    v.box.classList.toggle("minimized", min);
    v.toggle.title = min ? "Expand" : "Minimize";
    v.toggle.setAttribute("aria-label", v.toggle.title);
    v.toggle.setAttribute("aria-expanded", String(!min));
    order[w.placement === "belowEditor" ? "below" : "above"].push(v.box);
  }
  // Append only when the order or parent differs, so boxes that stay put are not detached.
  for (const [parent, boxes] of [[above, order.above], [below, order.below]] as const) {
    if (parent.children.length === boxes.length && boxes.every((b, i) => parent.children[i] === b)) continue;
    parent.replaceChildren(...boxes);
  }
}

function showDialog(r: any) {
  const box = el("div", "dialog");
  box.dataset.id = r.id;
  const respond = (resp: any) => {
    post({ type: "uiResponse", response: { id: r.id, ...resp } });
    box.remove();
    input.focus();
  };
  const title = el("div", "dialog-title");
  title.innerHTML = ansiToHtml(r.title ?? "");
  box.appendChild(title);
  if (r.message) {
    const m = el("div", "dialog-message md");
    m.innerHTML = md(stripAnsi(r.message));
    box.appendChild(m);
  }
  const actions = el("div", "dialog-actions");
  let focusEl: HTMLElement | undefined;

  if (r.method === "select") {
    const list = el("div", "dialog-options");
    const opts: string[] = r.options ?? [];
    let filter: HTMLInputElement | undefined;
    let sel = 0;
    const buttons = opts.map((o, i) => {
      const b = el("button", "option");
      b.innerHTML = `<span class="num">${i < 9 ? i + 1 : ""}</span>${ansiToHtml(o)}`;
      b.addEventListener("click", () => respond({ value: o }));
      list.appendChild(b);
      return b;
    });
    const visible = () => buttons.filter((b) => !b.classList.contains("hidden"));
    const highlight = () => visible().forEach((b, i) => b.classList.toggle("active", i === sel));
    if (opts.length > 8) {
      filter = el("input", "dialog-input") as HTMLInputElement;
      filter.placeholder = "Filter…";
      filter.addEventListener("input", () => {
        const q = filter!.value.toLowerCase();
        buttons.forEach((b, i) => b.classList.toggle("hidden", !opts[i].toLowerCase().includes(q)));
        sel = 0;
        highlight();
      });
      box.appendChild(filter);
    }
    box.appendChild(list);
    highlight();
    box.tabIndex = 0;
    box.addEventListener("keydown", (e) => {
      const v = visible();
      if (e.key === "ArrowDown") { sel = Math.min(sel + 1, v.length - 1); highlight(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(sel - 1, 0); highlight(); e.preventDefault(); }
      else if (e.key === "Enter") { v[sel]?.click(); e.preventDefault(); }
      else if (e.key === "Escape") respond({ cancelled: true });
      else if (!filter && /^[1-9]$/.test(e.key)) buttons[Number(e.key) - 1]?.click();
    });
    focusEl = filter ?? box;
    const cancel = el("button", "btn secondary", "Cancel");
    cancel.addEventListener("click", () => respond({ cancelled: true }));
    actions.appendChild(cancel);
  } else if (r.method === "confirm") {
    const yes = el("button", "btn", "Yes");
    const no = el("button", "btn secondary", "No");
    yes.addEventListener("click", () => respond({ confirmed: true }));
    no.addEventListener("click", () => respond({ confirmed: false }));
    actions.append(yes, no);
    box.tabIndex = 0;
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "y") yes.click();
      else if (e.key === "Escape" || e.key === "n") no.click();
    });
    focusEl = yes;
  } else {
    const multi = r.method === "editor";
    const field = (multi ? el("textarea", "dialog-input editor") : el("input", "dialog-input")) as HTMLInputElement | HTMLTextAreaElement;
    field.placeholder = r.placeholder ?? "";
    if (multi) field.value = r.prefill ?? "";
    box.appendChild(field);
    const ok = el("button", "btn", multi ? "Submit" : "OK");
    const cancel = el("button", "btn secondary", "Cancel");
    ok.addEventListener("click", () => respond({ value: field.value }));
    cancel.addEventListener("click", () => respond({ cancelled: true }));
    field.addEventListener("keydown", (e: any) => {
      if (e.key === "Enter" && (!multi || e.metaKey || e.ctrlKey)) { e.preventDefault(); ok.click(); }
      else if (e.key === "Escape") cancel.click();
    });
    actions.append(ok, cancel);
    focusEl = field;
  }
  box.appendChild(actions);

  if (r.timeout) {
    const bar = el("div", "dialog-timeout");
    bar.style.animationDuration = `${r.timeout}ms`;
    box.appendChild(bar);
    setTimeout(() => box.remove(), r.timeout + 200);
  }
  $("dialogs").appendChild(box);
  setTimeout(() => focusEl?.focus(), 0);
  stick = true;
  autoscroll();
}

// ------------------------------------------------------------------ header / footer

/** The sidebar shows the title in its own header row; editor tabs get it reported via the host. */
let lastTitle: string | undefined;
function updateTitle() {
  const t = state.sessionName || firstUserText.split("\n")[0].slice(0, 80) || undefined;
  const titleEl = $("topbar-title");
  titleEl.textContent = t ?? "New session";
  titleEl.title = t ?? "";
  titleEl.classList.toggle("placeholder", !t);
  if (t === lastTitle) return;
  lastTitle = t;
  post({ type: "title", title: t });
}
function levelLabel(l?: string): string {
  if (!l) return "";
  return l === "xhigh" ? "X-High" : l[0].toUpperCase() + l.slice(1);
}
function updateModel() {
  const m = state.model;
  $("model-name").textContent = m ? (m.name ?? m.id) : "Select model";
  $("btn-model").title = m ? `${m.provider}/${m.id} — click to change model or effort` : "Select model";
  const lvl = state.thinkingLevel ?? "off";
  $("thinking-level").textContent = m?.reasoning ? levelLabel(lvl) : "";
  if (picker.open) picker.render();
}
let lastStats: any;
let compacting = false;

/** Context-usage button in the toolbar: shows %, click compacts (like /compact). */
function updateStats(s: any = lastStats) {
  lastStats = s;
  const ctx = $<HTMLButtonElement>("ctx");
  const cu = s?.contextUsage;
  const pct = cu?.percent != null ? `${Math.round(cu.percent)}%` : "";
  ctx.classList.toggle("hidden", !pct && !compacting);
  ctx.classList.toggle("compacting", compacting);
  ctx.disabled = compacting || running;
  const frac = Math.max(0, Math.min(1, (cu?.percent ?? 0) / 100));
  const level = frac >= 0.9 ? "high" : frac >= 0.7 ? "warn" : "ok";
  ctx.dataset.level = compacting ? "busy" : level;
  // Ring gauge (r=6 → circumference ≈ 37.7) + percentage + hover-revealed action label.
  const C = 37.7;
  ctx.innerHTML = compacting
    ? `${SPINNER}<span class="ctx-pct">Compacting…</span>`
    : `<svg class="ctx-ring" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" class="ctx-track"/><circle cx="8" cy="8" r="6" class="ctx-fill" stroke-dasharray="${(frac * C).toFixed(2)} ${C}" transform="rotate(-90 8 8)"/></svg><span class="ctx-pct">${pct}</span><span class="ctx-action">Compact</span>`;
  const usage = cu
    ? `Context: ${cu.tokens != null ? fmtTokens(cu.tokens) : "?"} / ${fmtTokens(cu.contextWindow)} tokens (${pct || "?"})`
    : "Context usage";
  ctx.title = compacting
    ? "Compacting context…"
    : running
      ? `${usage}\nCompaction is available once Pi finishes`
      : `${usage}\nClick to compact now: older messages are summarized to free up context (/compact)`;
}
$("ctx").addEventListener("click", () => {
  if (compacting || running) return;
  post({ type: "builtin", name: "compact", arg: "" });
});

let workingTimer: number | undefined;
const VERBS = ["Working", "Thinking", "Pondering", "Computing", "Tinkering", "Reasoning", "Cooking"];
let verb = VERBS[0];
function setRunning(r: boolean) {
  running = r;
  document.body.classList.toggle("running", r);
  $("working").classList.toggle("hidden", !r);
  input.placeholder = r ? "Queue another message…  (Enter steers, ⌥Enter follow-up, Esc stops)" : "Ask Pi…  (/ commands, @ files, ! shell)";
  if (r) {
    runStart = Date.now();
    outputTokens = 0;
    verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    clearInterval(workingTimer);
    workingTimer = window.setInterval(updateWorking, 1000);
    updateWorking();
    stick = true;
    autoscroll();
  } else {
    clearInterval(workingTimer);
  }
  updateSendButton();
  updateStats();
}
function updateWorking() {
  if (!running) return;
  const toks = outputTokens ? ` · ↓ ${fmtTokens(outputTokens)} tokens` : "";
  $("working-text").textContent = `${verb}… (${fmtDuration(Date.now() - runStart)}${toks} · esc to interrupt)`;
}

type QueueKind = "steer" | "followUp";
const QUEUE_TAG: Record<QueueKind, { label: string; title: string }> = {
  steer: { label: "steer", title: "Steer: pi reads it after the current tool call" },
  followUp: { label: "follow-up", title: "Follow-up: pi reads it when the run ends" },
};
/** The queued message being dragged, to reorder it among messages of the same kind. */
let queueDrag: { kind: QueueKind; index: number } | undefined;

/**
 * Queued messages show as dimmed user messages at the end of the transcript, in the order pi
 * delivers them (steering first). Each one can be removed, sent now, or dragged to reorder.
 */
function renderQueue(steering: string[], followUp: string[]) {
  const q = $("queue");
  const items = [
    ...steering.map((text, index) => ({ text, index, kind: "steer" as QueueKind })),
    ...followUp.map((text, index) => ({ text, index, kind: "followUp" as QueueKind })),
  ];
  q.classList.toggle("hidden", !items.length);
  q.innerHTML = "";
  for (const it of items) {
    const op = (name: "remove" | "sendNow" | "move", to?: number) =>
      post({ type: "queueOp", op: name, kind: it.kind, index: it.index, text: it.text, to });
    const row = el("div", "user-msg queued-msg");
    row.draggable = true;
    const tag = el("span", "tag", QUEUE_TAG[it.kind].label);
    tag.title = QUEUE_TAG[it.kind].title;
    const text = el("span", "queued-text");
    text.textContent = it.text.replace(/\s+/g, " ").trim();
    text.title = it.text;
    const actions = el("span", "queued-actions");
    const btn = (icon: string, title: string, fn: () => void) => {
      const b = el("button", "icon-btn", icon);
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      actions.appendChild(b);
    };
    btn(I.send, "Send now (stops the current run)", () => op("sendNow"));
    btn(I.close, "Remove", () => op("remove"));
    const grip = el("span", "queued-grip", I.grip);
    grip.title = "Drag to reorder";
    row.append(grip, tag, text, actions);
    row.addEventListener("dragstart", (e) => {
      queueDrag = { kind: it.kind, index: it.index };
      e.dataTransfer!.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      queueDrag = undefined;
      row.classList.remove("dragging");
      q.querySelectorAll(".drop-before, .drop-after").forEach((n) => n.classList.remove("drop-before", "drop-after"));
    });
    // Drop on the top half to go before this message, on the bottom half to go after it.
    const after = (e: DragEvent) => e.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
    row.addEventListener("dragover", (e) => {
      if (!queueDrag || queueDrag.kind !== it.kind) return;
      e.preventDefault();
      row.classList.toggle("drop-after", after(e));
      row.classList.toggle("drop-before", !after(e));
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
    row.addEventListener("drop", (e) => {
      if (!queueDrag || queueDrag.kind !== it.kind) return;
      e.preventDefault();
      const from = queueDrag.index;
      let to = it.index + (after(e) ? 1 : 0);
      if (from < to) to--; // the list is one shorter once the message is taken out
      if (to !== from) {
        const list = it.kind === "steer" ? steering : followUp;
        post({ type: "queueOp", op: "move", kind: it.kind, index: from, text: list[from], to });
      }
    });
    q.appendChild(row);
  }
  if (items.length > 1) {
    const clear = el("button", "link queue-clear", "Clear queue");
    clear.title = "Move all queued messages back to the input box";
    clear.addEventListener("click", () => post({ type: "clearQueue" }));
    q.appendChild(clear);
  }
  scrollNow();
}

// Sidebar header row: session name + session actions (replaces the native view toolbar).
if (document.body.dataset.header) {
  $("topbar").classList.remove("hidden");
  document.body.classList.add("has-topbar");
  $("tb-terminal").addEventListener("click", () => post({ type: "openTerminal" }));
  $("tb-tree").addEventListener("click", () => post({ type: "builtin", name: "tree", arg: "" }));
  $("tb-history").addEventListener("click", () => post({ type: "builtin", name: "resume", arg: "" }));
  $("tb-new").addEventListener("click", () => post({ type: "builtin", name: "new", arg: "" }));
  const menu = $("tb-menu");
  const closeMenu = () => menu.classList.add("hidden");
  $("tb-more").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
    if (!menu.classList.contains("hidden")) menu.querySelector<HTMLElement>("button")?.focus();
  });
  menu.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!b) return;
    closeMenu();
    if (b.dataset.cmd) post({ type: "runCommand", command: b.dataset.cmd });
    else if (b.dataset.msg) post({ type: b.dataset.msg });
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll<HTMLElement>("button")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      closeMenu();
      $("tb-more").focus();
    }
  });
  document.addEventListener("click", (e) => !menu.contains(e.target as Node) && closeMenu());
  window.addEventListener("blur", closeMenu);
}

// ------------------------------------------------------------------ composer

/** Live markdown styling: re-render the backdrop copy of the input and keep it scrolled in sync. */
const inputHl = $("input-hl");
function syncHighlight() {
  inputHl.innerHTML = highlightMarkdown(input.value);
  inputHl.scrollTop = input.scrollTop;
}
input.addEventListener("scroll", () => (inputHl.scrollTop = input.scrollTop));

function resizeInput() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 300) + "px";
  syncHighlight();
  updateSendButton();
}
function updateSendButton() {
  const hasText = !!input.value.trim() || images.length > 0;
  const stop = running && !hasText;
  sendBtn.innerHTML = stop ? I.stop : I.send;
  sendBtn.classList.toggle("stop", stop);
  sendBtn.title = stop ? "Stop (Esc)" : running ? "Queue message (Enter)" : "Send (Enter)";
  sendBtn.toggleAttribute("disabled", !stop && !hasText);
}

function renderAttachments() {
  const a = $("attachments");
  a.classList.toggle("hidden", !images.length);
  a.innerHTML = "";
  images.forEach((im, i) => {
    const chip = el("div", "attachment");
    chip.innerHTML = `<img src="data:${im.image.mimeType};base64,${im.image.data}"><span>${escapeHtml(im.name)}</span>`;
    const x = el("button", "icon-btn", I.close);
    x.addEventListener("click", () => {
      images.splice(i, 1);
      renderAttachments();
    });
    chip.appendChild(x);
    a.appendChild(chip);
  });
  updateSendButton();
}

function submit(mode?: "steer" | "followUp") {
  const text = input.value;
  const trimmed = text.trim();
  if (!trimmed && !images.length) {
    if (running) post({ type: "abort" });
    return;
  }
  hidePopup();

  // Shell escape: !cmd (in context) / !!cmd (excluded from context)
  if (trimmed.startsWith("!") && !images.length) {
    const exclude = trimmed.startsWith("!!");
    const command = trimmed.slice(exclude ? 2 : 1).trim();
    if (command) post({ type: "bash", command, exclude });
    clearInput();
    return;
  }

  // Builtin slash commands (unless an extension/prompt/skill shadows them)
  const m = trimmed.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (m && !images.length && activeHooks().some((i) => i.interceptCommand?.(m[1], m[2]))) {
    clearInput();
    return;
  }
  if (m && !images.length) {
    const builtin = BUILTINS.find((b) => b.name === m[1]);
    const shadowed = commands.some((c) => c.name === m[1]);
    if (builtin && !shadowed) {
      post({ type: "builtin", name: m[1], arg: m[2].trim() });
      clearInput();
      return;
    }
  }

  post({ type: "prompt", text, images: images.map((i) => i.image), mode });
  clearInput();
  stick = true;
}
function clearInput() {
  input.value = "";
  images = [];
  renderAttachments();
  resizeInput();
}

// ------------------------------------------------------------------ autocomplete

interface PopupItem { label: string; detail?: string; tag?: string; icon?: string; apply: () => void }
let popupItems: PopupItem[] = [];
let popupSel = 0;
let fileReq = 0;
let fileToken: { start: number; end: number } | undefined;

/** Pending "hide on blur" timer; cancelled when the popup is (re)opened or the input refocuses. */
let blurHideTimer: number | undefined;
function cancelBlurHide() {
  clearTimeout(blurHideTimer);
  blurHideTimer = undefined;
}

function showPopup(items: PopupItem[]) {
  cancelBlurHide();
  popupItems = items;
  popupSel = 0;
  if (!items.length) return hidePopup();
  popup.classList.remove("hidden");
  renderPopup();
}
function renderPopup() {
  popup.innerHTML = "";
  popupItems.forEach((it, i) => {
    const row = el("div", `popup-item${i === popupSel ? " active" : ""}`);
    row.innerHTML = `${it.icon ? `<span class="popup-icon">${it.icon}</span>` : ""}<span class="popup-label">${escapeHtml(it.label)}</span>${it.detail ? `<span class="popup-detail">${escapeHtml(it.detail)}</span>` : ""}${it.tag ? `<span class="popup-tag">${escapeHtml(it.tag)}</span>` : ""}`;
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      it.apply();
    });
    popup.appendChild(row);
  });
  (popup.children[popupSel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
}
function hidePopup() {
  popup.classList.add("hidden");
  popupItems = [];
  fileToken = undefined;
}

function updateAutocomplete() {
  const v = input.value;
  const pos = input.selectionStart ?? v.length;
  // Slash commands: only at start, before the first space.
  const slash = v.match(/^\/(\S*)$/);
  if (slash && pos <= v.length) {
    const q = slash[1].toLowerCase();
    const all = [...commands.filter((c) => !BUILTINS.some((b) => b.name === c.name)), ...BUILTINS, ...commands.filter((c) => BUILTINS.some((b) => b.name === c.name))];
    const seen = new Set<string>();
    const list = all
      .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)))
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
      .slice(0, 50);
    showPopup(
      list.map((c) => ({
        label: `/${c.name}`,
        detail: c.description,
        tag: c.source === "builtin" ? "" : c.source,
        apply: () => {
          input.value = `/${c.name} `;
          hidePopup();
          resizeInput();
          input.focus();
        },
      })),
    );
    return;
  }
  // @file mentions
  const before = v.slice(0, pos);
  const at = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (at) {
    fileToken = { start: pos - at[1].length - 1, end: pos };
    post({ type: "searchFiles", query: at[1], requestId: ++fileReq });
    return;
  }
  hidePopup();
}

interface PathItem { label: string; insert: string; detail?: string; dir: boolean }

const FOLDER_ICON = `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M1.5 3h4.3l1.5 1.5h7.2v8.5h-13V3zm1 1v8h11V5.5H6.9L5.4 4H2.5z"/></svg>`;
const FILE_ICON = `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M3.5 1.5h6l3 3v10h-9v-13zm1 1v11h7V5H9V2.5H4.5z"/></svg>`;

/**
 * Show @-mention completions. Picking a folder inserts "@folder/" and immediately
 * lists its contents (drill down, like shell completion); picking a file inserts
 * "@path " and closes the list. Paths with spaces are quoted.
 */
function onFileResults(requestId: number, items: PathItem[]) {
  if (requestId !== fileReq || !fileToken) return;
  const tok = fileToken;
  showPopup(
    (items ?? []).map((it) => ({
      label: it.label,
      detail: it.detail,
      icon: it.dir ? FOLDER_ICON : FILE_ICON,
      apply: () => {
        const text = it.dir ? `@${it.insert}` : it.insert.includes(" ") ? `@"${it.insert}" ` : `@${it.insert} `;
        input.value = input.value.slice(0, tok.start) + text + input.value.slice(tok.end);
        const p = tok.start + text.length;
        input.setSelectionRange(p, p);
        resizeInput();
        input.focus();
        if (it.dir) updateAutocomplete(); // drill into the folder
        else hidePopup();
      },
    })),
  );
  fileToken = tok;
}

input.addEventListener("input", () => {
  resizeInput();
  updateAutocomplete();
});
input.addEventListener("keydown", (e) => {
  if (!popup.classList.contains("hidden") && popupItems.length) {
    if (e.key === "ArrowDown") { popupSel = (popupSel + 1) % popupItems.length; renderPopup(); e.preventDefault(); return; }
    if (e.key === "ArrowUp") { popupSel = (popupSel - 1 + popupItems.length) % popupItems.length; renderPopup(); e.preventDefault(); return; }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      const it = popupItems[popupSel];
      // Enter on an exact slash command with no args submits directly.
      if (e.key === "Enter" && it.label === input.value.trim()) { hidePopup(); }
      else { e.preventDefault(); it.apply(); return; }
    }
    if (e.key === "Escape") { hidePopup(); e.preventDefault(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit(e.altKey ? "followUp" : "steer");
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (!closeOverlay() && running) post({ type: "abort" });
  }
});
input.addEventListener("blur", () => {
  cancelBlurHide();
  blurHideTimer = window.setTimeout(hidePopup, 150);
});
input.addEventListener("focus", cancelBlurHide);
input.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items ?? ([] as any);
  for (const it of items as DataTransferItemList) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      e.preventDefault();
      const f = it.getAsFile();
      if (f) readImage(f);
    }
  }
});
const composer = $("composer");
composer.addEventListener("dragover", (e) => { e.preventDefault(); composer.classList.add("drag"); });
composer.addEventListener("dragleave", () => composer.classList.remove("drag"));
composer.addEventListener("drop", (e) => {
  composer.classList.remove("drag");
  const files = e.dataTransfer?.files;
  if (files?.length) {
    e.preventDefault();
    for (const f of files) if (f.type.startsWith("image/")) readImage(f);
    return;
  }
  const uri = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
  if (uri) {
    e.preventDefault();
    const refs = uri.split(/\r?\n/).filter(Boolean).map((u) => "@" + decodeURIComponent(u.replace(/^file:\/\//, "")).replace((state.cwd ?? "") + "/", ""));
    insertText(refs.join(" ") + " ");
  }
});
function readImage(f: File) {
  const r = new FileReader();
  r.onload = () => {
    const data = String(r.result).split(",")[1];
    images.push({ image: { type: "image", data, mimeType: f.type }, name: f.name || "pasted image" });
    renderAttachments();
  };
  r.readAsDataURL(f);
}
function insertText(text: string, replace = false) {
  if (replace) input.value = text;
  else {
    const s = input.selectionStart ?? input.value.length;
    const pre = input.value.slice(0, s);
    const sep = pre && !/\s$/.test(pre) ? " " : "";
    input.value = pre + sep + text + input.value.slice(input.selectionEnd ?? s);
  }
  resizeInput();
  input.focus();
}

sendBtn.addEventListener("click", () => (sendBtn.classList.contains("stop") ? post({ type: "abort" }) : submit("steer")));
$("btn-model").addEventListener("click", (e) => {
  e.stopPropagation();
  picker.toggle();
});
$("btn-image").addEventListener("click", () => post({ type: "pickImage" }));
// Composer toolbar buttons must not steal focus from the input: a blur would schedule
// hiding the "/" popup right after the click opened it (it then flashed and vanished).
for (const b of document.querySelectorAll<HTMLElement>(".composer .toolbar button")) {
  b.addEventListener("mousedown", (e) => e.preventDefault());
}
$("btn-slash").addEventListener("click", () => {
  // Always opens (or keeps open) the command list; Esc or clicking elsewhere closes it.
  if (!input.value.startsWith("/")) input.value = "/" + input.value;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  updateAutocomplete();
});
/**
 * Closes the topmost open menu or navigator. Returns true if one was open, so Esc acts on it
 * and does not abort the run (focus can leave a menu's search field, e.g. after a click on a row).
 */
function closeOverlay(): boolean {
  if (treeMenu.open) { treeMenu.escape(); return true; }
  if (listMenu.open) { listMenu.hide(); return true; }
  if (picker.open) { picker.hide(); return true; }
  const more = document.getElementById("tb-menu");
  if (more && !more.classList.contains("hidden")) { more.classList.add("hidden"); $("tb-more").focus(); return true; }
  if (!popup.classList.contains("hidden")) { hidePopup(); return true; }
  return false;
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if ($("dialogs").childElementCount) return;
  if (closeOverlay()) { e.preventDefault(); return; }
  if (running && document.activeElement !== input) post({ type: "abort" });
});

// ------------------------------------------------------------------ model picker

interface ModelInfo { provider: string; id: string; name: string; reasoning: boolean; contextWindow?: number; images?: boolean }

// ------------------------------------------------------------------ effort slider

let thinkingLevels: string[] = ["off"];

/**
 * Stepped effort slider shown in the model menu's footer. The DOM is built once
 * and updated in place (never re-created while it is being dragged), and uses
 * pointer capture on a padded hit area so clicks near the track register.
 */
class EffortSlider {
  private label: HTMLElement;
  private hit: HTMLElement;
  private track: HTMLElement;
  private dots: HTMLElement;
  private levels: string[] = [];
  private idx = 0;
  private dragging = false;

  constructor(private root: HTMLElement, private onCommit: (level: string) => void) {
    root.innerHTML = `
      <div class="mp-effort-label">Effort <span class="dim"></span></div>
      <div class="slider-hit" tabindex="0" role="slider" aria-label="Effort" title="Click or drag · ←/→">
        <div class="slider"><div class="slider-fill"></div><div class="slider-dots"></div><div class="slider-knob"></div></div>
      </div>`;
    this.label = root.querySelector(".mp-effort-label .dim")!;
    this.hit = root.querySelector(".slider-hit")!;
    this.track = root.querySelector(".slider")!;
    this.dots = root.querySelector(".slider-dots")!;

    this.hit.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.hit.focus();
      try { this.hit.setPointerCapture(e.pointerId); } catch {}
      this.dragging = true;
      this.root.classList.add("dragging");
      this.moveTo(e.clientX);
    });
    this.hit.addEventListener("pointermove", (e) => {
      if (this.dragging) this.moveTo(e.clientX);
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.root.classList.remove("dragging");
      try { this.hit.releasePointerCapture(e.pointerId); } catch {}
      this.commit();
    };
    this.hit.addEventListener("pointerup", end);
    this.hit.addEventListener("pointercancel", end);
    this.hit.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") { this.step(-1); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") { this.step(1); e.preventDefault(); e.stopPropagation(); }
    });
  }

  /** Sync with the current model's levels and state (ignored mid-drag). */
  update(levels: string[], current: string, visible: boolean) {
    this.root.classList.toggle("hidden", !visible);
    if (this.dragging) return;
    if (levels.join() !== this.levels.join()) {
      this.levels = [...levels];
      this.dots.innerHTML = levels.map((_, i) => `<i style="--p:${levels.length > 1 ? i / (levels.length - 1) : 0}"></i>`).join("");
    }
    this.show(Math.max(0, levels.indexOf(current)));
  }

  step(d: number) {
    if (this.levels.length < 2) return;
    this.show(Math.min(this.levels.length - 1, Math.max(0, this.idx + d)));
    this.commit();
  }

  private moveTo(clientX: number) {
    const r = this.track.getBoundingClientRect();
    const inset = 8; // knob radius: first/last stops sit inside the track ends
    const f = Math.min(1, Math.max(0, (clientX - r.left - inset) / Math.max(1, r.width - inset * 2)));
    this.show(Math.round(f * (this.levels.length - 1)));
  }

  private show(i: number) {
    this.idx = i;
    const p = this.levels.length > 1 ? i / (this.levels.length - 1) : 0;
    this.track.style.setProperty("--p", String(p));
    this.dots.querySelectorAll("i").forEach((d, j) => d.classList.toggle("on", j <= i));
    const level = this.levels[i] ?? "off";
    this.label.textContent = `(${levelLabel(level)})`;
    this.hit.setAttribute("aria-valuenow", String(i));
    this.hit.setAttribute("aria-valuetext", levelLabel(level));
  }

  private commit() {
    const level = this.levels[this.idx];
    if (level && level !== state.thinkingLevel) this.onCommit(level);
  }
}

class ModelPicker {
  open = false;
  private root = $("model-picker");
  private models: ModelInfo[] = [];
  private recent: string[] = [];
  private enabled?: string[];
  private scopeSource?: string;
  private unmatched: string[] = [];
  private showAll = false;
  private query = "";
  private sel = 0;
  private flat: ModelInfo[] = [];
  private search!: HTMLInputElement;
  private list!: HTMLElement;
  private loaded = false;
  private effort!: EffortSlider;

  constructor() {
    this.root.innerHTML = `
      <input class="mp-search" placeholder="Select a model" spellcheck="false" aria-label="Search models">
      <div class="mp-list" tabindex="-1"></div>
      <div class="mp-scope"></div>
      <div class="mp-effort"></div>`;
    this.search = this.root.querySelector(".mp-search")!;
    this.list = this.root.querySelector(".mp-list")!;
    this.effort = new EffortSlider(this.root.querySelector(".mp-effort")!, (level) => {
      state.thinkingLevel = level; // optimistic; host confirms via state
      updateModel();
      post({ type: "setThinking", level });
    });
    this.search.addEventListener("input", () => {
      this.query = this.search.value;
      this.sel = 0;
      this.renderList();
    });
    this.search.addEventListener("keydown", (e) => this.onKey(e));
    this.root.addEventListener("mousedown", (e) => e.stopPropagation());
    document.addEventListener("mousedown", (e) => {
      if (this.open && !(e.target as HTMLElement).closest("#btn-model")) this.hide();
    });
  }

  setData(models: ModelInfo[], levels: string[], recent: string[], enabled?: string[], scopeSource?: string, unmatched?: string[]) {
    this.enabled = enabled;
    this.scopeSource = scopeSource;
    this.unmatched = unmatched ?? [];
    this.models = models ?? [];
    thinkingLevels = levels?.length ? levels : ["off"];
    this.recent = recent ?? [];
    this.loaded = true;
    if (this.open) this.render();
  }

  toggle() {
    this.open ? this.hide() : this.show("");
  }

  show(query: string, focusEffort = false) {
    hidePopup();
    this.open = true;
    this.query = query;
    this.search.value = query;
    this.sel = -1; // select the current model on first render
    this.showAll = false;
    this.root.classList.remove("hidden");
    $("btn-model").classList.add("active");
    if (!this.loaded) this.list.innerHTML = `<div class="mp-empty">Loading models…</div>`;
    post({ type: "getModels" });
    this.render();
    if (focusEffort) this.focusEffort();
    else this.search.focus();
  }

  hide(focusInput = true) {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add("hidden");
    $("btn-model").classList.remove("active");
    if (focusInput) input.focus();
  }

  render() {
    this.renderList();
    this.renderEffort();
  }

  private isCurrent(m: ModelInfo) {
    return state.model && state.model.id === m.id && state.model.provider === m.provider;
  }

  private matches(m: ModelInfo, q: string) {
    if (!q) return true;
    const hay = `${m.name} ${m.id} ${m.provider}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
  }

  private renderEffort() {
    const visible = !!state.model?.reasoning && thinkingLevels.length > 1;
    this.effort.update(thinkingLevels, state.thinkingLevel ?? "off", visible);
  }

  private ctx(m: ModelInfo) {
    if (!m.contextWindow) return "";
    return m.contextWindow >= 1_000_000 ? `${+(m.contextWindow / 1_000_000).toFixed(1)}M context` : `${Math.round(m.contextWindow / 1000)}k context`;
  }

  /** One muted line: context · price · capabilities. Full id/provider is in the tooltip. */
  private detail(m: ModelInfo) {
    return [this.ctx(m), m.reasoning ? "reasoning" : "", m.images ? "images" : ""].filter(Boolean).join(" · ");
  }

  /** Everything else goes into the tooltip. */
  private tooltip(m: ModelInfo) {
    const lines = [`${m.provider}/${m.id}`];
    if (m.contextWindow) lines.push(this.ctx(m));
    if (m.reasoning) lines.push("Supports reasoning");
    return lines.join("\n");
  }

  private renderList() {
    if (!this.loaded) return;
    const q = this.query.trim();
    const key = (m: ModelInfo) => `${m.provider}/${m.id}`;
    const byKey = new Map(this.models.map((m) => [key(m), m]));
    const sections: { title?: string; items: ModelInfo[] }[] = [];
    const multiProvider = new Set(this.models.map((m) => m.provider)).size > 1;
    const enabled = this.enabled?.map((k) => byKey.get(k)).filter((m): m is ModelInfo => !!m);
    const scoped = !!enabled?.length && !this.showAll;
    const cur = this.models.find((m) => this.isCurrent(m));

    const grouped = (items: ModelInfo[], fallbackTitle?: string) => {
      if (multiProvider) {
        const groups = new Map<string, ModelInfo[]>();
        for (const m of items) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
        for (const [p, list] of groups) sections.push({ title: p, items: list });
      } else sections.push({ title: fallbackTitle ?? items[0]?.provider, items });
    };

    if (scoped) {
      // enabledModels configured: show exactly that list (in pattern order).
      if (!q) {
        if (cur && !enabled!.some((m) => key(m) === key(cur))) sections.push({ title: "Current", items: [cur] });
        sections.push({ title: "Enabled models", items: enabled! });
      } else {
        const hits = enabled!.filter((m) => this.matches(m, q));
        if (hits.length) sections.push({ title: "Enabled models", items: hits });
        const enabledKeys = new Set(enabled!.map(key));
        const others = this.models.filter((m) => !enabledKeys.has(key(m)) && this.matches(m, q));
        if (others.length) sections.push({ title: "Other models", items: others });
      }
    } else {
      if (!q) {
        const recent = [cur, ...this.recent.map((k) => byKey.get(k))]
          .filter((m): m is ModelInfo => !!m)
          .filter((m, i, a) => a.findIndex((x) => key(x) === key(m)) === i);
        if (recent.length) sections.push({ title: "Recent", items: recent });
      }
      const all = this.models.filter((m) => this.matches(m, q));
      grouped(all, q ? undefined : all[0]?.provider ?? "All models");
    }
    this.renderScope(enabled);

    this.flat = sections.flatMap((s) => s.items);
    if (this.sel < 0) this.sel = Math.max(0, this.flat.findIndex((m) => this.isCurrent(m)));
    this.sel = Math.min(this.sel, this.flat.length - 1);

    this.list.innerHTML = "";
    if (!this.flat.length) {
      this.list.innerHTML = `<div class="mp-empty">No models match “${escapeHtml(q)}”</div>`;
      return;
    }
    let idx = 0;
    const showHeaders = sections.filter((x) => x.items.length).length > 1;
    for (const s of sections) {
      if (!s.items.length) continue;
      if (s.title && showHeaders) this.list.appendChild(el("div", "mp-section", escapeHtml(s.title)));
      for (const m of s.items) {
        const i = idx++;
        const row = el("div", `mp-item${i === this.sel ? " active" : ""}${this.isCurrent(m) ? " current" : ""}`);
        const detail = this.detail(m);
        row.title = this.tooltip(m);
        row.innerHTML = `<div class="mp-text"><div class="mp-name">${escapeHtml(m.name)}</div>${detail ? `<div class="mp-detail">${escapeHtml(detail)}</div>` : ""}</div>${this.isCurrent(m) ? `<span class="mp-check">✓</span>` : ""}`;
        row.addEventListener("mousemove", () => {
          if (this.sel === i) return;
          this.sel = i;
          this.list.querySelectorAll(".mp-item").forEach((r, j) => r.classList.toggle("active", j === i));
        });
        row.addEventListener("click", () => this.choose(m));
        this.list.appendChild(row);
      }
    }
    this.scrollToSel();
  }

  private renderScope(enabled?: ModelInfo[]) {
    const box = this.root.querySelector(".mp-scope") as HTMLElement;
    const src = this.scopeSource ? shortPath(this.scopeSource).replace(/^\/Users\/[^/]+/, "~") : "settings.json";
    const text = enabled?.length && !this.showAll ? `${enabled.length} enabled` : `${this.models.length} models`;
    const tip = enabled?.length ? `enabledModels from ${src}` : `No enabledModels set in ${src}`;
    const warn = this.unmatched.length ? ` <span class="warn" title="Unmatched patterns:\n${escapeHtml(this.unmatched.join("\n"))}">⚠ ${this.unmatched.length}</span>` : "";
    box.innerHTML = `<span class="mp-scope-text" title="${escapeHtml(tip)}">${text}${warn}</span>`;
    if (enabled?.length) {
      const t = el("button", "link", this.showAll ? "Enabled only" : "Show all");
      t.addEventListener("click", () => {
        this.showAll = !this.showAll;
        this.sel = -1;
        this.renderList();
        this.search.focus();
      });
      box.appendChild(t);
    }
    const edit = el("button", "link", "Edit");
    edit.title = "Edit enabledModels in settings.json";
    edit.addEventListener("click", () => {
      post({ type: "editEnabledModels" });
      this.hide();
    });
    box.appendChild(edit);
  }

  private scrollToSel() {
    (this.list.querySelectorAll(".mp-item")[this.sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }

  private choose(m: ModelInfo) {
    if (!this.isCurrent(m)) {
      state.model = { ...state.model, ...m }; // optimistic; host sends full state
      post({ type: "setModel", provider: m.provider, id: m.id });
    }
    this.hide();
  }

  private onKey(e: KeyboardEvent) {
    const n = this.flat.length;
    if (e.key === "ArrowDown") { this.sel = (this.sel + 1) % n; this.renderList(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { this.sel = (this.sel - 1 + n) % n; this.renderList(); e.preventDefault(); }
    else if (e.key === "Enter") { const m = this.flat[this.sel]; if (m) this.choose(m); e.preventDefault(); }
    else if (e.key === "Escape") { this.hide(); e.preventDefault(); e.stopPropagation(); }
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && (!this.search.value || e.altKey)) {
      this.effort.step(e.key === "ArrowLeft" ? -1 : 1);
      e.preventDefault();
    } else if (e.key === "Tab") { this.effort.step(e.shiftKey ? -1 : 1); e.preventDefault(); }
  }

  focusEffort() {
    (this.root.querySelector(".slider-hit") as HTMLElement | null)?.focus();
  }
}
const picker = new ModelPicker();


// ------------------------------------------------------------------ dropdown list (sessions, fork)

interface ListItem {
  id: string;
  label: string;
  meta?: string;
  cols?: string[];
  group?: string;
  search?: string;
  current?: boolean;
  /** Hidden unless "Show archived" is on; rows then offer Unarchive. */
  archived?: boolean;
  /** The session is working right now (spinner instead of the dot). */
  running?: boolean;
  /** Open in a background process; can't be archived. */
  busy?: boolean;
  /** Id of the item this one is nested under (a forked or extension-started session). */
  parent?: string;
  depth?: number;
}

const ARCHIVE_ICON = `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M1.5 2h13v3.5h-1V14h-11V5.5h-1V2zm1 1v1.5h11V3h-11zm1 2.5V13h9V5.5h-9zM6 7h4v1H6V7z"/></svg>`;
const CHEVRON_ICON = `<svg viewBox="0 0 16 16"><path fill="currentColor" d="m6 3.6 4.4 4.4L6 12.4l-.7-.7L9 8 5.3 4.3z"/></svg>`;
const VIEW_ICON = `<svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor"/></svg>`;
const UNARCHIVE_ICON = `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M1.5 2h13v3.5h-1V14h-11V5.5h-1V2zm1 1v1.5h11V3h-11zm1 2.5V13h9V5.5h-9zM8 6.3l2.4 2.4-.7.7L8.5 8.2V12h-1V8.2L6.3 9.4l-.7-.7L8 6.3z"/></svg>`;

/**
 * Header-anchored navigator for sessions (/resume) and /fork. Shares its look with the
 * tree navigator (webview/treeMenu.ts): same box, search field, row metrics and footer.
 * Sessions can be archived: hidden from the list (kept on disk, still resumable by pi).
 * Sessions that came from another one (forks, subagents) are nested under it and collapsed.
 */
class ListMenu {
  open = false;
  private root = $("list-menu");
  private search!: HTMLInputElement;
  private list!: HTMLElement;
  private footer!: HTMLElement;
  private kind = "";
  get kindOpen() {
    return this.open ? this.kind : "";
  }
  private items: ListItem[] = [];
  private flat: ListItem[] = [];
  private sel = 0;
  private emptyText = "";
  private showArchived = false;
  /** Ids of nested items whose children are shown. */
  private expanded = new Set<string>();
  private byId = new Map<string, ListItem>();
  /** Number of visible items nested directly under each item (archived ones count only when shown). */
  private kids = new Map<string, number>();

  constructor() {
    this.root.innerHTML =
      `<div class="lm-head"><input class="mp-search" spellcheck="false">` +
      `<button class="lm-close" title="Close (Esc)" aria-label="Close">${I.close}</button></div>` +
      `<div class="mp-list"></div><div class="menu-footer"></div>`;
    this.search = this.root.querySelector(".mp-search")!;
    this.root.querySelector(".lm-close")!.addEventListener("click", () => this.hide());
    this.list = this.root.querySelector(".mp-list")!;
    this.footer = this.root.querySelector(".menu-footer")!;
    this.search.addEventListener("input", () => {
      this.sel = 0;
      this.render();
    });
    this.search.addEventListener("keydown", (e) => {
      const n = this.flat.length;
      if (e.key === "ArrowDown" && n) { this.sel = (this.sel + 1) % n; this.render(); e.preventDefault(); }
      else if (e.key === "ArrowUp" && n) { this.sel = (this.sel - 1 + n) % n; this.render(); e.preventDefault(); }
      else if (e.key === "PageDown" && n) { this.sel = Math.min(n - 1, this.sel + 10); this.render(); e.preventDefault(); }
      else if (e.key === "PageUp" && n) { this.sel = Math.max(0, this.sel - 10); this.render(); e.preventDefault(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && this.kind === "session") {
        const it = this.flat[this.sel];
        if (it && !it.id.startsWith("bg:")) this.act(it, "view");
        e.preventDefault();
      }
      else if (e.key === "Enter") { const it = this.flat[this.sel]; if (it) this.choose(it); e.preventDefault(); }
      else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !this.search.value && this.flat[this.sel]) {
        const it = this.flat[this.sel];
        const kids = this.kids.get(it.id);
        if (e.key === "ArrowRight" && kids && !this.expanded.has(it.id)) this.toggle(it);
        else if (e.key === "ArrowLeft" && kids && this.expanded.has(it.id)) this.toggle(it);
        else if (e.key === "ArrowLeft" && it.parent && this.byId.has(it.parent)) {
          this.sel = Math.max(0, this.flat.findIndex((x) => x.id === it.parent));
          this.render();
        }
        e.preventDefault();
      }
      else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey) && this.kind === "session") {
        const it = this.flat[this.sel];
        if (it && !it.current && !it.busy) this.act(it, it.archived ? "unarchive" : "archive");
        e.preventDefault();
      } else if (e.key === "Escape") { this.hide(); e.preventDefault(); e.stopPropagation(); }
    });
    this.root.addEventListener("mousedown", (e) => e.stopPropagation());
    document.addEventListener("mousedown", () => {
      if (this.open) this.hide();
    });
  }

  show(kind: string, placeholder: string, items: ListItem[], empty = "Nothing here", refresh = false) {
    treeMenu.hide();
    picker.hide(false);
    hidePopup();
    const keepId = refresh ? this.flat[this.sel]?.id : undefined;
    this.kind = kind;
    this.items = items;
    this.byId = new Map(items.map((it) => [it.id, it]));
    this.emptyText = empty;
    if (!refresh) {
      this.search.value = "";
      this.sel = 0;
      this.showArchived = false;
      this.expanded.clear();
      // Show where the current session is, if it is nested.
      for (let p = items.find((it) => it.current)?.parent; p && !this.expanded.has(p); p = this.byId.get(p)?.parent) this.expanded.add(p);
    }
    this.search.placeholder = placeholder;
    this.open = true;
    this.root.classList.remove("hidden");
    this.render(keepId);
    this.search.focus();
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add("hidden");
    input.focus();
  }

  private render(keepId?: string) {
    const q = this.search.value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const ancestors = (it: ListItem) => {
      const out: ListItem[] = [];
      for (let p = it.parent && this.byId.get(it.parent); p && !out.includes(p); p = p.parent && this.byId.get(p.parent)) out.push(p);
      return out;
    };
    const hidden = (it: ListItem) => !!it.archived && !this.showArchived;
    const matches = new Set(this.items.filter((it) => {
      if (hidden(it) || ancestors(it).some(hidden)) return false;
      const hay = `${it.label} ${it.search ?? ""} ${it.meta ?? ""} ${(it.cols ?? []).join(" ")}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    }));
    // With a query, show each match with the sessions it is nested under; without one, follow the folds.
    const shown = new Set<ListItem>();
    for (const it of matches) {
      const up = ancestors(it);
      if (words.length) [it, ...up].forEach((x) => shown.add(x));
      else if (up.every((p) => this.expanded.has(p.id))) shown.add(it);
    }
    this.flat = this.items.filter((it) => shown.has(it));
    this.kids.clear();
    for (const it of this.items) {
      if (it.parent && !hidden(it)) this.kids.set(it.parent, (this.kids.get(it.parent) ?? 0) + 1);
    }
    const nested = this.kids.size > 0;
    if (keepId) {
      const i = this.flat.findIndex((it) => it.id === keepId);
      if (i >= 0) this.sel = i;
    }
    this.sel = Math.min(this.sel, Math.max(0, this.flat.length - 1));
    this.list.innerHTML = "";
    if (!this.flat.length) {
      const allArchived = !q && !this.showArchived && this.items.some((it) => it.archived);
      this.list.innerHTML = `<div class="mp-empty">${escapeHtml(q ? `No matches for “${q}”` : allArchived ? "All sessions here are archived" : this.emptyText)}</div>`;
    }
    const archivable = this.kind === "session";
    let group: string | undefined;
    this.flat.forEach((it, i) => {
      if (it.group && it.group !== group && !it.depth) {
        group = it.group;
        this.list.appendChild(el("div", "lm-group", escapeHtml(group)));
      }
      const row = el("div", `mp-item lm-item${i === this.sel ? " active" : ""}${it.current ? " current" : ""}${it.archived ? " archived" : ""}${archivable ? " has-action" : ""}${it.depth ? " nested" : ""}`);
      row.title = it.search || it.label;
      const cols = it.cols ?? (it.meta ? [it.meta] : []);
      const open = this.expanded.has(it.id) || (!!words.length && this.flat.some((x) => x.parent === it.id));
      const kids = this.kids.get(it.id) ?? 0;
      const twisty = !nested ? "" : kids
        ? `<button class="lm-twisty${open ? " open" : ""}" title="${open ? "Hide" : "Show"} ${kids} nested session${kids === 1 ? "" : "s"} (${open ? "←" : "→"})">${CHEVRON_ICON}</button>`
        : `<span class="lm-twisty"></span>`;
      row.innerHTML =
        `<span class="lm-dot${it.running ? " lm-running" : ""}">${it.running ? SPINNER : it.current ? "●" : ""}</span>` +
        `<span class="lm-main" style="padding-left:${(it.depth ?? 0) * 16}px">${twisty}<span class="lm-label">${escapeHtml(it.label)}</span>` +
        (kids && !open ? `<span class="lm-kids">${kids}</span>` : "") + `</span>` +
        cols.map((c, j) => `<span class="lm-col lm-col-${j}">${escapeHtml(c)}</span>`).join("");
      row.querySelector("button.lm-twisty")?.addEventListener("click", (e) => {
        e.stopPropagation();
        this.sel = i;
        this.toggle(it);
        this.search.focus();
      });
      if (archivable) {
        const actions = el("span", "lm-actions");
        const v = el("button", "lm-action", VIEW_ICON);
        v.title = "View read-only in a new tab (⌘↵). It shows new messages as they are written.";
        v.disabled = it.id.startsWith("bg:");
        v.addEventListener("click", (e) => {
          e.stopPropagation();
          this.act(it, "view");
        });
        const b = el("button", "lm-action lm-archive", it.archived ? UNARCHIVE_ICON : ARCHIVE_ICON);
        b.title = it.current ? "The current session can't be archived" : it.busy ? "A running session can't be archived" : it.archived ? "Unarchive (⌘⌫)" : "Archive: hide from this list (⌘⌫)";
        b.disabled = !!it.current || !!it.busy;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          this.act(it, it.archived ? "unarchive" : "archive");
        });
        actions.append(v, b);
        row.appendChild(actions);
      }
      row.addEventListener("click", () => this.choose(it));
      this.list.appendChild(row);
    });
    (this.list.querySelectorAll(".lm-item")[this.sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
    this.renderFooter();
  }

  private renderFooter() {
    const f = this.footer;
    f.innerHTML = "";
    const hint = el("div", "menu-hint");
    const archivedCount = this.items.filter((it) => it.archived).length;
    const nested = this.kids.size > 0;
    hint.textContent = this.kind === "session" ? `Enter to open${nested ? " · → to expand" : ""} · ⌘↵ to view · ⌘⌫ to archive` : this.kind === "fork" ? "Enter to fork from this message" : "";
    f.appendChild(hint);
    if (this.kind === "session" && archivedCount) {
      const t = el("button", "link menu-toggle", this.showArchived ? "Hide archived" : `Show archived (${archivedCount})`);
      t.addEventListener("click", () => {
        const id = this.flat[this.sel]?.id;
        this.showArchived = !this.showArchived;
        this.render(id);
        this.search.focus();
      });
      f.appendChild(t);
    }
  }

  private toggle(it: ListItem) {
    if (this.expanded.has(it.id)) this.expanded.delete(it.id);
    else this.expanded.add(it.id);
    this.render(it.id);
  }

  private act(it: ListItem, action: "archive" | "unarchive" | "view") {
    if (action === "view") this.hide();
    post({ type: "listAction", kind: this.kind, id: it.id, action });
  }

  private choose(it: ListItem) {
    this.hide();
    post({ type: "listPick", kind: this.kind, id: it.id });
  }
}
const listMenu = new ListMenu();

const treeMenu = new TreeMenu(
  {
    post,
    escapeHtml,
    onOpen: () => {
      listMenu.hide();
      picker.hide(false);
      hidePopup();
    },
    onClose: () => input.focus(),
  },
  $("app"),
);

// ------------------------------------------------------------------ banner

function showBanner(html: string, actions: { label: string; fn: () => void }[] = [], cls = "error") {
  const b = $("banner");
  b.className = `banner ${cls}`;
  b.innerHTML = `<div class="banner-body">${html}</div>`;
  const row = el("div", "banner-actions");
  for (const a of actions) {
    const btn = el("button", "btn", a.label);
    btn.addEventListener("click", a.fn);
    row.appendChild(btn);
  }
  b.appendChild(row);
}
function hideBanner() {
  $("banner").className = "banner hidden";
}

// ------------------------------------------------------------------ widget width

/** Modules that render widgets to text (see `WebIntegrationApi.onWidgetColumns`). */
const widgetColumnListeners: ((columns: number) => void)[] = [];

/** Count the monospace characters that fit in a widget box, and tell the listeners when it changes. */
function watchWidgetColumns() {
  const bottom = document.querySelector<HTMLElement>(".bottom")!;
  const probe = el("div", "widget-body");
  probe.style.cssText = "position:absolute;visibility:hidden;left:0;top:0;padding:0;border:0;";
  probe.textContent = "0".repeat(100);
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const measure = () => {
    document.body.appendChild(probe);
    const charWidth = probe.getBoundingClientRect().width / 100;
    probe.remove();
    // .bottom padding (10px each side), the widget border (2px), body padding (12px) and the toggle with its margin (23px).
    const inner = bottom.clientWidth - 20 - 2 - 12 - 23;
    const columns = charWidth > 0 ? Math.floor(inner / charWidth) : 0;
    if (columns >= 20 && columns !== last) {
      last = columns;
      for (const cb of widgetColumnListeners) cb(columns);
    }
  };
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(measure, 300);
  }).observe(bottom);
  measure();
}

// ------------------------------------------------------------------ host messages

/** The VS Code bridge registers internal `vscode:*` commands; never show them. */
function visibleCommands(list?: Command[]): Command[] | undefined {
  return list?.filter((c) => !c.name.startsWith("vscode:"));
}

function applySnapshot(m: any) {
  state = { ...m.state, cwd: m.cwd ?? state.cwd };
  if (m.commands) commands = visibleCommands(m.commands)!;
  resetTranscript();
  for (const msg of m.messages ?? []) renderMessage(msg);
  setRunning(!!state.isStreaming);
  // A run that started before this snapshot (e.g. a session shown again after running in the background).
  if (running && m.runStartedAt) {
    runStart = m.runStartedAt;
    updateWorking();
  }
  updateTitle();
  updateModel();
  stick = true;
  autoscroll();
  hideBanner();
}

window.addEventListener("message", (ev) => {
  const m = ev.data;
  switch (m.type) {
    case "init":
    case "reset":
      if (READONLY) {
        applySnapshot(m);
        showBanner(
          `<b>Read-only view of this session.</b><div class="dim">New messages show when pi writes them to the session file.</div>`,
          [{ label: "Open in Chat", fn: () => post({ type: "openInChat" }) }],
          "info",
        );
        break;
      }
      if (m.commands) updateIntegrations(m.commands);
      for (const i of activeHooks()) i.onSnapshot?.(m.extEntries ?? []);
      // The host replays the session's statuses, widgets, queue and open dialogs after the snapshot.
      statuses.clear();
      renderStatus();
      widgets.clear();
      renderWidgets();
      renderQueue([], []);
      compacting = false;
      applySnapshot(m);
      break;
    case "state":
      state = { ...state, ...m.state };
      updateModel();
      updateTitle();
      break;
    case "stats":
      updateStats(m.stats);
      break;
    case "commands":
      commands = visibleCommands(m.commands) ?? commands;
      if (m.commands) updateIntegrations(m.commands);
      break;
    case "event":
      onEvent(m.event);
      break;
    case "appendMessages":
      // Read-only viewer: entries that pi wrote to the session file since the last update.
      for (const msg of m.messages ?? []) renderMessage(msg);
      autoscroll();
      break;
    case "terminalAttached":
      setRunning(false);
      document.body.classList.add("in-terminal");
      showBanner(
        `<b>This session is open in the terminal</b>${m.title ? ` (${escapeHtml(m.title)})` : ""}.<div class="dim">The chat is paused so both don't write to the same session. Close the terminal or reattach to continue here; everything done in the TUI will show up.</div>`,
        [
          { label: "Show Terminal", fn: () => post({ type: "showTerminal" }) },
          { label: "Reattach Here", fn: () => post({ type: "reattach" }) },
        ],
        "info",
      );
      break;
    case "terminalDetached":
      document.body.classList.remove("in-terminal");
      hideBanner();
      break;
    case "starting":
      hideBanner();
      break;
    case "exited":
      setRunning(false);
      showBanner(
        `<b>Pi process exited</b> (code ${m.code ?? m.signal ?? "?"}).${m.hint ? `<div>${escapeHtml(m.hint)}</div>` : ""}${m.stderr ? `<pre>${escapeHtml(m.stderr)}</pre>` : ""}`,
        [{ label: "Restart", fn: () => post({ type: "restart" }) }],
      );
      break;
    case "error":
      renderNote(`**Error:** ${m.message}`, "error");
      break;
    case "insertText":
      insertText(m.text, m.replace);
      break;
    case "restoreQueue":
      if (m.text) insertText(m.text, !input.value.trim());
      break;
    case "models":
      picker.setData(m.models, m.levels, m.recent, m.enabled, m.scopeSource, m.unmatched);
      break;
    case "openModelPicker":
      picker.show(m.query ?? "");
      break;
    case "openTree":
      if (treeMenu.open && !m.refresh && !m.selectId) treeMenu.hide();
      else treeMenu.show(m);
      break;
    case "treeBusy":
      treeMenu.setBusy(m.text ?? "");
      break;
    case "openList":
      if (m.refresh && listMenu.kindOpen === m.kind) listMenu.show(m.kind, m.placeholder, m.items ?? [], m.empty, true);
      else if (listMenu.open && m.kind === listMenu.kindOpen) listMenu.hide();
      else if (!m.refresh) listMenu.show(m.kind, m.placeholder, m.items ?? [], m.empty);
      break;
    case "ext":
      integrations.find((x) => x.def.id === m.id)?.hooks.onMessage?.(m.payload);
      break;
    case "openEffortPicker":
      picker.show("", true);
      break;
    case "fileResults":
      onFileResults(m.requestId, m.items ?? []);
      break;
    case "addImage":
      images.push({ image: m.image, name: m.name });
      renderAttachments();
      break;
    case "bashStart": {
      const c = new ToolCard(m.id, "bash");
      c.setArgs({ command: m.command, description: `! ${m.command.split("\n")[0]}` });
      bashCards.set(m.id, c);
      stick = true;
      autoscroll();
      break;
    }
    case "bashEnd": {
      const c = bashCards.get(m.id);
      if (c) {
        const r = m.result ?? {};
        c.setResult({ content: [{ type: "text", text: r.output ?? "" }] }, !!r.exitCode && !r.cancelled);
        bashCards.delete(m.id);
      }
      break;
    }
  }
});

// ------------------------------------------------------------------ integrations

/** Turn integrations on or off when the commands change (a new session or /restart can load other extensions). */
function updateIntegrations(list: PiCommand[]) {
  for (const x of integrations) {
    if (!x.def.matches) continue; // workarounds are always active
    const active = x.def.matches(list);
    if (active === x.active) continue;
    x.active = active;
    x.hooks.onActiveChange?.(active);
  }
}

for (const def of [...WEB_INTEGRATIONS, ...WEB_WORKAROUNDS]) {
  const key = `ext:${def.id}`;
  const hooks = def.create({
    post: (payload) => post({ type: "ext", id: def.id, payload }),
    addItem: (cls) => addItem(cls),
    addToolbarButton: ({ icon, title, onClick }) => {
      const header = !!document.body.dataset.header;
      const b = el("button", header ? "sp-icon" : "icon-btn", icon);
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", onClick);
      if (header) $("tb-tree").before(b);
      else {
        // Do not take focus from the input, like the other composer toolbar buttons.
        b.addEventListener("mousedown", (e) => e.preventDefault());
        $("btn-slash").after(b);
      }
      return b;
    },
    addComposerItem: (item, menu) => {
      // Like the other composer toolbar buttons: do not take focus from the input.
      item.addEventListener("mousedown", (e) => e.preventDefault());
      $("ctx").before(item);
      if (menu) $("model-picker").after(menu);
    },
    hidePopup: () => hidePopup(),
    onWidgetColumns: (cb) => void widgetColumnListeners.push(cb),
    icons: { close: I.close },
    insertText: (text) => insertText(text),
    focusComposer: () => input.focus(),
    md,
    mdUser,
    escapeHtml,
    linkify,
    loadState: <T>() => vscode.getState()?.[key] as T | undefined,
    saveState: (value) => vscode.setState({ ...(vscode.getState() ?? {}), [key]: value }),
  });
  integrations.push({ def, hooks, active: !def.matches });
}

updateEmpty();
resizeInput();
input.focus();
watchWidgetColumns(); // before "ready", so a module can tell the host the width before the first pi process starts
post({ type: "ready" });
