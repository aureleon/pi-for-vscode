import type { WebIntegration } from "../../webview/integrations";
import { SPINNER } from "../../webview/spinner";
import { fmtDuration } from "../../webview/duration";
import css from "./styles.css";

/** A session that an extension runs inside this chat's process, for example a subagent. */
interface ChildRun {
  file: string;
  title?: string;
  startedAt?: number;
}

/**
 * Webview side of the child-runs workaround. Child sessions (subagents, workflow agents) are not
 * in the RPC event stream, so the chat can look idle while they work. The host sends the count;
 * the toolbar shows it next to the context ring, and a click lists the sessions above the composer.
 */
export const childRunsWeb: WebIntegration = {
  id: "child-runs",
  create(api) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const button = document.createElement("button");
    button.className = "runs hidden";
    button.setAttribute("aria-haspopup", "true");
    const menu = document.createElement("div");
    menu.className = "model-picker runs-menu hidden";
    api.addComposerItem(button, menu);

    const { escapeHtml } = api;
    const view = {
      count: 0,
      runs: [] as ChildRun[],
      open: false,
      timer: undefined as number | undefined,

      set(count: number, runs: ChildRun[]) {
        this.count = Math.max(0, count | 0);
        this.runs = runs ?? [];
        button.classList.toggle("hidden", !this.count);
        const noun = this.count === 1 ? "session" : "sessions";
        // Built once, so the spinner's animation does not restart when the count changes.
        if (!button.firstChild) button.innerHTML = `${SPINNER}<span class="runs-count"></span><span class="runs-label">running</span>`;
        button.querySelector(".runs-count")!.textContent = String(this.count);
        button.title = this.count ? `${this.count} ${noun} running in this chat (for example subagents). Click to list them.` : "";
        button.setAttribute("aria-label", `${this.count} ${noun} running`);
        if (!this.count) this.hide();
        else if (this.open) this.render();
      },

      toggle() {
        this.open ? this.hide() : this.show();
      },

      show() {
        if (!this.count) return;
        api.hidePopup();
        this.open = true;
        menu.classList.remove("hidden");
        button.classList.add("active");
        // Titles of new runs can appear in their files after the first update; ask again.
        api.post({ op: "get" });
        this.render();
        clearInterval(this.timer);
        this.timer = window.setInterval(() => this.tick(), 1000);
      },

      hide() {
        if (!this.open) return;
        this.open = false;
        menu.classList.add("hidden");
        button.classList.remove("active");
        clearInterval(this.timer);
        this.timer = undefined;
      },

      render() {
        const now = Date.now();
        const rows = this.runs
          .map((r) => {
            // A new run has no title until pi writes its first prompt to the file.
            const name = r.title || "Untitled session";
            const start = r.startedAt ? ` data-start="${r.startedAt}"` : "";
            return `<div class="mp-item runs-item" title="${escapeHtml(r.title ? `${r.title}\n${r.file}` : r.file)}">${SPINNER}<div class="mp-text"><div class="mp-name">${escapeHtml(name)}</div><div class="mp-detail"${start}>${this.elapsed(r.startedAt, now)}</div></div></div>`;
          })
          .join("");
        // Sessions that extensions keep only in memory have no file, so they have no title.
        const unnamed = this.count - this.runs.length;
        const extra = unnamed > 0
          ? `<div class="mp-item runs-item">${SPINNER}<div class="mp-text"><div class="mp-name">${unnamed} ${unnamed === 1 ? "session" : "sessions"} without a session file</div><div class="mp-detail">running</div></div></div>`
          : "";
        menu.innerHTML =
          `<div class="lm-head"><span class="runs-title">Running in this chat</span>` +
          `<button class="lm-close" title="Close (Esc)" aria-label="Close">${api.icons.close}</button></div>` +
          `<div class="mp-list">${rows}${extra}</div>` +
          `<div class="menu-footer"><span class="menu-hint">You can open a session from /resume when it finishes.</span></div>`;
        menu.querySelector(".lm-close")!.addEventListener("click", () => this.hide());
      },

      elapsed(startedAt: number | undefined, now: number) {
        return startedAt ? `running for ${fmtDuration(now - startedAt)}` : "running";
      },

      /** Update the times in place. Rebuilding the rows would restart the spinners' animation every second. */
      tick() {
        const now = Date.now();
        menu.querySelectorAll<HTMLElement>(".mp-detail[data-start]").forEach((d) => {
          d.textContent = this.elapsed(Number(d.dataset.start), now);
        });
      },
    };

    button.addEventListener("click", () => view.toggle());
    menu.addEventListener("mousedown", (e) => e.stopPropagation());
    document.addEventListener("mousedown", (e) => {
      if (view.open && !button.contains(e.target as Node)) view.hide();
    });
    document.addEventListener("keydown", (e) => {
      if (view.open && e.key === "Escape") {
        view.hide();
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    return {
      onSnapshot: () => view.set(0, []),
      onMessage(m) {
        if (m?.op === "runs") view.set(m.count, m.runs);
      },
    };
  },
};
