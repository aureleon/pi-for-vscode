/**
 * Side-panel profiles: what the side panel needs to know about one
 * side-conversation extension (commands, thread modes, actions, persisted
 * entries). pi-btw is the built-in profile. Users add or change profiles with
 * the `pi.sidePanels` setting.
 *
 * Plain data, no DOM: the host imports this file to merge settings and to find
 * the entry types to restore, and the webview uses it to drive the panel.
 */

/** How one slash command opens the panel. */
export interface SideCommand {
  /** Command sent for the first message after the panel opens with this command. Defaults to the command itself. */
  send?: string;
  /** Command for follow-up messages. Defaults to the mode's `followUp`, else to the command itself. */
  followUp?: string;
  /** Thread mode this command selects. */
  mode?: string;
  /** Clear the visible thread: the command starts a new thread. */
  newThread?: boolean;
  /** Panel title for this command. Defaults to the profile title. */
  title?: string;
}

/** A thread mode, such as pi-btw's "tangent" thread that does not see the main chat. */
export interface SideMode {
  /** Short label next to the panel title. Empty for the default mode. */
  label?: string;
  /** Line under the empty-thread text. */
  hint?: string;
  /** Command for follow-ups in this mode (used after a restore). */
  followUp?: string;
}

/** A header button that runs a command of the extension. */
export interface SideAction {
  label: string;
  /** Command to run, without the leading `/`. */
  command: string;
  tooltip?: string;
  /** Append the text in the panel's input box as arguments. */
  useInput?: boolean;
  /** Enable the button only when the thread has an answer. */
  needsAnswer?: boolean;
  /** Enable the button only when the thread is not empty. */
  needsTurns?: boolean;
  /** Status text while the command runs. */
  status?: string;
  /** Show as an icon button. */
  icon?: "trash";
  /** Put a separator before this button. */
  separator?: boolean;
}

/** Custom session entries that hold the side thread, so the panel can restore it. */
export interface SideEntries {
  /** `customType` of one question/answer turn. */
  thread?: string;
  /** `customType` that clears the thread (its data can hold `mode`). */
  reset?: string;
  /** `customType` of the custom message that the main transcript shows as a link to the panel. */
  note?: string;
  /** Field names in the entry data. Defaults: question, answer, thinking, model, usage, mode, timestamp. */
  fields?: Partial<Record<"question" | "answer" | "thinking" | "model" | "usage" | "mode" | "timestamp", string>>;
}

export interface SideProfile {
  id: string;
  /** Panel title and the tag of transcript links. */
  title: string;
  commands: Record<string, SideCommand>;
  /** Command used when a live thread entry opens the panel. Defaults to the first command. */
  defaultCommand?: string;
  modes?: Record<string, SideMode>;
  defaultMode?: string;
  actions?: SideAction[];
  entries?: SideEntries;
  /** Regular expressions (source) for notices that the panel does not show. */
  hideNotices?: string[];
  /** Flags removed from the question before it is shown (the command still gets them). */
  stripFlags?: string[];
  /** Text of an empty thread. */
  emptyText?: string;
  placeholder?: string;
  followUpPlaceholder?: string;
}

/** Legacy `pi.sidePanelCommands` entry. */
export interface SideCommandConfig {
  followUp?: string;
  title?: string;
}

export const BTW_PROFILE: SideProfile = {
  id: "btw",
  title: "BTW",
  defaultCommand: "btw",
  commands: {
    btw: { mode: "contextual" },
    side: { send: "btw", mode: "contextual" },
    "btw:new": { mode: "contextual", newThread: true, followUp: "btw" },
    "btw:tangent": { mode: "tangent", newThread: true },
    "btw:ask": { mode: "readonly", newThread: true },
  },
  defaultMode: "contextual",
  modes: {
    contextual: { label: "", hint: "The side thread sees the main conversation's context.", followUp: "btw" },
    tangent: { label: "tangent · no main context", hint: "This thread does not see the main conversation.", followUp: "btw:tangent" },
    readonly: { label: "read-only", hint: "This thread can read files but cannot change anything.", followUp: "btw:ask" },
  },
  actions: [
    {
      label: "Inject",
      command: "btw:inject",
      tooltip: "Send the full thread to the main agent (/btw:inject). Text in the box is used as instructions.",
      useInput: true,
      needsAnswer: true,
      status: "Injecting thread into the main chat…",
    },
    {
      label: "Summarize",
      command: "btw:summarize",
      tooltip: "Send a summary of the thread to the main agent (/btw:summarize). Text in the box is used as instructions.",
      useInput: true,
      needsAnswer: true,
      status: "Summarizing thread for the main chat…",
    },
    { label: "Clear", command: "btw:clear", tooltip: "Clear the side thread and start fresh (/btw:clear)", needsTurns: true, icon: "trash", separator: true },
  ],
  entries: { thread: "btw-thread-entry", reset: "btw-thread-reset", note: "btw-note" },
  hideNotices: ["^(Displayed BTW response|BTW response queued|Saved BTW note|BTW note queued)"],
  stripFlags: ["--save", "-s"],
  emptyText: "Ask a side question without interrupting the main agent.",
  placeholder: "Ask a side question…  (Enter to send, Esc to close)",
  followUpPlaceholder: "Follow up on the side…  (Enter to send, Esc to close)",
};

export const BUILTIN_PROFILES: SideProfile[] = [BTW_PROFILE];

/** A plain profile for one command: a question/answer thread with no actions or entries. */
export function simpleProfile(cmd: string, cfg: SideCommandConfig = {}): SideProfile {
  return { id: `cmd:${cmd}`, title: cfg.title ?? `/${cmd}`, commands: { [cmd]: { followUp: cfg.followUp } } };
}

/**
 * Built-in profiles, changed or extended by `pi.sidePanels` (matched by id; fields
 * replace the built-in ones, `commands` and `modes` are merged), then legacy
 * `pi.sidePanelCommands` entries: a command that a profile already has gets the
 * new follow-up and title, any other command gets a plain profile.
 */
export function mergeProfiles(user: Partial<SideProfile>[] = [], legacy: Record<string, SideCommandConfig> = {}): SideProfile[] {
  // Copy deep enough that the legacy merge below never changes the built-in objects.
  const copyCommands = (c: Record<string, SideCommand> = {}) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { ...v }]));
  const out: SideProfile[] = BUILTIN_PROFILES.map((p) => ({ ...p, commands: copyCommands(p.commands), modes: p.modes && { ...p.modes } }));
  for (const u of Array.isArray(user) ? user : []) {
    if (!u || typeof u.id !== "string" || !u.id) continue;
    const base = out.find((p) => p.id === u.id);
    if (base) {
      const modes = base.modes || u.modes ? { ...(base.modes ?? {}), ...(u.modes ?? {}) } : undefined;
      Object.assign(base, { ...u, commands: { ...base.commands, ...copyCommands(u.commands) }, modes });
    } else if (u.commands && Object.keys(u.commands).length) {
      out.push({ title: u.id, ...u, commands: copyCommands(u.commands) } as SideProfile);
    }
  }
  for (const [cmd, cfg] of Object.entries(legacy && typeof legacy === "object" ? legacy : {})) {
    const owner = out.find((p) => p.commands[cmd]);
    if (!owner) {
      out.push(simpleProfile(cmd, cfg));
      continue;
    }
    const c = owner.commands[cmd];
    // The old default listed every pi-btw command with these values; skip entries that change nothing.
    if (cfg.followUp && cfg.followUp !== (c.followUp ?? (c.mode && owner.modes?.[c.mode]?.followUp) ?? c.send ?? cmd)) c.followUp = cfg.followUp;
    if (cfg.title && cfg.title !== owner.title) c.title = cfg.title;
  }
  return out;
}

/** Entry types (`customType`) the host must send so the panel can restore its threads. */
export function threadEntryTypes(profiles: SideProfile[]): string[] {
  return profiles.flatMap((p) => [p.entries?.thread, p.entries?.reset]).filter((t): t is string => !!t);
}
