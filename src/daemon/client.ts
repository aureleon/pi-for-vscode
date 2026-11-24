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

/** Only a newer extension build may replace the daemon. A protocol mismatch alone can also mean a downgrade. */
export function isStale(list: DaemonList): boolean {
  return (list.build ?? 0) < BUILD;
}

/** ACP history lives in the daemon even when its agent is idle. */
export function retainedIn(list: DaemonList): number {
  return list.sessions.filter((s) => s.busy || s.waiting || s.backend === "acp").length;
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
 * with work or ACP sessions stays unless `force` is set. Idle Pi sessions are on disk and
 * their chats can restart them after the daemon exits.
 */
export function replaceStale(force = false): Promise<DaemonList | undefined> {
  replacing ??= (async () => {
    const list = await daemonList();
    if (!list || !isStale(list)) return undefined;
    if (!force && retainedIn(list)) return list;
    await endDaemon(list);
    return undefined;
  })().finally(() => (replacing = undefined));
  return replacing;
}

/** Check the protocol even when this extension cannot replace the daemon. */
function checkProtocol(list: DaemonList) {
  if (list.protocol === PROTOCOL) return;
  if (isStale(list)) {
    throw new Error("An older Pi session daemon still holds sessions. Use Stop and Replace Now, or wait for those sessions to end.");
  }
  throw new Error("The Pi session daemon uses a newer protocol. Update Pi for VS Code and reload this window, or turn off Keep Sessions Alive.");
}

/** A connection to the daemon. Starts the daemon if it does not run. */
export async function connectDaemon(script: string): Promise<net.Socket> {
  await replaceStale();
  let sock: net.Socket;
  try {
    sock = await tryConnect();
  } catch {
    starting ??= startDaemon(script).finally(() => (starting = undefined));
    await starting;
    sock = await tryConnect();
  }
  // Another window can replace the daemon between opens or win the race to start it.
  // Hold the connection while checking so we do not reconnect after the version check.
  sock.on("error", () => {});
  try {
    const list = await daemonList();
    if (!list || sock.destroyed) throw new Error("Could not verify the Pi session daemon while opening the session. Try again.");
    checkProtocol(list);
    return sock;
  } catch (err) {
    sock.destroy();
    throw err;
  }
}
