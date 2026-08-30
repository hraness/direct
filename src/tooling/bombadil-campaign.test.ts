import { describe, expect, mock, test } from "bun:test";
import type { JSON as BombadilJson } from "@antithesishq/bombadil";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDirect } from "@hraness/direct";
import { createDirectSession } from "@hraness/direct/testing";

import { summarizeDirectBombadilTrace } from "./bombadil-runner.js";

interface FakeFormula {
  readonly body: unknown;
  readonly kind: "always" | "eventually";
  readonly milliseconds?: number;
  readonly within?: (count: number, unit: "milliseconds" | "seconds") => FakeFormula;
}

interface FakeCell {
  current: unknown;
  name: string | null;
  readonly named: (name: string) => FakeCell;
  readonly read: (state: {
    readonly resources?: Readonly<Record<string, number>>;
    readonly window: unknown;
  }) => unknown;
}

interface FakeActionGenerator {
  generate: () => unknown;
}

const cells: FakeCell[] = [];
let weightedEntries: ReadonlyArray<readonly [number, unknown]> = [];
const fakeClicks: { generate: () => unknown } = { generate: () => [] };
const fakeInputs: FakeActionGenerator = { generate: () => ["inputs"] };
const fakeScroll: FakeActionGenerator = { generate: () => ["scroll"] };

void mock.module("@antithesishq/bombadil", () => ({
  actions: (generate: () => unknown): FakeActionGenerator => ({ generate }),
  always: (body: unknown): FakeFormula => ({ kind: "always", body }),
  eventually: (body: unknown): FakeFormula => {
    const formula: FakeFormula = {
      kind: "eventually",
      body,
      within: (count, unit) => ({
        kind: "eventually",
        body,
        milliseconds: unit === "seconds" ? count * 1_000 : count,
      }),
    };
    return formula;
  },
  extract: (read: FakeCell["read"]): FakeCell => {
    const cell: FakeCell = {
      current: undefined,
      name: null,
      named: (name) => {
        cell.name = name;
        return cell;
      },
      read,
    };
    cells.push(cell);
    return cell;
  },
  weighted: (entries: ReadonlyArray<readonly [number, unknown]>): FakeActionGenerator => {
    weightedEntries = entries;
    return { generate: () => ({ branches: entries }) };
  },
}));

void mock.module("@antithesishq/bombadil/browser/defaults/actions", () => ({
  clicks: fakeClicks,
  inputs: fakeInputs,
  scroll: fakeScroll,
}));

const {
  createDirectBombadilActions,
  createDirectBombadilNamedSnapshot,
  createDirectBombadilProperties,
  createDirectBombadilResourceLeakProperty,
  readDirectBombadilObservation,
} = await import("./bombadil-campaign.js");

function contractFixture(options: {
  readonly catalogHash?: string;
  readonly isQuiescent?: boolean;
  readonly pending?: Readonly<Record<string, unknown>>;
  readonly probeActivationHash?: string;
  readonly violations?: Readonly<Record<string, unknown>>;
} = {}): Readonly<Record<string, unknown>> {
  let violation = 0;
  let pending = 0;
  const definition = defineDirect({
    parseWorld: (input) => {
      if (
        typeof input !== "object"
        || input === null
        || Array.isArray(input)
        || typeof Reflect.get(input, "count") !== "number"
      ) {
        throw new Error("count is required");
      }
      return { count: Reflect.get(input, "count") as number };
    },
    defaultScenario: "surface.ready",
    scenarios: [{
      id: "surface.ready",
      title: "Ready surface",
      route: "/surface",
      world: { count: 1 },
    }],
    coverage: [{
      key: "surface.visible",
      claim: "The surface is visible.",
      mode: "fixture",
      scenarios: ["surface.ready"],
    }],
  });
  const session = createDirectSession({
    definition,
    activation: { kind: "scenario", scenario: "surface.ready" },
    create: () => ({}),
    observe: () => ({
      pending: [{ name: "requests", read: () => pending }],
      violations: [{ name: "console", read: () => violation }],
      readRemainingWork: () => null,
    }),
  });
  if (!session.ok) throw new Error(session.error.message);
  violation = typeof options.violations?.console === "number"
    && Number.isSafeInteger(options.violations.console)
    ? options.violations.console
    : 0;
  pending = typeof options.pending?.requests === "number"
    && Number.isSafeInteger(options.pending.requests)
    ? options.pending.requests
    : 0;
  const snapshot = session.value.probe.snapshot();
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  const manifest = JSON.parse(JSON.stringify(session.value.manifest)) as Record<string, unknown>;
  const probe = JSON.parse(JSON.stringify(snapshot.value)) as Record<string, unknown>;
  if (options.catalogHash !== undefined) manifest.catalogHash = options.catalogHash;
  if (options.probeActivationHash !== undefined) {
    probe.activationHash = options.probeActivationHash;
  }
  if (options.violations !== undefined && !Number.isSafeInteger(options.violations.console)) {
    probe.violations = options.violations;
  }
  if (options.pending !== undefined && !Number.isSafeInteger(options.pending.requests)) {
    probe.pending = options.pending;
  }
  if (options.isQuiescent !== undefined) probe.isQuiescent = options.isQuiescent;
  return {
    __direct: {
      schema: "direct.browser-bridge/v2",
      manifest,
      snapshot: () => probe,
      reset: () => undefined,
    },
  };
}

function evaluate(body: unknown): boolean {
  if (typeof body !== "function") throw new Error("Expected a formula callback");
  return (body as () => boolean)();
}

function acceptBombadilJson(value: BombadilJson): value is BombadilJson {
  return value !== undefined;
}

function rejectBombadilJson(value: BombadilJson): value is never {
  return value === undefined;
}

describe("Direct Bombadil observation", () => {
  test("accepts the exact current bridge, manifest, and probe contract", () => {
    const observation = readDirectBombadilObservation(contractFixture());
    expect(observation).toMatchObject({
      activeRoute: "/surface",
      activeScenario: "surface.ready",
      activeSource: "scenario",
      bridgePresent: true,
      bridgeSchema: "direct.browser-bridge/v2",
      contractValid: true,
      isQuiescent: true,
      violations: [0],
      violationsValid: true,
    });
    expect(observation.activationHash).toMatch(/^fnv1a-64:/u);
    expect(observation.catalogHash).toMatch(/^fnv1a-64:/u);
    expect(observation.manifest).not.toBeNull();
    expect(observation.probe).not.toBeNull();
  });

  test("contains missing, hostile, and activation-drifted boundaries", () => {
    expect(readDirectBombadilObservation({}).contractValid).toBeFalse();
    expect(readDirectBombadilObservation(contractFixture({
      probeActivationHash: "fnv1a-64:aaaaaaaaaaaaaaaa",
    })).contractValid).toBeFalse();

    const hostile = {};
    Object.defineProperty(hostile, "__direct", {
      get: () => {
        throw new Error("hostile getter");
      },
    });
    expect(readDirectBombadilObservation(hostile)).toMatchObject({
      bridgePresent: true,
      contractValid: false,
      violationsValid: false,
    });
  });

  test("distinguishes valid nonzero counters from invalid counters", () => {
    const nonzero = readDirectBombadilObservation(contractFixture({
      violations: { console: 2 },
    }));
    expect(nonzero.contractValid).toBeTrue();
    expect(nonzero.violationsValid).toBeTrue();
    expect(nonzero.violations).toEqual([2]);

    const fractional = readDirectBombadilObservation(contractFixture({
      violations: { console: 0.5 },
    }));
    expect(fractional.contractValid).toBeFalse();
    expect(fractional.violationsValid).toBeFalse();
  });

  test("retains raw contracts for canonical runner-side drift validation", () => {
    expect(readDirectBombadilObservation(contractFixture({
      catalogHash: "",
    })).contractValid).toBeFalse();
    const drifted = readDirectBombadilObservation(contractFixture({
      isQuiescent: true,
      pending: { requests: 1 },
    }));
    expect(drifted.contractValid).toBeTrue();
    expect(drifted.manifest).not.toBeNull();
    expect(drifted.probe).toMatchObject({ pending: { requests: 1 } });
  });
});

describe("Direct Bombadil named snapshots", () => {
  test("names bounded JSON and fails closed around hostile or oversized page values", () => {
    const snapshot = createDirectBombadilNamedSnapshot({
      fallback: { status: "unavailable" },
      name: "product.phase",
      read: (state) => Reflect.get(state.window, "phase"),
      validate: (value): value is { readonly status: string } => (
        typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && typeof Reflect.get(value, "status") === "string"
      ),
    }) as unknown as FakeCell;
    expect(snapshot.name).toBe("product.phase");
    expect(snapshot.read({ window: { phase: { status: "ready" } } })).toEqual({
      status: "ready",
    });

    const hostile = {};
    Object.defineProperty(hostile, "phase", {
      get: () => {
        throw new Error("hostile getter");
      },
    });
    expect(snapshot.read({ window: hostile })).toEqual({ status: "unavailable" });
    expect(snapshot.read({
      window: { phase: { status: "é".repeat(1_100_000) } },
    })).toEqual({ status: "unavailable" });
    expect(snapshot.read({ window: { phase: null } })).toEqual({
      status: "unavailable",
    });
  });

  test("produces a named value accepted by the host summary contract", async () => {
    class MutablePageValue {
      status = "ready";

      toJSON() {
        return { status: "é".repeat(1_100_000) };
      }
    }
    const pageValue = new MutablePageValue();
    const snapshot = createDirectBombadilNamedSnapshot({
      fallback: { status: "unavailable" },
      name: "product.compat",
      read: () => pageValue,
      validate: (value): value is { readonly status: string } => (
        typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && typeof Reflect.get(value, "status") === "string"
      ),
    }) as unknown as FakeCell;
    const value = snapshot.read({
      window: { phase: { status: "ready" } },
    }) as { status: string };
    expect(value).toEqual({ status: "ready" });
    expect(value).not.toBe(pageValue);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    pageValue.status = "mutated";
    expect(value).toEqual({ status: "ready" });
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-helper-summary-"));
    const tracePath = join(directory, "trace.jsonl");
    try {
      await writeFile(tracePath, `${JSON.stringify({
        action: null,
        snapshots: [
          {
            index: 0,
            name: "direct",
            time: 1,
            value: readDirectBombadilObservation(contractFixture()),
          },
          { index: 1, name: snapshot.name, time: 1, value },
        ],
        state: {
          hash_current: 1,
          hash_previous: null,
          resources: {
            documents: 1,
            dom_nodes: 1,
            js_event_listeners: 1,
            js_heap_total: 1,
            js_heap_used: 1,
            layout_objects: 1,
            script_duration: 0,
            task_duration: 0,
            thread_time: 0,
            timestamp: 1,
          },
          screenshot: "1.png",
          url: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
        },
        timestamp: 1,
        violations: [],
      })}\n`, "utf8");
      const summary = await summarizeDirectBombadilTrace({
        targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
        tracePath,
      });
      expect(summary.namedSnapshots.find(({ name }) => name === snapshot.name))
        .toMatchObject({ distinctValueCount: 1, observationCount: 1 });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("matches the host name, UTF-8 size, and JSON depth boundary", () => {
    for (const name of [
      "direct",
      "__proto__",
      "constructor",
      "prototype",
      "unsafe name",
    ]) {
      expect(() => createDirectBombadilNamedSnapshot<BombadilJson>({
        fallback: null,
        name,
        read: () => null,
        validate: acceptBombadilJson,
      })).toThrow("safe, unreserved");
    }

    const snapshot = createDirectBombadilNamedSnapshot<BombadilJson>({
      fallback: null,
      name: "safe",
      read: (state) => Reflect.get(state.window, "phase"),
      validate: acceptBombadilJson,
    }) as unknown as FakeCell;
    let atLimit: BombadilJson = null;
    for (let index = 0; index < 64; index += 1) atLimit = [atLimit];
    expect(snapshot.read({ window: { phase: atLimit } })).toEqual(atLimit);
    const beyondLimit: BombadilJson = [atLimit];
    expect(snapshot.read({ window: { phase: beyondLimit } })).toBeNull();
  });

  test("accepts the exact canonical UTF-8 limit and rejects one byte more", () => {
    const snapshot = createDirectBombadilNamedSnapshot({
      fallback: "fallback",
      name: "product.boundary",
      read: (state) => Reflect.get(state.window, "value"),
      validate: (value): value is string => typeof value === "string",
    }) as unknown as FakeCell;
    const maximumBytes = 2 * 1024 * 1024;
    const exactValues = [
      () => "a".repeat(maximumBytes - 2),
      () => "é".repeat((maximumBytes - 2) / 2),
      () => "€".repeat((maximumBytes - 2) / 3),
      () => `${"😀".repeat(524_287)}é`,
      () => "\ud800".repeat((maximumBytes - 2) / 6),
      () => "\udc00".repeat((maximumBytes - 2) / 6),
    ];

    for (const createExactValue of exactValues) {
      const exactValue = createExactValue();
      expect(snapshot.read({ window: { value: exactValue } })).toBe(exactValue);
      expect(snapshot.read({ window: { value: `${exactValue}a` } })).toBe("fallback");
    }
  });

  test("rejects non-JSON or predicate-invalid fallbacks before registering an extractor", () => {
    expect(() => createDirectBombadilNamedSnapshot({
      fallback: null,
      name: "safe",
      read: () => null,
      validate: rejectBombadilJson,
    })).toThrow("accepted by validate");
    expect(() => createDirectBombadilNamedSnapshot<BombadilJson>({
      fallback: undefined as never,
      name: "safe",
      read: () => null,
      validate: acceptBombadilJson,
    })).toThrow("fallback must be bounded JSON accepted by validate");
  });
});

describe("Direct Bombadil resource properties", () => {
  const resources = (timestamp: number, domNodes: number) => ({
    documents: 1,
    dom_nodes: domNodes,
    js_event_listeners: 2,
    js_heap_total: 2_000,
    js_heap_used: 1_000,
    layout_objects: 10,
    script_duration: 0,
    task_duration: 0,
    thread_time: 0,
    timestamp,
  });

  test("detects excessive growth across a bounded sliding resource window", () => {
    const property = createDirectBombadilResourceLeakProperty({
      growthLimit: 10,
      metric: "dom_nodes",
      windowMillis: 1_000,
    }) as unknown as FakeFormula;
    const cell = cells.at(-1);
    if (cell === undefined) throw new Error("resource extractor was not registered");

    cell.current = cell.read({ resources: resources(1, 100), window: {} });
    expect(evaluate(property.body)).toBeTrue();
    cell.current = cell.read({ resources: resources(1.5, 105), window: {} });
    expect(evaluate(property.body)).toBeTrue();
    cell.current = cell.read({ resources: resources(1.75, 120), window: {} });
    expect(evaluate(property.body)).toBeFalse();
  });

  test("rejects unknown fields, metrics, and unsafe numeric bounds", () => {
    expect(() => createDirectBombadilResourceLeakProperty({
      growthLimit: 1,
      metric: "dom_nodes",
      windowMillis: 1_000,
      extra: true,
    } as never)).toThrow("must contain metric");
    expect(() => createDirectBombadilResourceLeakProperty({
      growthLimit: 1,
      metric: "documents" as never,
      windowMillis: 1_000,
    })).toThrow("metric is unsupported");
    expect(() => createDirectBombadilResourceLeakProperty({
      growthLimit: Number.POSITIVE_INFINITY,
      metric: "dom_nodes",
      windowMillis: 1_000,
    })).toThrow("positive finite safe number");
    expect(() => createDirectBombadilResourceLeakProperty({
      growthLimit: 1,
      metric: "dom_nodes",
      windowMillis: 300_001,
    })).toThrow("between 1 and 300000");
  });
});

function clickAction(overrides: Readonly<Record<string, string | null>> = {}): unknown {
  return {
    Click: {
      fingerprint: {
        testId: null,
        id: null,
        role: null,
        accessibleName: null,
        tag: "button",
        href: null,
        nameAttr: null,
        placeholder: null,
        inputType: "button",
        textContent: "Continue",
        structuralPath: null,
        ...overrides,
      },
      point: { x: 10, y: 20 },
    },
  };
}

describe("Direct Bombadil actions", () => {
  test("prunes nested navigation, submission, and destructive clicks", () => {
    fakeClicks.generate = () => ({
      branches: [
        [7, { value: clickAction() }],
        [6, { value: clickAction({ tag: "a" }) }],
        [5, { value: clickAction({ role: "link" }) }],
        [4, { value: clickAction({ href: "/next" }) }],
        [3, { value: clickAction({ inputType: "submit" }) }],
        [2, { value: clickAction({ inputType: "image" }) }],
        [2, { value: clickAction({ inputType: "reset" }) }],
        [2, { value: clickAction({ inputType: null }) }],
        [2, { value: clickAction({ textContent: "ReSeT" }) }],
        [2, { value: clickAction({ accessibleName: "RESET", textContent: "Again" }) }],
        [2, { value: clickAction({ accessibleName: "", textContent: "Reset" }) }],
        [2, { value: clickAction({ textContent: "Delete track" }) }],
        [2, { value: clickAction({ accessibleName: "Close editor", textContent: "Done" }) }],
        [2, { value: clickAction({ textContent: "Sign-out" }) }],
        [2, { value: clickAction({ textContent: "Remove from playlist" }) }],
        [2, { value: clickAction({ textContent: "Unclear status" }) }],
        [1, {
          branches: [
            [9, { value: clickAction({ tag: "input", inputType: "text" }) }],
            [8, { value: clickAction({ tag: "A" }) }],
            [7, { value: clickAction({ tag: "label", textContent: "Continue" }) }],
          ],
        }],
      ],
    });

    createDirectBombadilActions();
    expect(weightedEntries.map(([weight]) => weight)).toEqual([4, 3, 2, 1]);
    expect(weightedEntries[2]?.[1]).toBe(fakeScroll);
    const wait = weightedEntries[3]?.[1] as FakeActionGenerator | undefined;
    expect(wait?.generate()).toEqual(["Wait"]);
    const filtered = weightedEntries[0]?.[1] as FakeActionGenerator | undefined;
    expect(filtered?.generate()).toEqual({
      branches: [
        [7, { value: clickAction() }],
        [2, { value: clickAction({ textContent: "Unclear status" }) }],
        [1, {
          branches: [
            [9, { value: clickAction({ tag: "input", inputType: "text" }) }],
          ],
        }],
      ],
    });
  });

  test("turns an entirely unsafe click tree empty while retaining a Wait fallback", () => {
    fakeClicks.generate = () => ({
      branches: [[1, { value: clickAction({ href: "/elsewhere" }) }]],
    });
    createDirectBombadilActions();
    const filtered = weightedEntries[0]?.[1] as FakeActionGenerator | undefined;
    expect(filtered?.generate()).toEqual([]);
    const wait = weightedEntries[3]?.[1] as FakeActionGenerator | undefined;
    expect(wait?.generate()).toEqual(["Wait"]);
  });

  test("prunes Enter while retaining ordinary input actions and keys", () => {
    fakeClicks.generate = () => [];
    fakeInputs.generate = () => ({
      branches: [
        [3, { value: { PressKey: { code: 13 } } }],
        [2, { value: { PressKey: { code: 8 } } }],
        [1, { value: { TypeText: { text: "Email", delayMillis: 0 } } }],
      ],
    });
    createDirectBombadilActions();
    const filtered = weightedEntries[1]?.[1] as FakeActionGenerator | undefined;
    expect(filtered?.generate()).toEqual({
      branches: [
        [2, { value: { PressKey: { code: 8 } } }],
        [1, { value: { TypeText: { text: "Email", delayMillis: 0 } } }],
      ],
    });
  });
});

describe("Direct Bombadil formulas", () => {
  test("splits bounded startup from strict recurring health", () => {
    const properties = createDirectBombadilProperties() as unknown as Record<string, FakeFormula>;
    const cell = cells.at(-1);
    if (cell === undefined) throw new Error("Expected one Direct extractor cell");
    expect(cell.name).toBe("direct");
    const sample = (window: unknown): void => {
      cell.current = cell.read({ window });
    };
    sample({});

    expect(Object.keys(properties).sort()).toEqual([
      "eventualQuiescence",
      "exactContract",
      "noDeclaredViolations",
      "stableCatalog",
      "startupContract",
    ]);
    expect(properties.startupContract?.kind).toBe("eventually");
    expect(properties.startupContract?.milliseconds).toBe(10_000);
    expect(evaluate(properties.startupContract?.body)).toBeFalse();
    expect(properties.exactContract?.kind).toBe("always");
    expect(properties.stableCatalog?.kind).toBe("always");
    expect(properties.noDeclaredViolations?.kind).toBe("always");
    expect(evaluate(properties.exactContract?.body)).toBeTrue();
    expect(evaluate(properties.stableCatalog?.body)).toBeTrue();
    expect(evaluate(properties.noDeclaredViolations?.body)).toBeTrue();

    sample(contractFixture());
    expect(evaluate(properties.startupContract?.body)).toBeTrue();
    expect(evaluate(properties.exactContract?.body)).toBeTrue();
    expect(evaluate(properties.stableCatalog?.body)).toBeTrue();
    expect(evaluate(properties.noDeclaredViolations?.body)).toBeTrue();
    const initial = cell.current as Readonly<Record<string, unknown>>;
    for (const [key, value] of [
      ["activeScenario", ""],
      ["activeRoute", ""],
      ["activationHash", ""],
      ["activeSource", "fixture"],
    ] as const) {
      cell.current = { ...initial, [key]: value };
      expect(evaluate(properties.exactContract?.body), key).toBeFalse();
    }
    cell.current = initial;

    sample(contractFixture({
      catalogHash: "fnv1a-64:ffffffffffffffff",
    }));
    expect(evaluate(properties.exactContract?.body)).toBeTrue();
    expect(evaluate(properties.stableCatalog?.body)).toBeFalse();

    sample(contractFixture({ violations: { console: 1 } }));
    expect(evaluate(properties.noDeclaredViolations?.body)).toBeFalse();

    const outerAlways = properties.eventualQuiescence;
    expect(outerAlways?.kind).toBe("always");
    const boundedEventually = outerAlways?.body as FakeFormula;
    expect(boundedEventually.kind).toBe("eventually");
    expect(boundedEventually.milliseconds).toBe(10_000);
  });

  test("permits bootstrap absence before recurring exact health", () => {
    const properties = createDirectBombadilProperties() as unknown as Record<string, FakeFormula>;
    const cell = cells.at(-1);
    if (cell === undefined) throw new Error("Expected one Direct extractor cell");
    const sample = (window: unknown): void => {
      cell.current = cell.read({ window });
    };
    sample({});
    expect(evaluate(properties.startupContract?.body)).toBeFalse();
    expect(evaluate(properties.exactContract?.body)).toBeTrue();
    expect(evaluate(properties.noDeclaredViolations?.body)).toBeTrue();
    expect(evaluate(properties.stableCatalog?.body)).toBeTrue();

    const eventual = properties.eventualQuiescence?.body as FakeFormula;
    expect(evaluate(eventual.body)).toBeFalse();

    sample(contractFixture());
    expect(evaluate(properties.startupContract?.body)).toBeTrue();
    expect(evaluate(properties.exactContract?.body)).toBeTrue();
    expect(evaluate(properties.noDeclaredViolations?.body)).toBeTrue();
    expect(evaluate(properties.stableCatalog?.body)).toBeTrue();
    expect(evaluate(eventual.body)).toBeTrue();

    sample({});
    expect(evaluate(properties.exactContract?.body)).toBeFalse();
    expect(evaluate(properties.stableCatalog?.body)).toBeFalse();
    expect(evaluate(properties.noDeclaredViolations?.body)).toBeFalse();
  });
});
