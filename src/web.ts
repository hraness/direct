import {
  DIRECT_BROWSER_BRIDGE_SCHEMA as browserBridgeSchema,
  installDirectBrowserBridge as installBrowserBridge,
} from "./web/browser-bridge.js";
import {
  installDirectFetchFirewall as installFetchFirewall,
} from "./web/fetch-firewall.js";

export * from "./web/browser.js";
export const DIRECT_BROWSER_BRIDGE_SCHEMA = browserBridgeSchema;
export const installDirectBrowserBridge: typeof installBrowserBridge = (
  options,
) => installBrowserBridge(options);
export type {
  DirectBrowserBridge,
  DirectBrowserBridgeError,
  DirectBrowserBridgeErrorCode,
  DirectBrowserBridgeOptions,
  DirectBrowserBridgeUninstall,
} from "./web/browser-bridge.js";
export const installDirectFetchFirewall: typeof installFetchFirewall = (
  options,
) => installFetchFirewall(options);
export type {
  DirectFetchFirewallOptions,
  DirectFetchFirewallUninstall,
} from "./web/fetch-firewall.js";
