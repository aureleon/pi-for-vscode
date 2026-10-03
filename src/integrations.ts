/**
 * Host side of integrations and workarounds. Both use these hooks; the controller
 * calls them and never names a pi extension or a workaround itself.
 *
 *  - An integration (`integrations/<name>/`) adds support for one pi extension. It
 *    is active only in sessions that load that extension (`matches`).
 *  - A workaround (`workarounds/<name>/`) fills a gap in pi's RPC mode for every
 *    extension. It has no `matches` and is always active, unless the `pi.workarounds`
 *    setting turns it off.
 *
 * `integrations/host.ts` and `workarounds/host.ts` list them. The webview side is in
 * `webview/integrations.ts`. The two sides of one module use the same `id` and talk
 * with `{ type: "ext", id, payload }`.
 */
import { HOST_INTEGRATIONS as INTEGRATIONS } from "../integrations/host";
import { HOST_WORKAROUNDS as WORKAROUNDS } from "../workarounds/host";

/** A command from `get_commands`. */
export interface PiCommand {
  name: string;
  description?: string;
  source: string;
  /** `source` is the package (for example `npm:pi-btw`) or `auto` for a file in an extensions folder. */
  sourceInfo?: { path?: string; source?: string };
}

/** One pi process of the chat, as the hooks see it. The same object for the life of the process. */
export interface ExtSession {
  /** The webview shows this session (it is not running in the background). */
  readonly shown: boolean;
  readonly running: boolean;
  /** Send an RPC command to this process (not only the shown one). */
  request(cmd: { type: string; [k: string]: unknown }): Promise<any>;
}

export interface IntegrationHostApi {
  /** Send a prompt or slash command to the session that is shown. Resolves with pi's response. */
  prompt(text: string): Promise<any>;
  /** Send a payload to the webview side of this module. */
  post(payload: unknown): void;
  /** Send a payload to the webview side, only if `s` is the session shown (queued during a snapshot). */
  emit(s: ExtSession, payload: unknown): void;
  /** Set or clear (0) the badge of the Pi view in the sidebar. */
  setBadge(count: number, tooltip?: string): void;
  /** `isBusy()` of `s` may have changed: the controller updates the status bar and background sessions. */
  busyChanged(s: ExtSession): void;
}

/** The hooks of one module in one chat. Session hooks are called only while the module is active in that session. */
export interface HostIntegrationInstance {
  /**
   * Return true to keep a notice of the shown session out of VS Code notifications
   * (the webview side shows it).
   */
  filterNotice?(message: string, level: string): boolean;
  /** A payload from the webview side of this module. */
  onMessage?(payload: any): Promise<void> | void;
  /** More environment variables for a new pi process. Called for every process, before it starts. */
  env?(): Record<string, string | undefined>;
  /** The commands of `s` (after the snapshot, and after commands that can change them). */
  onCommands?(s: ExtSession, commands: PiCommand[]): void;
  /** The webview got a new snapshot of `s`. */
  onShown?(s: ExtSession): void;
  /** A `setStatus` from pi. Return true to consume it: it is not shown. */
  onStatus?(s: ExtSession, key: string, text: string | undefined): boolean;
  /** Is `s` doing work that RPC events do not show? A busy process is not stopped on a session switch. */
  isBusy?(s: ExtSession): boolean;
  /** Session files that a running pi process writes to apart from its own session. Another process must not open them. */
  filesInUse?(): string[];
  /** The process of `s` exited. */
  onExit?(s: ExtSession): void;
}

export interface HostIntegration {
  id: string;
  /**
   * Integrations: is the pi extension loaded in this session? The integration is active only then.
   * Workarounds leave it out: they are always active.
   */
  matches?(commands: PiCommand[]): boolean;
  /**
   * Optional pi side: a pi extension that pi loads with `-e` in every session (an integration's
   * must do nothing when its pi extension is not loaded). Path relative to `dist/`, built from
   * `integrations/<name>/pi.ts` or `workarounds/<name>/pi.ts`.
   */
  piExtension?: string;
  /**
   * Widget keys (`ctx.ui.setWidget`) that the chat does not show while the module is active, for
   * example a key-driven menu that does nothing without terminal input.
   */
  hiddenWidgets?: string[];
  /** `customType`s of custom entries on the active branch. The webview side gets them with each snapshot. */
  entryTypes?: string[];
  /** Called once for each chat. */
  create(api: IntegrationHostApi): HostIntegrationInstance;
}

export const HOST_INTEGRATIONS: HostIntegration[] = INTEGRATIONS;
export const HOST_WORKAROUNDS: HostIntegration[] = WORKAROUNDS;

/** Integrations, then the workarounds that `pi.workarounds` does not turn off. */
export function hostModules(enabled: (workaroundId: string) => boolean): HostIntegration[] {
  return [...HOST_INTEGRATIONS, ...HOST_WORKAROUNDS.filter((w) => enabled(w.id))];
}

/** Entry types that some module needs in the snapshot. */
export function moduleEntryTypes(modules: HostIntegration[]): Set<string> {
  return new Set(modules.flatMap((i) => i.entryTypes ?? []));
}

/** Pi extensions of the modules, as paths relative to `dist/`. */
export function modulePiExtensions(modules: HostIntegration[]): string[] {
  return modules.flatMap((i) => (i.piExtension ? [i.piExtension] : []));
}

/** Widget keys that the active modules hide. */
export function hiddenWidgets(modules: HostIntegration[], active: Set<string>): Set<string> {
  return new Set(modules.filter((i) => active.has(i.id)).flatMap((i) => i.hiddenWidgets ?? []));
}

/** Ids of the active modules: integrations whose pi extension is loaded, and every workaround. */
export function activeModules(modules: HostIntegration[], commands: PiCommand[] | undefined): Set<string> {
  return new Set(modules.filter((i) => !i.matches || (!!commands && i.matches(commands))).map((i) => i.id));
}
