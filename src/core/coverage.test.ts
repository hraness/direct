import { describe, expect, test } from "bun:test";

import {
  DIRECT_COVERAGE_SCHEMA,
  MAX_DIRECT_COVERAGE_ENTRIES,
  createCoverageCatalog,
  createCoverageCatalogSnapshot,
  parseCoverageCatalogSnapshot,
} from "./coverage.js";
import { testScenarios } from "./test-support.js";

describe("coverage wire snapshots", () => {
  test("creates and parses an exact versioned frozen snapshot", () => {
    const catalog = createCoverageCatalog([
      {
        key: "chat.ready",
        mode: "fixture",
        claim: "Ready chat renders",
        scenarios: ["chat.ready"],
      },
      {
        key: "native.lifecycle",
        mode: "direct",
        claim: "The native host survives a lifecycle transition",
        scenarios: [],
      },
    ]);
    if (!catalog.ok) throw new Error(catalog.error.message);
    const snapshot = createCoverageCatalogSnapshot(catalog.value);
    const parsed = parseCoverageCatalogSnapshot(JSON.parse(JSON.stringify(snapshot)));
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.schema).toBe(DIRECT_COVERAGE_SCHEMA);
    expect(parsed.value.entries.map(({ key }) => String(key))).toEqual(["chat.ready", "native.lifecycle"]);
    expect(parsed.value.entries.some((entry) => "route" in entry)).toBeFalse();
    expect(Object.isFrozen(parsed.value)).toBeTrue();
    expect(Object.isFrozen(parsed.value.entries)).toBeTrue();
  });

  test("rejects foreign keys, incomplete entries, legacy schemas, and invalid proof modes", () => {
    expect(parseCoverageCatalogSnapshot({ schema: DIRECT_COVERAGE_SCHEMA, entries: [{
      key: "chat.ready",
      mode: "fixture",
      claim: "Ready chat renders",
      scenarios: ["chat.ready"],
      status: "verified",
    }] })).toMatchObject({ ok: false, error: { code: "invalid-coverage" } });
    expect(parseCoverageCatalogSnapshot({
      schema: DIRECT_COVERAGE_SCHEMA,
      entries: [{ key: "chat.ready" }],
    })).toMatchObject({
      ok: false,
      error: { code: "invalid-coverage" },
    });
    expect(parseCoverageCatalogSnapshot({ schema: DIRECT_COVERAGE_SCHEMA, entries: [{
      key: "chat.ready",
      mode: "probable",
      claim: "Ready chat renders",
      scenarios: ["chat.ready"],
    }] })).toMatchObject({ ok: false, error: { code: "invalid-coverage" } });
    expect(parseCoverageCatalogSnapshot({ schema: "direct.coverage/v1", entries: [] })).toMatchObject({
      ok: false,
      error: { code: "invalid-coverage" },
    });
    expect(parseCoverageCatalogSnapshot({
      schema: DIRECT_COVERAGE_SCHEMA,
      entries: [],
      status: "verified",
    })).toMatchObject({ ok: false, error: { code: "invalid-coverage" } });
  });

  test("rejects inconsistent mode scenarios and legacy singular routes", () => {
    const snapshot = (entry: unknown) => ({
      schema: DIRECT_COVERAGE_SCHEMA,
      entries: [entry],
    });
    expect(parseCoverageCatalogSnapshot(snapshot({
      key: "native.direct",
      mode: "direct",
      claim: "Requires native evidence",
      scenarios: ["case.ready"],
    }))).toMatchObject({ ok: false, error: { code: "invalid-mode" } });
    expect(parseCoverageCatalogSnapshot(snapshot({
      key: "case.fixture",
      mode: "fixture",
      claim: "Uses deterministic evidence",
      scenarios: [],
    }))).toMatchObject({ ok: false, error: { code: "invalid-mode" } });
    expect(parseCoverageCatalogSnapshot(snapshot({
      key: "case.fixture",
      mode: "fixture",
      claim: "Uses deterministic evidence",
      route: "/",
      scenarios: ["case.ready"],
    }))).toMatchObject({ ok: false, error: { code: "invalid-coverage" } });
  });

  test("lets one claim cite catalog scenarios on different routes", () => {
    const catalog = createCoverageCatalog([{
      key: "surface.cross-route",
      mode: "mixed",
      claim: "The shared surface behaves across chat and settings",
      scenarios: ["chat.empty", "settings.ready"],
    }], testScenarios());
    if (!catalog.ok) throw new Error(catalog.error.message);

    expect(catalog.value.list().map((entry) => ({
      ...entry,
      key: String(entry.key),
      scenarios: entry.scenarios.map(String),
    }))).toEqual([{
      key: "surface.cross-route",
      mode: "mixed",
      claim: "The shared surface behaves across chat and settings",
      scenarios: ["chat.empty", "settings.ready"],
    }]);
  });

  test("parses the largest definition-bound coverage catalog with long scenario ids", () => {
    const scenarioIds = Array.from(
      { length: MAX_DIRECT_COVERAGE_ENTRIES },
      (_, index) => `case.${String(index).padStart(3, "0")}.${"x".repeat(110)}`,
    );
    const catalog = createCoverageCatalog(Array.from(
      { length: MAX_DIRECT_COVERAGE_ENTRIES },
      (_, index) => ({
        key: `claim.${String(index)}`,
        mode: "fixture" as const,
        claim: `Fixture claim ${String(index)}`,
        scenarios: scenarioIds as [string, ...string[]],
      }),
    ));
    if (!catalog.ok) throw new Error(catalog.error.message);
    const snapshot = createCoverageCatalogSnapshot(catalog.value);
    const encoded = JSON.stringify(snapshot);

    expect(new TextEncoder().encode(encoded).byteLength).toBeGreaterThan(1_048_576);
    expect(parseCoverageCatalogSnapshot(JSON.parse(encoded) as unknown)).toEqual({
      ok: true,
      value: snapshot,
    });
  });
});
