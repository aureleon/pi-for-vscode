import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { PiController, type ChatHost } from "./controller";
import { createPiTerminal } from "./piTerminal";

let output: vscode.OutputChannel;
const controllers = new Set<PiController>();
let sidebar: PiController | undefined;
let lastActive: PiController | undefined;

function html(webview: vscode.Webview, extUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "dist", "webview.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "webview", "styles.css"));
  const logo = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "media", "pi-logo.svg"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: https:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Pi</title>
</head>
<body data-logo="${logo}">
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

function webviewOptions(extUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extUri, "dist"), vscode.Uri.joinPath(extUri, "webview"), vscode.Uri.joinPath(extUri, "media")],
  };
}

class SidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = webviewOptions(this.context.extensionUri);
    const host: ChatHost = {
      webview: view.webview,
      // The view's own title carries the session name. Its container is already titled
      // "Pi Coding Agent", so a static view name would repeat it whenever VS Code shows
      // both (e.g. after moving the view into the secondary side bar).
      setTitle: (t) => {
        view.title = t || "New session";
        view.description = undefined;
      },
      setSideState: (open, count) => {
        // Unread side-thread turns show as a badge on the Pi view while the panel is closed.
        view.badge = !open && count ? { value: count, tooltip: `${count} BTW side-thread message${count === 1 ? "" : "s"}` } : undefined;
      },
      reveal: () => view.show(true),
    };
    // A re-resolved view (e.g. moved to another container) gets a fresh controller
    // bound to the new webview; the previous one is disposed with its process.
    sidebar?.dispose();
    const c = new PiController(this.context, host, output, { primary: true });
    sidebar = c;
    lastActive = c;
    controllers.add(c);
    view.onDidChangeVisibility(() => view.visible && (lastActive = c));
    view.onDidDispose(() => {
      c.dispose();
      controllers.delete(c);
      if (sidebar === c) sidebar = undefined;
    });
    view.webview.html = html(view.webview, this.context.extensionUri);
  }
}

function openPanel(context: vscode.ExtensionContext, sessionFile?: string) {
  const panel = vscode.window.createWebviewPanel("pi.panel", "Pi", vscode.ViewColumn.Beside, {
    ...webviewOptions(context.extensionUri),
    retainContextWhenHidden: true,
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "pi-logo.svg");
  const host: ChatHost = {
    webview: panel.webview,
    setTitle: (t) => (panel.title = t ?? "Pi"),
    reveal: () => panel.reveal(),
  };
  const c = new PiController(context, host, output, { primary: false, sessionFile });
  controllers.add(c);
  lastActive = c;
  panel.onDidChangeViewState(() => panel.active && (lastActive = c));
  panel.onDidDispose(() => {
    c.dispose();
    controllers.delete(c);
    if (lastActive === c) lastActive = sidebar;
  });
  panel.webview.html = html(panel.webview, context.extensionUri);
}

async function target(): Promise<PiController | undefined> {
  if (lastActive && controllers.has(lastActive)) return lastActive;
  await vscode.commands.executeCommand("pi.chat.focus");
  return sidebar;
}

function refFor(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, false);
  return rel.includes(" ") ? `@"${rel}"` : `@${rel}`;
}

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel("Pi");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("pi.chat", new SidebarProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const cmd = (id: string, fn: (...a: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd("pi.focus", () => vscode.commands.executeCommand("pi.chat.focus"));
  cmd("pi.openInTab", () => openPanel(context));
  cmd("pi.newSession", async () => (await target())?.runBuiltin("new", ""));
  cmd("pi.history", async () => (await target())?.runBuiltin("resume", ""));
  cmd("pi.tree", async () => (await target())?.runBuiltin("tree", ""));
  cmd("pi.openInTerminal", async () => (await target())?.openInTerminal());
  // "Pi: Open in Terminal": a fresh pi TUI session in a terminal, no chat attached.
  cmd("pi.newTerminal", () => createPiTerminal([]));
  cmd("pi.restart", async () => (await target())?.restart());
  cmd("pi.selectModel", async () => (await target())?.runBuiltin("model", ""));
  cmd("pi.selectThinking", async () => (await target())?.runBuiltin("thinking", ""));
  cmd("pi.abort", async () => (await target())?.abort());
  cmd("pi.toggleSidePanel", async () => (await target())?.toggleSidePanel());

  cmd("pi.addSelection", async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const sel = ed.selection;
    let text = refFor(ed.document.uri);
    if (!sel.isEmpty) {
      const a = sel.start.line + 1;
      const b = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      text += a === b ? `:${a}` : `:${a}-${b}`;
    }
    (await target())?.insertText(text + " ");
  });

  cmd("pi.addFile", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
    const list = uris?.length ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
    if (!list.length) return;
    (await target())?.insertText(list.map(refFor).join(" ") + " ");
  });

  output.appendLine(`[pi] extension activated (${path.basename(context.extensionPath)})`);
}

export function deactivate() {
  for (const c of controllers) c.dispose();
  controllers.clear();
}
