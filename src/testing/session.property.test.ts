import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "../core/test-support.js";

import { defineDirect } from "../core/definition.js";
import { parseTestWorld } from "../core/test-support.js";
import { createDirectSession } from "./session.js";

const definition = defineDirect({
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
describe("Direct session properties", () => {
  test("arbitrary hostile structural activations never escape the Result boundary", () => {
    assertProperty(fc.property(
      fc.string(),
      fc.constantFrom("throw", "hostile-result"),
      (message, behavior) => {
        const hostileDefinition = {
          ...definition,
          activateScenario: behavior === "throw"
            ? () => { throw new Error(message); }
            : () => new Proxy({}, {
              get: () => { throw new Error(message); },
            }),
        };
        const create = () => createDirectSession({
          definition: hostileDefinition as never,
          activation: { kind: "scenario", scenario: "chat.empty" },
          create: () => ({}),
        });
        expect(create).not.toThrow();
        expect(create()).toMatchObject({ ok: false, error: { code: "invalid-options" } });
      },
    ));
  });

  test("disposal runs each registered cleanup exactly once in reverse order", () => {
    assertProperty(fc.property(
      fc.array(fc.integer(), { maxLength: 100 }),
      fc.integer({ min: 1, max: 10 }),
      (values, disposeCalls) => {
        const observed: number[] = [];
        const created = createDirectSession({
          definition,
          activation: { kind: "query", source: "" },
          create: (context) => {
            for (const value of values) {
              const activity = context.activity.begin("property-cleanup");
              if (!activity.ok) throw new Error(activity.error.message);
              context.onDispose(() => {
                observed.push(value);
                expect(activity.value.release()).toEqual({ ok: true, value: true });
                return undefined;
              });
            }
            return {};
          },
          observe: () => ({}),
        });
        if (!created.ok) throw new Error(created.error.message);
        expect(created.value.store.getSnapshot().activity).toEqual({
          active: values.length,
          started: values.length,
          settled: 0,
        });
        for (let index = 0; index < disposeCalls; index += 1) {
          created.value.dispose();
          expect(created.value.activity.begin("after-disposal")).toMatchObject({
            ok: false,
            error: { code: "scope-closed" },
          });
        }
        expect(observed).toEqual([...values].reverse());
        expect(created.value.store.getSnapshot().activity).toEqual({
          active: 0,
          started: values.length,
          settled: values.length,
        });
        expect(created.value.probe.isQuiescent()).toEqual({ ok: true, value: true });
      },
    ));
  });
});
