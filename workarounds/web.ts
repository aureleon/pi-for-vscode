/**
 * Webview sides of the workarounds that this build includes. Remove an entry here (and in
 * `host.ts`) to build without that workaround.
 */
import type { WebIntegration } from "../webview/integrations";
import { factoryWidgetsWeb } from "./factory-widgets/web";

export const WEB_WORKAROUNDS: WebIntegration[] = [factoryWidgetsWeb];
