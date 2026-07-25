import { renderUnknownReason } from "../core/reason.js";
import { err, ok, type Result } from "../core/result.js";
import {
  parseDirectProbeSnapshot,
  type DirectProbe,
  type DirectProbeSnapshot,
} from "../testing/probe.js";
import {
  parseDirectSessionManifest,
  type DirectSessionManifest,
} from "../testing/manifest.js";

export const DIRECT_BROWSER_BRIDGE_SCHEMA = "direct.browser-bridge/v2" as const;

export interface DirectBrowserBridge {
  readonly schema: typeof DIRECT_BROWSER_BRIDGE_SCHEMA;
  readonly manifest: DirectSessionManifest;
  readonly snapshot: () => DirectProbeSnapshot;
  readonly reset: () => undefined;
}

export interface DirectBrowserBridgeOptions {
  readonly probe: Pick<DirectProbe, "snapshot">;
  readonly manifest: unknown;
  readonly reset?: () => undefined;
  readonly target?: object;
}

export type DirectBrowserBridgeErrorCode = "install-failed" | "invalid-manifest";

export interface DirectBrowserBridgeError {
  readonly code: DirectBrowserBridgeErrorCode;
  readonly message: string;
}

export type DirectBrowserBridgeUninstall = () => undefined;

export interface PreparedDirectBrowserBridgeInstallation {
  /** Make this provisional replacement the process owner. Cannot fail. */
  readonly commit: () => undefined;
  /** Restore the exact owner observed before preparation. */
  readonly rollback: () => undefined;
  /** Remove a committed replacement and restore its underlying owner. */
  readonly uninstall: DirectBrowserBridgeUninstall;
}

const BRIDGE_KEYS = ["__direct"] as const;

interface ActiveBridgeInstallation {
  readonly target: object;
  readonly installed: ReadonlyMap<string, unknown>;
  readonly restore: ReadonlyMap<string, PropertyDescriptor | undefined>;
  readonly deactivate: () => undefined;
  readonly uninstall: DirectBrowserBridgeUninstall;
}

let activeBridgeInstallation: ActiveBridgeInstallation | null = null;

function bridgeError(
  code: DirectBrowserBridgeErrorCode,
  message: string,
): DirectBrowserBridgeError {
  return Object.freeze({ code, message });
}

/** Consume a foreign thenable so a callback that lied about being synchronous cannot reject globally. */
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
    // Promise assimilation is a foreign boundary too. The callback remains contained.
  }
  return true;
}

function requireSynchronousResetResult(value: unknown): undefined {
  containPromiseLike(value);
  if (value !== undefined) {
    throw new Error("Direct reset must complete synchronously and return undefined");
  }
  return undefined;
}

function defaultReset(): undefined {
  const target = globalThis as typeof globalThis & {
    readonly location?: { readonly reload?: () => unknown };
  };
  return requireSynchronousResetResult(target.location?.reload?.());
}

function restoreDescriptor(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
  } else {
    Object.defineProperty(target, key, descriptor);
  }
}

function restoreInstalledValue(
  target: object,
  key: string,
  installedValue: unknown,
  previous: PropertyDescriptor | undefined,
): void {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor?.value === installedValue) restoreDescriptor(target, key, previous);
  } catch {
    // Uninstall and failed-install cleanup are best effort on a hostile target.
  }
}

/** Prepare a reversible bridge replacement without deactivating the current owner. */
export function prepareDirectBrowserBridgeInstallation(
  options: DirectBrowserBridgeOptions,
): Result<PreparedDirectBrowserBridgeInstallation, DirectBrowserBridgeError> {
  let manifestInput: unknown;
  try {
    manifestInput = options.manifest;
  } catch (reason) {
    return err(bridgeError(
      "invalid-manifest",
      renderUnknownReason(reason, "Failed to read the Direct session manifest"),
    ));
  }
  const parsedManifest = parseDirectSessionManifest(manifestInput);
  if (!parsedManifest.ok) {
    return err(bridgeError("invalid-manifest", parsedManifest.error.message));
  }
  const manifest = parsedManifest.value;

  let target: object;
  let reset: () => undefined;
  let probe: Pick<DirectProbe, "snapshot">;
  try {
    target = options.target ?? globalThis;
    reset = options.reset ?? defaultReset;
    probe = options.probe;
  } catch (reason) {
    return err(bridgeError(
      "install-failed",
      renderUnknownReason(reason, "Failed to read Direct browser bridge options"),
    ));
  }
  const previousInstallation = activeBridgeInstallation;
  const rollbackDescriptors = new Map<string, PropertyDescriptor | undefined>();
  const restore = new Map<string, PropertyDescriptor | undefined>();
  try {
    for (const key of BRIDGE_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      rollbackDescriptors.set(key, descriptor);
      const previousOwnsValue = previousInstallation?.target === target
        && descriptor?.value === previousInstallation.installed.get(key);
      restore.set(
        key,
        previousOwnsValue ? previousInstallation.restore.get(key) : descriptor,
      );
    }
  } catch (reason) {
    return err(bridgeError(
      "install-failed",
      renderUnknownReason(reason, "Failed to inspect the Direct browser bridge target"),
    ));
  }

  const readSnapshot = (): DirectProbeSnapshot => {
    try {
      const snapshot: unknown = probe.snapshot();
      if (containPromiseLike(snapshot)) {
        throw new Error("Direct probe snapshots must complete synchronously");
      }
      if ((typeof snapshot !== "object" || snapshot === null) && typeof snapshot !== "function") {
        throw new Error("Direct probe returned an invalid result");
      }
      const succeeded: unknown = Reflect.get(snapshot, "ok");
      if (succeeded !== true) {
        if (succeeded === false) throw new Error(renderUnknownReason(Reflect.get(snapshot, "error")));
        throw new Error("Direct probe returned an invalid result");
      }
      const parsed = parseDirectProbeSnapshot(Reflect.get(snapshot, "value"));
      if (!parsed.ok) throw new Error(parsed.error.message);
      if (parsed.value.activationHash !== manifest.active.activationHash) {
        throw new Error(
          "Direct probe activation hash does not match the installed session manifest",
        );
      }
      return parsed.value;
    } catch (reason) {
      throw new Error(`Direct probe failed: ${renderUnknownReason(reason)}`);
    }
  };
  const runReset = (): undefined => {
    try {
      const returned: unknown = reset();
      return requireSynchronousResetResult(returned);
    } catch (reason) {
      throw new Error(`Direct reset failed: ${renderUnknownReason(reason)}`);
    }
  };
  const bridge: DirectBrowserBridge = Object.freeze({
    schema: DIRECT_BROWSER_BRIDGE_SCHEMA,
    manifest,
    snapshot: readSnapshot,
    reset: runReset,
  });
  const installed = new Map<string, unknown>([["__direct", bridge]]);

  try {
    for (const [key, value] of installed) {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: false,
        writable: true,
        value,
      });
    }
  } catch (reason) {
    for (const key of BRIDGE_KEYS) {
      restoreInstalledValue(target, key, installed.get(key), rollbackDescriptors.get(key));
    }
    return err(bridgeError(
      "install-failed",
      renderUnknownReason(reason, "Direct browser bridge installation failed"),
    ));
  }

  let state: "prepared" | "committed" | "closed" = "prepared";
  const rollback = (): undefined => {
    if (state !== "prepared") return undefined;
    state = "closed";
    for (const key of BRIDGE_KEYS) {
      restoreInstalledValue(target, key, installed.get(key), rollbackDescriptors.get(key));
    }
    return undefined;
  };
  const deactivate = (): undefined => {
    if (state !== "committed") return undefined;
    state = "closed";
    if (activeBridgeInstallation === installation) activeBridgeInstallation = null;
    return undefined;
  };
  const uninstall = (): undefined => {
    if (state === "prepared") return rollback();
    if (state !== "committed") return undefined;
    state = "closed";
    for (const key of BRIDGE_KEYS) {
      restoreInstalledValue(target, key, installed.get(key), restore.get(key));
    }
    if (activeBridgeInstallation === installation) activeBridgeInstallation = null;
    return undefined;
  };
  const installation: ActiveBridgeInstallation = Object.freeze({
    target,
    installed,
    restore,
    deactivate,
    uninstall,
  });
  const commit = (): undefined => {
    if (state !== "prepared") return undefined;
    state = "committed";
    if (previousInstallation !== null) {
      if (previousInstallation.target === target) previousInstallation.deactivate();
      else previousInstallation.uninstall();
    }
    activeBridgeInstallation = installation;
    return undefined;
  };

  return ok(Object.freeze({
    commit,
    rollback,
    uninstall,
  }));
}

/**
 * Install one process-local browser automation bridge. A later installation
 * restores and replaces the earlier one; stale uninstall handles are harmless.
 */
export function installDirectBrowserBridge(
  options: DirectBrowserBridgeOptions,
): Result<DirectBrowserBridgeUninstall, DirectBrowserBridgeError> {
  const prepared = prepareDirectBrowserBridgeInstallation(options);
  if (!prepared.ok) return prepared;
  prepared.value.commit();
  return ok(prepared.value.uninstall);
}
