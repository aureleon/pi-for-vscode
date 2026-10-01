import { SPINNER } from "./spinner";
import { fmtDuration } from "./duration";
import { BTW_PROFILE, simpleProfile, type SideAction, type SideCommandConfig, type SideProfile } from "./sideProfiles";

/**
 * Side panel for "side conversation" extensions such as pi-btw.
 *
 * In Pi's TUI these extensions open an overlay composer. In RPC mode they refuse
 * to open it ("cannot open its composer outside Pi's TUI") and only accept an
 * inline question. This panel stands in for that overlay. A profile
 * (webview/sideProfiles.ts) says how one extension works:
 *
 *  - a bare `/cmd` (a profile command, or one learned from a refusal) opens the panel's composer;
 *  - `/cmd question` opens the panel and sends the question;
 *  - follow-ups typed in the panel are sent as `/<followUp> text`;
 *  - the profile's persisted thread entries fill the transcript live and restore it after reloads;
 *  - the profile's actions (for pi-btw: Inject, Summarize, Clear) are header buttons.
 */

export interface SideDeps {
  post(m: any): void;
  md(s: string): string;
  /** Markdown for user-typed text (keeps single line breaks). */
  mdUser?(s: string): string;
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
  /** The user has opened the panel since this turn arrived (clears the unread badge). */
  seen?: boolean;
  /** Id of the profile the turn was sent with; a thread entry only completes a turn of its own profile. */
  profile?: string;
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
  private titleEl!: HTMLElement;
  private modeEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  private turns: Turn[] = [];
  /** Profiles from the host (built-in ones merged with `pi.sidePanels`). */
  profiles: SideProfile[] = [BTW_PROFILE];
  /** The profile the panel shows now. */
  private profile: SideProfile = BTW_PROFILE;
  private mode = BTW_PROFILE.defaultMode ?? "";
  /** Mode of the thread on screen (from the last reset entry). */
  private threadMode = this.mode;
  /** Command used for the next submission (e.g. `btw:new` right after opening via /btw:new). */
  private nextCmd = "btw";
  /** Command used for follow-ups after the first submission. */
  private followCmd = "btw";
  private title = BTW_PROFILE.title;
  private reqSeq = 0;
  /** Side requests pi has not answered yet (notices are routed here meanwhile). */
  inflight = new Set<number>();
  private timer?: number;
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
        <button class="sp-icon sp-close" title="Close side panel (Esc)" aria-label="Close side panel">${ICON.close}</button>
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

  /** The profile that handles a command, if the side panel should take it over. */
  profileFor(cmd: string): SideProfile | undefined {
    const p = this.profiles.find((x) => x.commands[cmd]);
    if (p) return p;
    const learned = this.learned[cmd];
    return learned ? simpleProfile(cmd, learned) : undefined;
  }

  /**
   * Handle a slash command typed in the main composer. Returns true when the
   * side panel took it over.
   */
  interceptMain(cmd: string, args: string): boolean {
    const profile = this.profileFor(cmd);
    if (!profile) return false;
    this.configureFor(profile, cmd);
    this.show();
    if (args.trim()) this.submit(args, profile.commands[cmd]?.send ?? cmd);
    return true;
  }

  /** Called when an extension reports that it cannot open its composer. */
  learnFromRefusal(cmd: string) {
    const cfg: SideCommandConfig = { followUp: cmd, title: `/${cmd}` };
    this.learned[cmd] = cfg;
    this.configureFor(this.profileFor(cmd) ?? simpleProfile(cmd, cfg), cmd);
    this.show();
  }

  private configureFor(profile: SideProfile, cmd: string) {
    const c = profile.commands[cmd] ?? {};
    // Another extension's thread: keep only turns that are still waiting for an answer.
    if (profile.id !== this.profile.id) this.turns = this.turns.filter((t) => t.pending || t.profile === profile.id);
    this.profile = profile;
    this.mode = c.mode ?? this.mode;
    this.nextCmd = c.send ?? cmd;
    this.followCmd = c.followUp ?? (c.mode ? profile.modes?.[c.mode]?.followUp : undefined) ?? c.send ?? cmd;
    this.title = c.title ?? profile.title;
    // Starting a new/different thread type: clear the visible (non-pending) thread.
    if (c.newThread || (profile.modes && c.mode && this.mode !== this.threadMode)) this.turns = this.turns.filter((t) => t.pending);
    this.render();
  }

  /** The profile keeps a persisted thread: answers arrive as entries, not as notices. */
  private get hasThread() {
    return !!this.profile.entries?.thread;
  }

  // ------------------------------------------------------------ open/close

  show() {
    this.markSeen();
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
    this.markSeen();
    this.open = false;
    this.root.classList.add("hidden");
    this.splitter.classList.add("hidden");
    this.deps.onOpenChange(false);
  }

  toggle() {
    this.open ? this.hide() : this.show();
  }

  /** Turns the user hasn't looked at yet; 0 while the panel is open. */
  get count() {
    return this.open ? 0 : this.turns.filter((t) => !t.seen).length;
  }

  private markSeen() {
    for (const t of this.turns) t.seen = true;
  }

  // ------------------------------------------------------------ requests

  submit(text: string, cmd = this.nextCmd) {
    const q = text.trim();
    if (!q) return;
    const requestId = ++this.reqSeq;
    const flags = this.profile.stripFlags ?? [];
    const esc = (f: string) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const shown = flags.length ? q.replace(new RegExp(`(?:^|\\s)(?:${flags.map(esc).join("|")})(?=\\s|$)`, "g"), " ").trim() : q;
    this.turns.push({ question: shown, notes: [], pending: true, requestId, startedAt: Date.now(), profile: this.profile.id });
    this.inflight.add(requestId);
    this.deps.post({ type: "sidePrompt", text: `/${cmd} ${q}`, requestId });
    this.nextCmd = this.followCmd;
    this.input.value = "";
    this.resize();
    this.setStatus("");
    this.render();
    this.tick();
  }

  private runAction(a: SideAction) {
    const args = a.useInput ? this.input.value.trim() : "";
    const requestId = ++this.reqSeq;
    this.inflight.add(requestId);
    this.deps.post({ type: "sidePrompt", text: `/${a.command}${args ? " " + args : ""}`, requestId });
    if (a.useInput) this.input.value = "";
    this.setStatus(a.status ?? "");
  }

  /** pi finished handling a side-panel command. */
  onDone(requestId: number, error?: string, disposition?: string) {
    setTimeout(() => this.inflight.delete(requestId), 250);
    if (error && !this.turns.some((x) => x.requestId === requestId)) this.setStatus(error, "error");
    const t = this.turns.find((x) => x.requestId === requestId);
    if (t && t.pending) {
      t.pending = false;
      t.seen = this.open; // a result that lands while closed is unread
      if (error) t.error = error;
      else if (!t.answer && !t.notes.length && disposition !== "handled") t.notes.push("The command was sent to the main chat.");
      else if (!t.answer && !t.notes.length) t.notes.push("No side answer was produced.");
    }
    this.render();
  }

  /** Extension notices while a side request runs are shown in the panel. */
  onNotify(message: string, level: string) {
    const pending = [...this.turns].reverse().find((t) => t.pending);
    if ((this.profile.hideNotices ?? []).some((re) => safeRegExp(re)?.test(message))) return;
    if (pending && level === "error") pending.error = message;
    else if (pending && !this.hasThread) pending.notes.push(message);
    else this.setStatus(message, level);
    this.render();
  }

  // ------------------------------------------------------------ thread entries

  /** Apply a persisted custom entry (live `entry_appended` or restored from the session). */
  applyEntry(entry: any, live: boolean) {
    const type = entry?.customType;
    const owner = type ? this.profiles.find((p) => p.entries?.thread === type || p.entries?.reset === type) : undefined;
    if (!owner) return;
    const data = entry?.data ?? {};
    const f = owner.entries?.fields ?? {};
    const get = (k: "question" | "answer" | "thinking" | "model" | "usage" | "mode" | "timestamp") => data[f[k] ?? k];
    const switched = owner.id !== this.profile.id;
    if (switched) this.turns = this.turns.filter((t) => t.pending || t.profile === owner.id);
    this.profile = owner;
    if (type === owner.entries?.reset) {
      this.threadMode = get("mode") ?? owner.defaultMode ?? "";
      this.mode = this.threadMode;
      this.turns = this.turns.filter((t) => t.pending);
      if (live) this.setStatus("");
    } else if (get("question")) {
      const question = String(get("question"));
      const own = this.turns.filter((t) => t.pending && t.profile === owner.id);
      const pending = own.find((t) => t.question === question) ?? (live ? own[0] : undefined);
      const turn: Turn = pending ?? { question, notes: [], pending: false, startedAt: get("timestamp") ?? Date.now(), profile: owner.id };
      turn.answer = get("answer");
      turn.thinking = get("thinking");
      turn.model = get("model");
      turn.usage = get("usage");
      turn.pending = false;
      turn.seen = this.open;
      if (!pending) this.turns.push(turn);
      // Answers to a side command typed in the main composer also open the panel.
      if (live && (!this.open || switched)) {
        this.configureFor(owner, owner.defaultCommand ?? Object.keys(owner.commands)[0]);
        this.show();
      }
    } else return;
    this.render();
  }

  /** Replace the thread with the entries persisted on the active branch. */
  restore(entries: any[]) {
    this.turns = [];
    this.profile = this.profiles[0] ?? BTW_PROFILE;
    this.threadMode = this.mode = this.profile.defaultMode ?? "";
    for (const e of entries ?? []) this.applyEntry(e, false);
    this.markSeen(); // a restored thread isn't new
    const p = this.profile;
    const cmd = p.defaultCommand ?? Object.keys(p.commands)[0] ?? "";
    this.followCmd = p.modes?.[this.threadMode]?.followUp ?? p.commands[cmd]?.followUp ?? cmd;
    this.nextCmd = this.followCmd;
    this.title = p.title;
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
    const { escapeHtml, md } = this.deps;
    const p = this.profile;
    this.titleEl.textContent = this.title;
    const mode = p.modes?.[this.mode];
    const modeLabel = p.modes ? mode?.label ?? this.mode : "";
    this.modeEl.textContent = modeLabel;
    this.modeEl.classList.toggle("hidden", !modeLabel);

    this.actionsEl.innerHTML = "";
    const hasAnswer = this.turns.some((t) => t.answer);
    for (const a of p.actions ?? []) {
      if (a.separator && this.actionsEl.childElementCount) {
        const sep = document.createElement("span");
        sep.className = "sp-sep";
        this.actionsEl.appendChild(sep);
      }
      const b = this.button(a.label, a.tooltip ?? `/${a.command}`, () => this.runAction(a), a.icon ? ICON[a.icon] : undefined);
      b.disabled = (!!a.needsAnswer && !hasAnswer) || (!!a.needsTurns && !this.turns.length);
      this.actionsEl.appendChild(b);
    }

    this.body.innerHTML = "";
    if (!this.turns.length) {
      const empty = document.createElement("div");
      empty.className = "sp-empty";
      empty.innerHTML = p.emptyText
        ? `${escapeHtml(p.emptyText)}${mode?.hint ? `<br><span class="dim">${escapeHtml(mode.hint)}</span>` : ""}`
        : `Type a message for <code>/${escapeHtml(this.followCmd)}</code>.`;
      this.body.appendChild(empty);
    }
    for (const t of this.turns) {
      const q = document.createElement("div");
      q.className = "sp-q md";
      q.innerHTML = (this.deps.mdUser ?? md)(t.question);
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
    const fallback = `Message for /${this.followCmd}…`;
    this.input.placeholder = this.turns.length ? p.followUpPlaceholder ?? p.placeholder ?? fallback : p.placeholder ?? fallback;
  }
}

/** A user-supplied pattern; an invalid one is ignored, not fatal. */
function safeRegExp(source: string): RegExp | undefined {
  try {
    return new RegExp(source);
  } catch {
    return undefined;
  }
}
