/**
 * pi side of the pi-btw integration: a small pi extension that the VS Code
 * extension loads with `pi --mode rpc -e dist/integrations/pi-btw.mjs`.
 *
 * pi-btw (0.7.1) queues its display-only `btw-note` with `deliverAs: "followUp"`
 * while the main agent runs. pi then starts a model turn for it, and pi-btw's own
 * context hook removes the note, so the request ends with an assistant message.
 * Providers without assistant prefill (for example Claude on Bedrock) reject it:
 * "This model does not support assistant message prefill". This extension forces
 * `triggerTurn: false`, so pi appends the note at the end of the turn with no model
 * call. Remove it when pi-btw fixes this upstream.
 *
 * Kept dependency-free. It does nothing in sessions without pi-btw notes.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const NOTE_TYPE = "btw-note";
/** Marks the AgentSession prototype as patched, so a reloaded extension does not wrap it twice. */
const PATCHED = Symbol.for("pi-vscode.btwFollowUp");

async function patchBtwFollowUp() {
  let mod: any;
  try {
    // A plain `import("@earendil-works/pi-coding-agent")` does not resolve from this file. pi's
    // own entry (`dist/.../cli.js`) sits next to `index.js`, and importing that file URL gives
    // the same module instance that the running session uses.
    const cli = process.argv[1] ? realpathSync(process.argv[1]) : "";
    if (!/cli\.[cm]?js$/.test(cli)) return;
    mod = await import(new URL("./index.js", pathToFileURL(cli)).href);
  } catch {
    return;
  }
  const proto = mod?.AgentSession?.prototype;
  if (!proto || typeof proto.sendCustomMessage !== "function" || proto[PATCHED]) return;
  const original = proto.sendCustomMessage;
  proto.sendCustomMessage = function (this: unknown, message: any, options?: any) {
    if (message?.customType === NOTE_TYPE && options?.deliverAs === "followUp" && options.triggerTurn === undefined) {
      options = { ...options, triggerTurn: false };
    }
    return original.call(this, message, options);
  };
  proto[PATCHED] = true;
}

export default function piBtwVscode() {
  void patchBtwFollowUp();
}
