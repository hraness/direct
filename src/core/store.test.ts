import { expect, test } from "bun:test";
import { createDirectStore } from "./store.js";
import { operationId } from "./ids.js";
import { parseTestWorld, type TestWorld } from "./test-support.js";

function makeStore() {
  const created = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  return created.value;
}

test("transactions commit a validated clone once and failures stay atomic", () => {
  const store = makeStore();
  const initial = store.getSnapshot();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  const committed = store.transact(initial.generation, operationId("increment-000001"), (draft) => {
    draft.count += 1;
    draft.messages.push("committed");
  });
  expect(committed).toMatchObject({ ok: true, value: { world: { count: 1, messages: ["committed"] } } });
  expect(notifications).toBe(1);

  const beforeFailure = store.getSnapshot();
  const failed = store.transact(initial.generation, operationId("increment-000002"), (draft) => {
    draft.count = Number.NaN;
  });
  expect(failed).toMatchObject({ ok: false, error: { code: "invalid-world" } });
  expect(store.getSnapshot()).toBe(beforeFailure);
  expect(notifications).toBe(1);
  unsubscribe();
});

test("reset fences old activity leases and quiescence waiters", async () => {
  const store = makeStore();
  const oldGeneration = store.getSnapshot().generation;
  const lease = store.beginActivity(oldGeneration, operationId("stream-000001"));
  if (!lease.ok) {
    throw new Error(lease.error.message);
  }
  const waiting = store.whenQuiescent(oldGeneration);
  const reset = store.reset({ count: 9, messages: ["reset"] });
  expect(reset).toMatchObject({ ok: true, value: { activity: { active: 0, started: 0, settled: 0 } } });
  expect(lease.value.settle()).toMatchObject({ ok: false, error: { code: "stale-generation" } });
  expect(await waiting).toMatchObject({ ok: false, error: { code: "stale-generation" } });
});

test("quiescence resolves after the final current-generation activity settles", async () => {
  const store = makeStore();
  const current = store.getSnapshot().generation;
  const first = store.beginActivity(current, operationId("task-000001"));
  const second = store.beginActivity(current, operationId("task-000002"));
  if (!first.ok || !second.ok) {
    throw new Error("activities must start");
  }
  const waiting = store.whenQuiescent(current);
  expect(first.value.settle().ok).toBe(true);
  expect(store.isQuiescent(current)).toEqual({ ok: true, value: false });
  expect(second.value.settle().ok).toBe(true);
  expect(await waiting).toMatchObject({ ok: true, value: { activity: { active: 0, started: 2, settled: 2 } } });
});

test("throwing subscribers cannot corrupt mutation results or starve later listeners", () => {
  const listenerErrors: unknown[] = [];
  const created = createDirectStore(
    { count: 0, messages: [] },
    parseTestWorld,
    { onListenerError: (reason) => listenerErrors.push(reason) },
  );
  if (!created.ok) throw new Error(created.error.message);
  const store = created.value;
  let healthyNotifications = 0;
  store.subscribe(() => { throw new Error("broken listener"); });
  store.subscribe(() => { healthyNotifications += 1; });

  const result = store.transact(
    store.getSnapshot().generation,
    operationId("subscriber-000001"),
    (draft) => { draft.count = 7; },
  );

  expect(result).toMatchObject({ ok: true, value: { revision: 1, world: { count: 7 } } });
  expect(store.getSnapshot().world.count).toBe(7);
  expect(healthyNotifications).toBe(1);
  expect(listenerErrors).toHaveLength(1);
  expect(listenerErrors[0]).toEqual(new Error("broken listener"));
});

test("a reset inside an updater fences the stale transaction before it can publish", () => {
  const store = makeStore();
  const initial = store.getSnapshot();

  const result = store.transact(initial.generation, operationId("outer-000001"), (draft) => {
    expect(store.reset({ count: 100, messages: ["reset"] }).ok).toBe(true);
    draft.count = 1;
  });

  expect(result).toMatchObject({ ok: false, error: { code: "stale-generation" } });
  expect(store.getSnapshot()).toMatchObject({
    generation: Number(initial.generation) + 1,
    revision: 1,
    world: { count: 100, messages: ["reset"] },
  });
});

test("a nested same-generation commit makes the outer transaction conflict", () => {
  const store = makeStore();
  const initial = store.getSnapshot();

  const outer = store.transact(initial.generation, operationId("outer-000001"), (draft) => {
    const inner = store.transact(initial.generation, operationId("inner-000001"), (innerDraft) => {
      innerDraft.count = 2;
    });
    expect(inner).toMatchObject({ ok: true, value: { revision: 1 } });
    draft.count = 1;
  });

  expect(outer).toMatchObject({ ok: false, error: { code: "transaction-conflict" } });
  expect(store.getSnapshot()).toMatchObject({ revision: 1, world: { count: 2 } });
});

test("reentrant subscribers do not replace the snapshot returned by the commit", () => {
  const store = makeStore();
  const initial = store.getSnapshot();
  let resetOnce = true;
  store.subscribe(() => {
    if (!resetOnce) return;
    resetOnce = false;
    expect(store.reset({ count: 99, messages: ["listener reset"] }).ok).toBe(true);
  });

  const committed = store.transact(initial.generation, operationId("outer-000001"), (draft) => {
    draft.count = 1;
  });

  expect(committed).toMatchObject({
    ok: true,
    value: { generation: initial.generation, revision: 1, world: { count: 1 } },
  });
  expect(store.getSnapshot()).toMatchObject({
    generation: Number(initial.generation) + 1,
    revision: 2,
    world: { count: 99, messages: ["listener reset"] },
  });
});

test("transaction drafts never alias values returned by a world parser", () => {
  const shared: TestWorld = { count: 0, messages: [] };
  const parseSharedWorld = (input: unknown): TestWorld => {
    const parsed = parseTestWorld(input);
    if (!Number.isFinite(parsed.count)) throw new Error("count must be finite");
    return shared;
  };
  const created = createDirectStore(shared, parseSharedWorld);
  if (!created.ok) throw new Error(created.error.message);

  const result = created.value.transact(
    created.value.getSnapshot().generation,
    operationId("alias-000001"),
    (draft) => { draft.count = Number.NaN; },
  );

  expect(result).toMatchObject({ ok: false, error: { code: "invalid-world" } });
  expect(shared.count).toBe(0);
  expect(created.value.getSnapshot().world.count).toBe(0);
});

test("async subscriber failures are reported and option capture cannot be retargeted", async () => {
  const firstErrors: unknown[] = [];
  const secondErrors: unknown[] = [];
  const mutableOptions = {
    onListenerError: (reason: unknown): void => { firstErrors.push(reason); },
  };
  const created = createDirectStore({ count: 0, messages: [] }, parseTestWorld, mutableOptions);
  if (!created.ok) throw new Error(created.error.message);
  mutableOptions.onListenerError = (reason: unknown): void => { secondErrors.push(reason); };
  created.value.subscribe(async () => {
    await Promise.resolve();
    throw new Error("async listener");
  });

  expect(created.value.transact(
    created.value.getSnapshot().generation,
    operationId("subscriber-000002"),
    (draft) => { draft.count = 1; },
  ).ok).toBe(true);
  await Promise.resolve();
  await Promise.resolve();

  expect(firstErrors).toEqual([new Error("async listener")]);
  expect(secondErrors).toEqual([]);
});
