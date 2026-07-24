import { describe, expect, test } from "bun:test";

import { mountDeviceStatusDirect } from "./mount";

function requiredMount(source = "") {
  const mounted = mountDeviceStatusDirect(source);
  if (!mounted.ok) throw new Error(mounted.error.message);
  return mounted.value;
}

describe("React Native Direct browser mount", () => {
  test("effect cleanup and replay replace a disposed session with a fresh installation", async () => {
    const originalFetch = globalThis.fetch;
    const browserGlobal = globalThis as typeof globalThis & { readonly __direct?: unknown };

    const first = requiredMount();
    expect(browserGlobal.__direct).toBeDefined();
    first.dispose();
    first.dispose();
    expect(first.session.isDisposed()).toBeTrue();

    const second = requiredMount();
    expect(second.session).not.toBe(first.session);
    expect(second.session.isDisposed()).toBeFalse();
    expect(await second.session.harness.port.inspect()).toEqual({
      platform: "ios",
      colorScheme: "light",
      capturedAt: "2026-01-15T14:30:00.000Z",
    });

    second.dispose();
    expect(second.session.isDisposed()).toBeTrue();
    expect(browserGlobal.__direct).toBeUndefined();
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
