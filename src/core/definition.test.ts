import { describe, expect, test } from "bun:test";

import {
  defineDirect,
  parseDirectDefinition,
  tryDefineDirect,
} from "./definition.js";
import { MAX_DIRECT_COVERAGE_ENTRIES } from "./coverage.js";
import { DEFAULT_MAX_FIXTURE_BYTES } from "./fixture.js";
import { utf8ByteLength } from "./json.js";
import {
  DEFAULT_MAX_QUERY_BYTES,
  FIXTURE_QUERY_KEY,
  SCENARIO_QUERY_KEY,
} from "./query.js";
import { MAX_DIRECT_SCENARIOS } from "./scenario.js";
import { parseTestWorld, type TestRoute, type TestWorld } from "./test-support.js";

function definition() {
  return defineDirect({
    parseWorld: parseTestWorld,
    defaultScenario: "chat.empty",
    scenarios: [
      {
        id: "chat.empty",
        title: "Empty chat",
        route: "/chat",
        world: { count: 0, messages: [] },
      },
      {
        id: "settings.ready",
        title: "Ready settings",
        route: "/settings",
        world: { count: 1, messages: ["ready"] },
      },
    ],
    coverage: [
      {
        key: "chat.empty",
        mode: "fixture",
        claim: "The empty chat state renders",
        scenarios: ["chat.empty"],
      },
    ],
  });
}

function authoredTypeContracts(): void {
  defineDirect({
    parseWorld: parseTestWorld,
    // @ts-expect-error Authored defaults must name a scenario in the same definition.
    defaultScenario: "chat.missing",
    scenarios: [{
      id: "chat.empty",
      title: "Empty chat",
      route: "/chat",
      world: { count: 0, messages: [] },
    }],
    coverage: [],
  });
  defineDirect({
    parseWorld: parseTestWorld,
    defaultScenario: "chat.empty",
    scenarios: [{
      id: "chat.empty",
      title: "Empty chat",
      route: "/chat",
      world: { count: 0, messages: [] },
    }],
    coverage: [{
      key: "chat.missing",
      mode: "fixture",
      claim: "A missing scenario cannot prove this claim",
      // @ts-expect-error Authored coverage must cite a scenario in the same definition.
      scenarios: ["chat.missing"],
    }],
  });
  defineDirect({
    parseWorld: parseTestWorld,
    defaultScenario: "chat.empty",
    scenarios: [{
      id: "chat.empty",
      title: "Empty chat",
      route: "/chat",
      world: { count: 0, messages: [] },
    }],
    coverage: [{
      key: "chat.route",
      mode: "fixture",
      claim: "Coverage resolves routes through cited scenarios",
      // @ts-expect-error Coverage must not duplicate a singular scenario route.
      route: "/chat",
      scenarios: ["chat.empty"],
    }],
  });
  defineDirect({
    parseWorld: parseTestWorld,
    defaultScenario: "chat.empty",
    scenarios: [{
      id: "chat.empty",
      title: "Empty chat",
      route: "/chat",
      world: { count: 0, messages: [] },
    }],
    coverage: [
      {
        key: "native.direct",
        mode: "direct",
        claim: "The native host requires direct evidence",
        // @ts-expect-error Direct evidence cannot cite deterministic scenarios.
        scenarios: ["chat.empty"],
      },
    ],
  });
  defineDirect({
    parseWorld: parseTestWorld,
    defaultScenario: "chat.empty",
    scenarios: [{
      id: "chat.empty",
      title: "Empty chat",
      route: "/chat",
      world: { count: 0, messages: [] },
    }],
    coverage: [
      // @ts-expect-error Fixture evidence must cite at least one scenario.
      {
        key: "chat.fixture",
        mode: "fixture",
        claim: "The fixture renders",
        scenarios: [],
      },
    ],
  });
}
void authoredTypeContracts;

describe("Direct definition", () => {
  test("parses a genuinely unknown definition without asserting it into an owned type", () => {
    const input: unknown = {
      parseWorld: parseTestWorld,
      defaultScenario: "chat.empty",
      scenarios: [{
        id: "chat.empty",
        title: "Empty chat",
        route: "/chat",
        world: { count: 0, messages: [] },
      }],
      coverage: [{
        key: "chat.empty",
        mode: "fixture",
        claim: "The empty chat state renders",
        scenarios: ["chat.empty"],
      }],
    };
    const parsed = parseDirectDefinition(input);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.activate("")).toMatchObject({
      ok: true,
      value: { scenario: "chat.empty", route: "/chat", world: { count: 0 } },
    });

    const hostile = new Proxy({}, {
      get: () => {
        throw new Error("foreign definition getter failed");
      },
    });
    expect(parseDirectDefinition(hostile)).toMatchObject({
      ok: false,
      error: { code: "invalid-options", message: "foreign definition getter failed" },
    });
  });

  test("validates configuration once and activates the default for an empty query", () => {
    const created = definition();

    expect(String(created.defaultScenario.id)).toBe("chat.empty");
    expect(created.coverage.keys().map(String)).toEqual(["chat.empty"]);
    expect(created.activate("?tab=recent")).toMatchObject({
      ok: true,
      value: {
        kind: "active",
        source: "scenario",
        scenario: "chat.empty",
        route: "/chat",
        world: { count: 0, messages: [] },
      },
    });
  });

  test("keeps explicit activation fail-closed instead of falling back", () => {
    const created = definition();

    expect(created.activateScenario("settings.ready")).toMatchObject({
      ok: true,
      value: { scenario: "settings.ready", route: "/settings" },
    });
    expect(created.activate(`?${SCENARIO_QUERY_KEY}=missing`)).toMatchObject({
      ok: false,
      error: { code: "unknown-scenario" },
    });
  });

  test("rejects an unknown default and coverage drift", () => {
    const unknownDefault = tryDefineDirect<TestWorld, TestRoute>({
      parseWorld: parseTestWorld,
      defaultScenario: "missing",
      scenarios: [{
        id: "chat.empty",
        title: "Empty chat",
        route: "/chat",
        world: { count: 0, messages: [] },
      }],
      coverage: [],
    });
    expect(unknownDefault).toMatchObject({
      ok: false,
      error: { code: "invalid-default-scenario" },
    });

    const unknownCoverageScenario = tryDefineDirect<TestWorld, TestRoute>({
      parseWorld: parseTestWorld,
      defaultScenario: "chat.empty",
      scenarios: [{
        id: "chat.empty",
        title: "Empty chat",
        route: "/chat",
        world: { count: 0, messages: [] },
      }],
      coverage: [{
        key: "chat.ready",
        mode: "fixture",
        claim: "Ready chat renders",
        scenarios: ["chat.ready"],
      }],
    });
    expect(unknownCoverageScenario).toMatchObject({
      ok: false,
      error: { code: "invalid-coverage", coverageError: { code: "unknown-scenario" } },
    });

    try {
      defineDirect({
        parseWorld: parseTestWorld,
        // Deliberately bypass the authored type law to verify the runtime boundary.
        defaultScenario: "missing" as "chat.empty",
        scenarios: [{
          id: "chat.empty",
          title: "Empty chat",
          route: "/chat",
          world: { count: 0, messages: [] },
        }],
        coverage: [],
      });
      throw new Error("Invalid authored definition unexpectedly succeeded");
    } catch (reason) {
      expect(reason).toBeInstanceOf(Error);
      expect((reason as Error).cause).toMatchObject({ code: "invalid-default-scenario" });
    }
  });

  test("rejects invalid activation limits before accepting the definition", () => {
    const created = tryDefineDirect<TestWorld, TestRoute>({
      parseWorld: parseTestWorld,
      defaultScenario: "chat.empty",
      scenarios: [{
        id: "chat.empty",
        title: "Empty chat",
        route: "/chat",
        world: { count: 0, messages: [] },
      }],
      coverage: [],
      maxQueryBytes: 0,
    });
    expect(created).toMatchObject({ ok: false, error: { code: "invalid-limits" } });
  });

  test("rejects catalogs larger than the bounded discovery contract", () => {
    const tooManyScenarios = tryDefineDirect<TestWorld, TestRoute>({
      parseWorld: parseTestWorld,
      defaultScenario: "case.0",
      scenarios: Array.from(
        { length: MAX_DIRECT_SCENARIOS + 1 },
        (_, index) => ({
          id: `case.${String(index)}`,
          title: `Case ${String(index)}`,
          route: "/chat" as const,
          world: { count: index, messages: [] },
        }),
      ),
      coverage: [],
    });
    expect(tooManyScenarios).toMatchObject({
      ok: false,
      error: {
        code: "invalid-scenarios",
        scenarioError: { code: "too-many-scenarios" },
      },
    });

    const tooManyCoverageEntries = tryDefineDirect<TestWorld, TestRoute>({
      parseWorld: parseTestWorld,
      defaultScenario: "case.ready",
      scenarios: [{
        id: "case.ready",
        title: "Ready case",
        route: "/chat",
        world: { count: 0, messages: [] },
      }],
      coverage: Array.from(
        { length: MAX_DIRECT_COVERAGE_ENTRIES + 1 },
        (_, index) => ({
          key: `claim.${String(index)}`,
          mode: "direct" as const,
          claim: `Claim ${String(index)}`,
          scenarios: [] as const,
        }),
      ),
    });
    expect(tooManyCoverageEntries).toMatchObject({
      ok: false,
      error: {
        code: "invalid-coverage",
        coverageError: { code: "too-many-coverage-entries" },
      },
    });
  });

  test("freezes limits and binds fixture parsing, creation, and serialization to them", () => {
    const created = defineDirect({
      parseWorld: parseTestWorld,
      defaultScenario: "chat.empty",
      scenarios: [{
        id: "chat.empty",
        title: "Empty chat",
        route: "/chat",
        world: { count: 0, messages: [] },
      }],
      coverage: [],
      maxFixtureBytes: 256,
      maxQueryBytes: 1_024,
    });
    expect(created.limits).toEqual({ maxFixtureBytes: 256, maxQueryBytes: 1_024 });
    expect(Object.isFrozen(created.limits)).toBeTrue();
    const serialized = created.serializeFixture({
      scenario: "chat.empty",
      world: { count: 1, messages: ["portable"] },
    });
    if (!serialized.ok) throw new Error(serialized.error.message);
    expect(created.parseFixtureJson(serialized.value)).toMatchObject({
      ok: true,
      value: { scenario: "chat.empty", route: "/chat", world: { count: 1 } },
    });
    expect(created.createFixture({
      scenario: "chat.empty",
      world: { count: 1, messages: ["x".repeat(512)] },
    })).toMatchObject({ ok: false, error: { code: "oversized-fixture" } });
  });

  test("rejects limits that cannot carry every valid fixture through the query boundary", () => {
    expect(tryDefineDirect<TestWorld, TestRoute>({
      parseWorld: parseTestWorld,
      defaultScenario: "chat.empty",
      scenarios: [{
        id: "chat.empty",
        title: "Empty chat",
        route: "/chat",
        world: { count: 0, messages: [] },
      }],
      coverage: [],
      maxFixtureBytes: 256,
      maxQueryBytes: 512,
    })).toMatchObject({ ok: false, error: { code: "invalid-limits" } });
  });

  test("activates an exactly byte-limit fixture with worst-case-heavy percent encoding", () => {
    const created = definition();
    const baseline = created.serializeFixture({
      scenario: "chat.empty",
      world: { count: 0, messages: [""] },
    });
    if (!baseline.ok) throw new Error(baseline.error.message);
    const remainingBytes = DEFAULT_MAX_FIXTURE_BYTES - utf8ByteLength(baseline.value);
    expect(remainingBytes).toBeGreaterThan(0);
    expect(remainingBytes % 2).toBe(0);
    const messages = ['"'.repeat(remainingBytes / 2)];
    const serialized = created.serializeFixture({
      scenario: "chat.empty",
      world: { count: 0, messages },
    });
    if (!serialized.ok) throw new Error(serialized.error.message);
    expect(utf8ByteLength(serialized.value)).toBe(DEFAULT_MAX_FIXTURE_BYTES);

    const query = `?${FIXTURE_QUERY_KEY}=${encodeURIComponent(serialized.value)}`;
    expect(utf8ByteLength(query)).toBeLessThanOrEqual(DEFAULT_MAX_QUERY_BYTES);
    expect(created.activate(query)).toMatchObject({
      ok: true,
      value: { source: "fixture", world: { count: 0, messages } },
    });
  });
});
