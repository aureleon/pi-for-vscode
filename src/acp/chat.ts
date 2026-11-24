import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import * as vscode from "vscode";
import { connectDaemon } from "../daemon/client";
import { lineSplitter, type DaemonOp } from "../daemon/protocol";
import { openPath } from "../openPath";
import { getShellEnv } from "../shellEnv";
import { acpFingerprint, acpProfiles, pickAcpProfile, type AcpBackend, type AcpProfile } from "./config";
import type { DaemonAcpAttached } from "../daemon/protocol";
import { AcpSession } from "./session";
import { MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL, type AcpComposer, type AcpInput, type AcpOutput, type PermissionRequest } from "./sessionProtocol";

const imageMime: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

// VS Code has one quick pick. Do not dismiss another session's permission prompt.
let permissionQueue = Promise.resolve();

/** VS Code attachment to an ACP session. The process and transcript belong to the session owner. */
export class AcpChat implements vscode.Disposable {
  private readonly listeners: vscode.Disposable[];
  private readonly permissions = new Map<string, { request: PermissionRequest; token?: vscode.CancellationTokenSource }>();
  private local?: AcpSession;
  private socket?: Socket;
  private attached = false;
  private disposed = false;
  private connecting = false;
  private connectionError?: string;
  private recovery?: { canRestoreContext?: boolean };
  private title = "New session";
  private composer?: AcpComposer;
  private daemonKey?: string;
  private readonly newKey = randomUUID();
  hasWork = false;
  private used = false;
  private operation = false;

  get isEmptySession(): boolean { return !this.used && !this.hasWork && !this.operation; }

  constructor(
    private readonly webview: Pick<vscode.Webview, "postMessage" | "onDidReceiveMessage">,
    private readonly cwd: string,
    private readonly output: vscode.OutputChannel,
    private readonly setTitle: (title: string, busy: boolean, key?: string) => void,
    private readonly daemon?: { script: string; key?: string },
    private profile?: AcpProfile,
    private backend?: AcpBackend,
    private readonly newChat?: (backend: "pi" | "acp", name?: string) => void,
  ) {
    this.listeners = [
      webview.onDidReceiveMessage((m) => {
        void this.onMessage(m).catch((e) => this.post({ type: "error", message: String(e?.message ?? e) }));
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("pi.acp")) {
          this.sendAccent();
          this.sendProfiles();
        }
      }),
    ];
  }

  private post(message: object) {
    if (!this.disposed) void this.webview.postMessage(message);
  }

  private send(message: AcpInput) {
    if (this.local) this.local.receive(message);
    else if (this.attached && this.socket?.writable) this.socket.write(JSON.stringify(message) + "\n");
  }

  private async onMessage(m: any) {
    switch (m?.type) {
      case "ready":
        this.sendProfile();
        this.sendProfiles();
        if (this.local || this.attached) this.send({ type: "ready" });
        else if (this.connectionError) this.post({ type: "acpStatus", ready: false, error: this.connectionError });
        else await this.start();
        break;
      case "pickBackend":
        if (m.backend === "pi" || m.backend === "acp") {
          this.newChat?.(m.backend, typeof m.profile === "string" ? m.profile : undefined);
        }
        break;
      case "configureAcpProfiles":
        if (this.newChat) await vscode.commands.executeCommand("workbench.action.openSettings", "@id:pi.acp.profiles");
        break;
      case "restart":
        if (this.connectionError) await this.start();
        else if (this.recovery && this.daemon) {
          const fresh = "Start Without Earlier Context";
          const restore = "Restore Agent Context";
          if (!vscode.workspace.isTrusted) break;
          const candidates = this.profile ? [this.profile, ...acpProfiles()] : acpProfiles();
          const saved = candidates.find((p) => this.backend?.name === p.name && this.backend.fingerprint === acpFingerprint(p));
          const canRestore = !!saved && this.recovery.canRestoreContext;
          const choice = await vscode.window.showQuickPick(canRestore ? [fresh, restore] : [fresh], {
            placeHolder: "Reopen the saved chat. No prompt will be resent.",
          });
          if (!choice) break;
          const profile = saved ?? await pickAcpProfile(true);
          if (!profile) break;
          const launch = await this.agentConfig(profile);
          if (this.attached) this.socket?.write(JSON.stringify({
            type: "acp_relaunch", ...launch, restoreContext: choice === restore,
          }) + "\n");
        } else if (this.local?.failed) {
          const { command, args, env } = await this.agentConfig();
          if (!this.disposed) await this.local.start(command, args, env);
        } else this.send({ type: "restart" });
        break;
      case "rename":
        if (typeof m.name === "string" && m.name.trim()) {
          this.used = true;
          this.send({ type: "rename", name: m.name });
        }
        break;
      case "prompt":
        if (typeof m.text === "string") await this.prompt(m.text, m.images);
        break;
      case "pickAttachments":
        await this.pickImages();
        break;
      case "acpSetConfig":
        if (typeof m.id === "string" && typeof m.value === "string") this.send({ type: "acpSetConfig", id: m.id, value: m.value });
        break;
      case "acpCompact":
        this.send({ type: "acpCompact" });
        break;
      case "acpTitleRequest":
        this.generateTitle();
        break;
      case "abort":
        this.abort();
        break;
      case "openFile":
        if (typeof m.path === "string") await openPath(m.path, Number.isInteger(m.line) ? m.line : undefined, this.cwd);
        break;
      case "openExternal":
        if (typeof m.url === "string" && /^(https?|mailto):/i.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      case "copy":
        await vscode.env.clipboard.writeText(String(m.text ?? ""));
        if (!m.quiet) vscode.window.setStatusBarMessage("Pi: copied to clipboard", 1500);
        break;
    }
  }

  abort() { this.send({ type: "abort" }); }

  generateTitle() { this.send({ type: "acpTitleRequest" }); }

  openModelPicker(focusEffort = false) { this.post({ type: "openModelPicker", focusEffort }); }

  private async prompt(text: string, images?: Extract<AcpInput, { type: "prompt" }>["images"]) {
    if (!images?.length) {
      const command = text.trim();
      if (command === "/model" || command === "/effort") {
        this.resetComposer();
        this.openModelPicker(command === "/effort");
        return;
      }
      if (command === "/context") {
        this.resetComposer();
        const usage = this.composer?.usage;
        void vscode.window.showInformationMessage(usage === undefined ? "The ACP agent has not reported context usage." : `ACP context usage: ${Math.round(usage)}%.`);
        return;
      }
    }
    if (images?.length || (text.trim() && !/^\/(?:compact|title)$/.test(text.trim()))) this.used = true;
    this.send({ type: "prompt", text, images });
  }

  private resetComposer() {
    this.post({ type: "acpOperation", message: "" });
  }

  private async pickImages() {
    if (!this.composer?.images) return;
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Attach Images", filters: { Images: Object.keys(imageMime) } });
    let total = 0;
    for (const uri of uris?.slice(0, 16) ?? []) {
      if (this.disposed || !this.composer?.images) return;
      const mimeType = imageMime[uri.path.split(".").at(-1)?.toLowerCase() ?? ""];
      const stat = await vscode.workspace.fs.stat(uri);
      if (!mimeType || stat.size > MAX_IMAGE_BYTES || total + stat.size > MAX_IMAGE_TOTAL) {
        void vscode.window.showWarningMessage("ACP supports PNG, JPEG, GIF, and WebP images up to 8 MiB each and 16 MiB per prompt.");
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.length > MAX_IMAGE_BYTES || total + bytes.length > MAX_IMAGE_TOTAL) continue;
      total += bytes.length;
      this.post({ type: "addImage", image: { type: "image", mimeType, data: Buffer.from(bytes).toString("base64") }, name: uri.path.split("/").at(-1) });
    }
  }

  async promptRename() {
    const name = await vscode.window.showInputBox({ title: "Rename Session", value: this.title, valueSelection: [0, this.title.length] });
    if (name?.trim()) {
      this.used = true;
      this.send({ type: "rename", name });
    }
  }

  private sendAccent() {
    const name = this.backend?.name ?? this.profile?.name;
    const profile = name ? acpProfiles().find((p) => p.name === name) : undefined;
    const color = profile?.accentColor ?? vscode.workspace.getConfiguration("pi").get<string>("acp.accentColor", "");
    this.post({ type: "acpAccent", color });
  }

  private sendProfiles() {
    if (this.newChat) this.post({ type: "acpProfiles", names: acpProfiles().map((p) => p.name) });
  }

  private sendProfile() {
    this.post({ type: "acpProfile", name: this.backend?.name ?? this.profile?.name ?? "ACP" });
    this.sendAccent();
  }

  private async agentConfig(profile = this.profile) {
    if (!profile) throw new Error("Choose an ACP profile before starting the agent.");
    const cfg = vscode.workspace.getConfiguration("pi");
    const env = await getShellEnv(cfg.get<boolean>("useLoginShellEnv", true));
    return { command: profile.command, args: profile.args, env, acpBackend: { name: profile.name } };
  }

  private async start() {
    if (this.connecting || this.local || this.socket || this.disposed) return;
    this.connecting = true;
    this.connectionError = undefined;
    this.post({ type: "starting" });
    this.post({ type: "acpStatus", ready: false });
    try {
      if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before starting an ACP agent.");
      const existingKey = this.daemonKey ?? this.daemon?.key;
      if (existingKey && this.daemon) {
        await this.connect(this.daemon.script, { op: "acp_attach", key: existingKey });
        return;
      }
      const launch = await this.agentConfig();
      if (this.disposed) return;
      if (this.daemon) {
        await this.connect(this.daemon.script, { op: "acp_open", key: this.newKey, ...launch, cwd: this.cwd });
      } else {
        this.local = new AcpSession({ cwd: this.cwd, post: (msg) => this.receive(msg), log: (text) => this.output.appendLine(text) });
        await this.local.start(launch.command, launch.args, launch.env);
      }
    } catch (e) {
      this.fail(String((e as Error)?.message ?? e));
    } finally {
      this.connecting = false;
    }
  }

  private async connect(script: string, op: DaemonOp) {
    const sock = await connectDaemon(script);
    if (this.disposed) {
      sock.destroy();
      return;
    }
    this.socket = sock;
    const timeout = setTimeout(() => sock.destroy(new Error("The session daemon did not answer.")), 10_000);
    sock.on("error", (e) => { if (this.socket === sock) this.fail(e.message); });
    sock.on("close", () => {
      clearTimeout(timeout);
      if (this.socket !== sock) return;
      this.socket = undefined;
      this.attached = false;
      if (!this.connectionError) this.fail("Disconnected from the ACP session daemon. Use Restart to reconnect.");
    });
    sock.on("data", lineSplitter((line) => {
      let m: AcpOutput | DaemonAcpAttached | { type: "acp_attachError"; message: string };
      try { m = JSON.parse(line); } catch { return; }
      if (this.disposed) return;
      if (m.type === "acp_attached") {
        clearTimeout(timeout);
        this.attached = true;
        this.daemonKey = m.key;
        this.backend = m.acpBackend ?? this.backend;
        this.sendProfile();
      } else if (m.type === "acp_attachError") {
        this.fail(m.message);
        sock.destroy();
      } else if (this.attached) this.receive(m);
    }));
    sock.write(JSON.stringify(op) + "\n");
  }

  private fail(message: string) {
    if (this.disposed) return;
    this.dismissPermissions();
    this.connectionError = message;
    this.hasWork = false;
    this.setTitle(this.title, false, this.daemonKey);
    this.output.appendLine(`[acp] ${message}`);
    this.post({ type: "acpStatus", ready: false, error: message });
  }

  private receive(m: AcpOutput) {
    if (this.disposed) return;
    switch (m.type) {
      case "acpStatus":
        this.recovery = m.recoverable ? m : undefined;
        if (!m.ready && m.error) this.dismissPermissions();
        this.post(m);
        break;
      case "init":
        this.used ||= m.messages.length > 0;
        this.post(m);
        break;
      case "acpOperation":
        this.operation = !!m.message;
        this.post(m);
        break;
      case "acpBackend":
        this.backend = m.acpBackend;
        this.sendProfile();
        break;
      case "acpComposer":
        this.composer = m.capabilities;
        this.post(m);
        break;
      case "acpTitle":
        this.title = m.title;
        this.hasWork = m.busy;
        this.setTitle(m.title, m.busy, this.daemonKey);
        break;
      case "permission":
        if (!this.permissions.has(m.id)) {
          this.permissions.set(m.id, { request: m.request });
          permissionQueue = permissionQueue.then(() => this.showPermission(m.id)).catch((e) => {
            this.output.appendLine(`[acp] could not show permission request: ${String(e)}`);
          });
        }
        break;
      case "permissionClosed": {
        const pending = this.permissions.get(m.id);
        this.permissions.delete(m.id);
        pending?.token?.cancel();
        break;
      }
      default:
        this.post(m);
    }
  }

  private async showPermission(id: string) {
    const pending = this.permissions.get(id);
    if (!pending || this.disposed) return;
    const source = new vscode.CancellationTokenSource();
    pending.token = source;
    try {
      const { request } = pending;
      const item = await vscode.window.showQuickPick(request.options.map((o) => ({ ...o, detail: request.detail })), {
        title: `ACP permission: ${request.title}`,
        placeHolder: "Choose an option. Esc cancels the request.",
        ignoreFocusOut: true,
      }, source.token);
      if (!source.token.isCancellationRequested && this.permissions.get(id) === pending) {
        this.send({ type: "permissionAnswer", id, option: item?.id });
      }
    } catch (e) {
      this.output.appendLine(`[acp] could not show permission request: ${String(e)}`);
    } finally {
      source.dispose();
      pending.token = undefined;
    }
  }

  private dismissPermissions() {
    for (const pending of this.permissions.values()) pending.token?.cancel();
    this.permissions.clear();
  }

  /** Closing an ACP tab explicitly stops it. Window teardown only detaches. */
  close() { this.dispose(true); }

  dispose(stop = false) {
    if (this.disposed) return;
    this.disposed = true;
    this.dismissPermissions();
    for (const listener of this.listeners) listener.dispose();
    this.local?.dispose();
    const sock = this.socket;
    this.socket = undefined;
    if (sock) {
      if (stop && sock.writable) sock.end(JSON.stringify({ type: "acp_close" }) + "\n");
      else sock.end();
    }
  }
}
