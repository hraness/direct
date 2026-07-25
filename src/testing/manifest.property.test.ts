import { expect, test } from "bun:test";

import { defineDirect } from "../core/definition.js";
import type { TaggedStableHash } from "../core/json.js";
import { assertProperty, fc, parseTestWorld } from "../core/test-support.js";
import {
  createDirectSessionManifest,
  parseDirectSessionManifest,
} from "./manifest.js";

const scenarioNumbers = fc.uniqueArray(
  fc.integer({ min: 0, max: 10_000 }),
  { minLength: 1, maxLength: 10 },
);

function definition(
  numbers: readonly number[],
  mutation: "none" | "title" | "coverage" = "none",
) {
  const first = numbers[0];
  if (first === undefined) throw new Error("Property catalogs need a scenario");
  return defineDirect({
    parseWorld: parseTestWorld,
    defaultScenario: `case.${String(first)}`,
    scenarios: numbers.map((number, index) => ({
      id: `case.${String(number)}`,
      title: mutation === "title" && index === 0
        ? `Case ${String(number)} changed`
        : `Case ${String(number)}`,
      ...(index % 2 === 0
        ? { description: `Description ${String(number)}` }
        : {}),
      route: `/case/${String(number)}`,
      world: {
        count: number,
        messages: [`private-${String(number)}`],
      },
    })),
    coverage: [{
      key: "catalog.visible",
      mode: "fixture",
      claim: mutation === "coverage"
        ? "The selected catalog case is visible after a change."
        : "The selected catalog case is visible.",
      scenarios: [`case.${String(first)}`],
    }],
  });
}

function manifestFor(
  numbers: readonly number[],
  activeIndex: number,
  mutation: "none" | "title" | "coverage" = "none",
) {
  const direct = definition(numbers, mutation);
  const selected = numbers[activeIndex % numbers.length];
  if (selected === undefined) throw new Error("Property catalogs need an active scenario");
  const activation = direct.activateScenario(`case.${String(selected)}`);
  if (!activation.ok) throw new Error(activation.error.message);
  const manifest = createDirectSessionManifest(direct, activation.value);
  if (!manifest.ok) throw new Error(manifest.error.message);
  return manifest.value;
}

test("property: manifests round-trip, preserve authored order, and hash only the catalog", () => {
  assertProperty(fc.property(
    scenarioNumbers,
    fc.nat(),
    fc.nat(),
    (numbers, firstIndex, secondIndex) => {
      const first = manifestFor(numbers, firstIndex);
      const second = manifestFor(numbers, secondIndex);

      expect(parseDirectSessionManifest(
        JSON.parse(JSON.stringify(first)) as unknown,
      )).toEqual({ ok: true, value: first });
      expect(first.scenarios.map(({ id }) => String(id))).toEqual(
        numbers.map((number) => `case.${String(number)}`),
      );
      expect(first.catalogHash).toBe(second.catalogHash);
      expect(first.catalogHash).toMatch(/^fnv1a-64:[0-9a-f]{16}$/u);
    },
  ));
});

test("property: every public catalog mutation changes the catalog hash", () => {
  assertProperty(fc.property(
    scenarioNumbers,
    fc.nat(),
    (numbers, activeIndex) => {
      const original = manifestFor(numbers, activeIndex);
      const changedTitle = manifestFor(numbers, activeIndex, "title");
      const changedCoverage = manifestFor(numbers, activeIndex, "coverage");

      expect(changedTitle.catalogHash).not.toBe(original.catalogHash);
      expect(changedCoverage.catalogHash).not.toBe(original.catalogHash);
      if (numbers.length > 1) {
        const reversed = manifestFor([...numbers].reverse(), activeIndex);
        expect(reversed.catalogHash).not.toBe(original.catalogHash);
      }
    },
  ));
});

test("property: every activation-hash mutation is rejected", () => {
  assertProperty(fc.property(
    scenarioNumbers,
    fc.nat(),
    (numbers, activeIndex) => {
      const direct = definition(numbers);
      const selected = numbers[activeIndex % numbers.length];
      if (selected === undefined) throw new Error("Property catalogs need an active scenario");
      const activation = direct.activateScenario(`case.${String(selected)}`);
      if (!activation.ok) throw new Error(activation.error.message);
      const last = activation.value.activationHash.at(-1);
      const forged = `${activation.value.activationHash.slice(0, -1)}${
        last === "0" ? "1" : "0"
      }` as TaggedStableHash;

      expect(createDirectSessionManifest(direct, {
        ...activation.value,
        activationHash: forged,
      })).toMatchObject({
        ok: false,
        error: { code: "activation-hash-mismatch" },
      });
    },
  ));
});

test("property: every public active-identity mutation breaks its selection binding", () => {
  assertProperty(fc.property(
    scenarioNumbers,
    fc.nat(),
    (numbers, activeIndex) => {
      const manifest = manifestFor(numbers, activeIndex);
      const last = manifest.active.activationHash.at(-1);
      const forgedActivationHash =
        `${manifest.active.activationHash.slice(0, -1)}${
          last === "0" ? "1" : "0"
        }` as TaggedStableHash;
      const mutations: unknown[] = [
        {
          ...manifest,
          active: {
            ...manifest.active,
            source: manifest.active.source === "scenario" ? "fixture" : "scenario",
          },
        },
        {
          ...manifest,
          active: {
            ...manifest.active,
            activationHash: forgedActivationHash,
          },
        },
      ];
      const otherScenario = manifest.scenarios.find(
        ({ id }) => id !== manifest.active.scenario,
      );
      if (otherScenario !== undefined) {
        mutations.push({
          ...manifest,
          active: {
            ...manifest.active,
            scenario: otherScenario.id,
            route: otherScenario.route,
          },
        });
      }

      for (const mutated of mutations) {
        expect(parseDirectSessionManifest(mutated)).toMatchObject({
          ok: false,
          error: { code: "selection-hash-mismatch" },
        });
      }
    },
  ));
});

test("property: exact keys and semantic laws fail closed", () => {
  assertProperty(fc.property(
    scenarioNumbers,
    fc.nat(),
    fc.jsonValue(),
    fc.constantFrom("unknown-key", "route-mismatch", "hash-drift"),
    (numbers, activeIndex, extra, mutation) => {
      const manifest = manifestFor(numbers, activeIndex);
      const parsed = mutation === "unknown-key"
        ? parseDirectSessionManifest({ ...manifest, unexpected: extra })
        : mutation === "route-mismatch"
          ? parseDirectSessionManifest({
            ...manifest,
            active: {
              ...manifest.active,
              route: `${manifest.active.route}/mismatch`,
            },
          })
          : parseDirectSessionManifest({
            ...manifest,
            scenarios: manifest.scenarios.map((scenario, index) =>
              index === 0
                ? { ...scenario, title: `${scenario.title} drift` }
                : scenario
            ),
          });

      expect(parsed.ok).toBeFalse();
      if (parsed.ok) throw new Error("Mutated manifests must fail");
      expect(parsed.error.code).toBe(
        mutation === "route-mismatch"
          ? "route-mismatch"
          : mutation === "hash-drift"
            ? "catalog-hash-mismatch"
            : "invalid-manifest",
      );
    },
  ));
});

test("property: manifest discovery never leaks product worlds or runtimes", () => {
  assertProperty(fc.property(
    fc.integer({ min: 0, max: 1_000_000 }),
    (secret) => {
      const direct = defineDirect({
        parseWorld: parseTestWorld,
        defaultScenario: "private.case",
        scenarios: [{
          id: "private.case",
          title: "Private case",
          route: "/private",
          world: {
            count: secret,
            messages: [`world-secret-${String(secret)}-never-public`],
          },
          runtime: {
            schema: "direct.runtime/v1",
            nowMs: secret,
            nextOperation: 1,
            acceleration: 100,
          },
        }],
        coverage: [],
      });
      const activation = direct.activateScenario("private.case");
      if (!activation.ok) throw new Error(activation.error.message);
      const created = createDirectSessionManifest(direct, activation.value);
      if (!created.ok) throw new Error(created.error.message);

      const scenario = created.value.scenarios[0];
      if (scenario === undefined) throw new Error("Missing private scenario");
      expect(Object.hasOwn(scenario, "world")).toBeFalse();
      expect(Object.hasOwn(scenario, "runtime")).toBeFalse();
      expect(JSON.stringify(created.value)).not.toContain(
        `world-secret-${String(secret)}-never-public`,
      );
    },
  ));
});

test("property: the manifest parser is total for arbitrary JavaScript values", () => {
  assertProperty(fc.property(fc.anything(), (candidate) => {
    expect(() => parseDirectSessionManifest(candidate)).not.toThrow();
    expect(typeof parseDirectSessionManifest(candidate).ok).toBe("boolean");
  }));
});
