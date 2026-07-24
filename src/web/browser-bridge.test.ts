import { describe, expect, test } from "bun:test";

import {
  DIRECT_COVERAGE_SCHEMA,
  createCoverageCatalog,
  createCoverageCatalogSnapshot,
} from "../core/coverage.js";
import { createDirectStore } from "../core/store.js";
import { parseTestWorld } from "../core/test-support.js";
import { createDirectProbe } from "../testing/probe.js";
import {
  DIRECT_BROWSER_BRIDGE_SCHEMA,
  installDirectBrowserBridge,
  type DirectBrowserBridge,
} from "./browser-bridge.js";

function probeFixture() {
  const store = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
  if (!store.ok) throw new Error(store.error.message);
  const probe = createDirectProbe({
    store: store.value,
    activationHash: "bridge-hash",
    pending: [{ name: "requests", read: () => 0 }],
  });
  if (!probe.ok) throw new Error(probe.error.message);
  return probe.value;
}

function coverageFixture() {
  const catalog = createCoverageCatalog([{
    key: "surface.ready",
    mode: "fixture",
    claim: "The ready surface renders",
    scenarios: ["surface.ready"],
  }]);
  if (!catalog.ok) throw new Error(catalog.error.message);
  return createCoverageCatalogSnapshot(catalog.value);
}

function hostileThrownValue(): Error {
  return new Proxy(new Error("hostile"), {
    get: () => {
      throw new Error("hostile message getter");
    },
    getPrototypeOf: () => {
      throw new Error("hostile prototype");
    },
  });
}

describe("Direct browser bridge", () => {
  test("exposes one canonical global, then restores prior ownership idempotently", () => {
    const originalBridge = { original: true };
    const target: Record<string, unknown> = {
      __direct: originalBridge,
    };
    let resets = 0;
    const installed = installDirectBrowserBridge({
      target,
      probe: probeFixture(),
      coverage: coverageFixture(),
      reset: () => {
        resets += 1;
        return undefined;
      },
    });
    if (!installed.ok) throw new Error(installed.error.message);

    const bridge = target.__direct as DirectBrowserBridge;
    expect(bridge.schema).toBe(DIRECT_BROWSER_BRIDGE_SCHEMA);
    expect(bridge.snapshot()).toMatchObject({
      schema: "direct.probe/v1",
      activationHash: "bridge-hash",
      isQuiescent: true,
    });
    expect(bridge.coverage).toEqual(coverageFixture());
    expect(bridge.coverage).toEqual({
      schema: DIRECT_COVERAGE_SCHEMA,
      entries: [expect.objectContaining({ key: "surface.ready", mode: "fixture" })],
    });
    bridge.reset();
    expect(resets).toBe(1);

    installed.value();
    installed.value();
    expect(target.__direct).toBe(originalBridge);
  });

  test("a later install safely replaces the earlier install across targets", () => {
    const firstTarget: Record<string, unknown> = {};
    const secondTarget: Record<string, unknown> = {};
    const first = installDirectBrowserBridge({ target: firstTarget, probe: probeFixture() });
    if (!first.ok) throw new Error(first.error.message);
    const firstBridge = firstTarget.__direct;
    const second = installDirectBrowserBridge({ target: secondTarget, probe: probeFixture() });
    if (!second.ok) throw new Error(second.error.message);

    expect("__direct" in firstTarget).toBe(false);
    expect(secondTarget.__direct).not.toBe(firstBridge);
    first.value();
    expect("__direct" in secondTarget).toBe(true);
    second.value();
    expect("__direct" in secondTarget).toBe(false);
  });

  test("uninstall does not overwrite a newer external owner", () => {
    const target: Record<string, unknown> = {};
    const installed = installDirectBrowserBridge({ target, probe: probeFixture() });
    if (!installed.ok) throw new Error(installed.error.message);
    const external = { external: true };
    target.__direct = external;
    installed.value();
    expect(target.__direct).toBe(external);
  });

  test("rejects malformed or semantically invalid coverage without mutating the target", () => {
    const target: Record<string, unknown> = {};
    expect(installDirectBrowserBridge({
      target,
      probe: probeFixture(),
      coverage: { invalid: undefined },
    })).toMatchObject({ ok: false, error: { code: "invalid-coverage" } });
    expect(installDirectBrowserBridge({
      target,
      probe: probeFixture(),
      coverage: {
        schema: DIRECT_COVERAGE_SCHEMA,
        entries: [{ key: "surface.ready", mode: "fixture" }],
      },
    })).toMatchObject({ ok: false, error: { code: "invalid-coverage" } });
    expect(target).toEqual({});
  });

  test("a failed replacement leaves the active bridge installed", () => {
    const backing: Record<string, unknown> = {};
    let definitionsBeforeFailure = Number.POSITIVE_INFINITY;
    const target = new Proxy(backing, {
      defineProperty: (current, key, descriptor) => {
        if (definitionsBeforeFailure === 0) {
          definitionsBeforeFailure = Number.POSITIVE_INFINITY;
          throw new Error("replacement rejected");
        }
        definitionsBeforeFailure -= 1;
        return Reflect.defineProperty(current, key, descriptor);
      },
    });
    const first = installDirectBrowserBridge({ target, probe: probeFixture() });
    if (!first.ok) throw new Error(first.error.message);
    const firstBridge = target.__direct;
    definitionsBeforeFailure = 0;

    expect(installDirectBrowserBridge({
      target,
      probe: probeFixture(),
    })).toMatchObject({ ok: false, error: { code: "install-failed" } });
    expect(target.__direct).toBe(firstBridge);
    expect((target.__direct as DirectBrowserBridge).snapshot()).toMatchObject({
      activationHash: "bridge-hash",
    });
    first.value();
    expect(backing).toEqual({});
  });

  test("wraps hostile probe failures in controlled errors", () => {
    const hostile = hostileThrownValue();
    const hostileProbeTarget: Record<string, unknown> = {};
    const hostileProbe = installDirectBrowserBridge({
      target: hostileProbeTarget,
      probe: {
        snapshot: () => {
          throw hostile;
        },
      },
    });
    if (!hostileProbe.ok) throw new Error(hostileProbe.error.message);
    expect(() => (hostileProbeTarget.__direct as DirectBrowserBridge).snapshot()).toThrow(
      "Direct probe failed: Unknown failure",
    );
    hostileProbe.value();
  });

  test("validates successful foreign probe results before exposing them", () => {
    const target: Record<string, unknown> = {};
    const forgedProbe = { snapshot: probeFixture().snapshot };
    Object.defineProperty(forgedProbe, "snapshot", {
      value: () => ({
        ok: true,
        value: {
          schema: "direct.probe/v1",
          activationHash: "forged",
          generation: 1,
          revision: 0,
          activity: { active: 1, started: 0, settled: 0 },
          pending: {},
          violations: {},
          remainingWork: null,
          isQuiescent: true,
        },
      }),
    });
    const installed = installDirectBrowserBridge({
      target,
      probe: forgedProbe,
    });
    if (!installed.ok) throw new Error(installed.error.message);

    expect(() => (target.__direct as DirectBrowserBridge).snapshot()).toThrow(
      "activity counters must be non-negative and conserve started work",
    );
    installed.value();
  });

  test("rejects and contains asynchronous reset and probe callback returns", async () => {
    const resetTarget: Record<string, unknown> = {};
    const resetOptions = {
      target: resetTarget,
      probe: probeFixture(),
      reset: () => undefined,
    };
    Object.defineProperty(resetOptions, "reset", {
      value: () => Promise.reject(new Error("reset rejected")),
    });
    const reset = installDirectBrowserBridge(resetOptions);
    if (!reset.ok) throw new Error(reset.error.message);
    expect(() => (resetTarget.__direct as DirectBrowserBridge).reset()).toThrow(
      "Direct reset failed: Direct reset must complete synchronously and return undefined",
    );
    await Promise.resolve();
    reset.value();

    const probeTarget: Record<string, unknown> = {};
    const probe = { snapshot: probeFixture().snapshot };
    Object.defineProperty(probe, "snapshot", {
      value: () => Promise.reject(new Error("probe rejected")),
    });
    const asynchronousProbe = installDirectBrowserBridge({
      target: probeTarget,
      probe,
    });
    if (!asynchronousProbe.ok) throw new Error(asynchronousProbe.error.message);
    expect(() => (probeTarget.__direct as DirectBrowserBridge).snapshot()).toThrow(
      "must complete synchronously",
    );
    await Promise.resolve();
    asynchronousProbe.value();
  });

  test("returns install failure when a hostile target rejects property definition", () => {
    const hostile = hostileThrownValue();
    const target = new Proxy({}, {
      defineProperty: () => {
        throw hostile;
      },
    });
    expect(installDirectBrowserBridge({ target, probe: probeFixture() })).toEqual({
      ok: false,
      error: { code: "install-failed", message: "Direct browser bridge installation failed" },
    });
  });
});
