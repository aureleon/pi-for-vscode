/**
 * pi-side bridge loaded by the VS Code extension with `pi --mode rpc -e <this file>`.
 *
 * RPC mode has no command for moving within the session tree (the TUI's /tree),
 * but extension command contexts get `ctx.navigateTree()` in every mode. This
 * bridge exposes that (plus entry labels) as hidden slash commands whose argument
 * is a JSON payload. The VS Code webview hides `vscode:*` commands from autocomplete.
 *
 * Kept dependency-free: only the few API shapes used here are typed locally.
 */

interface NavigateOptions {
  summarize?: boolean;
  customInstructions?: string;
  replaceInstructions?: boolean;
  label?: string;
}

interface CommandContext {
  navigateTree(targetId: string, options?: NavigateOptions): Promise<{ cancelled: boolean }>;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  isIdle(): boolean;
}

interface PiApi {
  registerCommand(name: string, spec: { description?: string; handler: (args: string, ctx: CommandContext) => Promise<void> }): void;
  setLabel(entryId: string, label: string | undefined): void;
}

function parse<T>(args: string): T {
  try {
    return JSON.parse(args) as T;
  } catch {
    throw new Error("vscode bridge: invalid JSON payload");
  }
}

export default function piVscodeBridge(pi: PiApi) {
  pi.registerCommand("vscode:tree", {
    description: "(VS Code) Navigate the session tree",
    handler: async (args, ctx) => {
      const p = parse<{ targetId: string } & NavigateOptions>(args);
      try {
        if (!ctx.isIdle()) throw new Error("Wait for the current response to finish before navigating the session tree.");
        const r = await ctx.navigateTree(p.targetId, {
          summarize: !!p.summarize,
          customInstructions: p.customInstructions || undefined,
          replaceInstructions: p.replaceInstructions,
          label: p.label || undefined,
        });
        if (r.cancelled) ctx.ui.notify("Tree navigation was cancelled.", "warning");
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });

  pi.registerCommand("vscode:label", {
    description: "(VS Code) Set or clear a label on a session entry",
    handler: async (args, ctx) => {
      const p = parse<{ entryId: string; label?: string }>(args);
      try {
        pi.setLabel(p.entryId, p.label?.trim() || undefined);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
