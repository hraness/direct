import { afterEach, describe, expect, test } from "bun:test";

import { defineDirect } from "../core/definition.js";
import { parseTestWorld } from "../core/test-support.js";
import { createDirectSession } from "../testing/session.js";
import type { DirectBrowserBridge } from "./browser-bridge.js";
import { installDirectBrowser } from "./browser.js";

const hostFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = hostFetch;
});

function sessionFixture() {
  const definition = defineDirect({
    parseWorld: parseTestWorld,
    defaultScenario: "chat.empty",
    scenarios: [{
      id: "chat.empty",
      title: "Empty chat",
      route: "/chat",
      world: { count: 0, messages: [] },
    }],
    coverage: [{
      key: "chat.empty",
      mode: "fixture",
      claim: "The empty chat state renders",
      scenarios: ["chat.empty"],
    }],
  });
  const session = createDirectSession({
    definition,
    activation: { kind: "scenario", scenario: "chat.empty" },
    create: () => ({ kind: "chat-harness" as const }),
  });
  if (!session.ok) throw new Error(session.error.message);
  return session.value;
}

describe("Direct browser installation", () => {
  test("publishes one session and tears down bridge and firewall with session disposal", async () => {
    const target: Record<string, unknown> = {};
    const session = sessionFixture();
    let blocked = 0;
    const installed = installDirectBrowser({
      session,
      target,
      firewall: { onBlocked: () => { blocked += 1; } },
    });
    if (!installed.ok) throw new Error(installed.error.message);

    const bridge = target.__direct as DirectBrowserBridge;
    expect(bridge.manifest).toEqual(session.manifest);
    expect(bridge.manifest.coverage).toEqual(session.coverage);
    expect(bridge.snapshot()).toMatchObject({
      activationHash: session.activation.activationHash,
      isQuiescent: true,
    });
    expect((await fetch("https://example.com/unmapped")).status).toBe(501);
    expect(blocked).toBe(1);
    expect(bridge.snapshot()).toMatchObject({
      activity: { active: 0, started: 1, settled: 1 },
      isQuiescent: true,
    });

    session.dispose();
    expect(installed.value.isDisposed()).toBeTrue();
    expect(installed.value.disposalErrors()).toEqual([]);
    expect("__direct" in target).toBeFalse();
    expect(globalThis.fetch).toBe(hostFetch);
  });

  test("allows only explicit mappings while accounting for their activity", async () => {
    const target: Record<string, unknown> = {};
    const session = sessionFixture();
    let calls = 0;
    const originalFetch: typeof fetch = Object.assign(
      () => {
        calls += 1;
        return Promise.resolve(new Response("fixture"));
      },
      { preconnect: hostFetch.preconnect },
    );
    const installed = installDirectBrowser({
      session,
      target,
      firewall: {
        allow: (url) => url.protocol === "data:",
        originalFetch,
      },
    });
    if (!installed.ok) throw new Error(installed.error.message);

    expect(await (await fetch("data:text/plain,ready")).text()).toBe("fixture");
    expect((await fetch("https://example.com")).status).toBe(501);
    expect(calls).toBe(1);
    expect((target.__direct as DirectBrowserBridge).snapshot()).toMatchObject({
      activity: { active: 0, started: 2, settled: 2 },
    });
    session.dispose();
  });

  test("rolls back the firewall when bridge installation fails", () => {
    const session = sessionFixture();
    const target = new Proxy({}, {
      defineProperty: () => {
        throw new Error("target rejected bridge");
      },
    });
    const installed = installDirectBrowser({ session, target });
    expect(installed).toMatchObject({
      ok: false,
      error: { code: "bridge-install-failed", rollbackErrors: [] },
    });
    expect(globalThis.fetch).toBe(hostFetch);
    expect(session.isDisposed()).toBeFalse();
    session.dispose();
  });

  test("rolls back a successful install when its session is already disposed", () => {
    const target: Record<string, unknown> = {};
    const session = sessionFixture();
    session.dispose();
    const installed = installDirectBrowser({ session, target });
    expect(installed).toMatchObject({
      ok: false,
      error: {
        code: "session-registration-failed",
        registrationError: { code: "session-disposed" },
        rollbackErrors: [],
      },
    });
    expect("__direct" in target).toBeFalse();
    expect(globalThis.fetch).toBe(hostFetch);
  });

  test("a failed replacement restores the prior live installation and its cleanup authority", () => {
    const target: Record<string, unknown> = {};
    const firstSession = sessionFixture();
    const first = installDirectBrowser({ session: firstSession, target });
    if (!first.ok) throw new Error(first.error.message);
    const firstBridge = target.__direct;
    const firstFetch = globalThis.fetch;

    const disposedSession = sessionFixture();
    disposedSession.dispose();
    const replacement = installDirectBrowser({ session: disposedSession, target });
    expect(replacement).toMatchObject({
      ok: false,
      error: { code: "session-registration-failed", rollbackErrors: [] },
    });
    expect(target.__direct).toBe(firstBridge);
    expect(globalThis.fetch).toBe(firstFetch);
    expect(first.value.isDisposed()).toBeFalse();

    firstSession.dispose();
    expect(first.value.isDisposed()).toBeTrue();
    expect("__direct" in target).toBeFalse();
    expect(globalThis.fetch).toBe(hostFetch);
  });

  test("supports an explicit bridge-only composition", () => {
    const target: Record<string, unknown> = {};
    const session = sessionFixture();
    const installed = installDirectBrowser({ session, target, firewall: false });
    if (!installed.ok) throw new Error(installed.error.message);
    expect(target.__direct).toBeDefined();
    expect(globalThis.fetch).toBe(hostFetch);
    session.dispose();
  });

  test("contains hostile option access before mutating browser state", () => {
    const options = new Proxy({}, {
      get: () => {
        throw new Error("browser option getter failed");
      },
    });
    expect(installDirectBrowser(options as never)).toMatchObject({
      ok: false,
      error: { code: "invalid-options", message: "browser option getter failed" },
    });
    expect(globalThis.fetch).toBe(hostFetch);
  });

  test("contains hostile session access and registration while restoring browser ownership", () => {
    const session = sessionFixture();
    const unreadable = new Proxy(session, {
      get: (target, key, receiver) => {
        if (key === "probe") throw new Error("probe getter failed");
        const value: unknown = Reflect.get(target, key, receiver);
        return value;
      },
    });
    expect(installDirectBrowser({ session: unreadable })).toMatchObject({
      ok: false,
      error: { code: "invalid-options", message: "probe getter failed" },
    });

    const target: Record<string, unknown> = {};
    const rejectingRegistration = {
      ...session,
      onDispose: () => { throw new Error("cleanup registration failed"); },
    };
    expect(installDirectBrowser({ session: rejectingRegistration, target })).toMatchObject({
      ok: false,
      error: { code: "session-registration-threw", message: "cleanup registration failed" },
    });
    expect("__direct" in target).toBeFalse();
    expect(globalThis.fetch).toBe(hostFetch);

    const hostileRegistrationResult = {
      ...session,
      onDispose: () => new Proxy({}, {
        get: () => {
          throw new Error("cleanup registration result failed");
        },
      }),
    };
    expect(installDirectBrowser({
      session: hostileRegistrationResult as never,
      target,
    })).toMatchObject({
      ok: false,
      error: { code: "session-registration-threw", message: "cleanup registration result failed" },
    });
    expect("__direct" in target).toBeFalse();
    expect(globalThis.fetch).toBe(hostFetch);
    session.dispose();
  });
});
