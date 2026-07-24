import { expect, test } from "bun:test";
import { assertProperty, fc } from "../core/test-support.js";

import { createLogicalRuntime } from "../core/runtime.js";
import { createDirectStore } from "../core/store.js";
import { parseTestWorld } from "../core/test-support.js";
import { createDirectActivityScope } from "./activity.js";
import { createDirectProbe, parseDirectProbeSnapshot } from "./probe.js";

test("property: quiescence is exactly zero store activity and zero pending counters", () => {
  assertProperty(fc.property(
    fc.array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 20 }),
    fc.array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 20 }),
    fc.integer({ min: 0, max: 20 }),
    (pending, violations, activeCount) => {
      const store = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
      if (!store.ok) throw new Error(store.error.message);
      const activity = createDirectActivityScope(
        store.value,
        createLogicalRuntime(undefined, () => Promise.resolve()),
      );
      const leases = Array.from({ length: activeCount }, () => {
        const lease = activity.begin("probe-property");
        if (!lease.ok) throw new Error(lease.error.message);
        return lease.value;
      });
      const probe = createDirectProbe({
        store: store.value,
        activationHash: "property-hash",
        pending: pending.map((value, index) => ({ name: `pending${String(index)}`, read: () => value })),
        violations: violations.map((value, index) => ({ name: `violation${String(index)}`, read: () => value })),
        readRemainingWork: () => ({ remaining: pending.length }),
      });
      if (!probe.ok) throw new Error(probe.error.message);
      const snapshot = probe.value.snapshot();
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      expect(snapshot.value.isQuiescent).toBe(
        activeCount === 0 && pending.every((value) => value === 0),
      );
      expect(snapshot.value.activity).toEqual({
        active: activeCount,
        started: activeCount,
        settled: 0,
      });
      expect(JSON.parse(JSON.stringify(snapshot.value))).toEqual(snapshot.value);
      expect(parseDirectProbeSnapshot(JSON.parse(JSON.stringify(snapshot.value)))).toEqual(snapshot);
      for (const lease of leases) expect(lease.release()).toEqual({ ok: true, value: true });
    },
  ));
});

test("property: the probe wire parser is total for arbitrary JavaScript values", () => {
  assertProperty(fc.property(fc.anything(), (candidate) => {
    const parsed = parseDirectProbeSnapshot(candidate);
    expect(typeof parsed.ok).toBe("boolean");
  }));
});

test("property: genuine reset and activity traces always round-trip through the wire parser", () => {
  assertProperty(fc.property(
    fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 25 }),
    (activityCounts) => {
      const store = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
      if (!store.ok) throw new Error(store.error.message);
      const activity = createDirectActivityScope(
        store.value,
        createLogicalRuntime(undefined, () => Promise.resolve()),
      );
      const probe = createDirectProbe({
        store: store.value,
        activationHash: "reset-trace-hash",
      });
      if (!probe.ok) throw new Error(probe.error.message);
      const expectRoundTrip = (): void => {
        const snapshot = probe.value.snapshot();
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        expect(parseDirectProbeSnapshot(JSON.parse(JSON.stringify(snapshot.value)))).toEqual(snapshot);
      };

      expectRoundTrip();
      for (const [index, activityCount] of activityCounts.entries()) {
        const reset = store.value.reset({ count: index + 1, messages: [] });
        if (!reset.ok) throw new Error(reset.error.message);
        expectRoundTrip();

        const leases = Array.from({ length: activityCount }, () => {
          const lease = activity.begin("reset-trace");
          if (!lease.ok) throw new Error(lease.error.message);
          return lease.value;
        });
        expectRoundTrip();
        for (const lease of leases) expect(lease.release()).toEqual({ ok: true, value: true });
        expectRoundTrip();
      }
    },
  ));
});
