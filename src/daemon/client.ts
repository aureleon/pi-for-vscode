import { spawn } from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import { lineSplitter, PROTOCOL, socketPath, type DaemonList, type DaemonOp, type DialogPolicy } from "./protocol";

/** How a PiProcess reaches the session daemon (src/daemon/piDaemon.ts). */
export interface DaemonOptions {
  /** Path of the daemon's script (dist/pi-daemon.js). */
  script: string;
  policy: DialogPolicy;
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

/** A daemon of another extension version: stop it if it has no sessions, else do not use it. */
async function checkVersion() {
  const list = await daemonList();
  if (!list || list.protocol === PROTOCOL) return;
  const r = await daemonCall<{ ok: boolean }>({ op: "shutdown" });
  if (!r?.ok) throw new Error("a session daemon of another Pi for VS Code version still runs sessions; it is replaced when they end");
  await new Promise((r) => setTimeout(r, 300));
}

/** A connection to the daemon. Starts the daemon if it does not run. */
export async function connectDaemon(script: string): Promise<net.Socket> {
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
