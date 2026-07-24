import { describe, expect, test } from "bun:test";

import { createCoverageCatalogSnapshot } from "../core/coverage.js";
import { defineDirect } from "../core/definition.js";
import { parseTestWorld } from "../core/test-support.js";
import { parseDefinitionCoverageSnapshot } from "./coverage-binding.js";

const definition = defineDirect({
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
});

describe("definition-bound coverage parsing", () => {
  test("returns the definition-owned typed snapshot only after exact wire equality", () => {
    const expected = createCoverageCatalogSnapshot(definition.coverage);
    const parsed = parseDefinitionCoverageSnapshot(
      JSON.parse(JSON.stringify(expected)) as unknown,
      definition,
    );
    expect(parsed).toEqual({ ok: true, value: expected });
  });

  test("distinguishes malformed coverage from valid but stale coverage", () => {
    expect(parseDefinitionCoverageSnapshot({ schema: "wrong", entries: [] }, definition)).toMatchObject({
      ok: false,
      error: { code: "invalid-coverage", coverageError: { code: "invalid-coverage" } },
    });

    const expected = createCoverageCatalogSnapshot(definition.coverage);
    expect(parseDefinitionCoverageSnapshot({ ...expected, entries: [] }, definition)).toMatchObject({
      ok: false,
      error: { code: "coverage-mismatch", coverageError: null },
    });
    expect(parseDefinitionCoverageSnapshot({
      ...expected,
      entries: expected.entries.map((entry) => ({ ...entry, mode: "mixed" })),
    }, definition)).toMatchObject({ ok: false, error: { code: "coverage-mismatch" } });
    expect(parseDefinitionCoverageSnapshot({
      ...expected,
      entries: expected.entries.map((entry) => ({ ...entry, claim: `${entry.claim} stale` })),
    }, definition)).toMatchObject({ ok: false, error: { code: "coverage-mismatch" } });
  });
});
