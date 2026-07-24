import { describe, expect, test } from "bun:test";

import { createCoverageCatalogSnapshot, type CoverageMode } from "../core/coverage.js";
import { defineDirect } from "../core/definition.js";
import { assertProperty, fc, parseTestWorld } from "../core/test-support.js";
import { parseDefinitionCoverageSnapshot } from "./coverage-binding.js";

const definition = defineDirect({
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
      id: "chat.ready",
      title: "Ready chat",
      route: "/chat",
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
    {
      key: "chat.ready",
      mode: "mixed",
      claim: "The ready chat state renders before direct service evidence",
      scenarios: ["chat.ready"],
    },
  ],
});

interface MutableCoverageEntry {
  key: string;
  mode: CoverageMode;
  claim: string;
  scenarios: string[];
}

describe("definition-bound coverage properties", () => {
  test("every generated semantic mutation is rejected as drift", () => {
    assertProperty(fc.property(
      fc.integer({ min: 0, max: 1 }),
      fc.constantFrom("claim", "delete", "key", "mode", "reorder", "scenario"),
      fc.stringMatching(/^[a-z]{1,8}$/u),
      (index, mutation, suffix) => {
        const snapshot = createCoverageCatalogSnapshot(definition.coverage);
        const entries: MutableCoverageEntry[] = snapshot.entries.map((entry) => ({
          ...entry,
          scenarios: [...entry.scenarios],
        }));
        const selected = entries[index];
        if (selected === undefined) throw new Error("generated coverage index is out of range");
        switch (mutation) {
          case "claim":
            selected.claim = `${selected.claim} ${suffix}`;
            break;
          case "delete":
            entries.splice(index, 1);
            break;
          case "key":
            selected.key = `${selected.key}.${suffix}`;
            break;
          case "mode":
            selected.mode = selected.mode === "fixture" ? "mixed" : "fixture";
            break;
          case "reorder":
            entries.reverse();
            break;
          case "scenario":
            selected.scenarios = [`chat.${suffix}`];
            break;
        }
        expect(parseDefinitionCoverageSnapshot({ ...snapshot, entries }, definition)).toMatchObject({
          ok: false,
          error: { code: "coverage-mismatch" },
        });
      },
    ));
  });
});
