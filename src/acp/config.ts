import * as vscode from "vscode";
import { createHash } from "node:crypto";

export interface AcpProfile {
  name: string;
  command: string;
  args: string[];
}

export interface AcpBackend {
  name: string;
  fingerprint?: string;
}

export function acpFingerprint(profile: AcpProfile): string {
  return createHash("sha256").update(JSON.stringify([profile.command, profile.args])).digest("hex");
}

export function acpProfiles(): AcpProfile[] {
  const cfg = vscode.workspace.getConfiguration("pi");
  const entries = cfg.get<Record<string, Partial<AcpProfile>>>("acp.profiles", {});
  const profiles = Object.entries(entries ?? {}).flatMap(([name, value]) => {
    if (!name.trim() || name.length > 80 || typeof value?.command !== "string" || !value.command.trim()) return [];
    const args = value.args ?? [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return [];
    return [{ name: name.trim(), command: value.command.trim(), args: [...args] }];
  });
  if (profiles.length) return profiles;
  const command = cfg.get<string>("acp.command", "").trim();
  return command ? [{ name: command.split(/[\\/]/).at(-1) || "ACP", command, args: cfg.get<string[]>("acp.args", []) }] : [];
}

let configuring: Promise<AcpProfile | undefined> | undefined;

export async function pickAcpProfile(confirm = false): Promise<AcpProfile | undefined> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage("Trust this workspace before starting an ACP agent.");
    return;
  }
  const profiles = acpProfiles();
  if (!profiles.length) return configuring ??= promptAcp().finally(() => { configuring = undefined; });
  if (profiles.length === 1 && !confirm) return profiles[0];
  const pick = await vscode.window.showQuickPick(profiles.map((profile) => ({ label: profile.name, profile })), {
    placeHolder: confirm ? "Choose an agent to start without earlier context" : "Choose an ACP profile",
  });
  return pick?.profile;
}

async function promptAcp(): Promise<AcpProfile | undefined> {
  const config = vscode.workspace.getConfiguration("pi");
  const command = await vscode.window.showInputBox({
    title: "Set up an ACP agent (1/2)",
    prompt: "Enter the agent executable name or absolute path. You can change it later in Settings.",
    placeHolder: "e.g. agy",
    validateInput: (text) => text.trim() ? undefined : "Enter the executable name or path.",
    ignoreFocusOut: true,
  });
  if (!command?.trim()) return;
  const args = await vscode.window.showInputBox({
    title: "Set up an ACP agent (2/2)",
    prompt: "Enter arguments as a JSON array of strings. Use [] if the executable needs no arguments.",
    placeHolder: '["acp"]',
    value: JSON.stringify(config.get<string[]>("acp.args", [])),
    validateInput: (text) => parseArgs(text) ? undefined : 'Use a JSON array of strings, e.g. ["acp"].',
    ignoreFocusOut: true,
  });
  const parsed = args === undefined ? undefined : parseArgs(args);
  if (!parsed) return;
  await config.update("acp.args", parsed, vscode.ConfigurationTarget.Global);
  await config.update("acp.command", command.trim(), vscode.ConfigurationTarget.Global);
  return acpProfiles()[0];
}

function parseArgs(text: string): string[] | undefined {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value) && value.every((arg) => typeof arg === "string")) return value;
  } catch {}
  return undefined;
}
