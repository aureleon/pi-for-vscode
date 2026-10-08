/**
 * Host sides of the integrations that this build includes. Remove an entry
 * here (and in `web.ts`) to build without that integration.
 */
import type { HostIntegration } from "../src/integrations";
import { btwHost } from "./pi-btw/host";

export const HOST_INTEGRATIONS: HostIntegration[] = [btwHost];
