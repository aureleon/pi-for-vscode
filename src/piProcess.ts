import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type * as net from "node:net";
import { lineSplitter } from "./daemon/protocol";
import { connectDaemon, type DaemonOptions } from "./daemon/client";

export type RpcRecord = { type: string; [k: string]: any };

interface Pending {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
}

/**
 * Minimal JSONL client for `pi --mode rpc`.
 * Emits: "event" (RpcRecord), "stderr" (string), "exit" (code, signal), and "attached" (DaemonAttached)
 * when the daemon gave it a session that ran without a window.
 *
 * With `daemon`, the session daemon runs the pi process and this is one connection to it. The
 * process then outlives the extension host (see src/daemon/piDaemon.ts).
 */
export class PiProcess extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private seq = 0;
  /** The connection to the daemon, in daemon mode. */
  private sock?: net.Socket;
  /** Daemon mode: the session is open (or opening) in the daemon. */
  private alive = false;
  /** Daemon mode: records written before the connection is up. */
  private outbox?: string[];
  stderrTail = "";

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private daemon?: DaemonOptions,
  ) {
    super();
  }

  get running(): boolean {
    if (this.daemon) return this.alive;
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  start(): void {
    if (this.daemon) this.startInDaemon(this.daemon);
    else this.startLocal();
  }

  /** Open the session in the daemon. If the daemon is not usable, pi starts as a child process as without it. */
  private startInDaemon(daemon: DaemonOptions) {
    this.alive = true;
    this.outbox = [];
    connectDaemon(daemon.script).then(
      (sock) => {
        // Stopped while the connection came up: nothing is open in the daemon yet.
        if (!this.alive) return sock.destroy();
        this.sock = sock;
        sock.write(JSON.stringify({ op: "open", command: this.command, args: this.args, cwd: this.cwd, env: this.env, policy: daemon.policy, takeover: daemon.takeover }) + "\n");
        for (const line of this.outbox ?? []) sock.write(line);
        this.outbox = undefined;
        sock.on("data", lineSplitter((line) => this.handleLine(line)));
        sock.on("error", () => {});
        sock.on("close", () => this.onDaemonExit(null, null, Object.assign(new Error("lost the connection to the pi session daemon"), { code: "PI_DAEMON_LOST" })));
      },
      (err) => {
        if (!this.alive) return;
        this.emit("stderr", `[pi] ${err.message ?? err}; pi starts without the daemon\n`);
        this.alive = false;
        this.daemon = undefined;
        this.startLocal();
        for (const line of this.outbox ?? []) this.proc?.stdin.write(line);
        this.outbox = undefined;
      },
    );
  }

  private onDaemonExit(code: number | null, signal: string | null, err?: Error) {
    if (!this.alive) return;
    this.alive = false;
    if (err) this.stderrTail += `\n${err.message}`;
    this.failPending(err ?? new Error(`pi exited (code ${code ?? signal})`));
    this.emit("exit", code, signal, err);
  }

  private startLocal(): void {
    const proc = spawn(this.command, ["--mode", "rpc", ...this.args], {
      cwd: this.cwd,
      env: this.env,
      shell: process.platform === "win32",
    });
    this.proc = proc;
    proc.stdout.on("data", lineSplitter((line) => this.handleLine(line)));
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-8000);
      this.emit("stderr", text);
    });
    proc.on("error", (err) => {
      this.stderrTail += `\n${err.message}`;
      this.failPending(err);
      this.emit("exit", null, null, err);
    });
    proc.on("exit", (code, signal) => {
      this.failPending(new Error(`pi exited (code ${code ?? signal})`));
      this.emit("exit", code, signal);
    });
  }

  private handleLine(line: string) {
    let rec: RpcRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      this.emit("stderr", `[non-JSON stdout] ${line}\n`);
      return;
    }
    if (rec.type === "response" && typeof rec.id === "string" && this.pending.has(rec.id)) {
      const p = this.pending.get(rec.id)!;
      this.pending.delete(rec.id);
      if (rec.success) p.resolve(rec.data);
      else p.reject(new Error(rec.error || `${rec.command} failed`));
      return;
    }
    if (this.daemon && typeof rec.type === "string" && rec.type.startsWith("daemon_")) return this.handleDaemonRecord(rec);
    this.emit("event", rec);
  }

  /** Records from the daemon itself, not from pi. */
  private handleDaemonRecord(rec: RpcRecord) {
    switch (rec.type) {
      case "daemon_stderr":
        this.stderrTail = (this.stderrTail + rec.text).slice(-8000);
        this.emit("stderr", rec.text);
        break;
      case "daemon_attached":
        this.emit("attached", rec);
        break;
      case "daemon_exit": {
        const err = rec.error ? Object.assign(new Error(rec.error), { code: rec.errorCode }) : undefined;
        this.onDaemonExit(rec.code ?? null, rec.signal ?? null, err);
        break;
      }
    }
  }

  private failPending(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Send a command and await its response data. */
  request<T = any>(cmd: RpcRecord, id = `vsc-${++this.seq}`): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.running) return reject(new Error("pi is not running"));
      this.pending.set(id, { resolve, reject });
      this.write({ ...cmd, id });
    });
  }

  nextId(): string {
    return `vsc-${++this.seq}`;
  }

  /** Fire-and-forget write (used for extension_ui_response). */
  write(obj: RpcRecord): void {
    if (!this.running) return;
    const line = JSON.stringify(obj) + "\n";
    if (this.proc) this.proc.stdin.write(line);
    else if (this.sock) this.sock.write(line);
    else this.outbox?.push(line);
  }

  /** Daemon mode: say a last word to the daemon and close the connection. */
  private leaveDaemon(word: RpcRecord) {
    this.alive = false;
    this.removeAllListeners();
    this.outbox = undefined;
    this.sock?.end(JSON.stringify(word) + "\n");
    this.sock = undefined;
  }

  /**
   * Let go of the process without stopping it: in the daemon it keeps working, and a later start
   * of its session file gets it again. `keep`: it has work that the daemon cannot see (child sessions).
   * Without the daemon the process stops.
   */
  detach(keep: boolean): void {
    if (!this.daemon) return this.stop();
    if (this.alive) this.leaveDaemon({ type: "daemon_detach", keep });
  }

  stop(): void {
    if (this.daemon) {
      if (this.alive) this.leaveDaemon({ type: "daemon_kill" });
      return;
    }
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    this.removeAllListeners();
    try {
      proc.stdin.end();
    } catch {}
    const t = setTimeout(() => proc.kill("SIGTERM"), 3000);
    proc.once("exit", () => clearTimeout(t));
  }
}
