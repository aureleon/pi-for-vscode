import { spawn } from "node:child_process";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { LEGACY_PROTOCOL, lineSplitter, PROTOCOL, socketPath, type DaemonList, type DaemonOp, type DialogPolicy } from "./protocol";

export interface DaemonOptions {
  script: string;
  policy: DialogPolicy;
  takeover?: boolean;
}

/** Resolve on the extension host, so Remote-SSH uses the remote binary. */
export function daemonExecutable(extensionPath: string, configured?: string, native = false): string {
  return configured?.trim() || process.env.PIMUXD_PATH || path.join(extensionPath, "dist", native ? "pimuxd" : "pi-daemon.js");
}

function tryConnect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath());
    sock.once("connect", () => {
      sock.removeListener("error", reject);
      sock.on("error", () => {});
      resolve(sock);
    });
    sock.once("error", reject);
  });
}

/** One request to a daemon that is already running. */
export async function daemonCall<T = any>(op: DaemonOp): Promise<T | undefined> {
  let sock: net.Socket;
  try { sock = await tryConnect(); } catch { return undefined; }
  return new Promise<T | undefined>((resolve) => {
    let answer: T | undefined;
    sock.on("data", lineSplitter((line) => {
      try { answer ??= JSON.parse(line); } catch {}
    }));
    sock.setTimeout(5000, () => sock.destroy());
    sock.on("close", () => resolve(answer));
    sock.write(JSON.stringify(op) + "\n");
  });
}

export function daemonList(reconnectCwds?: string[]): Promise<DaemonList | undefined> {
  return daemonCall<DaemonList>({ op: "list", reconnectCwds });
}

export function isCompatible(list: DaemonList): boolean {
  return Number.isInteger(list.protocol) && list.protocol >= LEGACY_PROTOCOL && list.protocol <= PROTOCOL;
}

let starting: Promise<void> | undefined;

async function startDaemon(executable: string) {
  let error: Error | undefined;
  const legacy = path.basename(executable) === "pi-daemon.js";
  const child = spawn(legacy ? process.execPath : executable, legacy ? [executable] : ["serve"], {
    detached: true, stdio: "ignore", cwd: os.homedir(), windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.on("error", (e) => { error = e; });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await daemonList()) return;
    if (error) throw new Error(`Could not start pimuxd: ${error.message}. Install pimuxd or set pi.daemonPath.`);
    if (child.exitCode !== null) break;
  }
  throw new Error("pimuxd did not start. Run pimuxd serve to see the error.");
}

/** Check compatibility on every attach. Do not stop or replace a running daemon. */
export async function connectDaemon(executable: string): Promise<net.Socket> {
  let sock: net.Socket;
  try { sock = await tryConnect(); }
  catch {
    starting ??= startDaemon(executable).finally(() => (starting = undefined));
    await starting;
    sock = await tryConnect();
  }
  try {
    const list = await daemonList();
    if (!list || sock.destroyed || !isCompatible(list)) {
      const message = list && !isCompatible(list)
        ? `The running daemon speaks protocol ${list.protocol}, but this client supports protocols ${LEGACY_PROTOCOL}–${PROTOCOL}. Stop it explicitly after its sessions finish.`
        : "Could not verify the running session daemon.";
      throw Object.assign(new Error(message), { code: "PI_DAEMON_IN_USE" });
    }
    return sock;
  } catch (e) {
    sock.destroy();
    throw e;
  }
}
