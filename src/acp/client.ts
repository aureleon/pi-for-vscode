import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AcpImage } from "./sessionProtocol";

const rpcTimeout = (ms: number) => ({ cancellationSignal: AbortSignal.timeout(ms), stopWaitingOnCancel: true });

interface ClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  update: (update: acp.SessionUpdate) => void;
  permission: (request: acp.RequestPermissionRequest, signal: AbortSignal) => Promise<acp.RequestPermissionResponse>;
  stderr: (text: string) => void;
  exit: (error: Error) => void;
}

/** One ACP v1 session over stdio. The agent owns its tools and credentials. */
export class AcpClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly connection: acp.ClientConnection;
  private sessionId?: string;
  private pendingUpdates = new Map<string, acp.SessionUpdate[]>();
  private extensionMethods = new Set<string>();
  private closed = false;
  private stderrTail = "";

  constructor(private readonly options: ClientOptions) {
    const proc = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, windowsHide: true });
    this.process = proc;
    proc.stderr.setEncoding("utf8").on("data", (text: string) => {
      this.stderrTail = (this.stderrTail + text).slice(-3000);
      options.stderr(text);
    });
    proc.on("error", (error) => this.fail(error));
    proc.on("close", (code, signal) => this.fail(new Error(`ACP agent exited (${code ?? signal ?? "unknown"}).`)));
    const app = acp.client({ name: "pi-for-vscode" });
    app.onNotification(acp.methods.client.session.update, ({ params: { sessionId, update } }) => {
      if (this.closed) return;
      if (sessionId === this.sessionId) options.update(update);
      else if (!this.sessionId && (this.pendingUpdates.has(sessionId) || this.pendingUpdates.size < 8)) {
        const pending = this.pendingUpdates.get(sessionId) ?? [];
        if (pending.length < 100) pending.push(update);
        this.pendingUpdates.set(sessionId, pending);
      }
    });
    app.onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) => {
      if (this.closed || params.sessionId !== this.sessionId) return { outcome: { outcome: "cancelled" } };
      return options.permission(params, signal);
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    );
    this.connection = app.connect(stream);
    // A broken stdout can close the connection before the child exits.
    void this.connection.closed.then(() => {
      if (proc.exitCode === null && proc.signalCode === null) this.fail(new Error("The ACP connection closed."));
    });
  }

  async start() {
    const rpc = rpcTimeout(30_000);
    const peer = this.connection.agent;
    const init = await peer.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "pi-for-vscode", title: "Pi for VS Code", version: "1" },
      clientCapabilities: {},
    }, rpc);
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`Unsupported ACP version: ${init.protocolVersion}.`);
    const session = await peer.request(acp.methods.agent.session.new, { cwd: this.options.cwd, mcpServers: [] }, rpc);
    this.sessionId = session.sessionId;
    const kiro = init.agentCapabilities?._meta?.kiro as { extensionMethods?: unknown } | undefined;
    if (Array.isArray(kiro?.extensionMethods)) this.extensionMethods = new Set(kiro.extensionMethods.filter((m): m is string => typeof m === "string"));
    const updates = this.pendingUpdates.get(session.sessionId) ?? [];
    this.pendingUpdates.clear();
    return { title: init.agentInfo?.title || init.agentInfo?.name || "New session", capabilities: init.agentCapabilities, session, updates };
  }

  prompt(text: string, images: AcpImage[] = [], timeout?: number): Promise<acp.PromptResponse> {
    if (!this.sessionId) throw new Error("The ACP session is not ready.");
    const prompt: acp.ContentBlock[] = text.trim() ? [{ type: "text", text }] : [];
    prompt.push(...images);
    return this.connection.agent.request(acp.methods.agent.session.prompt, { sessionId: this.sessionId, prompt },
      timeout ? rpcTimeout(timeout) : undefined);
  }

  async setConfig(configId: string, value: string) {
    if (!this.sessionId) throw new Error("The ACP session is not ready.");
    return this.connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId, value }, rpcTimeout(30_000));
  }

  supports(method: string) { return this.extensionMethods.has(method); }

  requestKiro<T>(method: "_kiro/session/context" | "_kiro/session/compact", timeout = 30_000) {
    if (!this.sessionId || !this.supports(method)) throw new Error("The ACP agent does not support this operation.");
    return this.connection.agent.request<T>(method, { sessionId: this.sessionId }, rpcTimeout(timeout));
  }

  async closeSession() {
    if (this.sessionId && !this.closed) await this.connection.agent.request(acp.methods.agent.session.close, { sessionId: this.sessionId }, rpcTimeout(1500));
  }

  async cancel() {
    if (this.sessionId) await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
  }

  private fail(error: Error) {
    if (this.closed) return;
    const stderr = this.stderrTail.trim();
    if (stderr) error.message += `\n${stderr}`;
    this.dispose();
    this.options.exit(error);
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
    const proc = this.process;
    if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
      proc.kill();
      const timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      }, 2000);
      timer.unref();
      proc.once("exit", () => clearTimeout(timer));
    }
  }
}
