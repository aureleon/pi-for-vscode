import { SPINNER } from "../../webview/spinner";
import { fmtDuration } from "../../webview/duration";
import type { WebIntegrationApi } from "../../webview/integrations";
import {
  ACTIONS,
  COMMANDS,
  DEFAULT_MODE,
  EMPTY_TEXT,
  FOLLOW_UP_PLACEHOLDER,
  HIDDEN_NOTICES,
  MODES,
  PLACEHOLDER,
  RESET_ENTRY,
  STRIP_FLAGS,
  THREAD_ENTRY,
  TITLE,
  type BtwAction,
} from "./profile";

/**
 * Side panel for pi-btw.
 *
 * In Pi's TUI, pi-btw opens an overlay composer. In RPC mode it refuses to open
 * it and only accepts an inline question. This panel stands in for the overlay:
 *
 *  - a bare `/btw` (or another pi-btw command) opens the panel's composer;
 *  - `/btw question` opens the panel and sends the question;
 *  - follow-ups typed in the panel are sent as `/<followUp> text`;
 *  - pi-btw's thread entries fill the thread live and restore it after reloads;
 *  - Inject, Summarize and Clear are header buttons.
 */

interface Turn {
  question: string;
  answer?: string;
  thinking?: string;
  model?: string;
  usage?: any;
  notes: string[];
  pending: boolean;
  error?: string;
  requestId?: number;
  startedAt: number;
  /** The user has opened the panel since this turn arrived (clears the unread badge). */
  seen?: boolean;
}

/** Split sizes: `row` is the width in a left/right split, `col` the height in a top/bottom split. */
export interface PanelSize {
  row?: number;
  col?: number;
}

// Codicon-style 16px icons for the header toolbar (matches VS Code's view title actions).
const ICON = {
  trash: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M10 3h3v1h-1v9.5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 13.5V4H3V3h3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1zM7 2v1h2V2H7zM5 4v9.5c0 .28.22.5.5.5h5a.5.5 0 0 0 .5-.5V4H5zm1.5 2h1v6h-1V6zm2 0h1v6h-1V6z"/></svg>`,
  close: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="m8 7.3 3.6-3.6.7.7L8.7 8l3.6 3.6-.7.7L8 8.7l-3.6 3.6-.7-.7L7.3 8 3.7 4.4l.7-.7z"/></svg>`,
};

export class SidePanel {
  open = false;
  private root: HTMLElement;
  private body!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private modeEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  private turns: Turn[] = [];
  private mode = DEFAULT_MODE;
  /** Mode of the thread on screen (from the last reset entry). */
  private threadMode = DEFAULT_MODE;
  /** Command used for the next submission (e.g. `btw:new` right after opening via /btw:new). */
  private nextCmd = "btw";
  /** Command used for follow-ups after the first submission. */
  private followCmd = "btw";
  private reqSeq = 0;
  /** Side requests pi has not answered yet (notices are routed here meanwhile). */
  inflight = new Set<number>();
  private timer?: number;
  private splitter: HTMLElement;

  constructor(
    private api: WebIntegrationApi,
    private size: PanelSize,
    private onChange: () => void,
  ) {
    // Split layout: body is a flex container [#app | splitter | side panel].
    // Wide views split left/right, narrow views (the usual sidebar) split top/bottom,
    // so the main conversation always stays visible next to the side thread.
    this.splitter = document.createElement("div");
    this.splitter.className = "side-splitter hidden";
    this.splitter.title = "Drag to resize · double-click to reset";
    document.body.appendChild(this.splitter);
    this.initSplitter();
    this.root = document.createElement("aside");
    this.root.className = "side-panel hidden";
    this.root.innerHTML = `
      <div class="sp-header">
        <div class="sp-title-wrap"><span class="sp-title"></span><span class="sp-mode"></span></div>
        <div class="sp-actions"></div>
        <button class="sp-icon sp-close" title="Close side panel (Esc)" aria-label="Close side panel">${ICON.close}</button>
      </div>
      <div class="sp-body"></div>
      <div class="sp-status"></div>
      <div class="sp-composer">
        <textarea rows="2"></textarea>
      </div>`;
    document.body.appendChild(this.root);
    this.root.querySelector(".sp-title")!.textContent = TITLE;
    this.body = this.root.querySelector(".sp-body")!;
    this.input = this.root.querySelector("textarea")!;
    this.statusEl = this.root.querySelector(".sp-status")!;
    this.modeEl = this.root.querySelector(".sp-mode")!;
    this.actionsEl = this.root.querySelector(".sp-actions")!;
    this.root.querySelector(".sp-close")!.addEventListener("click", () => this.hide());
    this.input.addEventListener("input", () => this.resize());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit(this.input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.hide();
      }
    });
    this.root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.hide();
      }
    });
    this.render();
  }

  // ------------------------------------------------------------ split sizing

  private get horizontal() {
    return window.matchMedia("(min-width: 640px)").matches;
  }

  private applySize() {
    const b = document.body.style;
    if (this.size.row) b.setProperty("--side-w", `${this.size.row}px`);
    else b.removeProperty("--side-w");
    if (this.size.col) b.setProperty("--side-h", `${this.size.col}px`);
    else b.removeProperty("--side-h");
  }

  private saveSize() {
    this.api.saveState({ size: this.size });
  }

  private initSplitter() {
    this.applySize();
    let dragging = false;
    this.splitter.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      try { this.splitter.setPointerCapture(e.pointerId); } catch {}
      document.body.classList.add("side-resizing");
    });
    this.splitter.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (this.horizontal) {
        const w = Math.round(window.innerWidth - e.clientX);
        this.size.row = Math.max(220, Math.min(w, window.innerWidth - 260));
      } else {
        const h = Math.round(window.innerHeight - e.clientY);
        this.size.col = Math.max(140, Math.min(h, window.innerHeight - 180));
      }
      this.applySize();
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      try { this.splitter.releasePointerCapture(e.pointerId); } catch {}
      document.body.classList.remove("side-resizing");
      this.saveSize();
    };
    this.splitter.addEventListener("pointerup", end);
    this.splitter.addEventListener("pointercancel", end);
    this.splitter.addEventListener("dblclick", () => {
      if (this.horizontal) delete this.size.row;
      else delete this.size.col;
      this.applySize();
      this.saveSize();
    });
  }

  // ------------------------------------------------------------ routing

  /** Handle a slash command typed in the main composer. Returns true when the panel took it over. */
  interceptMain(cmd: string, args: string): boolean {
    const c = COMMANDS[cmd];
    if (!c) return false;
    this.configureFor(cmd);
    this.show();
    if (args.trim()) this.submit(args, c.send ?? cmd);
    return true;
  }

  private configureFor(cmd: string) {
    const c = COMMANDS[cmd];
    this.mode = c.mode;
    this.nextCmd = c.send ?? cmd;
    this.followCmd = c.followUp ?? MODES[c.mode]?.followUp ?? c.send ?? cmd;
    // Starting a new thread, or one of another mode: clear the visible (non-pending) thread.
    if (c.newThread || this.mode !== this.threadMode) this.turns = this.turns.filter((t) => t.pending);
    this.render();
  }

  // ------------------------------------------------------------ open/close

  show() {
    this.markSeen();
    if (!this.open) {
      this.open = true;
      this.root.classList.remove("hidden");
      this.splitter.classList.remove("hidden");
    }
    this.render();
    this.onChange();
    setTimeout(() => this.input.focus(), 0);
  }

  hide() {
    if (!this.open) return;
    this.markSeen();
    this.open = false;
    this.root.classList.add("hidden");
    this.splitter.classList.add("hidden");
    this.onChange();
    this.api.focusComposer();
  }

  toggle() {
    this.open ? this.hide() : this.show();
  }

  /** Turns the user has not looked at yet; 0 while the panel is open. */
  get count() {
    return this.open ? 0 : this.turns.filter((t) => !t.seen).length;
  }

  private markSeen() {
    for (const t of this.turns) t.seen = true;
  }

  // ------------------------------------------------------------ requests

  private send(text: string, requestId: number) {
    this.inflight.add(requestId);
    this.api.post({ op: "prompt", text, requestId });
  }

  submit(text: string, cmd = this.nextCmd) {
    const q = text.trim();
    if (!q) return;
    const requestId = ++this.reqSeq;
    const esc = (f: string) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const shown = q.replace(new RegExp(`(?:^|\\s)(?:${STRIP_FLAGS.map(esc).join("|")})(?=\\s|$)`, "g"), " ").trim();
    this.turns.push({ question: shown, notes: [], pending: true, requestId, startedAt: Date.now() });
    this.send(`/${cmd} ${q}`, requestId);
    this.nextCmd = this.followCmd;
    this.input.value = "";
    this.resize();
    this.setStatus("");
    this.render();
    this.tick();
  }

  private runAction(a: BtwAction) {
    const args = a.useInput ? this.input.value.trim() : "";
    this.send(`/${a.command}${args ? " " + args : ""}`, ++this.reqSeq);
    if (a.useInput) this.input.value = "";
    this.setStatus(a.status ?? "");
  }

  /** pi finished a panel command. */
  onDone(requestId: number, error?: string, disposition?: string) {
    setTimeout(() => this.inflight.delete(requestId), 250);
    const t = this.turns.find((x) => x.requestId === requestId);
    if (error && !t) this.setStatus(error, "error");
    if (t && t.pending) {
      t.pending = false;
      t.seen = this.open; // a result that lands while the panel is closed is unread
      if (error) t.error = error;
      else if (!t.answer && !t.notes.length && disposition !== "handled") t.notes.push("The command was sent to the main chat.");
      else if (!t.answer && !t.notes.length) t.notes.push("No side answer was produced.");
    }
    this.render();
    this.onChange();
  }

  /** Notices while a panel command runs show in the panel. */
  onNotify(message: string, level: string) {
    if (!this.inflight.size || HIDDEN_NOTICES.test(message)) return;
    const pending = [...this.turns].reverse().find((t) => t.pending);
    if (pending && level === "error") pending.error = message;
    else this.setStatus(message, level);
    this.render();
  }

  // ------------------------------------------------------------ thread entries

  /** Apply a thread entry (live `entry_appended`, or restored from the session). */
  applyEntry(entry: any, live: boolean) {
    const type = entry?.customType;
    if (type !== THREAD_ENTRY && type !== RESET_ENTRY) return;
    const data = entry?.data ?? {};
    if (type === RESET_ENTRY) {
      this.threadMode = data.mode ?? DEFAULT_MODE;
      this.mode = this.threadMode;
      this.turns = this.turns.filter((t) => t.pending);
      if (live) this.setStatus("");
    } else if (data.question) {
      const question = String(data.question);
      const own = this.turns.filter((t) => t.pending);
      const pending = own.find((t) => t.question === question) ?? (live ? own[0] : undefined);
      const turn: Turn = pending ?? { question, notes: [], pending: false, startedAt: data.timestamp ?? Date.now() };
      turn.answer = data.answer;
      turn.thinking = data.thinking;
      turn.model = data.model;
      turn.usage = data.usage;
      turn.pending = false;
      turn.seen = this.open;
      if (!pending) this.turns.push(turn);
      // Answers to a side command typed in the main composer also open the panel.
      if (live && !this.open) this.show();
    } else return;
    this.render();
    this.onChange();
  }

  /** Replace the thread with the entries on the active branch. */
  restore(entries: any[]) {
    this.turns = [];
    this.threadMode = this.mode = DEFAULT_MODE;
    for (const e of entries ?? []) this.applyEntry(e, false);
    this.markSeen(); // a restored thread is not new
    this.followCmd = MODES[this.threadMode]?.followUp ?? "btw";
    this.nextCmd = this.followCmd;
    this.render();
    this.onChange();
  }

  /** The session no longer loads pi-btw: close the panel and forget the thread. */
  reset() {
    this.turns = [];
    this.inflight.clear();
    this.hide();
    this.render();
  }

  // ------------------------------------------------------------ rendering

  private setStatus(text: string, level = "info") {
    this.statusEl.textContent = text;
    this.statusEl.className = `sp-status ${level}`;
  }

  private resize() {
    this.input.style.height = "auto";
    this.input.style.height = Math.min(this.input.scrollHeight, 200) + "px";
  }

  private tick() {
    clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      const els = this.body.querySelectorAll<HTMLElement>(".sp-pending-time");
      if (!els.length) return clearInterval(this.timer);
      els.forEach((el) => (el.textContent = fmtDuration(Date.now() - Number(el.dataset.start))));
    }, 1000);
  }

  private button(label: string, title: string, fn: () => void, icon?: string) {
    const b = document.createElement("button");
    b.className = icon ? "sp-icon" : "sp-btn";
    if (icon) {
      b.innerHTML = icon;
      b.setAttribute("aria-label", label);
    } else b.textContent = label;
    b.title = title;
    b.addEventListener("click", fn);
    return b;
  }

  render() {
    const { escapeHtml, md, mdUser } = this.api;
    const mode = MODES[this.mode];
    this.modeEl.textContent = mode?.label ?? this.mode;
    this.modeEl.classList.toggle("hidden", !this.modeEl.textContent);

    this.actionsEl.innerHTML = "";
    const hasAnswer = this.turns.some((t) => t.answer);
    for (const a of ACTIONS) {
      if (a.separator && this.actionsEl.childElementCount) {
        const sep = document.createElement("span");
        sep.className = "sp-sep";
        this.actionsEl.appendChild(sep);
      }
      const b = this.button(a.label, a.tooltip, () => this.runAction(a), a.icon ? ICON[a.icon] : undefined);
      b.disabled = (!!a.needsAnswer && !hasAnswer) || (!!a.needsTurns && !this.turns.length);
      this.actionsEl.appendChild(b);
    }

    this.body.innerHTML = "";
    if (!this.turns.length) {
      const empty = document.createElement("div");
      empty.className = "sp-empty";
      empty.innerHTML = `${escapeHtml(EMPTY_TEXT)}${mode?.hint ? `<br><span class="dim">${escapeHtml(mode.hint)}</span>` : ""}`;
      this.body.appendChild(empty);
    }
    for (const t of this.turns) {
      const q = document.createElement("div");
      q.className = "sp-q md";
      q.innerHTML = mdUser(t.question);
      this.body.appendChild(q);
      const a = document.createElement("div");
      a.className = "sp-a";
      let html = "";
      if (t.thinking?.trim()) html += `<details class="sp-thinking"><summary>Thinking</summary><div class="md">${md(t.thinking)}</div></details>`;
      if (t.answer) html += `<div class="md">${md(t.answer)}</div>`;
      for (const n of t.notes) html += `<div class="sp-note">${escapeHtml(n)}</div>`;
      if (t.error) html += `<div class="sp-error">${escapeHtml(t.error)}</div>`;
      if (t.pending) html += `<div class="sp-pending">${SPINNER} Thinking on the side… <span class="sp-pending-time" data-start="${t.startedAt}">0s</span></div>`;
      if (t.model && !t.pending) {
        const tok = t.usage?.totalTokens ? ` · ${t.usage.totalTokens.toLocaleString()} tokens` : "";
        html += `<div class="sp-meta">${escapeHtml(t.model)}${tok}</div>`;
      }
      a.innerHTML = html;
      this.api.linkify(a);
      this.body.appendChild(a);
    }
    this.body.scrollTop = this.body.scrollHeight;
    this.input.placeholder = this.turns.length ? FOLLOW_UP_PLACEHOLDER : PLACEHOLDER;
  }
}
