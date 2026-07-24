import { expect, test } from "bun:test";
import { FIXTURE_SCHEMA } from "./fixture.js";
import { FIXTURE_QUERY_KEY, SCENARIO_QUERY_KEY, parseDirectQuery } from "./query.js";
import { parseTestWorld, testScenarios } from "./test-support.js";

const fixture = JSON.stringify({
  schema: FIXTURE_SCHEMA,
  scenario: "chat.empty",
  route: "/chat",
  world: { count: 2, messages: ["fixture"] },
});

const options = () => ({ scenarios: testScenarios(), parseWorld: parseTestWorld });

test("query activation is stable and preserves unrelated application parameters", () => {
  const first = parseDirectQuery(`?tab=recent&__scenario=host-owned&${SCENARIO_QUERY_KEY}=chat.empty`, options());
  const second = parseDirectQuery(`?${SCENARIO_QUERY_KEY}=chat.empty&tab=other`, options());
  expect(first).toMatchObject({ ok: true, value: { kind: "active", source: "scenario", route: "/chat" } });
  expect(second).toMatchObject({ ok: true, value: { kind: "active", source: "scenario", route: "/chat" } });
  if (first.ok && second.ok && first.value.kind === "active" && second.value.kind === "active") {
    expect(first.value.activationHash).toBe(second.value.activationHash);
  }
});

test("query activation accepts a matching scenario guard and fixture", () => {
  const result = parseDirectQuery(
    `?${SCENARIO_QUERY_KEY}=chat.empty&${FIXTURE_QUERY_KEY}=${encodeURIComponent(fixture)}`,
    options(),
  );
  expect(result).toMatchObject({
    ok: true,
    value: { kind: "active", source: "fixture", scenario: "chat.empty", world: { count: 2 } },
  });
});

test.each([
  ["duplicate", `?${SCENARIO_QUERY_KEY}=chat.empty&${SCENARIO_QUERY_KEY}=chat.empty`, "duplicate-parameter"],
  ["unknown reserved", "?__direct_mode=loose", "unknown-parameter"],
  ["unknown scenario", `?${SCENARIO_QUERY_KEY}=chat.missing`, "unknown-scenario"],
  ["malformed encoding", `?${SCENARIO_QUERY_KEY}=%ZZ`, "invalid-encoding"],
])("rejects %s activation", (_name, source, code) => {
  expect(parseDirectQuery(source, options())).toMatchObject({ ok: false, error: { code } });
});

test("rejects mismatched fixture guards and bounded queries", () => {
  const mismatch = parseDirectQuery(
    `?${SCENARIO_QUERY_KEY}=settings.ready&${FIXTURE_QUERY_KEY}=${encodeURIComponent(fixture)}`,
    options(),
  );
  expect(mismatch).toMatchObject({ ok: false, error: { code: "mismatched-scenario" } });
  expect(parseDirectQuery(`?${SCENARIO_QUERY_KEY}=${"a".repeat(100)}`, {
    ...options(),
    maxQueryBytes: 20,
  })).toMatchObject({ ok: false, error: { code: "oversized-query" } });
});
