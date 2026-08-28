import { describe, expect, mock, test } from "bun:test";
import { defineDirect } from "@hraness/direct";
import { createDirectSession } from "@hraness/direct/testing";

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

function requireFormula(value: boolean | FakeFormula): FakeFormula {
  if (typeof value === "boolean") throw new Error("Expected a nested formula");
  return value;
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
      window: { phase: "x".repeat(2_000_001) },
    })).toEqual({ status: "unavailable" });
  });

  test("rejects unsafe names and non-JSON fallbacks before registering an extractor", () => {
    expect(() => createDirectBombadilNamedSnapshot({
      fallback: null,
      name: "unsafe name",
      read: () => null,
    })).toThrow("safe 1-128 character identifier");
    expect(() => createDirectBombadilNamedSnapshot({
      fallback: undefined as never,
      name: "safe",
      read: () => null,
    })).toThrow("fallback must be bounded JSON");
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
  test("returns four recurring bounded health formulas", () => {
    const properties = createDirectBombadilProperties() as unknown as Record<string, FakeFormula>;
    const cell = cells.at(-1);
    if (cell === undefined) throw new Error("Expected one Direct extractor cell");
    expect(cell.name).toBe("direct");
    cell.current = readDirectBombadilObservation(contractFixture());

    expect(Object.keys(properties).sort()).toEqual([
      "eventualQuiescence",
      "exactContract",
      "noDeclaredViolations",
      "stableCatalog",
    ]);
    const exactContract = properties.exactContract;
    expect(exactContract?.kind).toBe("always");
    const exactEventually = requireFormula(exactContract?.body as FakeFormula);
    expect(exactEventually.kind).toBe("eventually");
    expect(exactEventually.milliseconds).toBe(10_000);
    expect(evaluate(exactEventually.body)).toBeTrue();
    const initial = cell.current as Readonly<Record<string, unknown>>;
    for (const [key, value] of [
      ["activeScenario", ""],
      ["activeRoute", ""],
      ["activationHash", ""],
      ["activeSource", "fixture"],
    ] as const) {
      cell.current = { ...initial, [key]: value };
      expect(evaluate(exactEventually.body), key).toBeFalse();
    }
    cell.current = initial;

    const noDeclaredViolations = properties.noDeclaredViolations;
    expect(noDeclaredViolations?.kind).toBe("always");
    const violationsEventually = requireFormula(
      noDeclaredViolations?.body as FakeFormula,
    );
    expect(violationsEventually.kind).toBe("eventually");
    expect(violationsEventually.milliseconds).toBe(10_000);
    expect(evaluate(violationsEventually.body)).toBeTrue();

    const stableAlways = properties.stableCatalog;
    expect(stableAlways?.kind).toBe("always");
    const stableEventually = requireFormula(stableAlways?.body as FakeFormula);
    expect(stableEventually.kind).toBe("eventually");
    expect(stableEventually.milliseconds).toBe(10_000);
    expect(evaluate(stableEventually.body)).toBeTrue();
    cell.current = readDirectBombadilObservation(contractFixture({
      catalogHash: "",
    }));
    expect(evaluate(stableEventually.body)).toBeFalse();

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
    cell.current = readDirectBombadilObservation({});

    const exactEventually = requireFormula(properties.exactContract?.body as FakeFormula);
    const violationsEventually = requireFormula(
      properties.noDeclaredViolations?.body as FakeFormula,
    );
    const stableEventually = requireFormula(properties.stableCatalog?.body as FakeFormula);
    expect(evaluate(exactEventually.body)).toBeFalse();
    expect(evaluate(violationsEventually.body)).toBeFalse();
    expect(evaluate(stableEventually.body)).toBeFalse();

    const eventual = properties.eventualQuiescence?.body as FakeFormula;
    expect(evaluate(eventual.body)).toBeFalse();

    cell.current = readDirectBombadilObservation(contractFixture());
    expect(evaluate(exactEventually.body)).toBeTrue();
    expect(evaluate(violationsEventually.body)).toBeTrue();
    expect(evaluate(stableEventually.body)).toBeTrue();
    expect(evaluate(eventual.body)).toBeTrue();

    cell.current = readDirectBombadilObservation(contractFixture({
      catalogHash: "",
      violations: { console: 1 },
    }));
    expect(evaluate(exactEventually.body)).toBeFalse();
    expect(evaluate(stableEventually.body)).toBeFalse();
    expect(evaluate(violationsEventually.body)).toBeFalse();
  });
});
