import { describe, expect, test } from "bun:test";

import {
  createTodoDirectWorld,
  parseTodoDirectWorld,
  POPULATED_TODOS,
} from "./world";

describe("todo Direct world", () => {
  test("parses an owned versioned world", () => {
    const world = createTodoDirectWorld({ todos: POPULATED_TODOS, writeFailure: null });
    expect(parseTodoDirectWorld(JSON.parse(JSON.stringify(world)) as unknown)).toEqual(world);
    expect(Object.isFrozen(world)).toBeTrue();
    expect(Object.isFrozen(world.todos)).toBeTrue();
  });

  test("rejects unknown fields, unsupported versions, and duplicate IDs", () => {
    expect(() => parseTodoDirectWorld({
      version: 1,
      todos: [],
      writeFailure: null,
      extra: true,
    })).toThrow("unknown key");
    expect(() => parseTodoDirectWorld({ version: 2, todos: [], writeFailure: null }))
      .toThrow("version must be 1");
    expect(() => parseTodoDirectWorld({
      version: 1,
      todos: [POPULATED_TODOS[0], POPULATED_TODOS[0]],
      writeFailure: null,
    })).toThrow("repeats ID");
  });

  test("rejects accessors without invoking them", () => {
    let getterWasRead = false;
    const input: Record<string, unknown> = { version: 1, todos: [] };
    Object.defineProperty(input, "writeFailure", {
      enumerable: true,
      get: () => {
        getterWasRead = true;
        return null;
      },
    });

    expect(() => parseTodoDirectWorld(input)).toThrow("data property");
    expect(getterWasRead).toBeFalse();
  });
});
