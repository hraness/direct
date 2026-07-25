import {
  cloneTodos,
  TodoPortError,
  type TodoItem,
  type TodoPort,
} from "./todo-port";

export const TODO_STORAGE_KEY = "hraness.todo-example/v1";

const TODO_KEYS = new Set(["id", "title", "completed"]);
const TODO_ID = /^[a-z][a-z0-9-]{0,47}$/u;
const MAX_STORAGE_FAILURE_MESSAGE_LENGTH = 500;

function storageFailureMessage(reason: unknown, fallback: string): string {
  if ((typeof reason !== "object" || reason === null) && typeof reason !== "function") {
    return fallback;
  }
  try {
    const message: unknown = Reflect.get(reason, "message");
    return typeof message === "string" && message.length > 0
      ? message.slice(0, MAX_STORAGE_FAILURE_MESSAGE_LENGTH)
      : fallback;
  } catch {
    return fallback;
  }
}

function readStoredTodoRecord(input: unknown, index: number): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TodoPortError("invalid-storage", `Stored todo ${String(index)} must be an object.`);
  }
  let prototype: unknown;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(input);
    keys = Reflect.ownKeys(input);
  } catch {
    throw new TodoPortError("invalid-storage", `Stored todo ${String(index)} could not be inspected.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TodoPortError("invalid-storage", `Stored todo ${String(index)} has an invalid prototype.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !TODO_KEYS.has(key)) {
      throw new TodoPortError("invalid-storage", `Stored todo ${String(index)} has an unknown field.`);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
    } catch {
      throw new TodoPortError("invalid-storage", `Stored todo ${String(index)} could not be inspected.`);
    }
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) {
      throw new TodoPortError("invalid-storage", `Stored todo ${String(index)} must use data fields.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function readStoredTodoArray(input: unknown): readonly unknown[] {
  let arrayInput: unknown[] | undefined;
  try {
    if (Array.isArray(input)) arrayInput = input;
  } catch {
    throw new TodoPortError("invalid-storage", "Stored todos could not be inspected.");
  }
  if (arrayInput === undefined) {
    throw new TodoPortError("invalid-storage", "Stored todos must be an array of at most 100 items.");
  }

  let prototype: unknown;
  let keys: readonly PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(arrayInput);
    keys = Reflect.ownKeys(arrayInput);
    lengthDescriptor = Object.getOwnPropertyDescriptor(arrayInput, "length");
  } catch {
    throw new TodoPortError("invalid-storage", "Stored todos could not be inspected.");
  }
  if (prototype !== Array.prototype && prototype !== null) {
    throw new TodoPortError("invalid-storage", "Stored todos have an invalid prototype.");
  }
  const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
    ? lengthDescriptor.value as unknown
    : undefined;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 100) {
    throw new TodoPortError("invalid-storage", "Stored todos must be an array of at most 100 items.");
  }

  const expectedKeys = new Set<PropertyKey>(["length"]);
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    expectedKeys.add(key);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(arrayInput, key);
    } catch {
      throw new TodoPortError("invalid-storage", "Stored todos could not be inspected.");
    }
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TodoPortError("invalid-storage", "Stored todos must use dense data entries.");
    }
    output.push(descriptor.value);
  }
  if (keys.some((key) => !expectedKeys.has(key))) {
    throw new TodoPortError("invalid-storage", "Stored todos contain an unknown array field.");
  }
  return output;
}

export function parseStoredTodos(input: unknown): readonly TodoItem[] {
  const storedTodos = readStoredTodoArray(input);
  const ids = new Set<string>();
  const todos: TodoItem[] = [];
  for (const [index, candidate] of storedTodos.entries()) {
    const record = readStoredTodoRecord(candidate, index);
    if (
      typeof record.id !== "string"
      || !TODO_ID.test(record.id)
      || typeof record.title !== "string"
      || record.title.trim().length === 0
      || record.title.length > 120
      || typeof record.completed !== "boolean"
    ) {
      throw new TodoPortError("invalid-storage", `Stored todo ${String(index)} is invalid.`);
    }
    if (ids.has(record.id)) {
      throw new TodoPortError("invalid-storage", `Stored todo ID is duplicated: ${record.id}`);
    }
    ids.add(record.id);
    todos.push({ id: record.id, title: record.title, completed: record.completed });
  }
  return cloneTodos(todos);
}

export function createLocalStorageTodoPort(storage: Storage): TodoPort {
  const readTodos = (): Promise<readonly TodoItem[]> => Promise.resolve().then(() => {
    let encoded: string | null;
    try {
      encoded = storage.getItem(TODO_STORAGE_KEY);
    } catch (reason) {
      throw new TodoPortError(
        "storage-unavailable",
        storageFailureMessage(reason, "Browser storage could not be read."),
      );
    }
    if (encoded === null) return Object.freeze([]);
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded) as unknown;
    } catch {
      throw new TodoPortError("invalid-storage", "Stored todos are not valid JSON.");
    }
    return parseStoredTodos(decoded);
  });

  return Object.freeze({
    readTodos,
    setCompleted: async (id: string, completed: boolean): Promise<readonly TodoItem[]> => {
      const current = await readTodos();
      if (!current.some((todo) => todo.id === id)) {
        throw new TodoPortError("todo-not-found", `Todo does not exist: ${id}`);
      }
      const updated = cloneTodos(current.map((todo) => (
        todo.id === id ? { ...todo, completed } : todo
      )));
      try {
        storage.setItem(TODO_STORAGE_KEY, JSON.stringify(updated));
      } catch (reason) {
        throw new TodoPortError(
          "storage-unavailable",
          storageFailureMessage(reason, "Browser storage could not be written."),
        );
      }
      return updated;
    },
  });
}
