import type { JsonValue } from "@cclrte/direct";

import type { TodoItem } from "../src/todo-port";

export type TodoDirectItem = {
  readonly [key: string]: JsonValue;
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
};

export type TodoDirectWorld = {
  readonly [key: string]: JsonValue;
  readonly version: 1;
  readonly todos: readonly TodoDirectItem[];
  readonly writeFailure: string | null;
};

const WORLD_KEYS = new Set(["version", "todos", "writeFailure"]);
const TODO_KEYS = new Set(["id", "title", "completed"]);
const TODO_ID = /^[a-z][a-z0-9-]{0,47}$/u;

function exactRecord(
  input: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must have a JSON object prototype.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new Error(`${label} has an unknown key: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) {
      throw new Error(`${label}.${key} must be an enumerable data property.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function parseTodo(input: unknown, index: number): TodoDirectItem {
  const record = exactRecord(input, TODO_KEYS, `todos[${String(index)}]`);
  if (typeof record.id !== "string" || !TODO_ID.test(record.id)) {
    throw new Error(`todos[${String(index)}].id must be a lowercase identifier.`);
  }
  if (
    typeof record.title !== "string"
    || record.title.trim().length === 0
    || record.title.length > 120
  ) {
    throw new Error(`todos[${String(index)}].title must contain 1-120 visible characters.`);
  }
  if (typeof record.completed !== "boolean") {
    throw new Error(`todos[${String(index)}].completed must be boolean.`);
  }
  return Object.freeze({
    id: record.id,
    title: record.title,
    completed: record.completed,
  });
}

export function parseTodoDirectWorld(input: unknown): TodoDirectWorld {
  const record = exactRecord(input, WORLD_KEYS, "Todo Direct world");
  if (record.version !== 1) throw new Error("Todo Direct world version must be 1.");
  if (!Array.isArray(record.todos) || record.todos.length > 100) {
    throw new Error("Todo Direct world todos must contain at most 100 items.");
  }
  const todos = record.todos.map(parseTodo);
  const ids = new Set<string>();
  for (const todo of todos) {
    if (ids.has(todo.id)) throw new Error(`Todo Direct world repeats ID: ${todo.id}`);
    ids.add(todo.id);
  }
  if (
    record.writeFailure !== null
    && (
      typeof record.writeFailure !== "string"
      || record.writeFailure.trim().length === 0
      || record.writeFailure.length > 200
    )
  ) {
    throw new Error("Todo Direct writeFailure must be null or 1-200 visible characters.");
  }
  return Object.freeze({
    version: 1,
    todos: Object.freeze(todos),
    writeFailure: record.writeFailure,
  });
}

export function createTodoDirectWorld(
  input: {
    readonly todos: readonly TodoItem[];
    readonly writeFailure: string | null;
  },
): TodoDirectWorld {
  return parseTodoDirectWorld({ version: 1, ...input });
}

export const POPULATED_TODOS = Object.freeze([
  Object.freeze({ id: "write-docs", title: "Write the public guide", completed: false }),
  Object.freeze({ id: "scan-bundle", title: "Scan the production bundle", completed: true }),
]) satisfies readonly TodoDirectItem[];
