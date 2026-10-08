/**
 * Host side of integrations. An integration adds support for one pi extension
 * beyond pi's generic RPC extension UI (dialogs, notices, status, widgets).
 * The controller calls these hooks and never names an extension itself.
 *
 * The webview side is in `webview/integrations.ts`. The two sides of one
 * integration use the same `id` and talk with `{ type: "ext", id, payload }`.
 *
 * Pi for VS Code 0.1 supports standalone pi only, so the list is empty.
 */

export interface IntegrationHostApi {
  /** Send a prompt or slash command to the session that is shown. Resolves with pi's response. */
  prompt(text: string): Promise<any>;
  /** Send a payload to the webview side of this integration. */
  post(payload: unknown): void;
}

export interface HostIntegration {
  id: string;
  /** `customType`s of custom entries on the active branch. The webview side gets them with each snapshot. */
  entryTypes?: string[];
  /** Return true to keep a notice of the shown session out of VS Code notifications (the webview side shows it). */
  filterNotice?(message: string, level: string): boolean;
  /** A payload from the webview side of this integration. */
  onMessage?(payload: any, api: IntegrationHostApi): Promise<void> | void;
}

export const HOST_INTEGRATIONS: HostIntegration[] = [];

/** Entry types that some integration needs in the snapshot. */
export function integrationEntryTypes(): Set<string> {
  return new Set(HOST_INTEGRATIONS.flatMap((i) => i.entryTypes ?? []));
}
