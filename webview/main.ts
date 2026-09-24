import { marked } from "marked";
import { ansiToHtml, escapeHtml, stripAnsi } from "./ansi";

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

// ------------------------------------------------------------------ icons

const I = {
  history: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 1.5a6.5 6.5 0 1 1-6.1 8.7l1-.4A5.5 5.5 0 1 0 3.3 5H5.5v1h-4V2h1v2.1A6.5 6.5 0 0 1 8 1.5zM7.5 4h1v3.8l2.6 1.5-.5.9-3.1-1.8V4z"/></svg>`,
  plus: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M7.5 2h1v5.5H14v1H8.5V14h-1V8.5H2v-1h5.5z"/></svg>`,
  newChat: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H6.2L3 13.8V11h.5-.0A1.5 1.5 0 0 1 2 9.5v-6zm1.5-.5a.5.5 0 0 0-.5.5v6c0 .28.22.5.5.5H4v1.6L5.8 10h6.7a.5.5 0 0 0 .5-.5v-6a.5.5 0 0 0-.5-.5h-9zM7.5 4.5h1v1.5H10v1H8.5v1.5h-1V7H6V6h1.5z"/></svg>`,
  slash: `<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor"/><path d="M10 4.5 6 11.5" stroke="currentColor" stroke-width="1.2"/></svg>`,
  image: `<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/><circle cx="5.5" cy="6" r="1.2" fill="currentColor"/><path d="m2 12 4-4 3 3 2-2 3 3" fill="none" stroke="currentColor"/></svg>`,
  send: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 2.5 13.5 8l-.7.7L8.5 4.4V14h-1V4.4L3.2 8.7l-.7-.7z"/></svg>`,
  stop: `<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/></svg>`,
  close: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="m8 7.3 3.6-3.6.7.7L8.7 8l3.6 3.6-.7.7L8 8.7l-3.6 3.6-.7-.7L7.3 8 3.7 4.4l.7-.7z"/></svg>`,
  brain: `<svg viewBox="0 0 16 16"><path fill="none" stroke="currentColor" d="M6 2.5a2 2 0 0 0-2 2 2 2 0 0 0-1.5 3 2 2 0 0 0 .5 3.5 2 2 0 0 0 3 2V2.5zM10 2.5a2 2 0 0 1 2 2 2 2 0 0 1 1.5 3 2 2 0 0 1-.5 3.5 2 2 0 0 1-3 2V2.5z"/></svg>`,
};

// ------------------------------------------------------------------ DOM

const app = document.getElementById("app")!;
app.innerHTML = `
  <header class="header">
    <img class="header-logo" id="header-logo" alt="">
    <div class="title" id="title">New session</div>
    <button class="icon-btn" id="btn-history" title="Resume session (/resume)">${I.history}</button>
    <button class="icon-btn" id="btn-new" title="New session (/new)">${I.newChat}</button>
  </header>
  <div id="banner" class="banner hidden"></div>
  <main id="scroll" class="scroll">
    <div id="messages" class="messages"></div>
    <div id="empty" class="empty">
      <img class="logo" id="empty-logo" alt="pi">
      <div>Ask Pi anything about your code.</div>
      <div class="hint">Type <kbd>/</kbd> for commands, <kbd>@</kbd> to mention files, <kbd>!</kbd> to run a shell command.</div>
    </div>
    <div id="working" class="working hidden"><span class="spinner">✱</span><span id="working-text">Working…</span></div>
  </main>
  <div id="dialogs"></div>
  <div class="bottom">
    <div id="widgets-above" class="widgets"></div>
    <div id="queue" class="queue hidden"></div>
    <div class="composer" id="composer">
      <div id="popup" class="popup hidden"></div>
      <div id="model-picker" class="model-picker hidden"></div>
      <div id="effort-picker" class="effort-picker hidden"></div>
      <div id="attachments" class="attachments hidden"></div>
      <textarea id="input" rows="1" placeholder="Ask Pi…  (/ commands, @ files, ! shell)"></textarea>
      <div class="toolbar">
        <button class="icon-btn" id="btn-image" title="Attach image">${I.image}</button>
        <button class="icon-btn" id="btn-slash" title="Commands">${I.slash}</button>
        <button class="chip" id="btn-model" title="Select model"><span id="model-name">…</span></button>
        <button class="chip dim" id="btn-effort" title="Select effort (thinking level)">${I.brain}<span id="thinking-level"></span></button>
        <span class="spacer"></span>
        <span class="ctx" id="ctx" title="Context usage"></span>
        <button class="send" id="btn-send" title="Send (Enter)">${I.send}</button>
      </div>
    </div>
    <div id="widgets-below" class="widgets"></div>
    <div id="statusline" class="statusline"></div>
  </div>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LOGO = document.body.dataset.logo ?? "";
$<HTMLImageElement>("empty-logo").src = LOGO;
$<HTMLImageElement>("header-logo").src = LOGO;
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
const toolCards = new Map<string, ToolCard>();
const bashCards = new Map<string, ToolCard>();
let firstUserText = "";

// ------------------------------------------------------------------ scrolling

let stick = true;
scrollEl.addEventListener("scroll", () => {
  stick = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 60;
});
let scrollQueued = false;
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
const isPathLike = (s: string) => /^(~|\.{1,2})?\/?[\w@.\-]+(\/[\w@.\-]+)+(:\d+(-\d+)?)?$/.test(s) || /^[\w\-]+\.[a-z0-9]{1,6}(:\d+)?$/i.test(s);

/** Make inline code that looks like a path clickable. */
function linkify(root: HTMLElement) {
  root.querySelectorAll("code").forEach((c) => {
    if (c.parentElement?.tagName === "PRE") return;
    const t = c.textContent ?? "";
    if (isPathLike(t)) {
      c.classList.add("file-link");
      c.title = "Open file";
    }
  });
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".copy-btn")) return;
    const b = el("button", "copy-btn", "Copy");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? pre.textContent ?? "");
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1200);
    });
    pre.appendChild(b);
  });
}
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const link = t.closest(".file-link") as HTMLElement | null;
  if (link) {
    const raw = link.dataset.path ?? link.textContent ?? "";
    const m = raw.match(/^(.*?)(?::(\d+)(?:-\d+)?)?$/)!;
    post({ type: "openFile", path: m[1], line: m[2] ? Number(m[2]) : undefined });
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
  const body = el("div", "user-text");
  body.textContent = text;
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

interface Block { type: string; el: HTMLElement; text: string; id?: string }
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
      autoscroll();
    });
  }

  renderBlock(b: Block) {
    if (b.type === "text") {
      const target = b.el.querySelector(".md") as HTMLElement;
      target.innerHTML = md(b.text);
      linkify(target);
      b.el.classList.toggle("hidden", !b.text.trim());
    } else if (b.type === "thinking") {
      const body = b.el.querySelector(".thinking-body") as HTMLElement;
      body.innerHTML = md(b.text);
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
        if (!c.thinking?.trim() && c.redacted) return;
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

class ToolCard {
  item: HTMLElement;
  private head: HTMLElement;
  private body: HTMLElement;
  private inRow?: HTMLElement;
  private outRow?: HTMLElement;
  args: any = {};
  done = false;

  constructor(public id: string, public name: string) {
    this.item = addItem("tool pending");
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

  private setRow(which: "in" | "out", label: string, html: string, cls = "") {
    this.body.classList.remove("hidden");
    let row = which === "in" ? this.inRow : this.outRow;
    if (!row) {
      row = el("div", `tool-row ${which}`);
      row.innerHTML = `<div class="tool-label"></div><div class="tool-content"><pre></pre></div>`;
      row.addEventListener("click", () => row!.classList.toggle("expanded"));
      if (which === "in") {
        this.inRow = row;
        this.body.prepend(row);
      } else {
        this.outRow = row;
        this.body.append(row);
      }
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
  }

  setResult(result: any, isError: boolean) {
    this.done = true;
    this.item.classList.remove("pending");
    this.item.classList.add(isError ? "failed" : "ok");
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

function getToolCard(id: string, name: string): ToolCard {
  let c = toolCards.get(id);
  if (!c) {
    c = new ToolCard(id, name);
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
      const c = getToolCard(e.toolCallId, e.toolName);
      if (e.args && !Object.keys(c.args).length) c.setArgs(e.args);
      break;
    }
    case "tool_execution_update":
      getToolCard(e.toolCallId, e.toolName).setPartial(e.partialResult);
      break;
    case "tool_execution_end":
      getToolCard(e.toolCallId, e.toolName).setResult(e.result, e.isError);
      break;
    case "queue_update":
      renderQueue(e.steering ?? [], e.followUp ?? []);
      break;
    case "compaction_start":
      renderNote(`Compacting context (${e.reason})…`, "muted compaction");
      break;
    case "compaction_end":
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
    case "notify":
      break; // shown natively by the host
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
function renderWidgets() {
  const above = $("widgets-above");
  const below = $("widgets-below");
  above.innerHTML = below.innerHTML = "";
  for (const [key, w] of widgets) {
    const box = el("div", "widget");
    box.dataset.key = key;
    box.innerHTML = w.lines.map((l) => `<div>${ansiToHtml(l) || "&nbsp;"}</div>`).join("");
    (w.placement === "belowEditor" ? below : above).appendChild(box);
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

function updateTitle() {
  const t = state.sessionName || firstUserText.split("\n")[0] || "New session";
  $("title").textContent = t;
  $("title").title = t;
}
function levelLabel(l?: string): string {
  if (!l) return "";
  return l === "xhigh" ? "X-High" : l[0].toUpperCase() + l.slice(1);
}
function updateModel() {
  const m = state.model;
  $("model-name").textContent = m ? (m.name ?? m.id) : "Select model";
  $("btn-model").title = m ? `${m.provider}/${m.id} — click to change model` : "Select model";
  const lvl = state.thinkingLevel ?? "off";
  $("thinking-level").textContent = levelLabel(lvl);
  $("btn-effort").classList.toggle("hidden", !m?.reasoning);
  $("btn-effort").title = `Effort: ${levelLabel(lvl)} — click to change thinking level`;
  if (picker.open) picker.render();
  if (effortPicker.open) effortPicker.render();
}
function updateStats(s: any) {
  const ctx = $("ctx");
  if (!s) return (ctx.textContent = "");
  const parts: string[] = [];
  const cu = s.contextUsage;
  if (cu?.percent != null) parts.push(`${Math.round(cu.percent)}%`);
  if (s.cost) parts.push(`$${s.cost.toFixed(2)}`);
  ctx.textContent = parts.join(" · ");
  ctx.title = cu ? `Context: ${cu.tokens != null ? fmtTokens(cu.tokens) : "?"} / ${fmtTokens(cu.contextWindow)} tokens\nSession tokens: ${fmtTokens(s.tokens?.total ?? 0)}\nCost: $${(s.cost ?? 0).toFixed(4)}` : "";
}

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
}
function updateWorking() {
  if (!running) return;
  const secs = Math.round((Date.now() - runStart) / 1000);
  const toks = outputTokens ? ` · ↓ ${fmtTokens(outputTokens)} tokens` : "";
  $("working-text").textContent = `${verb}… (${secs}s${toks} · esc to interrupt)`;
}

function renderQueue(steering: string[], followUp: string[]) {
  const q = $("queue");
  const items = [...steering.map((t) => ({ t, k: "steer" })), ...followUp.map((t) => ({ t, k: "follow-up" }))];
  q.classList.toggle("hidden", !items.length);
  q.innerHTML = items.map((i) => `<div class="queued"><span class="tag">${i.k}</span>${escapeHtml(i.t.split("\n")[0])}</div>`).join("");
  if (items.length) {
    const clear = el("button", "link", "Clear queue");
    clear.addEventListener("click", () => post({ type: "clearQueue" }));
    q.appendChild(clear);
  }
}

// ------------------------------------------------------------------ composer

function resizeInput() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 300) + "px";
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

interface PopupItem { label: string; detail?: string; tag?: string; apply: () => void }
let popupItems: PopupItem[] = [];
let popupSel = 0;
let fileReq = 0;
let fileToken: { start: number; end: number } | undefined;

function showPopup(items: PopupItem[]) {
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
    row.innerHTML = `<span class="popup-label">${escapeHtml(it.label)}</span>${it.detail ? `<span class="popup-detail">${escapeHtml(it.detail)}</span>` : ""}${it.tag ? `<span class="popup-tag">${escapeHtml(it.tag)}</span>` : ""}`;
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

function onFileResults(requestId: number, files: string[]) {
  if (requestId !== fileReq || !fileToken) return;
  const tok = fileToken;
  showPopup(
    files.map((f) => ({
      label: f.split("/").pop()!,
      detail: f,
      apply: () => {
        const ref = f.includes(" ") ? `@"${f}" ` : `@${f} `;
        input.value = input.value.slice(0, tok.start) + ref + input.value.slice(tok.end);
        const p = tok.start + ref.length;
        input.setSelectionRange(p, p);
        hidePopup();
        resizeInput();
        input.focus();
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
  } else if (e.key === "Escape" && running) {
    e.preventDefault();
    post({ type: "abort" });
  }
});
input.addEventListener("blur", () => setTimeout(hidePopup, 150));
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
$("btn-new").addEventListener("click", () => post({ type: "builtin", name: "new" }));
$("btn-history").addEventListener("click", () => post({ type: "builtin", name: "resume" }));
$("btn-model").addEventListener("click", (e) => {
  e.stopPropagation();
  picker.toggle();
});
$("btn-effort").addEventListener("click", (e) => {
  e.stopPropagation();
  effortPicker.toggle();
});
$("btn-image").addEventListener("click", () => post({ type: "pickImage" }));
$("btn-slash").addEventListener("click", () => {
  if (!input.value.startsWith("/")) input.value = "/" + input.value;
  input.focus();
  updateAutocomplete();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && running && document.activeElement !== input && !$("dialogs").childElementCount) post({ type: "abort" });
});

// ------------------------------------------------------------------ model picker

interface ModelInfo { provider: string; id: string; name: string; reasoning: boolean; contextWindow?: number; cost?: { input: number; output: number }; images?: boolean }

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

  constructor() {
    this.root.innerHTML = `
      <div class="mp-title">Select a model</div>
      <input class="mp-search" placeholder="Search models…" spellcheck="false">
      <div class="mp-list" tabindex="-1"></div>
      <div class="mp-scope"></div>`;
    this.search = this.root.querySelector(".mp-search")!;
    this.list = this.root.querySelector(".mp-list")!;
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
    if (effortPicker.open) effortPicker.render();
    this.recent = recent ?? [];
    this.loaded = true;
    if (this.open) this.render();
  }

  toggle() {
    this.open ? this.hide() : this.show("");
  }

  show(query: string) {
    hidePopup();
    effortPicker.hide(false);
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
    this.search.focus();
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
  }

  private isCurrent(m: ModelInfo) {
    return state.model && state.model.id === m.id && state.model.provider === m.provider;
  }

  private matches(m: ModelInfo, q: string) {
    if (!q) return true;
    const hay = `${m.name} ${m.id} ${m.provider}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).every((t) => hay.includes(t));
  }

  private detail(m: ModelInfo) {
    const parts = [m.id];
    if (m.contextWindow) parts.push(m.contextWindow >= 1_000_000 ? `${m.contextWindow / 1_000_000}M context` : `${Math.round(m.contextWindow / 1000)}k context`);
    if (m.reasoning) parts.push("reasoning");
    if (m.cost && (m.cost.input || m.cost.output)) parts.push(`$${m.cost.input}/$${m.cost.output}`);
    return parts.join(" · ");
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
    for (const s of sections) {
      if (!s.items.length) continue;
      if (s.title) this.list.appendChild(el("div", "mp-section", escapeHtml(s.title)));
      for (const m of s.items) {
        const i = idx++;
        const row = el("div", `mp-item${i === this.sel ? " active" : ""}${this.isCurrent(m) ? " current" : ""}`);
        row.innerHTML = `<div class="mp-text"><div class="mp-name">${escapeHtml(m.name)}</div><div class="mp-detail">${escapeHtml(this.detail(m))}</div></div>${this.isCurrent(m) ? `<span class="mp-check">✓</span>` : ""}`;
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
    let text: string;
    if (enabled?.length) {
      text = this.showAll
        ? `Showing all ${this.models.length} models`
        : `${enabled.length} enabled model${enabled.length === 1 ? "" : "s"} from <span class="mono" title="${escapeHtml(this.scopeSource ?? "")}">${escapeHtml(src)}</span>`;
    } else {
      text = `All ${this.models.length} models · no <span class="mono">enabledModels</span> set`;
    }
    const warn = this.unmatched.length ? ` · <span class="warn" title="${escapeHtml(this.unmatched.join("\n"))}">${this.unmatched.length} pattern${this.unmatched.length === 1 ? "" : "s"} unmatched</span>` : "";
    box.innerHTML = `<span class="mp-scope-text">${text}${warn}</span>`;
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
  }
}
const picker = new ModelPicker();

// ------------------------------------------------------------------ effort picker

let thinkingLevels: string[] = ["off"];
const LEVEL_INFO: Record<string, string> = {
  off: "No extended thinking",
  minimal: "Very brief reasoning",
  low: "Light reasoning, faster",
  medium: "Balanced depth and speed",
  high: "Deep reasoning",
  xhigh: "Extra deep reasoning",
  max: "Maximum reasoning budget",
};

class EffortPicker {
  open = false;
  private root = $("effort-picker");
  private loaded = false;

  constructor() {
    this.root.tabIndex = -1;
    this.root.addEventListener("mousedown", (e) => e.stopPropagation());
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    document.addEventListener("mousedown", (e) => {
      if (this.open && !(e.target as HTMLElement).closest("#btn-effort")) this.hide();
    });
  }

  toggle() {
    this.open ? this.hide() : this.show();
  }

  show() {
    hidePopup();
    picker.hide(false);
    this.open = true;
    this.root.classList.remove("hidden");
    $("btn-effort").classList.add("active");
    // Anchor under the chip horizontally.
    const chip = $("btn-effort");
    const composerRect = $("composer").getBoundingClientRect();
    const left = Math.max(0, Math.min(chip.getBoundingClientRect().left - composerRect.left, composerRect.width - 280));
    this.root.style.left = `${left}px`;
    if (!this.loaded) post({ type: "getModels" }); // also returns thinking levels for the current model
    this.loaded = true;
    this.render();
    this.root.focus();
  }

  hide(focusInput = true) {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add("hidden");
    $("btn-effort").classList.remove("active");
    if (focusInput) input.focus();
  }

  render() {
    const levels = thinkingLevels;
    const cur = state.thinkingLevel ?? "off";
    const idx = Math.max(0, levels.indexOf(cur));
    const pct = levels.length > 1 ? idx / (levels.length - 1) : 0;
    this.root.innerHTML = `
      <div class="ep-head">
        <div class="ep-title">Effort <span class="dim">(${escapeHtml(levelLabel(cur))})</span></div>
        <div class="slider" role="slider" aria-valuemin="0" aria-valuemax="${levels.length - 1}" aria-valuenow="${idx}" title="←/→ to adjust">
          <div class="slider-fill" style="width:calc(20px + (100% - 20px) * ${pct})"></div>
          ${levels.map((l, i) => `<div class="slider-dot${i <= idx ? " on" : ""}" style="left:calc(10px + (100% - 20px) * ${levels.length > 1 ? i / (levels.length - 1) : 0})"></div>`).join("")}
          <div class="slider-knob" style="left:calc(10px + (100% - 20px) * ${pct})"></div>
        </div>
      </div>
      <div class="ep-list"></div>`;
    const list = this.root.querySelector(".ep-list")!;
    levels.forEach((l) => {
      const row = el("div", `ep-item${l === cur ? " active" : ""}`);
      row.innerHTML = `<div class="mp-text"><div class="mp-name">${escapeHtml(levelLabel(l))}</div><div class="mp-detail">${escapeHtml(LEVEL_INFO[l] ?? "")}</div></div>${l === cur ? `<span class="mp-check">✓</span>` : ""}`;
      row.addEventListener("click", () => {
        this.set(l);
        this.hide();
      });
      list.appendChild(row);
    });
    const slider = this.root.querySelector(".slider") as HTMLElement;
    const pick = (clientX: number) => {
      const r = slider.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (clientX - r.left - 10) / (r.width - 20)));
      this.set(levels[Math.round(f * (levels.length - 1))]);
    };
    slider.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pick(e.clientX);
      const move = (ev: MouseEvent) => pick(ev.clientX);
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        this.root.focus();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  set(level: string | undefined) {
    if (!level || level === state.thinkingLevel) return;
    state.thinkingLevel = level; // optimistic; host confirms via state
    updateModel();
    post({ type: "setThinking", level });
  }

  private step(d: number) {
    const i = Math.max(0, thinkingLevels.indexOf(state.thinkingLevel ?? "off"));
    this.set(thinkingLevels[Math.min(thinkingLevels.length - 1, Math.max(0, i + d))]);
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") { this.step(-1); e.preventDefault(); }
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") { this.step(1); e.preventDefault(); }
    else if (e.key === "Enter" || e.key === "Escape") { this.hide(); e.preventDefault(); e.stopPropagation(); }
    else if (/^[0-9]$/.test(e.key) && thinkingLevels[Number(e.key)]) { this.set(thinkingLevels[Number(e.key)]); }
  }
}
const effortPicker = new EffortPicker();

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

// ------------------------------------------------------------------ host messages

function applySnapshot(m: any) {
  state = { ...m.state, cwd: m.cwd ?? state.cwd };
  if (m.commands) commands = m.commands;
  resetTranscript();
  for (const msg of m.messages ?? []) renderMessage(msg);
  setRunning(!!state.isStreaming);
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
      applySnapshot(m);
      if (m.type === "reset") {
        statuses.clear();
        renderStatus();
      }
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
      commands = m.commands ?? commands;
      break;
    case "event":
      onEvent(m.event);
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
    case "openEffortPicker":
      effortPicker.show();
      break;
    case "fileResults":
      onFileResults(m.requestId, m.files);
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

updateEmpty();
resizeInput();
input.focus();
post({ type: "ready" });
