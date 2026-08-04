import { expect, test } from "bun:test";
import { DEFAULT_JSON_LIMITS } from "./json.js";
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

test("primitive replacements copy and freeze only touched ancestors", () => {
  const validationInputs: unknown[] = [];
  let parserCalls = 0;
  const created = createDirectStore(
    { count: 0, messages: ["alpha", "beta"] },
    (input) => {
      parserCalls += 1;
      return parseTestWorld(input);
    },
    {
      validateReplacements: (input) => {
        validationInputs.push(input);
        return undefined;
      },
    },
  );
  if (!created.ok) throw new Error(created.error.message);
  const parserCallsAfterConstruction = parserCalls;
  const store = created.value;
  const initial = store.getSnapshot();
  const replacements = [{ expected: 0, path: ["count"], value: 7 }] as const;

  const result = store.transactReplacements(
    initial.generation,
    operationId("replace-count-000001"),
    replacements,
  );

  expect(result).toMatchObject({ ok: true, value: { world: { count: 7 } } });
  if (!result.ok) throw new Error(result.error.message);
  expect(result.value.world).not.toBe(initial.world);
  expect(result.value.world.messages).toBe(initial.world.messages);
  expect(Object.isFrozen(result.value.world)).toBe(true);
  expect(Object.isFrozen(result.value.world.messages)).toBe(true);
  expect(validationInputs).toHaveLength(1);
  const context = validationInputs[0] as {
    baseWorld: TestWorld;
    candidateWorld: TestWorld;
    replacements: readonly { path: readonly string[] }[];
  };
  expect(Object.isFrozen(context)).toBe(true);
  expect(Object.isFrozen(context.replacements)).toBe(true);
  const firstContextReplacement = context.replacements[0];
  const firstInputReplacement = replacements[0];
  if (firstContextReplacement === undefined || firstInputReplacement === undefined) {
    throw new Error("expected one validated primitive replacement");
  }
  expect(Object.isFrozen(firstContextReplacement)).toBe(true);
  expect(Object.isFrozen(firstContextReplacement.path)).toBe(true);
  expect(context.replacements).not.toBe(replacements);
  expect(firstContextReplacement.path).not.toBe(firstInputReplacement.path);
  expect(context.baseWorld).toBe(initial.world);
  expect(context.candidateWorld).toBe(result.value.world);
  expect(context.candidateWorld).not.toBe(context.baseWorld);
  expect(context.candidateWorld.messages).toBe(context.baseWorld.messages);
  expect(Object.isFrozen(context.candidateWorld)).toBe(true);
  expect(parserCalls).toBe(parserCallsAfterConstruction);
});

test("primitive replacements fail closed before semantic validation", () => {
  let validationCalls = 0;
  const created = createDirectStore(
    { count: 0, messages: ["a"] },
    parseTestWorld,
    { validateReplacements: () => { validationCalls += 1; } },
  );
  if (!created.ok) throw new Error(created.error.message);
  const store = created.value;
  const snapshot = store.getSnapshot();
  const duplicate = [
    { expected: 0, path: ["count"], value: 1 },
    { expected: 0, path: ["count"], value: 2 },
  ];
  const overlap = [
    { expected: null, path: ["messages"], value: null },
    { expected: "a", path: ["messages", 0], value: "a" },
  ];
  const holeyPath = new Array<string | number>(2);
  holeyPath[1] = 0;
  const extraPath = ["count"] as Array<string | number> & { extra?: boolean };
  extraPath.extra = true;
  const accessor = Object.defineProperties({}, {
    expected: { enumerable: true, value: 0 },
    path: { enumerable: true, value: ["count"] },
    value: { enumerable: true, get: () => 1 },
  });
  const withSymbol = {
    expected: 0,
    path: ["count"],
    value: 1,
    [Symbol("extra")]: true,
  };
  const hostile = new Proxy([], {
    ownKeys: () => {
      throw new Error("hostile replacement proxy");
    },
  });
  const oversizedString = "x".repeat(DEFAULT_JSON_LIMITS.maxStringBytes + 1);
  const cases: unknown[] = [
    [],
    Array.from({ length: 33 }, () => ({
      expected: 0,
      path: ["count"],
      value: 1,
    })),
    [{ expected: 0, path: [], value: 1 }],
    [{
      expected: 0,
      path: Array.from({ length: 33 }, () => "count"),
      value: 1,
    }],
    [{
      expected: "a",
      path: ["messages", 0],
      value: oversizedString,
    }],
    [{ expected: 0, path: ["missing"], value: 1 }],
    [{ expected: "a", path: ["messages", 2], value: "a" }],
    [{ expected: 1, path: ["count"], value: 2 }],
    [{ expected: 0, path: ["count"], value: "1" }],
    [{ expected: "a", path: ["messages", 0], value: "alphabet" }],
    [{ expected: -0, path: ["count"], value: 1 }],
    [{ expected: 0, path: ["count"], value: Number.NaN }],
    duplicate,
    overlap,
    [{ expected: "a", path: holeyPath, value: "a" }],
    [{ expected: 0, path: extraPath, value: 1 }],
    [accessor],
    [withSymbol],
    hostile,
  ];

  for (const [index, replacements] of cases.entries()) {
    const result = store.transactReplacements(
      snapshot.generation,
      operationId(`invalid-replace-${String(index).padStart(6, "0")}`),
      replacements as never,
    );
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-world" } });
    expect(store.getSnapshot()).toBe(snapshot);
  }
  expect(validationCalls).toBe(0);
});

test("replacement array bounds are checked before enumeration or length getters", () => {
  let ownKeyCalls = 0;
  let lengthGets = 0;
  const oversized = new Proxy(new Array(33), {
    get: (target, key, receiver) => {
      if (key === "length") lengthGets += 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
    ownKeys: () => {
      ownKeyCalls += 1;
      throw new Error("oversized replacements were enumerated");
    },
  });
  const created = createDirectStore(
    { count: 0, messages: [] },
    parseTestWorld,
    { validateReplacements: () => undefined },
  );
  if (!created.ok) throw new Error(created.error.message);
  const before = created.value.getSnapshot();
  const oversizedResult = created.value.transactReplacements(
    before.generation,
    operationId("oversized-replacement-array"),
    oversized as never,
  );
  expect(oversizedResult).toMatchObject({
    ok: false,
    error: { code: "invalid-world" },
  });
  if (oversizedResult.ok) throw new Error("Oversized replacements must fail.");
  expect(oversizedResult.error.message).toContain("0 through 32");
  expect(created.value.getSnapshot()).toBe(before);
  expect(lengthGets).toBe(0);
  expect(ownKeyCalls).toBe(0);
});

test("the replacement fast path preserves the actual aggregate string-byte boundary", () => {
  const objectKeyBytes = "count".length + "messages".length;
  const largeString = "b".repeat(
    DEFAULT_JSON_LIMITS.maxStringBytes - objectKeyBytes - 1,
  );
  const created = createDirectStore(
    { count: 1, messages: ["a", largeString] },
    parseTestWorld,
    { validateReplacements: () => undefined },
  );
  if (!created.ok) throw new Error(created.error.message);
  const store = created.value;
  const before = store.getSnapshot();

  const numericGrowth = store.transactReplacements(
    before.generation,
    operationId("numeric-json-growth"),
    [{ expected: 1, path: ["count"], value: 100_000 }],
  );
  expect(numericGrowth).toMatchObject({ ok: true });
  if (!numericGrowth.ok) throw new Error(numericGrowth.error.message);
  const escapedGrowth = store.transactReplacements(
    numericGrowth.value.generation,
    operationId("escaped-json-growth"),
    [{
      expected: "a",
      path: ["messages", 0],
      value: "\n",
    }],
  );
  expect(escapedGrowth).toMatchObject({ ok: true });
  if (!escapedGrowth.ok) throw new Error(escapedGrowth.error.message);
  const compensatedGrowth = store.transactReplacements(
    escapedGrowth.value.generation,
    operationId("compensated-string-growth"),
    [
      {
        expected: "\n",
        path: ["messages", 0],
        value: "\n\n",
      },
      {
        expected: largeString,
        path: ["messages", 1],
        value: largeString.slice(1),
      },
    ],
  );
  expect(compensatedGrowth).toMatchObject({ ok: true });
  if (!compensatedGrowth.ok) {
    throw new Error(compensatedGrowth.error.message);
  }
  const beforeRawGrowth = store.getSnapshot();
  const rawGrowth = store.transactReplacements(
    beforeRawGrowth.generation,
    operationId("raw-string-growth"),
    [{
      expected: "\n\n",
      path: ["messages", 0],
      value: "\n\n\n",
    }],
  );
  expect(rawGrowth).toMatchObject({
    ok: false,
    error: { code: "invalid-world" },
  });
  if (rawGrowth.ok) throw new Error("Raw string growth must fail.");
  expect(rawGrowth.error.message).toContain(
    "aggregate raw UTF-8 string bytes",
  );
  expect(store.getSnapshot()).toBe(beforeRawGrowth);
});

test("replacement validation is required, synchronous, captured, and atomic", () => {
  const unconfigured = makeStore();
  expect(unconfigured.transactReplacements(
    unconfigured.getSnapshot().generation,
    operationId("replace-unconfigured-000001"),
    [{ expected: 0, path: ["count"], value: 1 }],
  )).toMatchObject({ ok: false, error: { code: "invalid-world" } });

  let firstCalls = 0;
  let secondCalls = 0;
  const options = {
    validateReplacements: (): undefined => {
      firstCalls += 1;
      return undefined;
    },
  };
  const captured = createDirectStore(
    { count: 0, messages: [] },
    parseTestWorld,
    options,
  );
  if (!captured.ok) throw new Error(captured.error.message);
  options.validateReplacements = () => {
    secondCalls += 1;
    return undefined;
  };
  expect(captured.value.transactReplacements(
    captured.value.getSnapshot().generation,
    operationId("replace-captured-000001"),
    [{ expected: 0, path: ["count"], value: 1 }],
  ).ok).toBe(true);
  expect(firstCalls).toBe(1);
  expect(secondCalls).toBe(0);

  const throwing = createDirectStore(
    { count: 0, messages: [] },
    parseTestWorld,
    { validateReplacements: () => { throw new Error("rejected domain move"); } },
  );
  if (!throwing.ok) throw new Error(throwing.error.message);
  const beforeThrow = throwing.value.getSnapshot();
  expect(throwing.value.transactReplacements(
    beforeThrow.generation,
    operationId("replace-throwing-000001"),
    [{ expected: 0, path: ["count"], value: 1 }],
  )).toMatchObject({ ok: false, error: { code: "invalid-world" } });
  expect(throwing.value.getSnapshot()).toBe(beforeThrow);

  const asynchronous = createDirectStore(
    { count: 0, messages: [] },
    parseTestWorld,
    {
      validateReplacements: (() => Promise.resolve()) as never,
    },
  );
  if (!asynchronous.ok) throw new Error(asynchronous.error.message);
  const beforeAsync = asynchronous.value.getSnapshot();
  expect(asynchronous.value.transactReplacements(
    beforeAsync.generation,
    operationId("replace-async-000001"),
    [{ expected: 0, path: ["count"], value: 1 }],
  )).toMatchObject({ ok: false, error: { code: "invalid-world" } });
  expect(asynchronous.value.getSnapshot()).toBe(beforeAsync);
});

test("a replacement validator reentrant commit fences the outer candidate", () => {
  let store: ReturnType<typeof makeStore> | null = null;
  const created = createDirectStore(
    { count: 0, messages: [] },
    parseTestWorld,
    {
      validateReplacements: ({ generation }) => {
        if (store === null) throw new Error("store unavailable");
        const nested = store.transact(
          generation,
          operationId("replace-nested-000001"),
          draft => { draft.count = 9; },
        );
        if (!nested.ok) throw new Error(nested.error.message);
        return undefined;
      },
    },
  );
  if (!created.ok) throw new Error(created.error.message);
  store = created.value;
  const initial = store.getSnapshot();

  const outer = store.transactReplacements(
    initial.generation,
    operationId("replace-outer-000001"),
    [{ expected: 0, path: ["count"], value: 1 }],
  );

  expect(outer).toMatchObject({
    ok: false,
    error: { code: "transaction-conflict" },
  });
  expect(store.getSnapshot()).toMatchObject({ revision: 1, world: { count: 9 } });
});

test("hostile replacement options fail store construction without throwing", () => {
  const options = Object.defineProperty({}, "validateReplacements", {
    get: () => {
      throw new Error("hostile options getter");
    },
  });
  expect(createDirectStore(
    { count: 0, messages: [] },
    parseTestWorld,
    options,
  )).toMatchObject({ ok: false, error: { code: "invalid-world" } });
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
