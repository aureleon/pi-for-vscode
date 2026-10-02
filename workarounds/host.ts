/**
 * Host sides of the workarounds that this build includes. Remove an entry here (and in
 * `web.ts`) to build without that workaround.
 */
import type { HostIntegration } from "../src/integrations";
import { factoryWidgetsHost } from "./factory-widgets/host";

export const HOST_WORKAROUNDS: HostIntegration[] = [factoryWidgetsHost];
