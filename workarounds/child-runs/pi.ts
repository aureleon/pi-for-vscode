/**
 * Pi side of the child-runs workaround: a pi extension that the VS Code extension loads with
 * `pi --mode rpc -e dist/workarounds/child-runs.mjs`.
 *
 * Gap: extensions run their own AgentSessions in the pi process (subagents, workflow agents,
 * side threads), but RPC events only describe the main session. The host saw the process as
 * idle while they worked, and stopped it on a session switch. This extension counts prompts in
 * flight on other AgentSessions and reports them, with their session files, in a hidden status.
 * Remove it when pi's RPC mode reports such sessions itself.
 *
 * It wraps `AgentSession.prototype.prompt`, which is not part of pi's extension API, so a pi
 * update can break it. The `pi.workarounds` setting turns it off.
 *
 * Kept dependency-free: only the few API shapes used here are typed locally.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface UiContext {
  setStatus(key: string, text: string | undefined): void;
}

interface EventContext {
  ui: UiContext;
  sessionManager?: unknown;
  mode?: string;
  hasUI?: boolean;
}

interface PiApi {
  on(event: string, handler: (event: any, ctx: EventContext) => unknown): void;
}

/**
 * The RPC host's own session. Extensions can load this extension into child sessions too
 * (subagents); those have no UI (`hasUI` false) and must not take over the shared state.
 */
const isRpcHost = (ctx: EventContext) => ctx.mode === "rpc" || (ctx.mode === undefined && ctx.hasUI === true);

/** Status key the host reads (and does not show): `{ count, files }` of running child sessions. */
const WORK_KEY = "vscode:work";
const RUNS_PATCHED = Symbol.for("pi-vscode.childRuns");

/** Shared on globalThis, so this extension loaded again by /reload keeps counting the same runs. */
interface RunState {
  runs: Map<any, number>;
  main?: unknown;
  ui?: UiContext;
  last?: string;
}
const runState: RunState = ((globalThis as any)[RUNS_PATCHED] ??= { runs: new Map() });

/**
 * Extensions run their own AgentSessions in this process (subagents, side threads). RPC events
 * only describe the main session, so the host saw the process as idle while they worked, and
 * stopped it on a session switch. Count prompts that are in flight on other AgentSessions
 * and report them, with their session files, through a hidden status.
 */
function trackChildRuns(mod: any) {
  const proto = mod?.AgentSession?.prototype;
  if (!proto || typeof proto.prompt !== "function" || proto[RUNS_PATCHED]) return;
  const original = proto.prompt;
  proto.prompt = async function (this: any, ...args: unknown[]) {
    runState.runs.set(this, (runState.runs.get(this) ?? 0) + 1);
    reportChildRuns();
    try {
      return await original.apply(this, args);
    } finally {
      const n = (runState.runs.get(this) ?? 1) - 1;
      if (n > 0) runState.runs.set(this, n);
      else runState.runs.delete(this);
      reportChildRuns();
    }
  };
  proto[RUNS_PATCHED] = true;
}

function reportChildRuns() {
  let count = 0;
  const files: string[] = [];
  for (const session of runState.runs.keys()) {
    if (!runState.main || session.sessionManager === runState.main) continue;
    count++;
    try {
      const file = session.sessionFile;
      if (typeof file === "string" && file) files.push(file);
    } catch {
      /* ignore */
    }
  }
  const text = count ? JSON.stringify({ count, files }) : undefined;
  if (text === runState.last) return;
  runState.last = text;
  try {
    runState.ui?.setStatus(WORK_KEY, text);
  } catch {
    /* the UI context may be stale after a session switch */
  }
}

/**
 * A plain `import("@earendil-works/pi-coding-agent")` does not resolve from this file. pi's own
 * entry (`dist/.../cli.js`) sits next to `index.js`, and importing that file URL gives the same
 * module instance that the running session uses. Undefined when pi runs some other way.
 */
async function loadPiModule(): Promise<any> {
  try {
    const cli = process.argv[1] ? realpathSync(process.argv[1]) : "";
    if (!/cli\.[cm]?js$/.test(cli)) return undefined;
    return await import(new URL("./index.js", pathToFileURL(cli)).href);
  } catch {
    return undefined;
  }
}

export default function childRuns(pi: PiApi) {
  void loadPiModule().then((mod) => trackChildRuns(mod));

  pi.on("session_start", (_e, ctx) => {
    if (!isRpcHost(ctx)) return;
    runState.main = ctx.sessionManager;
    runState.ui = ctx.ui;
    runState.last = undefined;
    reportChildRuns();
  });
}
