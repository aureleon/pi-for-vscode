import { spawn } from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import { BUILD, lineSplitter, PROTOCOL, socketPath, type DaemonList, type DaemonOp, type DialogPolicy } from "./protocol";

/** How a PiProcess reaches the session daemon (src/daemon/piDaemon.ts). */
export interface DaemonOptions {
  /** Path of the daemon's script (dist/pi-daemon.js). */
  script: string;
  policy: DialogPolicy;
  /** Take the session from another client that has it (see `open` in protocol.ts). */
  takeover?: boolean;
}

function tryConnect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath());
    sock.once("connect", () => {
      sock.removeAllListeners("error");
      resolve(sock);
    });
    sock.once("error", reject);
  });
}

/** One request to the daemon, if it runs: the first record is `op`, the answer is one record. */
export async function daemonCall<T = any>(op: DaemonOp): Promise<T | undefined> {
  let sock: net.Socket;
  try {
    sock = await tryConnect();
  } catch {
    return undefined;
  }
  return new Promise<T | undefined>((resolve) => {
    let answer: T | undefined;
    sock.on("data", lineSplitter((line) => {
      try {
        answer ??= JSON.parse(line);
      } catch {}
    }));
    sock.on("error", () => {});
    sock.on("close", () => resolve(answer));
    sock.write(JSON.stringify(op) + "\n");
  });
}

export function daemonList(): Promise<DaemonList | undefined> {
  return daemonCall<DaemonList>({ op: "list" });
}

let starting: Promise<void> | undefined;
let usable: Promise<void> | undefined;

/**
 * Start the daemon as a process of its own: `detached` puts it in a new session, so it stays when
 * the extension host stops. The extension host's node runs it (Electron's, as node, on a local machine).
 */
async function startDaemon(script: string) {
  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: "ignore",
    cwd: os.homedir(),
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.on("error", () => {});
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      (await tryConnect()).destroy();
      return;
    } catch {}
  }
  throw new Error("the pi session daemon did not start");
}

/** The daemon is of an older build than this extension (or speaks another protocol). */
export function isStale(list: DaemonList): boolean {
  return list.protocol !== PROTOCOL || (list.build ?? 0) < BUILD;
}

/** Sessions of the daemon with a run or an open question: they would lose their work if the daemon stopped. */
export function workingIn(list: DaemonList): number {
  return list.sessions.filter((s) => s.busy || s.waiting).length;
}

const connectable = () => tryConnect().then((s) => (s.destroy(), true), () => false);

/** Stop the daemon and all its sessions, and wait until it is gone. */
async function endDaemon(list: DaemonList) {
  const kill = () => {
    try {
      process.kill(list.pid, "SIGTERM");
    } catch {}
  };
  // The first daemons know no `retire` (they sent no build).
  if (list.build === undefined) kill();
  else await daemonCall({ op: "retire" });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!(await connectable())) return;
    if (i === 30) kill();
  }
}

let replacing: Promise<DaemonList | undefined> | undefined;

/**
 * End a daemon of an older build, so that the next start gets a daemon of this build. A stale daemon
 * with working sessions stays (its list is returned) unless `force` is set: ending it stops them.
 * Idle sessions are on disk; their chats start them again (see PI_DAEMON_LOST in controller.ts).
 */
export function replaceStale(force = false): Promise<DaemonList | undefined> {
  replacing ??= (async () => {
    const list = await daemonList();
    if (!list || !isStale(list)) return undefined;
    if (!force && workingIn(list)) return list;
    await endDaemon(list);
    return undefined;
  })().finally(() => (replacing = undefined));
  return replacing;
}

/** Replace a stale daemon if no session works in it. One that stays is used if it speaks this protocol. */
async function checkVersion() {
  const stale = await replaceStale();
  if (stale && stale.protocol !== PROTOCOL) throw new Error("a session daemon of another Pi for VS Code version still runs sessions; it is replaced when they end");
}

/** A connection to the daemon. Starts the daemon if it does not run. */
export async function connectDaemon(script: string): Promise<net.Socket> {
  // Checked once: after that the status bar item looks for a stale daemon (src/daemon/ui.ts).
  usable ??= checkVersion();
  try {
    await usable;
  } catch (err) {
    // Look again at the next start: the old daemon may be gone then.
    usable = undefined;
    throw err;
  }
  try {
    return await tryConnect();
  } catch {}
  starting ??= startDaemon(script).finally(() => (starting = undefined));
  await starting;
  return tryConnect();
}
