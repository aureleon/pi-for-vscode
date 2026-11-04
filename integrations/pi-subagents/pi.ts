/**
 * pi side of the pi-subagents integration: a small pi extension that the VS Code extension loads
 * with `pi --mode rpc -e dist/integrations/pi-subagents.mjs`.
 *
 * pi-subagents names each agent session `<type>#<id>` (for example `general-purpose#1a2b3c4d`).
 * The chat shows that name in the list of running sessions and in the session history, and it
 * says nothing about the task. This extension renames the session to the task description that
 * the agent got, for example `Find auth code`.
 *
 * It uses only the public surfaces of pi-subagents: the `subagents:started` event and the
 * `Symbol.for("pi-subagents:manager")` registry. These cover top-level agents (Agent tool, RPC,
 * scheduler). Workflow children and nested agents send no events, so they keep their names.
 *
 * Kept dependency-free. It does nothing in sessions without pi-subagents.
 */

interface EventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
}

interface PiApi {
  events: EventBus;
}

interface ChildSession {
  readonly sessionName?: string;
  setSessionName(name: string): void;
}

interface Registry {
  getRecord(id: string): { status?: string; session?: ChildSession } | undefined;
}

const MANAGER_KEY = Symbol.for("pi-subagents:manager");
/** Shared on globalThis, so a second copy of this extension (for example after /reload) does not rename twice. */
const PENDING_KEY = Symbol.for("pi-vscode.subagentNames");
const pending: Set<string> = ((globalThis as any)[PENDING_KEY] ??= new Set());

/** pi-subagents creates the session shortly after `subagents:started`. Wait this long at most. */
const POLL_MS = 200;
const MAX_WAIT_MS = 5 * 60_000;

function sessionName(description: string) {
  return description.trim().replace(/\s+/g, " ").slice(0, 120);
}

/**
 * Rename the session of agent `id` once pi-subagents has created it. Only a name that pi-subagents
 * set (`…#<id prefix>`) is replaced, so a name that someone else gave the session stays.
 */
function rename(id: string, description: string) {
  if (pending.has(id)) return;
  pending.add(id);
  const started = Date.now();
  const tick = () => {
    const record = (globalThis as any)[MANAGER_KEY]?.getRecord?.(id) as ReturnType<Registry["getRecord"]>;
    const session = record?.session;
    if (session) {
      pending.delete(id);
      try {
        const name = session.sessionName;
        if (name === undefined || name.endsWith(`#${id.slice(0, 8)}`)) session.setSessionName(sessionName(description));
      } catch {
        /* the session may be gone */
      }
      return;
    }
    const done = record && record.status !== "running" && record.status !== "queued";
    if (!record || done || Date.now() - started > MAX_WAIT_MS) {
      pending.delete(id);
      return;
    }
    setTimeout(tick, POLL_MS);
  };
  tick();
}

export default function subagentNames(pi: PiApi) {
  pi.events?.on?.("subagents:started", (data) => {
    const d = data as { id?: unknown; description?: unknown } | undefined;
    if (typeof d?.id !== "string" || typeof d.description !== "string" || !d.description.trim()) return;
    rename(d.id, d.description);
  });
}
