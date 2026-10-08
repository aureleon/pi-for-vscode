import type { HostIntegration } from "../../src/integrations";
import { COMPOSER_REFUSAL, hasPiBtw, HIDDEN_NOTICES, RESET_ENTRY, THREAD_ENTRY } from "./profile";

/**
 * Host side of the pi-btw integration. It runs the panel's commands in pi and
 * keeps the notices of those commands out of VS Code notifications, because
 * the panel shows them.
 */
export const btwHost: HostIntegration = {
  id: "pi-btw",
  matches: hasPiBtw,
  entryTypes: [THREAD_ENTRY, RESET_ENTRY],
  create(api) {
    /** Panel commands that pi has not answered yet. */
    let pending = 0;
    return {
      filterNotice: (message) => pending > 0 || HIDDEN_NOTICES.test(message) || COMPOSER_REFUSAL.test(message),
      async onMessage(m) {
        if (m?.op === "badge") {
          api.setBadge(m.count ?? 0, m.count ? `${m.count} side-thread message${m.count === 1 ? "" : "s"}` : undefined);
          return;
        }
        if (m?.op !== "prompt") return;
        // Extension commands run to completion before pi responds, so the response marks
        // the end of the side request (pi-btw resolves only when its side answer is ready).
        pending++;
        try {
          const res = await api.prompt(String(m.text));
          api.post({ op: "done", requestId: m.requestId, disposition: res?.disposition });
        } catch (err: any) {
          api.post({ op: "done", requestId: m.requestId, error: err?.message ?? String(err) });
        } finally {
          // Late notices from the same command can trail the response slightly.
          setTimeout(() => pending--, 250);
        }
      },
    };
  },
};
