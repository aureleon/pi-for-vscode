import * as path from "node:path";
import type { ExtSession, HostIntegration } from "../../src/integrations";
import { summarizeSession } from "../../src/sessions";

/** Hidden status key that `pi.ts` reports in: `{ count, files }` of running child sessions. */
const STATUS_KEY = "vscode:work";

interface Runs {
  count: number;
  files: string[];
  /** When each file was first reported; `pi.ts` does not send start times. */
  startedAt: Map<string, number>;
}

/**
 * Host side of the child-runs workaround. A process whose extensions run agent sessions is busy:
 * the controller keeps it in the background on a session switch instead of stopping it, and no
 * other process may open the session files that those sessions write. The composer shows the
 * running sessions (`web.ts`).
 */
export const childRunsHost: HostIntegration = {
  id: "child-runs",
  piExtension: "workarounds/child-runs.mjs",
  create(api) {
    const runs = new Map<ExtSession, Runs>();
    /** Titles of child session files, read once a file has a name or a first prompt. */
    const titles = new Map<string, string>();
    let shown: ExtSession | undefined;

    /**
     * Tell the webview which child sessions run. Titles come from the session files. pi writes a
     * file only after the first reply, so a new run can have no title yet; the next update reads it again.
     */
    const send = async (s: ExtSession) => {
      if (!s.shown) return;
      const r = runs.get(s);
      const missing = (r?.files ?? []).filter((f) => !titles.has(f));
      if (missing.length) {
        const read = await Promise.all(missing.map((f) => summarizeSession(f)));
        for (const x of read) {
          const title = x.name || x.firstMessage?.split("\n")[0]?.trim();
          if (title) titles.set(x.file, title.slice(0, 200));
        }
        // Something newer was sent while the files were read.
        if (runs.get(s) !== r) return;
      }
      api.emit(s, {
        op: "runs",
        count: r?.count ?? 0,
        runs: (r?.files ?? []).map((f) => ({ file: f, title: titles.get(f), startedAt: r?.startedAt.get(f) })),
      });
    };

    return {
      onStatus(s, key, text) {
        if (key !== STATUS_KEY) return false;
        let next: Runs | undefined;
        try {
          const p = text ? JSON.parse(text) : undefined;
          if (p && p.count > 0) {
            const files: string[] = Array.isArray(p.files) ? p.files.map((f: unknown) => path.resolve(String(f))) : [];
            const prev = runs.get(s)?.startedAt;
            next = { count: Number(p.count), files, startedAt: new Map(files.map((f) => [f, prev?.get(f) ?? Date.now()])) };
          }
        } catch {}
        if (next) runs.set(s, next);
        else runs.delete(s);
        api.busyChanged(s);
        void send(s);
        return true;
      },
      isBusy: (s) => (runs.get(s)?.count ?? 0) > 0,
      filesInUse: () => [...runs.values()].flatMap((r) => r.files),
      onShown(s) {
        shown = s;
        void send(s);
      },
      onExit(s) {
        runs.delete(s);
        void send(s);
      },
      onMessage(m) {
        // The list opened: titles of new runs can appear in their files after the first update.
        if (m?.op === "get" && shown) void send(shown);
      },
    };
  },
};
