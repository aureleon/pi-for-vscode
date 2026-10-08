/**
 * What the integration knows about pi-btw (https://github.com/dbachelder/pi-btw):
 * its commands, thread modes, header actions, session entries and notices.
 * Plain data with no DOM, so the host side and the webview side both use it.
 */

/** How one slash command opens the panel. */
export interface BtwCommand {
  /** Command sent for the first message after the panel opens with this command. Defaults to the command itself. */
  send?: string;
  /** Command for follow-up messages. Defaults to the mode's `followUp`. */
  followUp?: string;
  /** Thread mode this command selects. */
  mode: string;
  /** Clear the visible thread: the command starts a new thread. */
  newThread?: boolean;
}

/** A thread mode, such as the "tangent" thread that does not see the main chat. */
export interface BtwMode {
  /** Short label next to the panel title. Empty for the default mode. */
  label: string;
  /** Line under the empty-thread text. */
  hint: string;
  /** Command for follow-ups in this mode (also used after a restore). */
  followUp: string;
}

/** A header button that runs a pi-btw command. */
export interface BtwAction {
  label: string;
  /** Command to run, without the leading `/`. */
  command: string;
  tooltip: string;
  /** Append the text in the panel's input box as arguments. */
  useInput?: boolean;
  /** Enable the button only when the thread has an answer. */
  needsAnswer?: boolean;
  /** Enable the button only when the thread is not empty. */
  needsTurns?: boolean;
  /** Status text while the command runs. */
  status?: string;
  icon?: "trash";
  /** Put a separator before this button. */
  separator?: boolean;
}

export const TITLE = "BTW";

export const COMMANDS: Record<string, BtwCommand> = {
  btw: { mode: "contextual" },
  side: { send: "btw", mode: "contextual" },
  "btw:new": { mode: "contextual", newThread: true, followUp: "btw" },
  "btw:tangent": { mode: "tangent", newThread: true },
  "btw:ask": { mode: "readonly", newThread: true },
};

export const DEFAULT_MODE = "contextual";

export const MODES: Record<string, BtwMode> = {
  contextual: { label: "", hint: "The side thread sees the main conversation's context.", followUp: "btw" },
  tangent: { label: "tangent · no main context", hint: "This thread does not see the main conversation.", followUp: "btw:tangent" },
  readonly: { label: "read-only", hint: "This thread can read files but cannot change anything.", followUp: "btw:ask" },
};

export const ACTIONS: BtwAction[] = [
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
];

/** `customType` of one question/answer turn (`pi.appendEntry`). Its data has question, answer, thinking, model, usage. */
export const THREAD_ENTRY = "btw-thread-entry";
/** `customType` of the entry that clears the thread. Its data can hold `mode`. */
export const RESET_ENTRY = "btw-thread-reset";
/** `customType` of the custom message that the main transcript shows as a link to the panel. */
export const NOTE_MESSAGE = "btw-note";

/** Notices that pi-btw sends for the TUI; the panel shows the same information. */
export const HIDDEN_NOTICES = /^(Displayed BTW response|BTW response queued|Saved BTW note|BTW note queued)/;
/** pi-btw refuses a bare command in RPC mode. The panel opens its own composer instead, so this notice is not needed. */
export const COMPOSER_REFUSAL = /cannot open its composer outside Pi's TUI/i;
/** Flags removed from the question before it is shown (the command still gets them). */
export const STRIP_FLAGS = ["--save", "-s"];

export const EMPTY_TEXT = "Ask a side question without interrupting the main agent.";
export const PLACEHOLDER = "Ask a side question…  (Enter to send, Esc to close)";
export const FOLLOW_UP_PLACEHOLDER = "Follow up on the side…  (Enter to send, Esc to close)";

/** pi-btw is loaded: its main command and one of its thread commands are extension commands. */
export function hasPiBtw(commands: { name: string; source: string }[]): boolean {
  const ext = new Set(commands.filter((c) => c.source === "extension").map((c) => c.name));
  return ext.has("btw") && ext.has("btw:inject");
}
