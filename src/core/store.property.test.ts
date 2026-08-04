import { expect, test } from "bun:test";
import { assertProperty, fc } from "./test-support.js";
import { operationId } from "./ids.js";
import { createDirectStore } from "./store.js";
import { parseTestWorld } from "./test-support.js";

test("property: every reset invalidates every prior generation transaction", () => {
  assertProperty(fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 30 }), (counts) => {
    const created = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    const store = created.value;
    for (const [index, count] of counts.entries()) {
      const stale = store.getSnapshot().generation;
      expect(store.reset({ count, messages: [] }).ok).toBe(true);
      const attempted = store.transact(stale, operationId(`stale-${String(index + 1).padStart(6, "0")}`), (draft) => {
        draft.count += 1;
      });
      expect(attempted).toMatchObject({ ok: false, error: { code: "stale-generation" } });
      expect(store.getSnapshot().world.count).toBe(count);
    }
  }));
});

test("property: reset fences every active lease without leaking activity into the new generation", () => {
  assertProperty(fc.property(fc.integer({ min: 1, max: 30 }), fc.integer(), (activityCount, resetCount) => {
    const created = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    const store = created.value;
    const oldGeneration = store.getSnapshot().generation;
    const leases = Array.from({ length: activityCount }, (_, index) => store.beginActivity(
      oldGeneration,
      operationId(`activity-${String(index + 1).padStart(6, "0")}`),
    ));
    expect(leases.every((lease) => lease.ok)).toBe(true);
    expect(store.getSnapshot().activity.active).toBe(activityCount);
    expect(store.reset({ count: resetCount, messages: [] }).ok).toBe(true);
    for (const lease of leases) {
      if (lease.ok) {
        expect(lease.value.settle()).toMatchObject({ ok: false, error: { code: "stale-generation" } });
      }
    }
    expect(store.getSnapshot().activity).toEqual({ active: 0, started: 0, settled: 0 });
    expect(store.getSnapshot().world.count).toBe(resetCount);
  }));
});

test("property: primitive replacement sequences preserve immutable structural sharing", () => {
  assertProperty(fc.property(
    fc.array(fc.integer(), { minLength: 1, maxLength: 40 }),
    (counts) => {
      const created = createDirectStore(
        { count: 0, messages: ["stable"] },
        parseTestWorld,
        { validateReplacements: () => undefined },
      );
      if (!created.ok) throw new Error(created.error.message);
      const store = created.value;
      for (const [index, count] of counts.entries()) {
        const before = store.getSnapshot();
        const result = store.transactReplacements(
          before.generation,
          operationId(`replace-${String(index + 1).padStart(6, "0")}`),
          [{
            expected: before.world.count,
            path: ["count"],
            value: count,
          }],
        );
        expect(result).toMatchObject({ ok: true, value: { world: { count } } });
        if (!result.ok) throw new Error(result.error.message);
        expect(result.value.world.messages).toBe(before.world.messages);
        expect(Object.isFrozen(result.value.world)).toBe(true);
        expect(Object.isFrozen(result.value.world.messages)).toBe(true);
      }
    },
  ));
});

test("property: incorrect expected leaves never publish or reach the domain validator", () => {
  assertProperty(fc.property(
    fc.integer(),
    fc.integer().filter(value => value !== 0),
    (value, wrongExpected) => {
      let validationCalls = 0;
      const created = createDirectStore(
        { count: 0, messages: [] },
        parseTestWorld,
        { validateReplacements: () => { validationCalls += 1; } },
      );
      if (!created.ok) throw new Error(created.error.message);
      const before = created.value.getSnapshot();
      expect(created.value.transactReplacements(
        before.generation,
        operationId("wrong-expected-000001"),
        [{ expected: wrongExpected, path: ["count"], value }],
      )).toMatchObject({ ok: false, error: { code: "invalid-world" } });
      expect(created.value.getSnapshot()).toBe(before);
      expect(validationCalls).toBe(0);
    },
  ));
});
