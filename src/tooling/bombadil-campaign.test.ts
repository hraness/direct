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
  readonly read: (state: { readonly window: unknown }) => unknown;
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
  createDirectBombadilProperties,
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

function evaluateIntoFormula(body: unknown): boolean | FakeFormula {
  if (typeof body !== "function") throw new Error("Expected a formula callback");
  return (body as () => boolean | FakeFormula)();
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
  test("prunes nested visible navigation and submission clicks", () => {
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
  test("returns the four named formulas with stable-catalog and bounded-quiet semantics", () => {
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
    expect(exactContract?.kind).toBe("eventually");
    expect(exactContract?.milliseconds).toBe(10_000);
    const exactAlways = requireFormula(evaluateIntoFormula(exactContract?.body));
    expect(exactAlways.kind).toBe("always");
    expect(evaluate(exactAlways.body)).toBeTrue();
    const initial = cell.current as Readonly<Record<string, unknown>>;
    for (const [key, value] of [
      ["activeScenario", "surface.other"],
      ["activeRoute", "/other"],
      ["activationHash", "fnv1a-64:aaaaaaaaaaaaaaaa"],
      ["activeSource", "fixture"],
    ] as const) {
      cell.current = { ...initial, [key]: value };
      expect(evaluate(exactAlways.body), key).toBeFalse();
    }
    cell.current = initial;

    const noDeclaredViolations = properties.noDeclaredViolations;
    expect(noDeclaredViolations?.kind).toBe("eventually");
    expect(noDeclaredViolations?.milliseconds).toBe(10_000);
    const violationsAlways = requireFormula(
      evaluateIntoFormula(noDeclaredViolations?.body),
    );
    expect(violationsAlways.kind).toBe("always");
    expect(evaluate(violationsAlways.body)).toBeTrue();

    const stableEventually = properties.stableCatalog;
    expect(stableEventually?.kind).toBe("eventually");
    expect(stableEventually?.milliseconds).toBe(10_000);
    const stableAlways = requireFormula(evaluateIntoFormula(stableEventually?.body));
    expect(stableAlways.kind).toBe("always");
    expect(evaluate(stableAlways.body)).toBeTrue();
    cell.current = readDirectBombadilObservation(contractFixture({
      catalogHash: "fnv1a-64:4444444444444444",
    }));
    expect(evaluate(stableAlways.body)).toBeFalse();

    const outerAlways = properties.eventualQuiescence;
    expect(outerAlways?.kind).toBe("always");
    const boundedEventually = outerAlways?.body as FakeFormula;
    expect(boundedEventually.kind).toBe("eventually");
    expect(boundedEventually.milliseconds).toBe(10_000);
  });

  test("permits bootstrap absence before locking the contract, catalog, and counters", () => {
    const properties = createDirectBombadilProperties() as unknown as Record<string, FakeFormula>;
    const cell = cells.at(-1);
    if (cell === undefined) throw new Error("Expected one Direct extractor cell");
    cell.current = readDirectBombadilObservation({});

    const violationsAlways = requireFormula(
      evaluateIntoFormula(properties.noDeclaredViolations?.body),
    );
    expect(evaluateIntoFormula(properties.exactContract?.body)).toBeFalse();
    expect(evaluate(violationsAlways.body)).toBeFalse();
    expect(evaluateIntoFormula(properties.stableCatalog?.body)).toBeFalse();

    const eventual = properties.eventualQuiescence?.body as FakeFormula;
    expect(evaluate(eventual.body)).toBeFalse();

    cell.current = readDirectBombadilObservation(contractFixture());
    const exactAlways = requireFormula(
      evaluateIntoFormula(properties.exactContract?.body),
    );
    expect(evaluate(exactAlways.body)).toBeTrue();
    expect(evaluate(violationsAlways.body)).toBeTrue();
    const stableAlways = requireFormula(
      evaluateIntoFormula(properties.stableCatalog?.body),
    );
    expect(evaluate(stableAlways.body)).toBeTrue();
    expect(evaluate(eventual.body)).toBeTrue();

    cell.current = readDirectBombadilObservation(contractFixture({
      catalogHash: "fnv1a-64:5555555555555555",
      violations: { console: 1 },
    }));
    expect(evaluate(exactAlways.body)).toBeTrue();
    expect(evaluate(stableAlways.body)).toBeFalse();
    expect(evaluate(violationsAlways.body)).toBeFalse();
  });
});
