/**
 * Short titles for sessions: for new sessions (setting `pi.autoTitle`, off by default), and for the
 * session that is open with the hidden `vscode:title` command (`/title` in the chat).
 *
 * Without a name, a session shows the first line of its first prompt. With the setting on, the first
 * prompt also goes to a small model, which writes a title of a few words. The title becomes the
 * session name, so the tabs, the session list and the pi TUI (`/resume`) show it.
 *
 * The VS Code extension passes the setting in the environment:
 * - `PI_VSCODE_AUTO_TITLE=1` turns on the titles for new sessions.
 * - `PI_VSCODE_TITLE_MODEL=<provider>/<id>` selects the model. Without it: a Haiku model of the
 *   session's provider, else the session's model.
 *
 * Kept dependency-free: only the few API shapes used here are typed locally.
 */

interface Model {
  provider: string;
  id: string;
}

interface Registry {
  find(provider: string, id: string): Model | undefined;
  getAvailable(): Model[];
  complete(
    model: Model,
    context: { messages: unknown[] },
    options?: Record<string, unknown>,
  ): Promise<{ content: { type: string; text?: string }[] }>;
}

interface Context {
  model?: Model;
  modelRegistry: Registry;
  sessionManager: { getSessionFile(): string | undefined; getBranch(): { type: string; message?: { role?: string; content?: unknown } }[] };
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

interface PiApi {
  on(event: "before_agent_start", handler: (event: { messageType?: string; prompt?: string }, ctx: Context) => void): void;
  registerCommand(name: string, spec: { description?: string; handler: (args: string, ctx: Context) => Promise<void> }): void;
  getSessionName(): string | undefined;
  setSessionName(name: string): void;
}

const MAX_PROMPT = 4000;
const MAX_TITLE = 60;
/** For a title of a session that has messages: this much of each prompt. */
const MAX_EACH = 600;

const INSTRUCTION =
  "Write a title for a coding session that starts with the request below. Use 3 to 6 words, in sentence case. " +
  "Name the task, as a short imperative phrase (for example: Fix tab titles after reload). " +
  "Reply with the title only: no quotes, no trailing period, no other text.";

function pickModel(ctx: Context): Model | undefined {
  const wanted = process.env.PI_VSCODE_TITLE_MODEL?.trim();
  if (wanted) {
    const i = wanted.indexOf("/");
    const m = i > 0 ? ctx.modelRegistry.find(wanted.slice(0, i), wanted.slice(i + 1)) : ctx.modelRegistry.getAvailable().find((x) => x.id === wanted);
    if (m) return m;
  }
  const provider = ctx.model?.provider;
  // The newest Haiku of the same provider (ids sort by version).
  const small = ctx.modelRegistry
    .getAvailable()
    .filter((m) => m.provider === provider && /haiku/i.test(m.id))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
  return small ?? ctx.model;
}

function clean(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line
    .replace(/^title:\s*/i, "")
    .replace(/^["'`*#\s]+|["'`*\s.]+$/g, "")
    .slice(0, MAX_TITLE)
    .trim();
}

/** The prompts of the session, in order: the first ones and the last ones if they are too long together. */
function promptsOf(ctx: Context): string {
  const texts = ctx.sessionManager
    .getBranch()
    .filter((e) => e.type === "message" && e.message?.role === "user")
    .map((e) => {
      const c = e.message!.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join("\n") : "";
      return text.trim().slice(0, MAX_EACH);
    })
    .filter(Boolean);
  const all = texts.map((t, i) => `${i + 1}. ${t}`);
  let head = all.slice(0, 3).join("\n\n");
  for (let i = all.length - 1; i >= 3; i--) {
    const tail = all.slice(i).join("\n\n");
    if (head.length + tail.length > MAX_PROMPT) return `${head}\n\n…\n\n${all.slice(i + 1).join("\n\n")}`;
  }
  return all.join("\n\n");
}

/** Ask the model for a title. `replace`: also when the session has a name (the user asked for a new title). */
async function title(pi: PiApi, ctx: Context, prompt: string, replace = false): Promise<string | undefined> {
  const model = pickModel(ctx);
  if (!model) throw new Error("no model for the title");
  const file = ctx.sessionManager.getSessionFile();
  const response = await ctx.modelRegistry.complete(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: `${INSTRUCTION}\n\n<request>\n${prompt.slice(0, MAX_PROMPT)}\n</request>` }],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens: 200, cacheRetention: "none" },
  );
  const name = clean(response.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"));
  // The process can have another session by now (/new), or the session got a name (a rename).
  if (!name || ctx.sessionManager.getSessionFile() !== file || (!replace && pi.getSessionName())) return undefined;
  pi.setSessionName(name);
  return name;
}

export function sessionTitle(pi: PiApi) {
  pi.registerCommand("vscode:title", {
    description: "(VS Code) Write a short title for this session",
    handler: async (_args, ctx) => {
      try {
        const prompts = promptsOf(ctx);
        if (!prompts) throw new Error("the session has no prompt yet");
        const name = await title(pi, ctx, `The requests of the session so far, in order:\n${prompts}`, true);
        if (!name) throw new Error("the model gave no title");
      } catch (err) {
        ctx.ui.notify(`Could not write a session title: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
  if (process.env.PI_VSCODE_AUTO_TITLE !== "1") return;
  /** Session files that have a title request, so a second prompt does not start another one. */
  const asked = new Set<string | undefined>();
  pi.on("before_agent_start", (event, ctx) => {
    try {
      const prompt = event.prompt?.trim();
      if (event.messageType === "custom" || !prompt || pi.getSessionName()) return;
      const file = ctx.sessionManager.getSessionFile();
      if (asked.has(file)) return;
      // Only the first prompt of a session. pi can add the prompt to the session before or after this event.
      const users = ctx.sessionManager.getBranch().filter((e) => e.type === "message" && e.message?.role === "user").length;
      if (users > 1) return;
      asked.add(file);
      // Do not wait: the run starts now, and the title comes when the model answers.
      title(pi, ctx, prompt).catch(() => {});
    } catch {
      /* a title is optional */
    }
  });
}
