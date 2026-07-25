import {
  parseDirectProbeSnapshot,
  parseDirectSessionManifest
} from "./index-way196f7.js";
import {
  err,
  ok,
  renderUnknownReason
} from "./index-s0h6zg88.js";

// src/web/browser-bridge.ts
var DIRECT_BROWSER_BRIDGE_SCHEMA = "direct.browser-bridge/v2";
var BRIDGE_KEYS = ["__direct"];
var activeBridgeInstallation = null;
function bridgeError(code, message) {
  return Object.freeze({ code, message });
}
function containPromiseLike(value) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function")
    return false;
  let then;
  try {
    then = Reflect.get(value, "then");
  } catch {
    return false;
  }
  if (typeof then !== "function")
    return false;
  try {
    Promise.resolve(value).catch(() => {
      return;
    });
  } catch {}
  return true;
}
function requireSynchronousResetResult(value) {
  containPromiseLike(value);
  if (value !== undefined) {
    throw new Error("Direct reset must complete synchronously and return undefined");
  }
  return;
}
function defaultReset() {
  const target = globalThis;
  return requireSynchronousResetResult(target.location?.reload?.());
}
function restoreDescriptor(target, key, descriptor) {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
  } else {
    Object.defineProperty(target, key, descriptor);
  }
}
function restoreInstalledValue(target, key, installedValue, previous) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor?.value === installedValue)
      restoreDescriptor(target, key, previous);
  } catch {}
}
function prepareDirectBrowserBridgeInstallation(options) {
  let manifestInput;
  try {
    manifestInput = options.manifest;
  } catch (reason) {
    return err(bridgeError("invalid-manifest", renderUnknownReason(reason, "Failed to read the Direct session manifest")));
  }
  const parsedManifest = parseDirectSessionManifest(manifestInput);
  if (!parsedManifest.ok) {
    return err(bridgeError("invalid-manifest", parsedManifest.error.message));
  }
  const manifest = parsedManifest.value;
  let target;
  let reset;
  let probe;
  try {
    target = options.target ?? globalThis;
    reset = options.reset ?? defaultReset;
    probe = options.probe;
  } catch (reason) {
    return err(bridgeError("install-failed", renderUnknownReason(reason, "Failed to read Direct browser bridge options")));
  }
  const previousInstallation = activeBridgeInstallation;
  const rollbackDescriptors = new Map;
  const restore = new Map;
  try {
    for (const key of BRIDGE_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      rollbackDescriptors.set(key, descriptor);
      const previousOwnsValue = previousInstallation?.target === target && descriptor?.value === previousInstallation.installed.get(key);
      restore.set(key, previousOwnsValue ? previousInstallation.restore.get(key) : descriptor);
    }
  } catch (reason) {
    return err(bridgeError("install-failed", renderUnknownReason(reason, "Failed to inspect the Direct browser bridge target")));
  }
  const readSnapshot = () => {
    try {
      const snapshot = probe.snapshot();
      if (containPromiseLike(snapshot)) {
        throw new Error("Direct probe snapshots must complete synchronously");
      }
      if ((typeof snapshot !== "object" || snapshot === null) && typeof snapshot !== "function") {
        throw new Error("Direct probe returned an invalid result");
      }
      const succeeded = Reflect.get(snapshot, "ok");
      if (succeeded !== true) {
        if (succeeded === false)
          throw new Error(renderUnknownReason(Reflect.get(snapshot, "error")));
        throw new Error("Direct probe returned an invalid result");
      }
      const parsed = parseDirectProbeSnapshot(Reflect.get(snapshot, "value"));
      if (!parsed.ok)
        throw new Error(parsed.error.message);
      if (parsed.value.activationHash !== manifest.active.activationHash) {
        throw new Error("Direct probe activation hash does not match the installed session manifest");
      }
      return parsed.value;
    } catch (reason) {
      throw new Error(`Direct probe failed: ${renderUnknownReason(reason)}`);
    }
  };
  const runReset = () => {
    try {
      const returned = reset();
      return requireSynchronousResetResult(returned);
    } catch (reason) {
      throw new Error(`Direct reset failed: ${renderUnknownReason(reason)}`);
    }
  };
  const bridge = Object.freeze({
    schema: DIRECT_BROWSER_BRIDGE_SCHEMA,
    manifest,
    snapshot: readSnapshot,
    reset: runReset
  });
  const installed = new Map([["__direct", bridge]]);
  try {
    for (const [key, value] of installed) {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: false,
        writable: true,
        value
      });
    }
  } catch (reason) {
    for (const key of BRIDGE_KEYS) {
      restoreInstalledValue(target, key, installed.get(key), rollbackDescriptors.get(key));
    }
    return err(bridgeError("install-failed", renderUnknownReason(reason, "Direct browser bridge installation failed")));
  }
  let state = "prepared";
  const rollback = () => {
    if (state !== "prepared")
      return;
    state = "closed";
    for (const key of BRIDGE_KEYS) {
      restoreInstalledValue(target, key, installed.get(key), rollbackDescriptors.get(key));
    }
    return;
  };
  const deactivate = () => {
    if (state !== "committed")
      return;
    state = "closed";
    if (activeBridgeInstallation === installation)
      activeBridgeInstallation = null;
    return;
  };
  const uninstall = () => {
    if (state === "prepared")
      return rollback();
    if (state !== "committed")
      return;
    state = "closed";
    for (const key of BRIDGE_KEYS) {
      restoreInstalledValue(target, key, installed.get(key), restore.get(key));
    }
    if (activeBridgeInstallation === installation)
      activeBridgeInstallation = null;
    return;
  };
  const installation = Object.freeze({
    target,
    installed,
    restore,
    deactivate,
    uninstall
  });
  const commit = () => {
    if (state !== "prepared")
      return;
    state = "committed";
    if (previousInstallation !== null) {
      if (previousInstallation.target === target)
        previousInstallation.deactivate();
      else
        previousInstallation.uninstall();
    }
    activeBridgeInstallation = installation;
    return;
  };
  return ok(Object.freeze({
    commit,
    rollback,
    uninstall
  }));
}
function installDirectBrowserBridge(options) {
  const prepared = prepareDirectBrowserBridgeInstallation(options);
  if (!prepared.ok)
    return prepared;
  prepared.value.commit();
  return ok(prepared.value.uninstall);
}

// src/web/fetch-firewall.ts
var activeFirewallInstallation = null;
function containPromiseLike2(value) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function")
    return false;
  let then;
  try {
    then = Reflect.get(value, "then");
  } catch {
    return false;
  }
  if (typeof then !== "function")
    return false;
  try {
    Promise.resolve(value).catch(() => {
      return;
    });
  } catch {}
  return true;
}
function requestUrl(input) {
  try {
    if (typeof Request !== "undefined" && input instanceof Request)
      return new URL(input.url);
    const browserGlobal = globalThis;
    const locationOrigin = browserGlobal.location?.origin;
    const base = locationOrigin === undefined || locationOrigin === "null" ? "http://direct.invalid" : locationOrigin;
    return new URL(String(input), base);
  } catch {
    return null;
  }
}
function blockedResponse() {
  return new Response(JSON.stringify({ error: "Direct blocked an unmapped network request." }), { status: 501, headers: { "content-type": "application/json" } });
}
function beginBoundary(beginActivity, url) {
  if (beginActivity === undefined) {
    return { valid: true, release: () => {
      return;
    } };
  }
  let candidate;
  try {
    candidate = beginActivity(url);
  } catch {
    return { valid: false, release: () => {
      return;
    } };
  }
  if (containPromiseLike2(candidate) || typeof candidate !== "function") {
    return { valid: false, release: () => {
      return;
    } };
  }
  let active = true;
  return {
    valid: true,
    release: () => {
      if (!active)
        return;
      active = false;
      try {
        const returned = Reflect.apply(candidate, undefined, []);
        containPromiseLike2(returned);
      } catch {}
      return;
    }
  };
}
function explicitlyAllowed(allow, url) {
  if (allow === undefined || url === null)
    return false;
  try {
    const returned = allow(url);
    if (containPromiseLike2(returned))
      return false;
    return returned === true;
  } catch {
    return false;
  }
}
function notifyBlocked(onBlocked, url) {
  if (onBlocked === undefined)
    return;
  try {
    const returned = onBlocked(url);
    containPromiseLike2(returned);
  } catch {}
}
function prepareDirectFetchFirewallInstallation(options = {}) {
  const previousInstallation = activeFirewallInstallation;
  const currentFetch = globalThis.fetch;
  const previousOwnsCurrent = previousInstallation?.guardedFetch === currentFetch;
  const restoreFetch = previousOwnsCurrent ? previousInstallation.restoreFetch : currentFetch;
  const allow = options.allow;
  const beginActivity = options.beginActivity;
  const onBlocked = options.onBlocked;
  const originalFetch = options.originalFetch ?? restoreFetch;
  if (typeof originalFetch !== "function") {
    throw new TypeError("Direct fetch firewall requires a callable fetch implementation");
  }
  const guardedCall = async (input, init) => {
    const url = requestUrl(input);
    const activity = beginBoundary(beginActivity, url);
    try {
      if (activity.valid && explicitlyAllowed(allow, url)) {
        return await originalFetch(input, init);
      }
      notifyBlocked(onBlocked, url);
      return blockedResponse();
    } finally {
      activity.release();
    }
  };
  const previousPreconnect = Reflect.get(restoreFetch, "preconnect");
  if (typeof previousPreconnect === "function") {
    Object.defineProperty(guardedCall, "preconnect", {
      configurable: true,
      value: (...arguments_) => {
        const url = requestUrl(arguments_[0]);
        const activity = beginBoundary(beginActivity, url);
        try {
          if (activity.valid && explicitlyAllowed(allow, url)) {
            const returned = Reflect.apply(previousPreconnect, restoreFetch, arguments_);
            containPromiseLike2(returned);
          } else {
            notifyBlocked(onBlocked, url);
          }
        } finally {
          activity.release();
        }
        return;
      }
    });
  }
  const guardedFetch = guardedCall;
  try {
    globalThis.fetch = guardedFetch;
    if (globalThis.fetch !== guardedFetch) {
      throw new TypeError("Direct fetch firewall could not replace global fetch");
    }
  } catch (reason) {
    try {
      if (globalThis.fetch === guardedFetch)
        globalThis.fetch = currentFetch;
    } catch {}
    throw reason;
  }
  let state = "prepared";
  const rollback = () => {
    if (state !== "prepared")
      return;
    if (globalThis.fetch === guardedFetch)
      globalThis.fetch = currentFetch;
    state = "closed";
    return;
  };
  const deactivate = () => {
    if (state !== "committed")
      return;
    state = "closed";
    if (activeFirewallInstallation === installation)
      activeFirewallInstallation = null;
    return;
  };
  const uninstall = () => {
    if (state === "prepared")
      return rollback();
    if (state !== "committed")
      return;
    if (globalThis.fetch === guardedFetch)
      globalThis.fetch = restoreFetch;
    state = "closed";
    if (activeFirewallInstallation === installation)
      activeFirewallInstallation = null;
    return;
  };
  const installation = {
    guardedFetch,
    restoreFetch,
    deactivate,
    uninstall
  };
  const commit = () => {
    if (state !== "prepared")
      return;
    state = "committed";
    if (previousInstallation !== null)
      previousInstallation.deactivate();
    activeFirewallInstallation = installation;
    return;
  };
  return Object.freeze({
    commit,
    rollback,
    uninstall
  });
}
function installDirectFetchFirewall(options = {}) {
  const prepared = prepareDirectFetchFirewallInstallation(options);
  prepared.commit();
  return prepared.uninstall;
}

// src/web/browser.ts
function freezeMessages(messages) {
  return Object.freeze([...messages]);
}
function containPromiseLike3(value) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function")
    return false;
  let then;
  try {
    then = Reflect.get(value, "then");
  } catch {
    return false;
  }
  if (typeof then !== "function")
    return false;
  try {
    Promise.resolve(value).catch(() => {
      return;
    });
  } catch {}
  return true;
}
function notifyActivityError(observer, error) {
  if (observer === undefined)
    return;
  try {
    const returned = observer(error);
    containPromiseLike3(returned);
  } catch {}
}
function runBrowserCleanup(bridge, firewall) {
  const errors = [];
  for (const [label, cleanup] of [
    ["bridge", bridge],
    ["firewall", firewall]
  ]) {
    if (cleanup === null)
      continue;
    try {
      const returned = cleanup();
      if (returned !== undefined) {
        containPromiseLike3(returned);
        errors.push(`Direct browser ${label} cleanup must return undefined`);
      }
    } catch (reason) {
      errors.push(renderUnknownReason(reason, `Direct browser ${label} cleanup failed`));
    }
  }
  return freezeMessages(errors);
}
function installDirectBrowser(options) {
  let activity;
  let manifest;
  let onDispose;
  let probe;
  let reset;
  let target;
  let firewallOptions;
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
      rollbackErrors: freezeMessages([])
    }));
  }
  let preparedFirewall = null;
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
          return () => {
            const released = started.value.release();
            if (!released.ok)
              notifyActivityError(onActivityError, released.error);
            return;
          };
        }
      });
    } catch (reason) {
      return err(Object.freeze({
        code: "firewall-install-failed",
        message: renderUnknownReason(reason, "Direct fetch firewall installation failed"),
        bridgeError: null,
        registrationError: null,
        rollbackErrors: freezeMessages([])
      }));
    }
  }
  const preparedBridgeResult = prepareDirectBrowserBridgeInstallation({
    probe,
    manifest,
    ...reset === undefined ? {} : { reset },
    ...target === undefined ? {} : { target }
  });
  if (!preparedBridgeResult.ok) {
    const rollbackErrors = runBrowserCleanup(null, preparedFirewall?.rollback ?? null);
    return err(Object.freeze({
      code: "bridge-install-failed",
      message: preparedBridgeResult.error.message,
      bridgeError: preparedBridgeResult.error,
      registrationError: null,
      rollbackErrors
    }));
  }
  const preparedBridge = preparedBridgeResult.value;
  let disposed = false;
  let committed = false;
  let disposalErrors = freezeMessages([]);
  const dispose = () => {
    if (disposed)
      return;
    disposed = true;
    disposalErrors = committed ? runBrowserCleanup(preparedBridge.uninstall, preparedFirewall?.uninstall ?? null) : runBrowserCleanup(preparedBridge.rollback, preparedFirewall?.rollback ?? null);
    return;
  };
  const installation = Object.freeze({
    dispose,
    isDisposed: () => disposed,
    disposalErrors: () => disposalErrors
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
        rollbackErrors: disposalErrors
      }));
    }
  } catch (reason) {
    dispose();
    return err(Object.freeze({
      code: "session-registration-threw",
      message: renderUnknownReason(reason, "Direct session cleanup registration failed"),
      bridgeError: null,
      registrationError: null,
      rollbackErrors: disposalErrors
    }));
  }
  if (disposed) {
    return err(Object.freeze({
      code: "session-registration-threw",
      message: "Direct session disposed browser ownership during cleanup registration",
      bridgeError: null,
      registrationError: null,
      rollbackErrors: disposalErrors
    }));
  }
  preparedFirewall?.commit();
  preparedBridge.commit();
  committed = true;
  return ok(installation);
}

// src/web.ts
var DIRECT_BROWSER_BRIDGE_SCHEMA2 = DIRECT_BROWSER_BRIDGE_SCHEMA;
var installDirectBrowserBridge2 = (options) => installDirectBrowserBridge(options);
var installDirectFetchFirewall2 = (options) => installDirectFetchFirewall(options);
export {
  installDirectFetchFirewall2 as installDirectFetchFirewall,
  installDirectBrowserBridge2 as installDirectBrowserBridge,
  installDirectBrowser,
  DIRECT_BROWSER_BRIDGE_SCHEMA2 as DIRECT_BROWSER_BRIDGE_SCHEMA
};
