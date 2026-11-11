import * as os from "node:os";
import * as path from "node:path";

/** Version of the records between the extension and the daemon. A daemon with another version is not used. */
export const PROTOCOL = 1;

declare const __PI_BUILD__: number | undefined;
/**
 * When this code was built (set by esbuild.mjs; 0 without it). The daemon outlives the extension that
 * started it, so after an update an old daemon still runs. The extension of a newer build ends it.
 */
export const BUILD: number = typeof __PI_BUILD__ === "number" ? __PI_BUILD__ : 0;

/** What the daemon does with a dialog (select, confirm, input, editor) of a session that no VS Code window shows. */
export type DialogPolicy = "wait" | "deny" | "acceptRecommended";

export function daemonDir(): string {
  return path.join(os.homedir(), ".pi", "vscode-daemon");
}

/** One daemon for each user: a unix socket in the user's pi directory, or a named pipe on Windows. */
export function socketPath(): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\pi-vscode-daemon-${os.userInfo().username}`;
  return path.join(daemonDir(), "daemon.sock");
}

/** First record of a connection. `open` turns the connection into the RPC stream of one pi process. */
export type DaemonOp =
  | {
    op: "open"; command: string; args: string[]; cwd: string; env: Record<string, string | undefined>; policy: DialogPolicy;
    /** Take the session from the client that has it (the user opened it here). Without it, such an open is refused. */
    takeover?: boolean;
  }
  | { op: "list" }
  | { op: "kill"; key: string }
  | { op: "ack"; files: string[] }
  | { op: "shutdown" }
  /** Stop all sessions and exit, so that a daemon of a newer build can start. */
  | { op: "retire" };

/** A dialog that the daemon answered for the user. */
export interface AutoAnswer {
  title: string;
  answer: string;
}

/** A pi process that the daemon runs. */
export interface DaemonSession {
  key: string;
  pid?: number;
  cwd: string;
  file?: string;
  id?: string;
  name?: string;
  /** The agent runs. */
  busy: boolean;
  /** Dialogs that wait for an answer. */
  waiting: number;
  /** A VS Code window has the session. */
  attached: boolean;
  detachedAt?: number;
  startedAt: number;
}

/** A session that ended its work while no VS Code window had it. Its process stopped; the session is on disk. */
export interface DaemonFinished {
  file: string;
  name?: string;
  cwd: string;
  finishedAt: number;
  detachedAt: number;
  auto: AutoAnswer[];
  /** Set when pi exited by itself (a crash), not when the daemon stopped it after its work. */
  code?: number | null;
}

export interface DaemonList {
  protocol: number;
  /** `BUILD` of the daemon. The first daemons did not send it. */
  build?: number;
  pid: number;
  sessions: DaemonSession[];
  finished: DaemonFinished[];
}

/** Sent to a client that opened a session which ran without a window. The open dialogs and the unfinished output follow as normal records. */
export interface DaemonAttached {
  type: "daemon_attached";
  name?: string;
  detachedMs: number;
  runStartedAt?: number;
  auto: AutoAnswer[];
}

/**
 * A stream handler that calls `onLine` for each JSONL record. It splits only on LF (never on
 * U+2028/U+2029 like readline). TextDecoder, not node:string_decoder: other extensions in the shared
 * extension host can break that module. `stream: true` keeps split UTF-8 sequences intact.
 */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  return (chunk) => {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim()) onLine(line);
    }
  };
}
