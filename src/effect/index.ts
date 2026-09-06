/** Optional Effect integration. Existing Direct entry points do not import Effect. */
export { createDirectEffectDriver } from "./driver.js";
export type {
  DirectEffectCloseReport, DirectEffectDriver, DirectEffectDriverOptions,
  DirectEffectDriverSnapshot, DirectEffectOperation,
} from "./driver.js";
export type { DirectEffectDriverError } from "./deadline.js";
