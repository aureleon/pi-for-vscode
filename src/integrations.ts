/**
 * Host side of integrations. An integration adds support for one pi extension
 * beyond pi's generic RPC extension UI (dialogs, notices, status, widgets).
 * The controller calls these hooks and never names an extension itself.
 *
 * Integrations live in `integrations/<name>/`. `integrations/host.ts` lists them.
 * The webview side is in `webview/integrations.ts`. The two sides of one
 * integration use the same `id` and talk with `{ type: "ext", id, payload }`.
 */
import { HOST_INTEGRATIONS as LIST } from "../integrations/host";

/** A command from `get_commands`. */
export interface PiCommand {
  name: string;
  description?: string;
  source: string;
  sourceInfo?: { path?: string };
}

export interface IntegrationHostApi {
  /** Send a prompt or slash command to the session that is shown. Resolves with pi's response. */
  prompt(text: string): Promise<any>;
  /** Send a payload to the webview side of this integration. */
  post(payload: unknown): void;
  /** Set or clear (0) the badge of the Pi view in the sidebar. */
  setBadge(count: number, tooltip?: string): void;
}

/** The hooks of one integration in one chat. */
export interface HostIntegrationInstance {
  /**
   * Return true to keep a notice of the shown session out of VS Code notifications
   * (the webview side shows it). Called only while the integration is active.
   */
  filterNotice?(message: string, level: string): boolean;
  /** A payload from the webview side of this integration. */
  onMessage?(payload: any): Promise<void> | void;
}

export interface HostIntegration {
  id: string;
  /** Is the pi extension loaded in this session? The integration is active only then. */
  matches(commands: PiCommand[]): boolean;
  /**
   * Optional pi side: a pi extension that pi loads with `-e` in every session (it must do nothing
   * when its pi extension is not loaded). Path relative to `dist/`, built from `integrations/<name>/pi.ts`.
   */
  piExtension?: string;
  /** `customType`s of custom entries on the active branch. The webview side gets them with each snapshot. */
  entryTypes?: string[];
  /** Called once for each chat. */
  create(api: IntegrationHostApi): HostIntegrationInstance;
}

export const HOST_INTEGRATIONS: HostIntegration[] = LIST;

/** Entry types that some integration needs in the snapshot. */
export function integrationEntryTypes(): Set<string> {
  return new Set(HOST_INTEGRATIONS.flatMap((i) => i.entryTypes ?? []));
}

/** Pi extensions of the integrations, as paths relative to `dist/`. */
export function integrationPiExtensions(): string[] {
  return HOST_INTEGRATIONS.flatMap((i) => (i.piExtension ? [i.piExtension] : []));
}

/** Ids of the integrations whose pi extension is loaded. */
export function activeIntegrations(commands: PiCommand[] | undefined): Set<string> {
  return new Set(HOST_INTEGRATIONS.filter((i) => commands && i.matches(commands)).map((i) => i.id));
}
