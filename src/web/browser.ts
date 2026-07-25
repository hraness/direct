import type { JsonValue } from "../core/json-value.js";
import { renderUnknownReason } from "../core/reason.js";
import { err, ok, type Result } from "../core/result.js";
import type { DirectActivityScopeError } from "../testing/activity.js";
import type { DirectProbe } from "../testing/probe.js";
import type {
  DirectSession,
  DirectSessionRegistrationError,
} from "../testing/session.js";
import {
  prepareDirectBrowserBridgeInstallation,
  type DirectBrowserBridgeError,
  type DirectBrowserBridgeUninstall,
  type PreparedDirectBrowserBridgeInstallation,
} from "./browser-bridge.js";
import {
  prepareDirectFetchFirewallInstallation,
  type DirectFetchFirewallOptions,
  type DirectFetchFirewallUninstall,
  type PreparedDirectFetchFirewallInstallation,
} from "./fetch-firewall.js";

export interface DirectBrowserFirewallOptions extends Omit<
  DirectFetchFirewallOptions,
  "beginActivity"
> {
  /** Observe activity bookkeeping failures without allowing them to escape the fetch boundary. */
  readonly onActivityError?: (error: DirectActivityScopeError) => void;
}

export interface InstallDirectBrowserOptions<
  World extends JsonValue,
  Route extends string,
  Harness,
> {
  /** The installation registers its teardown with this session. */
  readonly session: DirectSession<World, Route, Harness>;
  readonly reset?: () => undefined;
  readonly target?: object;
  /** Fail closed by default. Set false only when another boundary owns application fetch. */
  readonly firewall?: DirectBrowserFirewallOptions | false;
}

export type DirectBrowserInstallError =
  | {
    readonly code: "invalid-options" | "firewall-install-failed";
    readonly message: string;
    readonly bridgeError: null;
    readonly registrationError: null;
    readonly rollbackErrors: readonly string[];
  }
  | {
    readonly code: "bridge-install-failed";
    readonly message: string;
    readonly bridgeError: DirectBrowserBridgeError;
    readonly registrationError: null;
    readonly rollbackErrors: readonly string[];
  }
  | {
    readonly code: "session-registration-failed";
    readonly message: string;
    readonly bridgeError: null;
    readonly registrationError: DirectSessionRegistrationError;
    readonly rollbackErrors: readonly string[];
  }
  | {
    readonly code: "session-registration-threw";
    readonly message: string;
    readonly bridgeError: null;
    readonly registrationError: null;
    readonly rollbackErrors: readonly string[];
  };

export interface DirectBrowserInstallation {
  /** Uninstall browser globals and the fetch firewall without disposing the owning session. */
  readonly dispose: () => undefined;
  readonly isDisposed: () => boolean;
  /** Best-effort disposal always attempts both browser boundaries. */
  readonly disposalErrors: () => readonly string[];
}

function freezeMessages(messages: readonly string[]): readonly string[] {
  return Object.freeze([...messages]);
}

function containPromiseLike(value: unknown): boolean {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  let then: unknown;
  try {
    then = Reflect.get(value, "then");
  } catch {
    return false;
  }
  if (typeof then !== "function") return false;
  try {
    void Promise.resolve(value).catch(() => undefined);
  } catch {
    // Promise assimilation is foreign code. Reporting remains observational.
  }
  return true;
}

function notifyActivityError(
  observer: ((error: DirectActivityScopeError) => void) | undefined,
  error: DirectActivityScopeError,
): void {
  if (observer === undefined) return;
  try {
    const returned: unknown = observer(error);
    containPromiseLike(returned);
  } catch {
    // Reporting cannot weaken the fail-closed activity boundary.
  }
}

function runBrowserCleanup(
  bridge: DirectBrowserBridgeUninstall | null,
  firewall: DirectFetchFirewallUninstall | null,
): readonly string[] {
  const errors: string[] = [];
  for (const [label, cleanup] of [
    ["bridge", bridge],
    ["firewall", firewall],
  ] as const) {
    if (cleanup === null) continue;
    try {
      const returned: unknown = cleanup();
      if (returned !== undefined) {
        containPromiseLike(returned);
        errors.push(`Direct browser ${label} cleanup must return undefined`);
      }
    } catch (reason) {
      errors.push(renderUnknownReason(reason, `Direct browser ${label} cleanup failed`));
    }
  }
  return freezeMessages(errors);
}

/**
 * Install the exact session-manifest, probe, and reset browser bridge plus the
 * fail-closed fetch boundary around one session. Installation is failure-atomic
 * and teardown is registered with the session, so session disposal remains the
 * aggregate lifecycle boundary.
 */
export function installDirectBrowser<
  World extends JsonValue,
  Route extends string,
  Harness,
>(
  options: InstallDirectBrowserOptions<World, Route, Harness>,
): Result<DirectBrowserInstallation, DirectBrowserInstallError> {
  let activity: DirectSession<World, Route, Harness>["activity"];
  let manifest: DirectSession<World, Route, Harness>["manifest"];
  let onDispose: DirectSession<World, Route, Harness>["onDispose"];
  let probe: DirectProbe;
  let reset: (() => undefined) | undefined;
  let target: object | undefined;
  let firewallOptions: DirectBrowserFirewallOptions | false;
  try {
    const session = options.session;
    activity = session.activity;
    manifest = session.manifest;
    onDispose = session.onDispose;
    probe = session.probe;
    reset = options.reset;
    target = options.target;
    firewallOptions = options.firewall ?? {};
  } catch (reason) {
    return err(Object.freeze({
      code: "invalid-options",
      message: renderUnknownReason(reason, "Direct browser options could not be inspected"),
      bridgeError: null,
      registrationError: null,
      rollbackErrors: freezeMessages([]),
    }));
  }

  let preparedFirewall: PreparedDirectFetchFirewallInstallation | null = null;
  if (firewallOptions !== false) {
    try {
      const { onActivityError, ...lowLevelOptions } = firewallOptions;
      preparedFirewall = prepareDirectFetchFirewallInstallation({
        ...lowLevelOptions,
        beginActivity: () => {
          const started = activity.begin("browser-fetch");
          if (!started.ok) {
            notifyActivityError(onActivityError, started.error);
            throw new Error(started.error.message, { cause: started.error });
          }
          return (): undefined => {
            const released = started.value.release();
            if (!released.ok) notifyActivityError(onActivityError, released.error);
            return undefined;
          };
        },
      });
    } catch (reason) {
      return err(Object.freeze({
        code: "firewall-install-failed",
        message: renderUnknownReason(reason, "Direct fetch firewall installation failed"),
        bridgeError: null,
        registrationError: null,
        rollbackErrors: freezeMessages([]),
      }));
    }
  }

  const preparedBridgeResult = prepareDirectBrowserBridgeInstallation({
    probe,
    manifest,
    ...(reset === undefined ? {} : { reset }),
    ...(target === undefined ? {} : { target }),
  });
  if (!preparedBridgeResult.ok) {
    const rollbackErrors = runBrowserCleanup(null, preparedFirewall?.rollback ?? null);
    return err(Object.freeze({
      code: "bridge-install-failed",
      message: preparedBridgeResult.error.message,
      bridgeError: preparedBridgeResult.error,
      registrationError: null,
      rollbackErrors,
    }));
  }
  const preparedBridge: PreparedDirectBrowserBridgeInstallation = preparedBridgeResult.value;

  let disposed = false;
  let committed = false;
  let disposalErrors: readonly string[] = freezeMessages([]);
  const dispose = (): undefined => {
    if (disposed) return undefined;
    disposed = true;
    disposalErrors = committed
      ? runBrowserCleanup(preparedBridge.uninstall, preparedFirewall?.uninstall ?? null)
      : runBrowserCleanup(preparedBridge.rollback, preparedFirewall?.rollback ?? null);
    return undefined;
  };
  const installation: DirectBrowserInstallation = Object.freeze({
    dispose,
    isDisposed: () => disposed,
    disposalErrors: () => disposalErrors,
  });
  try {
    const registered = onDispose(dispose);
    if (!registered.ok) {
      dispose();
      return err(Object.freeze({
        code: "session-registration-failed",
        message: registered.error.message,
        bridgeError: null,
        registrationError: registered.error,
        rollbackErrors: disposalErrors,
      }));
    }
  } catch (reason) {
    dispose();
    return err(Object.freeze({
      code: "session-registration-threw",
      message: renderUnknownReason(reason, "Direct session cleanup registration failed"),
      bridgeError: null,
      registrationError: null,
      rollbackErrors: disposalErrors,
    }));
  }
  if (disposed) {
    return err(Object.freeze({
      code: "session-registration-threw",
      message: "Direct session disposed browser ownership during cleanup registration",
      bridgeError: null,
      registrationError: null,
      rollbackErrors: disposalErrors,
    }));
  }
  preparedFirewall?.commit();
  preparedBridge.commit();
  committed = true;
  return ok(installation);
}
