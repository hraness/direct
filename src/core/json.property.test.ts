import { expect, test } from "bun:test";
import { assertProperty, fc } from "./test-support.js";
import type { JsonValue } from "./json-value.js";
import {
  canonicalJson,
  cloneJson,
  parseAndCloneWorld,
  parseExactJsonSource,
  parseJsonValue,
  stableHash,
} from "./json.js";

function expectOrdinaryJsonPrototypes(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    expect(Object.getPrototypeOf(value)).toBe(Array.prototype);
    for (const child of value) expectOrdinaryJsonPrototypes(child);
    return;
  }
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  for (const child of Object.values(value)) expectOrdinaryJsonPrototypes(child);
}

test("property: strict JSON parsing is total over arbitrary JavaScript values", () => {
  assertProperty(fc.property(fc.anything({ withBigInt: true, withMap: true, withSet: true }), (value) => {
    expect(() => parseJsonValue(value)).not.toThrow();
    const parsed = parseJsonValue(value);
    expect(typeof parsed.ok).toBe("boolean");
  }));
});

test("hostile inspection failures remain structured JSON boundary errors", () => {
  const hostileReason = new Proxy(new Error("hostile"), {
    get: () => {
      throw new Error("hostile message getter");
    },
    getPrototypeOf: () => {
      throw new Error("hostile prototype");
    },
  });
  const input = new Proxy({}, {
    getPrototypeOf: () => {
      throw hostileReason;
    },
  });
  const expected: ReturnType<typeof cloneJson> = {
    ok: false,
    error: {
      code: "invalid-object",
      path: "$",
      message: "JSON object inspection failed",
    },
  };
  expect(parseJsonValue(input)).toEqual(expected);
  expect(cloneJson(input)).toEqual(expected);
});

test("property: canonical JSON round trips and hashes identically", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    const first = canonicalJson(value);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const roundTripped = JSON.parse(first.value) as unknown;
    expect(canonicalJson(roundTripped)).toEqual(first);
    expect(stableHash(roundTripped)).toEqual(stableHash(value));
  }));
});

test("property: one-pass clones preserve canonical JSON with ordinary prototypes", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    const canonical = canonicalJson(value);
    const cloned = cloneJson(value);
    expect(canonical.ok).toBe(true);
    expect(cloned.ok).toBe(true);
    if (!canonical.ok || !cloned.ok) return;

    expect(cloned.value).toEqual(JSON.parse(canonical.value) as JsonValue);
    expect(canonicalJson(cloned.value)).toEqual(canonical);
    expectOrdinaryJsonPrototypes(cloned.value);
  }));
});

test("clones preserve the legacy JSON normalization of signed zero", () => {
  const parsedNegativeZero = parseJsonValue(-0);
  const clonedNegativeZero = cloneJson(-0);
  const clonedPositiveZero = cloneJson(0);
  const clonedNested = cloneJson({ negative: -0, positive: 0, values: [-0, 0] });

  expect(parsedNegativeZero.ok && Object.is(parsedNegativeZero.value, -0)).toBe(true);
  expect(clonedNegativeZero.ok && Object.is(clonedNegativeZero.value, 0)).toBe(true);
  expect(clonedNegativeZero.ok && Object.is(clonedNegativeZero.value, -0)).toBe(false);
  expect(clonedPositiveZero.ok && Object.is(clonedPositiveZero.value, 0)).toBe(true);
  expect(clonedNested).toEqual({
    ok: true,
    value: { negative: 0, positive: 0, values: [0, 0] },
  });
});

test("property: exact JSON decoding agrees with JSON.parse for generated JSON", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    const source = JSON.stringify(value);
    expect(parseExactJsonSource(source)).toEqual({
      ok: true,
      value: JSON.parse(source) as unknown,
    });
  }));
});

test("property: duplicate object keys are rejected at arbitrary nested decoded-key paths", () => {
  assertProperty(fc.property(fc.string(), fc.integer({ min: 0, max: 40 }), (key, depth) => {
    const encodedKey = JSON.stringify(key);
    let source = `{${encodedKey}:1,${encodedKey}:2}`;
    for (let index = 0; index < depth; index += 1) {
      source = index % 2 === 0 ? `[${source}]` : `{"outer":${source}}`;
    }

    expect(parseExactJsonSource(source)).toMatchObject({
      ok: false,
      error: { code: "duplicate-key" },
    });
  }));
  expect(parseExactJsonSource('{"a":1,"\\u0061":2}')).toMatchObject({
    ok: false,
    error: { code: "duplicate-key", path: "$.a" },
  });
});

test("prototype-shaped keys remain own JSON data and participate in canonical hashes", () => {
  const input = JSON.parse(
    '{"safe":1,"prototype":"data","constructor":{"safe":true},"__proto__":{"polluted":true}}',
  ) as unknown;
  const parsed = parseJsonValue(input);

  expect(parsed.ok).toBe(true);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    throw new Error("expected a parsed JSON object");
  }
  const object = parsed.value as Record<string, unknown>;
  expect(Object.getPrototypeOf(object)).toBeNull();
  expect(Object.hasOwn(object, "__proto__")).toBe(true);
  expect(object["__proto__"]).toEqual({ polluted: true });

  const cloned = cloneJson(input);
  expect(cloned.ok).toBe(true);
  if (!cloned.ok || cloned.value === null || typeof cloned.value !== "object" || Array.isArray(cloned.value)) {
    throw new Error("expected a cloned JSON object");
  }
  const ordinaryObject = cloned.value as Record<string, unknown>;
  expect(Object.getPrototypeOf(ordinaryObject)).toBe(Object.prototype);
  expect(Reflect.ownKeys(ordinaryObject)).toEqual([
    "__proto__",
    "constructor",
    "prototype",
    "safe",
  ]);
  expect(Object.hasOwn(ordinaryObject, "__proto__")).toBe(true);
  expect(ordinaryObject["__proto__"]).toEqual({ polluted: true });
  expect(Object.getOwnPropertyDescriptor(ordinaryObject, "__proto__")).toEqual({
    configurable: true,
    enumerable: true,
    value: { polluted: true },
    writable: true,
  });
  expect(Object.getPrototypeOf(ordinaryObject["__proto__"])).toBe(Object.prototype);
  const unpolluted: Record<string, unknown> = {};
  expect(unpolluted["polluted"]).toBeUndefined();
  expect(canonicalJson(input)).toEqual({
    ok: true,
    value: '{"__proto__":{"polluted":true},"constructor":{"safe":true},"prototype":"data","safe":1}',
  });
  expect(stableHash(input)).not.toEqual(stableHash({ safe: 1 }));
});

test("clones have deterministic Direct operation shape independent of insertion order", () => {
  const first = {
    to: { startStep: 8, pitch: 61, endStep: 12 },
    kind: "move-event",
    from: { pitch: 60, endStep: 8, startStep: 4 },
    address: { trackId: "track-1", eventId: "event-1" },
  };
  const second = {
    address: { eventId: "event-1", trackId: "track-1" },
    from: { endStep: 8, pitch: 60, startStep: 4 },
    kind: "move-event",
    to: { endStep: 12, pitch: 61, startStep: 8 },
  };
  const expected = '{"address":{"eventId":"event-1","trackId":"track-1"},"from":{"endStep":8,"pitch":60,"startStep":4},"kind":"move-event","to":{"endStep":12,"pitch":61,"startStep":8}}';

  for (const operation of [first, second]) {
    const cloned = cloneJson(operation);
    expect(cloned.ok).toBe(true);
    if (cloned.ok) expect(JSON.stringify(cloned.value)).toBe(expected);
  }
});

test("clones break shared aliases without mutating or freezing the source", () => {
  const shared = { messages: ["source"] };
  const input = { left: shared, right: shared };
  const cloned = cloneJson(input);

  expect(cloned.ok).toBe(true);
  if (!cloned.ok || cloned.value === null || typeof cloned.value !== "object" || Array.isArray(cloned.value)) {
    throw new Error("expected a cloned JSON object");
  }
  const output = cloned.value as {
    left: { messages: string[] };
    right: { messages: string[] };
  };
  expect(output.left).not.toBe(shared);
  expect(output.right).not.toBe(shared);
  expect(output.left).not.toBe(output.right);
  expect(output.left.messages).not.toBe(output.right.messages);
  expect(Object.isFrozen(output)).toBe(false);
  expect(Object.isFrozen(shared)).toBe(false);
  shared.messages.push("external mutation");
  expect(output.left.messages).toEqual(["source"]);
  expect(output.right.messages).toEqual(["source"]);
});

test("world parsers cannot leak or freeze caller-owned aliases", () => {
  const shared = { count: 1, messages: ["external"] };
  const parsed = parseAndCloneWorld({ ignored: true }, () => shared);

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.error.message);
  expect(parsed.value).toEqual(shared);
  expect(parsed.value).not.toBe(shared);
  expect(Object.getPrototypeOf(parsed.value)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(parsed.value.messages)).toBe(Array.prototype);
  expect(Object.isFrozen(parsed.value)).toBe(true);
  expect(Object.isFrozen(parsed.value.messages)).toBe(true);
  expect(Object.isFrozen(shared)).toBe(false);
  shared.count = 9;
  expect(parsed.value.count).toBe(1);
});

test("clone validation preserves hostile object, cycle, own-key, and budget guards", () => {
  let getterCalls = 0;
  const accessor: { safe: boolean; unsafe?: string } = { safe: true };
  Object.defineProperty(accessor, "unsafe", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "unsafe";
    },
  });
  expect(cloneJson(accessor)).toMatchObject({
    ok: false,
    error: { code: "accessor-property", path: "$.unsafe" },
  });
  expect(getterCalls).toBe(0);

  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(cloneJson(cyclic)).toMatchObject({
    ok: false,
    error: { code: "cycle", path: "$.self" },
  });

  const hidden = { visible: true };
  Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
  expect(cloneJson(hidden)).toMatchObject({
    ok: false,
    error: { code: "invalid-object", path: "$.hidden" },
  });

  const symbolKey: Record<PropertyKey, unknown> = { visible: true };
  symbolKey[Symbol("hidden")] = true;
  expect(cloneJson(symbolKey)).toMatchObject({
    ok: false,
    error: { code: "symbol-key", path: "$" },
  });

  const customPrototype = Object.assign(Object.create({ inherited: true }) as object, { own: true });
  expect(cloneJson(customPrototype)).toMatchObject({
    ok: false,
    error: { code: "invalid-object", path: "$" },
  });

  const hostileOwnKeys = new Proxy({}, {
    ownKeys: () => {
      throw new Error("hostile ownKeys");
    },
  });
  expect(cloneJson(hostileOwnKeys)).toEqual({
    ok: false,
    error: {
      code: "invalid-object",
      path: "$",
      message: "hostile ownKeys",
    },
  });

  expect(cloneJson({ nested: null }, {
    maxDepth: 0,
    maxNodes: 100,
    maxStringBytes: 100,
  })).toMatchObject({ ok: false, error: { code: "depth-exceeded", path: "$.nested" } });
  expect(cloneJson({ nested: null }, {
    maxDepth: 100,
    maxNodes: 1,
    maxStringBytes: 100,
  })).toMatchObject({ ok: false, error: { code: "node-limit-exceeded", path: "$.nested" } });
  expect(cloneJson("é", {
    maxDepth: 100,
    maxNodes: 100,
    maxStringBytes: 1,
  })).toMatchObject({ ok: false, error: { code: "string-limit-exceeded", path: "$" } });
});

test("arrays reject accessors, hidden keys, custom prototypes, and extra properties", () => {
  let getterCalls = 0;
  const accessor = ["safe"];
  Object.defineProperty(accessor, 0, {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "unsafe";
    },
  });
  expect(parseJsonValue(accessor)).toMatchObject({
    ok: false,
    error: { code: "accessor-property", path: "$[0]" },
  });
  expect(cloneJson(accessor)).toMatchObject({
    ok: false,
    error: { code: "accessor-property", path: "$[0]" },
  });
  expect(getterCalls).toBe(0);

  const extra = [1] as number[] & { hidden?: boolean };
  extra.hidden = true;
  expect(parseJsonValue(extra)).toMatchObject({
    ok: false,
    error: { code: "invalid-object", path: "$.hidden" },
  });
  expect(cloneJson(extra)).toMatchObject({
    ok: false,
    error: { code: "invalid-object", path: "$.hidden" },
  });

  const custom = [1];
  const customPrototype = Object.create(Array.prototype) as object;
  Object.setPrototypeOf(custom, customPrototype);
  expect(parseJsonValue(custom)).toMatchObject({
    ok: false,
    error: { code: "invalid-object" },
  });
  expect(cloneJson(custom)).toMatchObject({
    ok: false,
    error: { code: "invalid-object" },
  });
});
