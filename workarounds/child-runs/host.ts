import * as path from "node:path";
import type { ExtSession, HostIntegration } from "../../src/integrations";

/** Hidden status key that `pi.ts` reports in: `{ count, files }` of running child sessions. */
const STATUS_KEY = "vscode:work";

interface Runs {
  count: number;
  files: string[];
}

/**
 * Host side of the child-runs workaround. A process whose extensions run agent sessions is busy:
 * the controller keeps it in the background on a session switch instead of stopping it, and no
 * other process may open the session files that those sessions write.
 */
export const childRunsHost: HostIntegration = {
  id: "child-runs",
  piExtension: "workarounds/child-runs.mjs",
  create(api) {
    const runs = new Map<ExtSession, Runs>();
    return {
      onStatus(s, key, text) {
        if (key !== STATUS_KEY) return false;
        let next: Runs | undefined;
        try {
          const p = text ? JSON.parse(text) : undefined;
          if (p && p.count > 0) {
            const files: string[] = Array.isArray(p.files) ? p.files.map((f: unknown) => path.resolve(String(f))) : [];
            next = { count: Number(p.count), files };
          }
        } catch {}
        if (next) runs.set(s, next);
        else runs.delete(s);
        api.busyChanged(s);
        return true;
      },
      isBusy: (s) => (runs.get(s)?.count ?? 0) > 0,
      filesInUse: () => [...runs.values()].flatMap((r) => r.files),
      onExit(s) {
        runs.delete(s);
      },
    };
  },
};
