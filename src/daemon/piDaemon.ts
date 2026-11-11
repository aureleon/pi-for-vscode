/**
 * The session daemon: a process apart from VS Code that runs the `pi --mode rpc` processes, so that
 * sessions keep working when the VS Code window closes or a Remote-SSH connection drops.
 *
 * A client (PiProcess) connects to the socket and sends `open`. From then on the connection is the
 * RPC stream of one pi process: lines go to pi's stdin and pi's stdout lines come back. When the
 * connection closes, a session that works goes on without a client ("detached"). A later `open`
 * of the same session file gets that process again, with its open dialogs and unfinished output.
 *
 * Keep this file free of dependencies: it runs with plain node.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { daemonDir, lineSplitter, PROTOCOL, socketPath, type AutoAnswer, type DaemonAttached, type DaemonFinished, type DaemonList, type DaemonOp, type DialogPolicy } from "./protocol";

/** A detached session that has no work and no pi output for this long stops. Its session is on disk. */
const QUIET_MS = Number(process.env.PI_VSCODE_DAEMON_QUIET_MS) || 60_000;
/** The daemon exits when it has had nothing to do for this long. */
const IDLE_EXIT_MS = 60_000;
/** How long the daemon keeps the record of a session that finished without a window. */
const FINISHED_TTL_MS = 3 * 86_400_000;

/** Event types that make up in-progress output (the same set as TAIL_EVENTS in controller.ts). */
const TAIL_EVENTS = new Set(["message_start", "message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end"]);
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

interface Dialog {
  rec: any;
  line: string;
  timer?: ReturnType<typeof setTimeout>;
}

interface Session {
  key: string;
  proc: ChildProcessWithoutNullStreams;
  cwd: string;
  policy: DialogPolicy;
  client?: net.Socket;
  busy: boolean;
  runStartedAt?: number;
  /** Raw records since the last completed message: what `get_messages` does not have yet. */
  tail: string[];
  dialogs: Map<string, Dialog>;
  /** Last status, widget and queue record per key. */
  ui: Map<string, string>;
  file?: string;
  id?: string;
  name?: string;
  startedAt: number;
  detachedAt?: number;
  /** The session had work when its client left, so its end is reported. */
  worked?: boolean;
  auto: AutoAnswer[];
  quiet?: ReturnType<typeof setTimeout>;
  /** The daemon stopped the process (the user asked, or the work ended): its exit is not a crash. */
  stopped?: boolean;
  /** The user stopped the session: its end is not reported. */
  silent?: boolean;
  exited?: boolean;
}

const sessions = new Map<string, Session>();
const conns = new Set<net.Socket>();
let finished: DaemonFinished[] = [];
let seq = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

// ------------------------------------------------------------------ log

const logFile = path.join(daemonDir(), "daemon.log");

function log(msg: string) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

// ------------------------------------------------------------------ sessions

/** The session that the arguments of `open` name: `--session <file>` or `--session-id <id>`. */
function targetOf(args: string[], cwd: string): { file?: string; id?: string } {
  const out: { file?: string; id?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = (name: string) => (a === name ? args[i + 1] : a.startsWith(name + "=") ? a.slice(name.length + 1) : undefined);
    const file = value("--session");
    // `--session` also takes an id prefix; only a path names a file.
    if (file && (path.isAbsolute(file) || file.endsWith(".jsonl"))) out.file = path.resolve(cwd, file);
    const id = value("--session-id");
    if (id) out.id = id;
  }
  return out;
}

function send(s: Session, rec: object) {
  s.client?.write(JSON.stringify(rec) + "\n");
}

function toPi(s: Session, rec: object) {
  if (!s.exited && s.proc.stdin.writable) s.proc.stdin.write(JSON.stringify(rec) + "\n");
}

function openSession(op: Extract<DaemonOp, { op: "open" }>, sock: net.Socket): Session | undefined {
  const target = targetOf(op.args, op.cwd);
  const held = [...sessions.values()].find((s) => !s.exited && ((!!target.file && !!s.file && path.resolve(s.file) === target.file) || (!!target.id && s.id === target.id)));
  if (held) {
    if (held.client) {
      // Two processes must not write to one session file.
      sock.end(JSON.stringify({ type: "daemon_exit", code: null, signal: null, error: "This session is open in another VS Code window." }) + "\n");
      return undefined;
    }
    attach(held, sock, op.policy);
    return held;
  }
  const proc = spawn(op.command, ["--mode", "rpc", ...op.args], { cwd: op.cwd, env: op.env as NodeJS.ProcessEnv, shell: process.platform === "win32", windowsHide: true });
  const s: Session = {
    key: `s${++seq}`, proc, cwd: op.cwd, policy: op.policy, client: sock, busy: false,
    tail: [], dialogs: new Map(), ui: new Map(), file: target.file, id: target.id, startedAt: Date.now(), auto: [],
  };
  sessions.set(s.key, s);
  log(`open ${s.key} pid=${proc.pid} cwd=${op.cwd} ${op.args.join(" ")}`);
  proc.stdout.on("data", lineSplitter((line) => fromPi(s, line)));
  proc.stderr.on("data", (chunk: Buffer) => send(s, { type: "daemon_stderr", text: chunk.toString("utf8") }));
  proc.on("error", (err) => onExit(s, null, null, err));
  proc.on("exit", (code, signal) => onExit(s, code, signal));
  return s;
}

/** Give a detached session to a client: what it has to know first, then the records that a snapshot of the session lacks. */
function attach(s: Session, sock: net.Socket, policy: DialogPolicy) {
  clearTimeout(s.quiet);
  log(`attach ${s.key}`);
  const info: DaemonAttached = { type: "daemon_attached", name: s.name, detachedMs: Date.now() - (s.detachedAt ?? Date.now()), runStartedAt: s.runStartedAt, auto: s.auto };
  s.client = sock;
  s.policy = policy;
  s.detachedAt = undefined;
  s.worked = false;
  s.auto = [];
  send(s, info);
  for (const line of [...s.ui.values(), ...s.tail, ...[...s.dialogs.values()].map((d) => d.line)]) sock.write(line + "\n");
}

/** The client of `s` left. `keep`: the client says that the session has work that the daemon cannot see (for example child sessions). */
function detach(s: Session, keep: boolean) {
  if (s.exited) return;
  s.client = undefined;
  s.detachedAt = Date.now();
  s.auto = [];
  if (!s.busy && !s.dialogs.size && !keep) {
    s.silent = true;
    return stop(s);
  }
  log(`detach ${s.key} busy=${s.busy} dialogs=${s.dialogs.size}`);
  s.worked = true;
  for (const [id, d] of s.dialogs) if (autoAnswer(s, d.rec)) dropDialog(s, id);
  detachedTick(s);
}

/** A detached session with no run, no open dialog and a session file stops when pi is quiet for a while. */
function detachedTick(s: Session) {
  clearTimeout(s.quiet);
  if (s.client || s.exited || s.busy || s.dialogs.size || !s.file) return;
  s.quiet = setTimeout(() => {
    log(`done ${s.key}`);
    stop(s);
  }, QUIET_MS);
}

function stop(s: Session) {
  if (s.exited) return;
  s.stopped = true;
  try {
    s.proc.stdin.end();
  } catch {}
  const t = setTimeout(() => s.proc.kill("SIGTERM"), 3000);
  s.proc.once("exit", () => clearTimeout(t));
}

function onExit(s: Session, code: number | null, signal: string | null, err?: Error) {
  if (s.exited) return;
  s.exited = true;
  sessions.delete(s.key);
  clearTimeout(s.quiet);
  for (const d of s.dialogs.values()) clearTimeout(d.timer);
  log(`exit ${s.key} code=${code} signal=${signal} ${err?.message ?? ""}`);
  if (s.client) {
    s.client.end(JSON.stringify({ type: "daemon_exit", code, signal, error: err?.message, errorCode: (err as any)?.code }) + "\n");
    s.client = undefined;
  } else if (s.worked && !s.silent && s.file) {
    finished.push({ file: s.file, name: s.name, cwd: s.cwd, finishedAt: Date.now(), detachedAt: s.detachedAt ?? Date.now(), auto: s.auto, code: s.stopped ? undefined : code });
  }
  idleCheck();
}

// ------------------------------------------------------------------ dialogs

function dropDialog(s: Session, id: string) {
  clearTimeout(s.dialogs.get(id)?.timer);
  s.dialogs.delete(id);
}

/** Answer a dialog of a detached session as the policy says. Returns false when the dialog has to wait for the user. */
function autoAnswer(s: Session, rec: any): boolean {
  let response: object;
  let answer: string;
  if (s.policy === "deny") {
    response = { cancelled: true };
    answer = "cancelled";
  } else if (s.policy === "acceptRecommended") {
    if (rec.method === "confirm") {
      response = { confirmed: true };
      answer = "Yes";
    } else if (rec.method === "select" && Array.isArray(rec.options) && rec.options.length) {
      const options: string[] = rec.options.map((o: any) => String(o));
      answer = options.find((o) => /\(recommended\)/i.test(o)) ?? options[0];
      response = { value: answer };
    } else return false; // no option to accept: free text waits for the user
  } else return false;
  toPi(s, { type: "extension_ui_response", id: rec.id, ...response });
  if (s.auto.length < 100) s.auto.push({ title: String(rec.title ?? rec.message ?? rec.method), answer });
  log(`auto-answer ${s.key} "${rec.title}" -> ${answer}`);
  return true;
}

// ------------------------------------------------------------------ records

function fromPi(s: Session, line: string) {
  s.client?.write(line + "\n");
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  switch (rec.type) {
    case "agent_start":
      s.busy = true;
      s.runStartedAt = Date.now();
      s.tail = [];
      break;
    case "agent_settled":
      s.busy = false;
      s.runStartedAt = undefined;
      s.tail = [];
      s.ui.delete("queue");
      break;
    case "message_end":
      s.tail = [];
      break;
    case "queue_update":
      s.ui.set("queue", line);
      break;
    case "response":
      if (rec.command === "get_state" && rec.success && rec.data) {
        s.file = rec.data.sessionFile;
        s.id = rec.data.sessionId;
        s.name = rec.data.sessionName;
      }
      break;
    case "extension_ui_request":
      if (DIALOG_METHODS.has(rec.method)) {
        if (!s.client && autoAnswer(s, rec)) break;
        const d: Dialog = { rec, line };
        // pi answers a dialog with a timeout by itself.
        if (typeof rec.timeout === "number") d.timer = setTimeout(() => (dropDialog(s, rec.id), detachedTick(s)), rec.timeout + 500);
        s.dialogs.set(rec.id, d);
      } else if (rec.method === "setStatus") {
        if (rec.statusText == null) s.ui.delete(`status:${rec.statusKey}`);
        else s.ui.set(`status:${rec.statusKey}`, line);
      } else if (rec.method === "setWidget") {
        if (rec.widgetLines == null) s.ui.delete(`widget:${rec.widgetKey}`);
        else s.ui.set(`widget:${rec.widgetKey}`, line);
      }
      break;
    default:
      if (TAIL_EVENTS.has(rec.type)) s.tail.push(line);
  }
  if (!s.client) detachedTick(s);
}

function fromClient(s: Session, line: string) {
  if (line.startsWith('{"type":"daemon_')) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    const sock = s.client;
    if (rec.type === "daemon_kill") {
      s.client = undefined;
      s.silent = true;
      stop(s);
    } else if (rec.type === "daemon_detach") detach(s, !!rec.keep);
    sock?.end();
    return;
  }
  if (line.includes('"extension_ui_response"')) {
    try {
      dropDialog(s, JSON.parse(line).id);
    } catch {}
  }
  if (!s.exited && s.proc.stdin.writable) s.proc.stdin.write(line + "\n");
}

// ------------------------------------------------------------------ server

function listing(): DaemonList {
  finished = finished.filter((f) => Date.now() - f.finishedAt < FINISHED_TTL_MS);
  return {
    protocol: PROTOCOL,
    pid: process.pid,
    sessions: [...sessions.values()].map((s) => ({
      key: s.key, pid: s.proc.pid, cwd: s.cwd, file: s.file, id: s.id, name: s.name, busy: s.busy,
      waiting: s.dialogs.size, attached: !!s.client, detachedAt: s.detachedAt, startedAt: s.startedAt,
    })),
    finished,
  };
}

function shutdown() {
  log("exit");
  if (process.platform !== "win32") {
    try {
      fs.unlinkSync(socketPath());
    } catch {}
  }
  process.exit(0);
}

/** Exit when there is no session, no client and no report to give. */
function idleCheck() {
  clearTimeout(idleTimer);
  if (sessions.size || conns.size) return;
  idleTimer = setTimeout(() => {
    if (sessions.size || conns.size) return;
    if (listing().finished.length) return idleCheck();
    shutdown();
  }, IDLE_EXIT_MS);
}

const server = net.createServer((sock) => {
  let s: Session | undefined;
  let first = true;
  conns.add(sock);
  clearTimeout(idleTimer);
  sock.on("error", () => {});
  sock.on("data", lineSplitter((line) => {
    if (!first) {
      if (s && s.client === sock) fromClient(s, line);
      return;
    }
    first = false;
    let op: DaemonOp;
    try {
      op = JSON.parse(line);
    } catch {
      sock.destroy();
      return;
    }
    switch (op.op) {
      case "open":
        s = openSession(op, sock);
        break;
      case "list":
        sock.end(JSON.stringify(listing()) + "\n");
        break;
      case "kill": {
        const k = sessions.get(op.key);
        if (k) {
          k.silent = true;
          stop(k);
        }
        sock.end("{}\n");
        break;
      }
      case "ack": {
        const files = new Set(op.files.map((f) => path.resolve(f)));
        finished = finished.filter((f) => !files.has(path.resolve(f.file)));
        sock.end("{}\n");
        break;
      }
      case "shutdown":
        // Only a daemon without sessions stops on request (a newer extension starts its own).
        sock.end(JSON.stringify({ ok: !sessions.size }) + "\n", () => !sessions.size && shutdown());
        break;
      default:
        sock.destroy();
    }
  }));
  sock.on("close", () => {
    conns.delete(sock);
    // A connection that closes without a word (the extension host died, the SSH connection dropped): the session goes on.
    if (s && s.client === sock) detach(s, false);
    idleCheck();
  });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") {
    log(`server error: ${err.message}`);
    process.exit(1);
  }
  // Another daemon has the socket, or a dead one left the file.
  const probe = net.connect(socketPath());
  probe.on("connect", () => process.exit(0));
  probe.on("error", () => {
    try {
      fs.unlinkSync(socketPath());
    } catch {}
    server.listen(socketPath());
  });
});

server.on("listening", () => {
  if (process.platform !== "win32") fs.chmodSync(socketPath(), 0o600);
  log(`listening pid=${process.pid} protocol=${PROTOCOL}`);
  idleCheck();
});

fs.mkdirSync(daemonDir(), { recursive: true, mode: 0o700 });
try {
  if (fs.statSync(logFile).size > 1_000_000) fs.unlinkSync(logFile);
} catch {}
// The terminal of the process that started the daemon goes away; the daemon stays.
process.on("SIGHUP", () => {});
process.on("uncaughtException", (err) => log(`uncaught: ${err.stack ?? err}`));
server.listen(socketPath());
