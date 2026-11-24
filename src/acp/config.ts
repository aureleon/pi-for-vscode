import * as vscode from "vscode";

let configuring: Promise<boolean> | undefined;

/** Ask once before starting any ACP agent. Do not treat a dismissed setup as an error. */
export async function configureAcp(): Promise<boolean> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("Pi: trust this workspace before starting an ACP agent.");
    return false;
  }
  const config = vscode.workspace.getConfiguration("pi");
  if (config.get<string>("acp.command", "").trim()) return true;
  return configuring ??= promptAcp(config).finally(() => { configuring = undefined; });
}

async function promptAcp(config: vscode.WorkspaceConfiguration): Promise<boolean> {
  const command = await vscode.window.showInputBox({
    title: "Set up an ACP agent (1/2)",
    prompt: "Enter the agent executable name or absolute path. You can change it later in Settings.",
    placeHolder: "e.g. agy",
    validateInput: (text) => text.trim() ? undefined : "Enter the executable name or path.",
    ignoreFocusOut: true,
  });
  if (!command?.trim()) return false;
  const args = await vscode.window.showInputBox({
    title: "Set up an ACP agent (2/2)",
    prompt: "Enter arguments as a JSON array of strings. Use [] if the executable needs no arguments.",
    placeHolder: '["acp"]',
    value: JSON.stringify(config.get<string[]>("acp.args", [])),
    validateInput: (text) => parseArgs(text) ? undefined : 'Use a JSON array of strings, e.g. ["acp"].',
    ignoreFocusOut: true,
  });
  if (args === undefined) return false;
  const parsed = parseArgs(args);
  if (!parsed) return false;
  await config.update("acp.args", parsed, vscode.ConfigurationTarget.Global);
  await config.update("acp.command", command.trim(), vscode.ConfigurationTarget.Global);
  return true;
}

function parseArgs(text: string): string[] | undefined {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value) && value.every((arg) => typeof arg === "string")) return value;
  } catch {}
  return undefined;
}
