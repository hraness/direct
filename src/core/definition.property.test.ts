import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "./test-support.js";

import { defineDirect, parseDirectDefinition } from "./definition.js";
import { FIXTURE_QUERY_KEY } from "./query.js";
import { parseTestWorld } from "./test-support.js";

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
});
describe("Direct definition properties", () => {
  test("unreserved query parameters cannot perturb the default activation", () => {
    assertProperty(fc.property(
      fc.array(fc.tuple(
        fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u).filter((key) => !key.startsWith("__")),
        fc.string({ maxLength: 24 }),
      ), { maxLength: 12 }),
      (entries) => {
        const query = new URLSearchParams(entries).toString();
        const activation = created.activate(query);
        expect(activation).toMatchObject({
          ok: true,
          value: { scenario: "chat.empty", source: "scenario" },
        });
      },
    ));
  });

  test("foreign scenario identifiers never throw", () => {
    assertProperty(fc.property(fc.anything(), (candidate) => {
      expect(() => created.activateScenario(candidate)).not.toThrow();
    }));
  });

  test("foreign definition values never escape the fallible boundary", () => {
    assertProperty(fc.property(fc.anything(), (candidate) => {
      expect(() => parseDirectDefinition(candidate)).not.toThrow();
    }));
  });

  test("every serialized fixture within the default bound activates through its encoded query", () => {
    assertProperty(fc.property(
      fc.integer(),
      fc.array(fc.string({ maxLength: 64 }), { maxLength: 50 }),
      (count, messages) => {
        const serialized = created.serializeFixture({
          scenario: "chat.empty",
          world: { count, messages },
        });
        if (!serialized.ok) throw new Error(serialized.error.message);

        expect(created.activate(
          `?${FIXTURE_QUERY_KEY}=${encodeURIComponent(serialized.value)}`,
        )).toMatchObject({
          ok: true,
          value: {
            source: "fixture",
            scenario: "chat.empty",
            world: { count, messages },
          },
        });
      },
    ));
  });
});
