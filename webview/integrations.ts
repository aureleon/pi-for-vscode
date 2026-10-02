/**
 * Webview side of integrations and workarounds (see `src/integrations.ts`).
 * `main.ts` calls these hooks and never names a pi extension or a workaround itself.
 *
 * `integrations/web.ts` and `workarounds/web.ts` list them. The two sides of one
 * module use the same `id` and talk with `{ type: "ext", id, payload }`.
 */
import { WEB_INTEGRATIONS as INTEGRATIONS } from "../integrations/web";
import { WEB_WORKAROUNDS as WORKAROUNDS } from "../workarounds/web";

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
  /**
   * Put an item into the composer toolbar, before the context ring. A `menu` goes into the composer
   * box, where it opens above the input like the model picker (give it the `model-picker` class).
   */
  addComposerItem(item: HTMLElement, menu?: HTMLElement): void;
  /** Close the autocomplete popup, so a menu of the module can open in its place. */
  hidePopup(): void;
  /**
   * Called with the number of monospace characters that fit in a widget box, now and when the view
   * is resized. The core knows the box geometry.
   */
  onWidgetColumns(cb: (columns: number) => void): void;
  /** Icons of the core, for buttons that should look the same. */
  icons: { close: string };
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
  /** Integrations: is the pi extension loaded in this session? The hooks are called only then. Workarounds leave it out. */
  matches?(commands: PiCommand[]): boolean;
  create(api: WebIntegrationApi): WebIntegrationInstance;
}

export const WEB_INTEGRATIONS: WebIntegration[] = INTEGRATIONS;
export const WEB_WORKAROUNDS: WebIntegration[] = WORKAROUNDS;
