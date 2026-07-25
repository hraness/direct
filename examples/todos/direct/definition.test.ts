import { describe, expect, test } from "bun:test";
import { SCENARIO_QUERY_KEY } from "@hraness/direct";

import { todoDirectDefinition } from "./definition";
import { createTodoDirectSession } from "./session";

describe("todo Direct definition", () => {
  test("activates the default and every stable scenario", () => {
    expect(todoDirectDefinition.activate("")).toMatchObject({
      ok: true,
      value: { scenario: "todos.populated", route: "/" },
    });
    expect(todoDirectDefinition.activate(`?${SCENARIO_QUERY_KEY}=todos.empty`)).toMatchObject({
      ok: true,
      value: { scenario: "todos.empty", world: { todos: [] } },
    });
    expect(todoDirectDefinition.activate(`?${SCENARIO_QUERY_KEY}=missing`)).toMatchObject({
      ok: false,
      error: { code: "unknown-scenario" },
    });
  });

  test("keeps fixture and direct claims exact", () => {
    expect(todoDirectDefinition.coverage.requireExactKeys([
      "todos.empty.render",
      "todos.completion",
      "todos.write.failure",
      "storage.local.direct",
    ])).toEqual({ ok: true, value: true });
    const created = createTodoDirectSession("");
    if (!created.ok) throw new Error(created.error.message);
    const snapshot = created.value.coverage;
    expect(snapshot.schema).toBe("direct.coverage/v2");
    const direct = snapshot.entries.at(-1);
    expect(direct).toBeDefined();
    if (direct === undefined) throw new Error("Direct storage coverage is missing");
    expect({
      ...direct,
      key: String(direct.key),
      scenarios: [...direct.scenarios],
    }).toEqual({
      key: "storage.local.direct",
      mode: "direct",
      claim: "Browser local-storage parsing, quota behavior, and persistence require direct production-adapter evidence.",
      scenarios: [],
    });
    created.value.dispose();
  });
});
