/**
 * Webview side of integrations. An integration adds support for one pi
 * extension beyond pi's generic RPC extension UI. `main.ts` calls these hooks
 * and never names an extension itself.
 *
 * The host side is in `src/integrations.ts`. The two sides of one integration
 * use the same `id` and talk with `{ type: "ext", id, payload }`.
 *
 * Pi for VS Code 0.1 supports standalone pi only, so the list is empty.
 */

export interface WebIntegrationApi {
  /** Send a payload to the host side of this integration. */
  post(payload: unknown): void;
  /** Add a transcript item (`.item <cls>`) at the end of the transcript. */
  addItem(cls: string): HTMLElement;
  /** Add an icon button to the header row (sidebar only). Returns undefined when there is no header row. */
  addToolbarButton(opts: { icon: string; title: string; onClick: () => void }): HTMLButtonElement | undefined;
  insertText(text: string): void;
  md(text: string): string;
  escapeHtml(text: string): string;
  linkify(root: HTMLElement): void;
}

export interface WebIntegration {
  id: string;
  init?(api: WebIntegrationApi): void;
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

export const WEB_INTEGRATIONS: WebIntegration[] = [];
