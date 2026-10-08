/**
 * Webview side of integrations. An integration adds support for one pi
 * extension beyond pi's generic RPC extension UI. `main.ts` calls these hooks
 * and never names an extension itself.
 *
 * Integrations live in `integrations/<name>/`. `integrations/web.ts` lists them.
 * The host side is in `src/integrations.ts`. The two sides of one integration
 * use the same `id` and talk with `{ type: "ext", id, payload }`.
 */
import { WEB_INTEGRATIONS as LIST } from "../integrations/web";

/** A command from `get_commands`. */
export interface PiCommand {
  name: string;
  description?: string;
  source: string;
  sourceInfo?: { path?: string };
}

export interface WebIntegrationApi {
  /** Send a payload to the host side of this integration. */
  post(payload: unknown): void;
  /** Add a transcript item (`.item <cls>`) at the end of the transcript. */
  addItem(cls: string): HTMLElement;
  /**
   * Add an icon button to the header row. Editor tabs have no header row, so there the
   * button goes into the composer toolbar.
   */
  addToolbarButton(opts: { icon: string; title: string; onClick: () => void }): HTMLButtonElement;
  insertText(text: string): void;
  focusComposer(): void;
  /** Markdown for model text. */
  md(text: string): string;
  /** Markdown for user text (keeps single line breaks). */
  mdUser(text: string): string;
  escapeHtml(text: string): string;
  linkify(root: HTMLElement): void;
  /** State of this integration that is kept when the webview reloads. */
  loadState<T>(): T | undefined;
  saveState(value: unknown): void;
}

/** The hooks of one integration in this webview. */
export interface WebIntegrationInstance {
  /** The pi extension was loaded or unloaded (new session, /restart). */
  onActiveChange?(active: boolean): void;
  /** A new transcript: the custom entries that the host side asked for (`entryTypes`), oldest first. */
  onSnapshot?(entries: any[]): void;
  /** Render a `custom` message. Return true if it was rendered here. */
  renderCustomMessage?(msg: any): boolean;
  /** An extension appended a custom session entry (`entry_appended`). */
  onEntry?(entry: any): void;
  /** A notice from pi (it can also show as a VS Code notification). */
  onNotice?(text: string, level: string): void;
  /** A slash command typed in the composer. Return true to take it. */
  interceptCommand?(name: string, args: string): boolean;
  /** A payload from the host side of this integration. */
  onMessage?(payload: any): void;
}

export interface WebIntegration {
  id: string;
  /** Is the pi extension loaded in this session? The hooks are called only then. */
  matches(commands: PiCommand[]): boolean;
  create(api: WebIntegrationApi): WebIntegrationInstance;
}

export const WEB_INTEGRATIONS: WebIntegration[] = LIST;
