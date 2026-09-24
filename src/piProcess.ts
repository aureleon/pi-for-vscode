import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export type RpcRecord = { type: string; [k: string]: any };

interface Pending {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
}

/**
 * Minimal JSONL client for `pi --mode rpc`.
 * Emits: "event" (RpcRecord), "stderr" (string), "exit" (code, signal).
 */
export class PiProcess extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private buffer = "";
  stderrTail = "";

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    super();
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  start(): void {
    const proc = spawn(this.command, ["--mode", "rpc", ...this.args], {
      cwd: this.cwd,
      env: this.env,
      shell: process.platform === "win32",
    });
    this.proc = proc;
    const decoder = new StringDecoder("utf8");

    proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += decoder.write(chunk);
      let nl: number;
      // Split strictly on LF (never on U+2028/U+2029 like readline would).
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        let line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.trim()) this.handleLine(line);
      }
    });
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
    this.emit("event", rec);
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
    this.proc!.stdin.write(JSON.stringify(obj) + "\n");
  }

  stop(): void {
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
