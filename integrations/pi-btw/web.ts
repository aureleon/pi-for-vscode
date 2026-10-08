import type { WebIntegration } from "../../webview/integrations";
import { hasPiBtw, NOTE_MESSAGE, TITLE } from "./profile";
import { SidePanel, type PanelSize } from "./sidePanel";
import css from "./styles.css";

const SIDE_ICON = `<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor"/><path d="M10 2.5v11" stroke="currentColor"/><path d="M11.5 5.5h1.5M11.5 7.5h1.5" stroke="currentColor"/></svg>`;

/** Webview side of the pi-btw integration: the side panel, its toggle button and the transcript links. */
export const btwWeb: WebIntegration = {
  id: "pi-btw",
  matches: hasPiBtw,
  create(api) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    const button = api.addToolbarButton({ icon: SIDE_ICON, title: "Toggle BTW Side Panel", onClick: () => panel.toggle() });
    button.classList.add("btw-toggle", "hidden");
    const badge = document.createElement("span");
    badge.className = "btw-badge hidden";
    button.appendChild(badge);

    let lastCount = -1;
    /** Show unread side-thread turns on the button and on the native view. */
    const update = () => {
      const n = panel.count;
      badge.textContent = n ? String(n) : "";
      badge.classList.toggle("hidden", !n);
      button.classList.toggle("active", panel.open);
      if (n !== lastCount) api.post({ op: "badge", count: n });
      lastCount = n;
    };
    const saved = api.loadState<{ size?: PanelSize }>();
    const panel = new SidePanel(api, { ...(saved?.size ?? {}) }, update);

    return {
      onActiveChange(active) {
        button.classList.toggle("hidden", !active);
        if (!active) panel.reset();
        update();
      },
      onSnapshot: (entries) => panel.restore(entries),
      onEntry: (entry) => panel.applyEntry(entry, true),
      onNotice: (text, level) => panel.onNotify(text, level),
      interceptCommand: (name, args) => panel.interceptMain(name, args),
      onMessage(m) {
        if (m?.op === "done") panel.onDone(m.requestId, m.error, m.disposition);
      },
      /** Side-thread notes live in the panel; the main transcript only shows a compact link. */
      renderCustomMessage(msg) {
        if (msg.customType !== NOTE_MESSAGE) return false;
        const text = typeof msg.content === "string" ? msg.content : (msg.content ?? []).find((b: any) => b.type === "text")?.text ?? "";
        const q = msg.details?.question ?? text.replace(/^\*\*Question\*\*\s*/, "").split("\n")[0];
        const item = api.addItem("note btw-link");
        item.innerHTML = `<span class="btw-tag"></span><span class="btw-q"></span>`;
        (item.querySelector(".btw-tag") as HTMLElement).textContent = TITLE;
        (item.querySelector(".btw-q") as HTMLElement).textContent = q;
        item.title = "Open in side panel";
        item.addEventListener("click", () => panel.show());
        return true;
      },
    };
  },
};
