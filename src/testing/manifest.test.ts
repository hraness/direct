import { describe, expect, test } from "bun:test";

import { defineDirect } from "../core/definition.js";
import { MAX_DIRECT_COVERAGE_ENTRIES } from "../core/coverage.js";
import {
  FIXTURE_QUERY_KEY,
  SCENARIO_QUERY_KEY,
} from "../core/query.js";
import { parseTestWorld } from "../core/test-support.js";
import { MAX_DIRECT_SCENARIOS } from "../core/scenario.js";
import {
  createDirectSessionManifest,
  DIRECT_SESSION_MANIFEST_SCHEMA,
  parseDirectSessionManifest,
} from "./manifest.js";
import { createDirectSession } from "./session.js";

function definition() {
  return defineDirect({
    parseWorld: parseTestWorld,
    defaultScenario: "chat.empty",
    scenarios: [
      {
        id: "chat.empty",
        title: "Empty chat",
        description: "A quiet starting point.",
        route: "/chat",
        world: { count: 0, messages: ["world-only-secret"] },
      },
      {
        id: "settings.ready",
        title: "Ready settings",
        route: "/settings",
        world: { count: 1, messages: ["runtime-only-secret"] },
      },
    ],
    coverage: [
      {
        key: "chat.empty.visible",
        mode: "fixture",
        claim: "The empty chat renders.",
        scenarios: ["chat.empty"],
      },
      {
        key: "settings.persistence",
        mode: "direct",
        claim: "Persistence is verified through product controls.",
        scenarios: [],
      },
    ],
  });
}

function createdManifest(scenario = "chat.empty") {
  const direct = definition();
  const activation = direct.activateScenario(scenario);
  if (!activation.ok) throw new Error(activation.error.message);
  const manifest = createDirectSessionManifest(direct, activation.value);
  if (!manifest.ok) throw new Error(manifest.error.message);
  return manifest.value;
}

function jsonClone(input: unknown): unknown {
  return JSON.parse(JSON.stringify(input)) as unknown;
}

describe("Direct session manifest", () => {
  test("projects an exact ordered public catalog without world or runtime data", () => {
    const manifest = createdManifest();

    expect(manifest.catalogHash).toBe("fnv1a-64:2d4bf54ff1c57132");
    expect(manifest.active.activationHash).toMatch(/^fnv1a-64:[0-9a-f]{16}$/u);
    expect(manifest.active.selectionHash).toMatch(/^fnv1a-64:[0-9a-f]{16}$/u);
    expect(jsonClone(manifest)).toEqual({
      schema: DIRECT_SESSION_MANIFEST_SCHEMA,
      catalogHash: manifest.catalogHash,
      queries: {
        scenario: SCENARIO_QUERY_KEY,
        fixture: FIXTURE_QUERY_KEY,
      },
      defaultScenario: "chat.empty",
      active: {
        source: "scenario",
        scenario: "chat.empty",
        route: "/chat",
        activationHash: manifest.active.activationHash,
        selectionHash: manifest.active.selectionHash,
      },
      scenarios: [
        {
          id: "chat.empty",
          title: "Empty chat",
          description: "A quiet starting point.",
          route: "/chat",
        },
        {
          id: "settings.ready",
          title: "Ready settings",
          description: null,
          route: "/settings",
        },
      ],
      coverage: {
        schema: "direct.coverage/v2",
        entries: [
          {
            key: "chat.empty.visible",
            mode: "fixture",
            claim: "The empty chat renders.",
            scenarios: ["chat.empty"],
          },
          {
            key: "settings.persistence",
            mode: "direct",
            claim: "Persistence is verified through product controls.",
            scenarios: [],
          },
        ],
      },
    });
    expect(Object.keys(manifest)).toEqual([
      "schema",
      "catalogHash",
      "queries",
      "defaultScenario",
      "active",
      "scenarios",
      "coverage",
    ]);
    expect(JSON.stringify(manifest)).not.toContain("world-only-secret");
    expect(JSON.stringify(manifest)).not.toContain("runtime-only-secret");
    expect(Object.hasOwn(manifest.scenarios[0] ?? {}, "world")).toBeFalse();
    expect(Object.hasOwn(manifest.scenarios[0] ?? {}, "runtime")).toBeFalse();
  });

  test("round-trips foreign JSON into deeply frozen owned values", () => {
    const manifest = createdManifest();
    const parsed = parseDirectSessionManifest(jsonClone(manifest));

    expect(parsed).toEqual({ ok: true, value: manifest });
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(Object.isFrozen(parsed.value)).toBeTrue();
    expect(Object.isFrozen(parsed.value.active)).toBeTrue();
    expect(Object.isFrozen(parsed.value.queries)).toBeTrue();
    expect(Object.isFrozen(parsed.value.scenarios)).toBeTrue();
    expect(Object.isFrozen(parsed.value.scenarios[0])).toBeTrue();
    expect(Object.isFrozen(parsed.value.coverage)).toBeTrue();
    expect(Object.isFrozen(parsed.value.coverage.entries[0])).toBeTrue();
  });

  test("keeps the catalog hash stable across active selections", () => {
    const first = createdManifest("chat.empty");
    const second = createdManifest("settings.ready");

    expect(first.catalogHash).toBe(second.catalogHash);
    expect(first.active).not.toEqual(second.active);
    expect(first.scenarios.map(({ id }) => String(id))).toEqual([
      "chat.empty",
      "settings.ready",
    ]);
  });

  test("identifies fixture activations without exposing their world or runtime", () => {
    const direct = definition();
    const fixture = direct.serializeFixture({
      scenario: "chat.empty",
      world: { count: 99, messages: ["fixture-only-secret"] },
    });
    if (!fixture.ok) throw new Error(fixture.error.message);
    const activation = direct.activate(
      `?${FIXTURE_QUERY_KEY}=${encodeURIComponent(fixture.value)}`,
    );
    if (!activation.ok) throw new Error(activation.error.message);
    const manifest = createDirectSessionManifest(direct, activation.value);
    if (!manifest.ok) throw new Error(manifest.error.message);

    expect(manifest.value.active).toMatchObject({
      source: "fixture",
      scenario: "chat.empty",
      route: "/chat",
      activationHash: activation.value.activationHash,
    });
    expect(JSON.stringify(manifest.value)).not.toContain("fixture-only-secret");
  });

  test("rejects forged hashes and scenario state that differs from its authored catalog", () => {
    const direct = definition();
    const activation = direct.activateScenario("chat.empty");
    if (!activation.ok) throw new Error(activation.error.message);

    expect(createDirectSessionManifest(direct, {
      ...activation.value,
      activationHash: "fnv1a-64:0000000000000000",
    })).toMatchObject({
      ok: false,
      error: { code: "activation-hash-mismatch" },
    });
    expect(createDirectSessionManifest(direct, {
      ...activation.value,
      world: { count: 44, messages: ["different"] },
    })).toMatchObject({
      ok: false,
      error: { code: "activation-hash-mismatch" },
    });
  });

  test("the largest valid definition still constructs a manifest and session", () => {
    const descriptions = "\u0800".repeat(2_000);
    const scenarios = Array.from({ length: MAX_DIRECT_SCENARIOS }, (_, index) => ({
      id: `case.${String(index)}`,
      title: `Case ${String(index)}`,
      description: descriptions,
      route: `/case/${String(index)}`,
      world: { count: index, messages: [] },
    }));
    const direct = defineDirect({
      parseWorld: parseTestWorld,
      defaultScenario: "case.0",
      scenarios,
      coverage: Array.from(
        { length: MAX_DIRECT_COVERAGE_ENTRIES },
        (_, index) => ({
          key: `claim.${String(index)}`,
          mode: "direct" as const,
          claim: `Direct claim ${String(index)}`,
          scenarios: [] as const,
        }),
      ),
    });
    const session = createDirectSession({
      definition: direct,
      activation: { kind: "scenario", scenario: "case.0" },
      create: () => ({}),
    });
    if (!session.ok) throw new Error(session.error.message);

    expect(session.value.manifest.scenarios).toHaveLength(MAX_DIRECT_SCENARIOS);
    expect(session.value.manifest.coverage.entries).toHaveLength(
      MAX_DIRECT_COVERAGE_ENTRIES,
    );
    expect(parseDirectSessionManifest(
      JSON.parse(JSON.stringify(session.value.manifest)) as unknown,
    )).toEqual({ ok: true, value: session.value.manifest });
    expect(session.value.dispose()).toBeUndefined();
  });

  test("rejects unknown keys and every catalog consistency violation", () => {
    const manifest = createdManifest();

    expect(parseDirectSessionManifest({
      ...manifest,
      unexpected: true,
    })).toMatchObject({ ok: false, error: { code: "invalid-manifest" } });
    expect(parseDirectSessionManifest({
      ...manifest,
      active: { ...manifest.active, unexpected: true },
    })).toMatchObject({ ok: false, error: { code: "invalid-manifest" } });
    expect(parseDirectSessionManifest({
      ...manifest,
      scenarios: [
        manifest.scenarios[0],
        manifest.scenarios[0],
      ],
    })).toMatchObject({ ok: false, error: { code: "duplicate-scenario" } });
    expect(parseDirectSessionManifest({
      ...manifest,
      defaultScenario: "missing",
    })).toMatchObject({ ok: false, error: { code: "unknown-scenario" } });
    expect(parseDirectSessionManifest({
      ...manifest,
      active: { ...manifest.active, scenario: "missing" },
    })).toMatchObject({ ok: false, error: { code: "unknown-scenario" } });
    expect(parseDirectSessionManifest({
      ...manifest,
      active: { ...manifest.active, route: "/settings" },
    })).toMatchObject({ ok: false, error: { code: "route-mismatch" } });
    expect(parseDirectSessionManifest({
      ...manifest,
      active: {
        ...manifest.active,
        source: "fixture",
      },
    })).toMatchObject({ ok: false, error: { code: "selection-hash-mismatch" } });
    expect(parseDirectSessionManifest({
      ...manifest,
      active: {
        ...manifest.active,
        scenario: "settings.ready",
        route: "/settings",
      },
    })).toMatchObject({ ok: false, error: { code: "selection-hash-mismatch" } });
    expect(parseDirectSessionManifest({
      ...manifest,
      active: {
        ...manifest.active,
        activationHash: "fnv1a-64:0000000000000000",
      },
    })).toMatchObject({ ok: false, error: { code: "selection-hash-mismatch" } });
    expect(parseDirectSessionManifest({
      ...manifest,
      active: {
        ...manifest.active,
        selectionHash: "fnv1a-64:0000000000000000",
      },
    })).toMatchObject({ ok: false, error: { code: "selection-hash-mismatch" } });
    expect(parseDirectSessionManifest({
      ...manifest,
      active: {
        ...manifest.active,
        selectionHash: "not-a-hash",
      },
    })).toMatchObject({ ok: false, error: { code: "invalid-selection-hash" } });
    expect(parseDirectSessionManifest({
      ...manifest,
      coverage: {
        schema: manifest.coverage.schema,
        entries: [{
          key: "chat.empty.visible",
          mode: "fixture",
          claim: "Unknown citation.",
          scenarios: ["missing"],
        }],
      },
    })).toMatchObject({
      ok: false,
      error: { code: "unknown-coverage-scenario" },
    });
    expect(parseDirectSessionManifest({
      ...manifest,
      scenarios: manifest.scenarios.map((scenario, index) =>
        index === 0
          ? { ...scenario, title: `${scenario.title} changed` }
          : scenario
      ),
    })).toMatchObject({ ok: false, error: { code: "catalog-hash-mismatch" } });
    expect(parseDirectSessionManifest({
      ...manifest,
      catalogHash: "not-a-hash",
    })).toMatchObject({ ok: false, error: { code: "invalid-catalog-hash" } });
  });

  test("exposes manifest coverage by the same session object reference", () => {
    const created = createDirectSession({
      definition: definition(),
      activation: { kind: "scenario", scenario: "chat.empty" },
      create: () => ({}),
    });
    if (!created.ok) throw new Error(created.error.message);

    expect(created.value.coverage).toBe(created.value.manifest.coverage);
    expect(String(created.value.manifest.active.scenario)).toBe("chat.empty");
  });

  test("contains structurally hostile manifest creation inside the session Result", () => {
    const direct = definition();
    const hostile = {
      ...direct,
      scenarios: {
        ...direct.scenarios,
        list: () => {
          throw new Error("catalog unavailable");
        },
      },
    };
    expect(() => createDirectSession({
      definition: hostile,
      activation: { kind: "scenario", scenario: "chat.empty" },
      create: () => ({}),
    })).not.toThrow();
    expect(createDirectSession({
      definition: hostile,
      activation: { kind: "scenario", scenario: "chat.empty" },
      create: () => ({}),
    })).toMatchObject({
      ok: false,
      error: { code: "invalid-options", message: "catalog unavailable" },
    });
  });
});
