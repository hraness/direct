import { expect, test } from "bun:test";
import { assertProperty, fc } from "./test-support.js";
import { utf8ByteLength } from "./json.js";
import {
  FIXTURE_QUERY_KEY,
  SCENARIO_QUERY_KEY,
  maximumFixtureQueryBytes,
  parseDirectQuery,
} from "./query.js";
import { parseFixtureEnvelope, parseFixtureJson, serializeFixtureJson } from "./fixture.js";
import { parseTestWorld, testScenarios } from "./test-support.js";

test("property: query and fixture parsers are total over arbitrary input", () => {
  assertProperty(fc.property(
    fc.anything({ withBigInt: true }),
    fc.anything({ withBigInt: true }),
    (query, fixture) => {
      const options = { scenarios: testScenarios(), parseWorld: parseTestWorld };
      expect(() => parseDirectQuery(query, options)).not.toThrow();
      expect(() => parseFixtureEnvelope(fixture, options)).not.toThrow();
      expect(() => parseFixtureJson(query, options)).not.toThrow();
    },
  ));
});

test("property: duplicate activation parameters are rejected regardless of their values", () => {
  assertProperty(fc.property(fc.string(), fc.string(), (first, second) => {
    const options = { scenarios: testScenarios(), parseWorld: parseTestWorld };
    const query = `?${SCENARIO_QUERY_KEY}=${encodeURIComponent(first)}&x=kept&${SCENARIO_QUERY_KEY}=${encodeURIComponent(second)}`;
    expect(parseDirectQuery(query, options)).toMatchObject({
      ok: false,
      error: { code: "duplicate-parameter" },
    });
  }));
});

test("property: created fixtures survive their canonical JSON round trip", () => {
  assertProperty(fc.property(
    fc.integer(),
    fc.array(fc.string(), { maxLength: 50 }),
    (count, messages) => {
      const options = { scenarios: testScenarios(), parseWorld: parseTestWorld };
      const serialized = serializeFixtureJson({
        scenario: "chat.empty",
        world: { count, messages },
      }, options);
      if (!serialized.ok) throw new Error(serialized.error.message);
      expect(parseFixtureJson(serialized.value, options)).toEqual(parseFixtureEnvelope(
        JSON.parse(serialized.value),
        options,
      ));
    },
  ));
});

test("property: the query bound covers worst-case percent encoding of JSON text", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    const source = JSON.stringify(value);
    if (source === undefined) throw new Error("JSON values must serialize");
    const query = `?${FIXTURE_QUERY_KEY}=${encodeURIComponent(source)}`;

    expect(utf8ByteLength(query)).toBeLessThanOrEqual(
      maximumFixtureQueryBytes(utf8ByteLength(source)),
    );
  }));
});
