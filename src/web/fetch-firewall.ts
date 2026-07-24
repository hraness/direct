export interface DirectFetchFirewallOptions {
  readonly allow?: (url: URL) => boolean;
  readonly beginActivity?: (url: URL | null) => () => void;
  readonly onBlocked?: (url: URL | null) => void;
  readonly originalFetch?: FetchCall;
}

type FetchCall = (...arguments_: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

export type DirectFetchFirewallUninstall = () => undefined;

export interface PreparedDirectFetchFirewallInstallation {
  readonly commit: () => undefined;
  readonly rollback: () => undefined;
  readonly uninstall: DirectFetchFirewallUninstall;
}

interface ActiveFetchFirewallInstallation {
  readonly guardedFetch: typeof fetch;
  readonly restoreFetch: typeof fetch;
  readonly deactivate: DirectFetchFirewallUninstall;
  readonly uninstall: DirectFetchFirewallUninstall;
}

interface ActivityBoundary {
  readonly valid: boolean;
  readonly release: () => undefined;
}

let activeFirewallInstallation: ActiveFetchFirewallInstallation | null = null;

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
    // Promise assimilation is foreign code. Treat it as contained and invalid.
  }
  return true;
}

function requestUrl(input: unknown): URL | null {
  try {
    if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url);
    const browserGlobal = globalThis as typeof globalThis & { readonly location?: { readonly origin?: string } };
    const locationOrigin = browserGlobal.location?.origin;
    const base = locationOrigin === undefined || locationOrigin === "null"
      ? "http://direct.invalid"
      : locationOrigin;
    return new URL(String(input), base);
  } catch {
    return null;
  }
}

function blockedResponse(): Response {
  return new Response(
    JSON.stringify({ error: "Direct blocked an unmapped network request." }),
    { status: 501, headers: { "content-type": "application/json" } },
  );
}

function beginBoundary(
  beginActivity: ((url: URL | null) => () => void) | undefined,
  url: URL | null,
): ActivityBoundary {
  if (beginActivity === undefined) {
    return { valid: true, release: () => undefined };
  }
  let candidate: unknown;
  try {
    candidate = beginActivity(url);
  } catch {
    return { valid: false, release: () => undefined };
  }
  if (containPromiseLike(candidate) || typeof candidate !== "function") {
    return { valid: false, release: () => undefined };
  }
  let active = true;
  return {
    valid: true,
    release: (): undefined => {
      if (!active) return undefined;
      active = false;
      try {
        const returned: unknown = Reflect.apply(candidate, undefined, []);
        containPromiseLike(returned);
      } catch {
        // Activity cleanup cannot turn a blocked request into an unhandled failure.
      }
      return undefined;
    },
  };
}

function explicitlyAllowed(
  allow: ((url: URL) => boolean) | undefined,
  url: URL | null,
): boolean {
  if (allow === undefined || url === null) return false;
  try {
    const returned: unknown = allow(url);
    if (containPromiseLike(returned)) return false;
    return returned === true;
  } catch {
    return false;
  }
}

function notifyBlocked(
  onBlocked: ((url: URL | null) => void) | undefined,
  url: URL | null,
): void {
  if (onBlocked === undefined) return;
  try {
    const returned: unknown = onBlocked(url);
    containPromiseLike(returned);
  } catch {
    // Reporting is observational and cannot bypass or reject the firewall.
  }
}

/** Prepare a reversible replacement without deactivating the current owner. */
export function prepareDirectFetchFirewallInstallation(
  options: DirectFetchFirewallOptions = {},
): PreparedDirectFetchFirewallInstallation {
  const previousInstallation = activeFirewallInstallation;
  const currentFetch = globalThis.fetch;
  const previousOwnsCurrent = previousInstallation?.guardedFetch === currentFetch;
  const restoreFetch = previousOwnsCurrent
    ? previousInstallation.restoreFetch
    : currentFetch;

  // Capture every foreign option before mutating the global. A throwing getter
  // therefore leaves an already-installed firewall intact.
  const allow = options.allow;
  const beginActivity = options.beginActivity;
  const onBlocked = options.onBlocked;
  const originalFetch: FetchCall = options.originalFetch ?? restoreFetch;
  if (typeof originalFetch !== "function") {
    throw new TypeError("Direct fetch firewall requires a callable fetch implementation");
  }

  const guardedCall: FetchCall = async (input, init) => {
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

  const previousPreconnect: unknown = Reflect.get(restoreFetch, "preconnect");
  if (typeof previousPreconnect === "function") {
    Object.defineProperty(guardedCall, "preconnect", {
      configurable: true,
      value: (...arguments_: unknown[]): undefined => {
        const url = requestUrl(arguments_[0]);
        const activity = beginBoundary(beginActivity, url);
        try {
          if (activity.valid && explicitlyAllowed(allow, url)) {
            const returned: unknown = Reflect.apply(previousPreconnect, restoreFetch, arguments_);
            containPromiseLike(returned);
          } else {
            notifyBlocked(onBlocked, url);
          }
        } finally {
          activity.release();
        }
        return undefined;
      },
    });
  }

  const guardedFetch = guardedCall as typeof fetch;
  try {
    globalThis.fetch = guardedFetch;
    if (globalThis.fetch !== guardedFetch) {
      throw new TypeError("Direct fetch firewall could not replace global fetch");
    }
  } catch (reason) {
    try {
      if (globalThis.fetch === guardedFetch) globalThis.fetch = currentFetch;
    } catch {
      // Best-effort rollback on a hostile global; the original error is more useful.
    }
    throw reason;
  }

  let state: "prepared" | "committed" | "closed" = "prepared";
  const rollback = (): undefined => {
    if (state !== "prepared") return undefined;
    if (globalThis.fetch === guardedFetch) globalThis.fetch = currentFetch;
    state = "closed";
    return undefined;
  };
  const deactivate = (): undefined => {
    if (state !== "committed") return undefined;
    state = "closed";
    if (activeFirewallInstallation === installation) activeFirewallInstallation = null;
    return undefined;
  };
  const uninstall = (): undefined => {
    if (state === "prepared") return rollback();
    if (state !== "committed") return undefined;
    if (globalThis.fetch === guardedFetch) globalThis.fetch = restoreFetch;
    state = "closed";
    if (activeFirewallInstallation === installation) activeFirewallInstallation = null;
    return undefined;
  };
  const installation: ActiveFetchFirewallInstallation = {
    guardedFetch,
    restoreFetch,
    deactivate,
    uninstall,
  };
  const commit = (): undefined => {
    if (state !== "prepared") return undefined;
    state = "committed";
    if (previousInstallation !== null) previousInstallation.deactivate();
    activeFirewallInstallation = installation;
    return undefined;
  };

  return Object.freeze({
    commit,
    rollback,
    uninstall,
  });
}

/** Install one process-local, fail-closed fetch boundary for a browser Direct frame. */
export function installDirectFetchFirewall(
  options: DirectFetchFirewallOptions = {},
): DirectFetchFirewallUninstall {
  const prepared = prepareDirectFetchFirewallInstallation(options);
  prepared.commit();
  return prepared.uninstall;
}
