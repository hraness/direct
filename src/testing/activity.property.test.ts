import { expect, test } from "bun:test";
import { assertAsyncProperty, assertProperty, fc } from "../core/test-support.js";

import { createLogicalRuntime } from "../core/runtime.js";
import { createDirectStore } from "../core/store.js";
import { parseTestWorld } from "../core/test-support.js";
import { createDirectActivityScope } from "./activity.js";

test("property: arbitrary repeated releases conserve activity accounting", () => {
  assertProperty(fc.property(
    fc.array(fc.integer({ min: 1, max: 8 }), { maxLength: 50 }),
    (releaseCounts) => {
      const store = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
      if (!store.ok) throw new Error(store.error.message);
      const scope = createDirectActivityScope(
        store.value,
        createLogicalRuntime(undefined, () => Promise.resolve()),
      );
      for (const count of releaseCounts) {
        const lease = scope.begin("property");
        if (!lease.ok) throw new Error(lease.error.message);
        for (let index = 0; index < count; index += 1) lease.value.release();
      }
      expect(store.value.getSnapshot().activity).toEqual({
        active: 0,
        started: releaseCounts.length,
        settled: releaseCounts.length,
      });
    },
  ));
});

test("property: arbitrary error messages remain Result failures", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.string(),
    async (message) => {
      const reason = new Error(message);
      const store = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
      if (!store.ok) throw new Error(store.error.message);
      const scope = createDirectActivityScope(
        store.value,
        createLogicalRuntime(undefined, () => Promise.resolve()),
      );
      const result = await scope.run("rejection", () => Promise.reject(reason));
      expect(result).toMatchObject({ ok: false, error: { code: "work-failed", workError: reason } });
      expect(store.value.getSnapshot().activity).toEqual({ active: 0, started: 1, settled: 1 });
    },
  ));
});
