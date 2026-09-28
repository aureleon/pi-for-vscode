import { SPINNER } from "./spinner";

/**
 * Side panel for "side conversation" extensions such as pi-btw.
 *
 * In Pi's TUI these extensions open an overlay composer. In RPC mode they refuse
 * to open it ("cannot open its composer outside Pi's TUI") and only accept an
 * inline question. This panel stands in for that overlay:
 *
 *  - a bare `/btw` (or any configured / auto-detected command) opens the panel's composer;
 *  - `/btw question` opens the panel and sends the question;
 *  - follow-ups typed in the panel are sent as `/<followUp> text`;
 *  - pi-btw's persisted thread entries (`btw-thread-entry`, `btw-thread-reset`)
 *    fill the transcript live and restore it after reloads;
 *  - Inject / Summarize / New / Clear map to pi-btw's lifecycle commands.
 */

export interface SideCommandConfig {
  followUp?: string;
  title?: string;
}

export interface SideDeps {
  post(m: any): void;
  md(s: string): string;
  escapeHtml(s: string): string;
  linkify(el: HTMLElement): void;
  onOpenChange(open: boolean): void;
  /** Persisted split sizes ({ row: px width, col: px height }). */
  initialSize?: { row?: number; col?: number };
  saveSize(size: { row?: number; col?: number }): void;
}

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
}

const BTW_FAMILY = /^(btw|side)(:|$)/;
const MODE_LABEL: Record<string, string> = { contextual: "", tangent: "tangent · no main context", readonly: "read-only" };

export class SidePanel {
  open = false;
  private root: HTMLElement;
  private body!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private statusEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private modeEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  private turns: Turn[] = [];
  private mode = "contextual";
  /** Command used for the next submission (e.g. `btw:new` right after opening via /btw:new). */
  private nextCmd = "btw";
  /** Command used for follow-ups after the first submission. */
  private followCmd = "btw";
  private title = "BTW";
  private reqSeq = 0;
  /** Side requests pi has not answered yet (notices are routed here meanwhile). */
  inflight = new Set<number>();
  private timer?: number;
  config: Record<string, SideCommandConfig> = {};
  /** Commands learned at runtime from composer-refusal notices. */
  learned: Record<string, SideCommandConfig> = {};

  private splitter: HTMLElement;
  private size: { row?: number; col?: number };

  constructor(private deps: SideDeps) {
    // Split layout: body is a flex container [#app | splitter | side panel].
    // Wide views split left/right, narrow views (the usual sidebar) split top/bottom,
    // so the main conversation always stays visible next to the side thread.
    this.size = { ...(deps.initialSize ?? {}) };
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
        <button class="icon-btn sp-close" title="Close side panel (Esc)"><svg viewBox="0 0 16 16"><path fill="currentColor" d="m8 7.3 3.6-3.6.7.7L8.7 8l3.6 3.6-.7.7L8 8.7l-3.6 3.6-.7-.7L7.3 8 3.7 4.4l.7-.7z"/></svg></button>
      </div>
      <div class="sp-body"></div>
      <div class="sp-status"></div>
      <div class="sp-composer">
        <textarea rows="2" placeholder="Ask a side question…  (Enter to send, Esc to close)"></textarea>
      </div>`;
    document.body.appendChild(this.root);
    this.body = this.root.querySelector(".sp-body")!;
    this.input = this.root.querySelector("textarea")!;
    this.statusEl = this.root.querySelector(".sp-status")!;
    this.titleEl = this.root.querySelector(".sp-title")!;
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
      this.deps.saveSize(this.size);
    };
    this.splitter.addEventListener("pointerup", end);
    this.splitter.addEventListener("pointercancel", end);
    this.splitter.addEventListener("dblclick", () => {
      if (this.horizontal) delete this.size.row;
      else delete this.size.col;
      this.applySize();
      this.deps.saveSize(this.size);
    });
  }

  // ------------------------------------------------------------ routing

  /** Config entry for a command, if it should be handled by the side panel. */
  commandConfig(cmd: string): SideCommandConfig | undefined {
    return this.config[cmd] ?? this.learned[cmd];
  }

  /**
   * Handle a slash command typed in the main composer. Returns true when the
   * side panel took it over.
   */
  interceptMain(cmd: string, args: string): boolean {
    const cfg = this.commandConfig(cmd);
    if (!cfg) return false;
    this.configureFor(cmd, cfg);
    this.show();
    if (args.trim()) this.submit(args, cmd);
    return true;
  }

  /** Called when an extension reports that it cannot open its composer. */
  learnFromRefusal(cmd: string) {
    const cfg = { followUp: cmd, title: `/${cmd}` };
    this.learned[cmd] = cfg;
    this.configureFor(cmd, cfg);
    this.show();
  }

  private configureFor(cmd: string, cfg: SideCommandConfig) {
    const isNewThread = cmd === "btw:new" || cmd === "btw:tangent" || cmd === "btw:ask";
    this.nextCmd = cmd === "side" ? "btw" : cmd;
    this.followCmd = cfg.followUp ?? cmd;
    this.title = cfg.title ?? `/${cmd}`;
    if (cmd === "btw:tangent") this.mode = "tangent";
    else if (cmd === "btw:ask") this.mode = "readonly";
    else if (cmd === "btw" || cmd === "side" || cmd === "btw:new") this.mode = "contextual";
    // Starting a new/different thread type: clear the visible (non-pending) thread.
    if (isNewThread || (BTW_FAMILY.test(cmd) && this.mode !== this.threadMode)) this.turns = this.turns.filter((t) => t.pending);
    this.render();
  }

  private threadMode = "contextual";

  private get isBtw() {
    return BTW_FAMILY.test(this.followCmd);
  }

  // ------------------------------------------------------------ open/close

  show() {
    if (!this.open) {
      this.open = true;
      this.root.classList.remove("hidden");
      this.splitter.classList.remove("hidden");
      this.deps.onOpenChange(true);
    }
    this.render();
    setTimeout(() => this.input.focus(), 0);
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add("hidden");
    this.splitter.classList.add("hidden");
    this.deps.onOpenChange(false);
  }

  toggle() {
    this.open ? this.hide() : this.show();
  }

  get count() {
    return this.turns.length;
  }

  // ------------------------------------------------------------ requests

  submit(text: string, cmd = this.nextCmd) {
    const q = text.trim();
    if (!q) return;
    const requestId = ++this.reqSeq;
    this.turns.push({ question: q.replace(/(?:^|\s)(?:--save|-s)(?=\s|$)/g, " ").trim(), notes: [], pending: true, requestId, startedAt: Date.now() });
    this.inflight.add(requestId);
    this.deps.post({ type: "sidePrompt", text: `/${cmd} ${q}`, requestId });
    this.nextCmd = this.followCmd;
    this.input.value = "";
    this.resize();
    this.setStatus("");
    this.render();
    this.tick();
  }

  private runLifecycle(cmd: string, useInputAsArgs = true) {
    const args = useInputAsArgs ? this.input.value.trim() : "";
    const requestId = ++this.reqSeq;
    this.inflight.add(requestId);
    this.deps.post({ type: "sidePrompt", text: `/${cmd}${args ? " " + args : ""}`, requestId });
    if (useInputAsArgs) this.input.value = "";
    this.setStatus(cmd === "btw:inject" ? "Injecting thread into the main chat…" : cmd === "btw:summarize" ? "Summarizing thread for the main chat…" : "");
  }

  /** pi finished handling a side-panel command. */
  onDone(requestId: number, error?: string, disposition?: string) {
    setTimeout(() => this.inflight.delete(requestId), 250);
    if (error && !this.turns.some((x) => x.requestId === requestId)) this.setStatus(error, "error");
    const t = this.turns.find((x) => x.requestId === requestId);
    if (t && t.pending) {
      t.pending = false;
      if (error) t.error = error;
      else if (!t.answer && !t.notes.length && disposition !== "handled") t.notes.push("The command was sent to the main chat.");
      else if (!t.answer && !t.notes.length) t.notes.push("No side answer was produced.");
    }
    this.render();
  }

  /** Extension notices while a side request runs are shown in the panel. */
  onNotify(message: string, level: string) {
    const pending = [...this.turns].reverse().find((t) => t.pending);
    if (/^(Displayed BTW response|BTW response queued|Saved BTW note|BTW note queued)/.test(message)) return;
    if (pending && level === "error") pending.error = message;
    else if (pending && !this.isBtw) pending.notes.push(message);
    else this.setStatus(message, level);
    this.render();
  }

  // ------------------------------------------------------------ pi-btw entries

  /** Apply a persisted custom entry (live `entry_appended` or restored from the session). */
  applyEntry(entry: any, live: boolean) {
    const data = entry?.data ?? {};
    if (entry?.customType === "btw-thread-reset") {
      this.threadMode = data.mode ?? "contextual";
      this.mode = this.threadMode;
      this.turns = this.turns.filter((t) => t.pending);
      if (live) this.setStatus("");
    } else if (entry?.customType === "btw-thread-entry" && data.question) {
      const pending = this.turns.find((t) => t.pending && t.question === data.question) ?? (live ? this.turns.find((t) => t.pending) : undefined);
      const turn: Turn = pending ?? { question: data.question, notes: [], pending: false, startedAt: data.timestamp ?? Date.now() };
      turn.answer = data.answer;
      turn.thinking = data.thinking;
      turn.model = data.model;
      turn.usage = data.usage;
      turn.pending = false;
      if (!pending) this.turns.push(turn);
      // Answers to /btw typed in the main composer also open the panel.
      if (live && !this.open) {
        this.configureFor("btw", this.config.btw ?? { followUp: "btw", title: "BTW" });
        this.show();
      }
    } else return;
    this.render();
  }

  /** Replace the thread with the entries persisted on the active branch. */
  restore(entries: any[]) {
    this.turns = [];
    this.threadMode = this.mode = "contextual";
    for (const e of entries ?? []) this.applyEntry(e, false);
    this.followCmd = this.threadMode === "tangent" ? "btw:tangent" : this.threadMode === "readonly" ? "btw:ask" : "btw";
    this.nextCmd = this.followCmd;
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
      els.forEach((el) => (el.textContent = `${Math.round((Date.now() - Number(el.dataset.start)) / 1000)}s`));
    }, 1000);
  }

  private button(label: string, title: string, fn: () => void) {
    const b = document.createElement("button");
    b.className = "sp-btn";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", fn);
    return b;
  }

  render() {
    const { escapeHtml, md } = this.deps;
    this.titleEl.textContent = this.title;
    const modeLabel = this.isBtw ? MODE_LABEL[this.mode] ?? this.mode : "";
    this.modeEl.textContent = modeLabel;
    this.modeEl.classList.toggle("hidden", !modeLabel);

    this.actionsEl.innerHTML = "";
    if (this.isBtw) {
      const has = this.turns.some((t) => t.answer);
      const inject = this.button("Inject", "Send the full thread to the main agent (/btw:inject). Text in the box is used as instructions.", () => this.runLifecycle("btw:inject"));
      const summarize = this.button("Summarize", "Send a summary of the thread to the main agent (/btw:summarize). Text in the box is used as instructions.", () => this.runLifecycle("btw:summarize"));
      const fresh = this.button("New", "Start a fresh side thread (/btw:new)", () => {
        this.turns = this.turns.filter((t) => t.pending);
        this.mode = "contextual";
        this.nextCmd = "btw:new";
        this.followCmd = "btw";
        this.render();
        this.input.focus();
      });
      const clear = this.button("Clear", "Clear the side thread (/btw:clear)", () => this.runLifecycle("btw:clear", false));
      inject.disabled = summarize.disabled = !has;
      this.actionsEl.append(inject, summarize, fresh, clear);
    }

    this.body.innerHTML = "";
    if (!this.turns.length) {
      const empty = document.createElement("div");
      empty.className = "sp-empty";
      empty.innerHTML = this.isBtw
        ? `Ask a side question without interrupting the main agent.<br><span class="dim">${
            this.mode === "tangent" ? "This thread does not see the main conversation." : this.mode === "readonly" ? "This thread can read files but cannot change anything." : "The side thread sees the main conversation's context."
          }</span>`
        : `Type a message for <code>/${escapeHtml(this.followCmd)}</code>.`;
      this.body.appendChild(empty);
    }
    for (const t of this.turns) {
      const q = document.createElement("div");
      q.className = "sp-q";
      q.textContent = t.question;
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
      this.deps.linkify(a);
      this.body.appendChild(a);
    }
    this.body.scrollTop = this.body.scrollHeight;
    this.input.placeholder = this.isBtw
      ? this.turns.length ? "Follow up on the side…  (Enter to send, Esc to close)" : "Ask a side question…  (Enter to send, Esc to close)"
      : `Message for /${this.followCmd}…`;
  }
}
