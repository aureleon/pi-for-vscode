/**
 * Webview sides of the integrations that this build includes. Remove an entry
 * here (and in `host.ts`) to build without that integration.
 */
import type { WebIntegration } from "../webview/integrations";
import { btwWeb } from "./pi-btw/web";

export const WEB_INTEGRATIONS: WebIntegration[] = [btwWeb];
