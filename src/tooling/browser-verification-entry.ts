import {
  parseDirectProbeSnapshot,
  parseDirectSessionManifest,
  type DirectProbeSnapshot,
  type DirectSessionManifest,
} from "@hraness/direct/testing";
import { DIRECT_BROWSER_BRIDGE_SCHEMA } from "@hraness/direct/web";

import {
  createDirectBrowserContractReader,
  type DirectBrowserContract,
} from "./browser-verification.js";

export * from "./browser-verification.js";

export type DirectSessionBrowserContract = DirectBrowserContract<
  DirectSessionManifest,
  DirectProbeSnapshot
>;

/**
 * Reads the package's exact browser bridge without requiring consumers to
 * repeat the schema and parser binding.
 */
export const readDirectBrowserContract = createDirectBrowserContractReader<
  DirectSessionManifest,
  DirectProbeSnapshot
>({
  bridgeSchema: DIRECT_BROWSER_BRIDGE_SCHEMA,
  parseManifest: parseDirectSessionManifest,
  parseProbe: parseDirectProbeSnapshot,
});
