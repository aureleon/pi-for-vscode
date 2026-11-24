import * as os from "node:os";
import * as path from "node:path";
import type { AcpBackend } from "../acp/config";

/** Version of the records between the extension and the daemon. A daemon with another version is not used. */
export const PROTOCOL = 6;
export const PREVIOUS_PROTOCOL = 4;
export const LEGACY_PROTOCOL = 3;

declare const __PI_BUILD__: number | undefined;
/**
 * Build timestamp used by the legacy daemon. pimuxd checks the wire protocol, not this timestamp.
 */
export const BUILD: number = typeof __PI_BUILD__ === "number" ? __PI_BUILD__ : 0;

/** What the daemon does with a dialog (select, confirm, input, editor) of a session that no VS Code window shows. */
export type DialogPolicy = "wait" | "deny" | "acceptRecommended";

export function daemonDir(): string {
  return process.env.PIMUXD_DIR || path.join(os.homedir(), ".pi", "vscode-daemon");
}

/** One daemon for each user: a unix socket in the user's pi directory, or a named pipe on Windows. */
export function socketPath(): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\pi-vscode-daemon-${os.userInfo().username}`;
  return path.join(daemonDir(), "daemon.sock");
}

/** First record of a connection. An open or attach op gives the connection to one session. */
export type DaemonOp =
  | {
    op: "open"; command: string; args: string[]; cwd: string; env: Record<string, string | undefined>; policy: DialogPolicy;
    /** Take the session from the client that has it (the user opened it here). Without it, such an open is refused. */
    takeover?: boolean; canReveal?: boolean;
  }
  | { op: "pi_attach"; key: string; policy: DialogPolicy; canReveal?: boolean }
  | { op: "acp_open"; key: string; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; acpBackend?: AcpBackend; canReveal?: boolean }
  | { op: "acp_attach"; key: string; canReveal?: boolean }
  | { op: "list"; reconnectCwds?: string[] }
  | { op: "reveal"; key: string; reconnect?: boolean }
  | { op: "kill" | "stop"; key: string }
  | { op: "ack"; files: string[] }
  | { op: "shutdown" }
  /** Stop all sessions and exit, so that a daemon of a newer build can start. */
  | { op: "retire" };

/** A dialog that the daemon answered for the user. */
export interface AutoAnswer {
  title: string;
  answer: string;
}

/** A session that the daemon runs. */
export interface DaemonSession {
  key: string;
  /** Pi sessions omit this field. */
  backend?: "pi" | "acp";
  acpBackend?: AcpBackend;
  observers?: number;
  canRestoreContext?: boolean;
  pid?: number;
  cwd: string;
  file?: string;
  id?: string;
  name?: string;
  /** The agent runs. */
  busy: boolean;
  /** Dialogs or permissions that wait for an answer. */
  waiting: number;
  /** The ACP agent failed, but its transcript is still in the daemon. */
  failed?: boolean;
  /** A VS Code window has the session. */
  attached: boolean;
  /** The current owner can reveal this tab without giving up the session. */
  canReveal?: boolean;
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
  canNavigate?: boolean;
  /** Detached sessions requested for this window. The daemon returns each request once. */
  reconnect?: DaemonSession[];
}

export interface DaemonRevealResult {
  status: "revealed" | "queued" | "unavailable";
}

/** Sent to a client that opened a session which ran without a window. The open dialogs and the unfinished output follow as normal records. */
export interface DaemonAttached {
  type: "daemon_attached";
  name?: string;
  detachedMs: number;
  runStartedAt?: number;
  auto: AutoAnswer[];
}

/** The transcript snapshot and pending permissions follow this record. */
export interface DaemonAcpAttached {
  type: "acp_attached";
  key: string;
  acpBackend?: AcpBackend;
}

export interface DaemonAcpAttachError {
  type: "acp_attachError";
  message: string;
}

/** Stop the ACP session. Closing the connection alone only detaches it. */
export interface DaemonAcpClose {
  type: "acp_close";
}

/**
 * A stream handler that calls `onLine` for each JSONL record. It splits only on LF (never on
 * U+2028/U+2029 like readline). TextDecoder, not node:string_decoder: other extensions in the shared
 * extension host can break that module. `stream: true` keeps split UTF-8 sequences intact.
 *
 * A record can be many MB (`get_messages` of a session with screenshots) and comes in chunks of
 * about 64 KB. Each chunk is searched once, and the parts of an open line wait in a list: a search
 * of the whole buffer at each chunk makes a long record take a time that grows with its square.
 */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new TextDecoder("utf-8");
  /** The parts of the line that has no LF yet. */
  let parts: string[] = [];
  const emit = (line: string) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim()) onLine(line);
  };
  return (chunk) => {
    const text = decoder.decode(chunk, { stream: true });
    let start = 0;
    let nl: number;
    while ((nl = text.indexOf("\n", start)) >= 0) {
      const end = text.slice(start, nl);
      if (parts.length) {
        parts.push(end);
        const line = parts.join("");
        parts = [];
        emit(line);
      } else emit(end);
      start = nl + 1;
    }
    if (start < text.length) parts.push(text.slice(start));
  };
}
