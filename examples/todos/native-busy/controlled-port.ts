import { cloneTodos, TodoPortError, type TodoItem, type TodoPort } from "../src/todo-port.js";

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export const BUSY_FIXTURE_SCHEMA = "todo.busy-paint-fixture/v1";
export const BUSY_FIXTURE_TODOS = Object.freeze([
  Object.freeze({ id: "write-docs", title: "Write the public guide", completed: false }),
  Object.freeze({ id: "scan-bundle", title: "Scan the production bundle", completed: true }),
]) satisfies readonly TodoItem[];
export type BusyOutcome = "success" | "failure";
export type BusyPhase = "created" | "read-pending" | "ready" | "write-pending" | "finished" | "disposed";
export interface BusySnapshot {
  readonly schema: typeof BUSY_FIXTURE_SCHEMA;
  readonly outcome: BusyOutcome;
  readonly phase: BusyPhase;
  readonly readCalls: number;
  readonly writeCalls: number;
  readonly violations: number;
  readonly requested: null | { readonly id: string; readonly completed: boolean };
  readonly todos: readonly TodoItem[];
}
interface Pending {
  readonly operation: "read" | "write";
  readonly ticket: 1 | 2;
  readonly resolve: (todos: readonly TodoItem[]) => void;
  readonly reject: (error: Error) => void;
}
export interface ControlledTodoPort {
  readonly port: TodoPort;
  readonly inspect: () => BusySnapshot;
  readonly release: (command: unknown) => void;
  readonly dispose: () => void;
}

export function parseBusyOutcome(search: string): BusyOutcome {
  const params = new URLSearchParams(search);
  const entries = [...params];
  requireCondition(entries.length === 1, "Pass exactly one busy fixture outcome");
  const [entry] = entries;
  requireCondition(entry && entry[0] === "outcome" && (entry[1] === "success" || entry[1] === "failure"), "Unknown busy fixture activation");
  return entry[1];
}

function parseRelease(value: unknown): { readonly operation: "read" | "write"; readonly ticket: 1 | 2 } {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), "Release command must be an object");
  requireCondition(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "Release command must be plain");
  const keys = Reflect.ownKeys(value);
  requireCondition(keys.length === 2 && keys.includes("operation") && keys.includes("ticket"), "Release command has missing or foreign fields");
  const fields: Record<string, unknown> = {};
  for (const key of ["operation", "ticket"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireCondition(descriptor && descriptor.enumerable && "value" in descriptor, "Release command requires ordinary fields");
    fields[key] = descriptor.value;
  }
  requireCondition((fields.operation === "read" && fields.ticket === 1) || (fields.operation === "write" && fields.ticket === 2), "Release operation/ticket mismatch");
  return { operation: fields.operation, ticket: fields.ticket };
}

/** This verification-only port controls promises, never React or DOM state. */
export function createControlledTodoPort(outcome: BusyOutcome): ControlledTodoPort {
  requireCondition(outcome === "success" || outcome === "failure", "Unknown busy fixture outcome");
  let phase: BusyPhase = "created", readCalls = 0, writeCalls = 0, violations = 0;
  let todos = cloneTodos(BUSY_FIXTURE_TODOS);
  let requested: BusySnapshot["requested"] = null;
  let pending: Pending | undefined;
  const rejected = (message: string): Promise<readonly TodoItem[]> => {
    violations += 1;
    return Promise.reject(new TodoPortError("write-failed", message));
  };
  const port: TodoPort = Object.freeze({
    readTodos(): Promise<readonly TodoItem[]> {
      readCalls += 1;
      if (phase !== "created" || pending !== undefined) return rejected("Busy fixture admitted an unexpected read");
      phase = "read-pending";
      return new Promise((resolve, reject) => { pending = { operation: "read", ticket: 1, resolve, reject }; });
    },
    setCompleted(id: string, completed: boolean): Promise<readonly TodoItem[]> {
      writeCalls += 1;
      if (phase !== "ready" || pending !== undefined || typeof completed !== "boolean" || !todos.some((todo) => todo.id === id)) {
        return rejected("Busy fixture admitted an unexpected or concurrent write");
      }
      requested = Object.freeze({ id, completed });
      phase = "write-pending";
      return new Promise((resolve, reject) => { pending = { operation: "write", ticket: 2, resolve, reject }; });
    },
  });
  return Object.freeze({
    port,
    inspect: () => Object.freeze({ schema: BUSY_FIXTURE_SCHEMA, outcome, phase, readCalls, writeCalls, violations,
      requested: requested === null ? null : Object.freeze({ ...requested }), todos: Object.freeze(cloneTodos(todos)) }),
    release(command: unknown): void {
      let parsed: ReturnType<typeof parseRelease>;
      try { parsed = parseRelease(command); }
      catch (error) { violations += 1; throw error; }
      const admitted = pending;
      if (admitted === undefined || admitted.operation !== parsed.operation || admitted.ticket !== parsed.ticket ||
        (phase !== "read-pending" && phase !== "write-pending")) {
        violations += 1;
        throw new Error("Busy fixture release did not match the live operation");
      }
      pending = undefined;
      if (admitted.operation === "read") {
        phase = "ready";
        admitted.resolve(cloneTodos(todos));
      } else {
        phase = "finished";
        requireCondition(requested, "Admitted write lost its request");
        if (outcome === "failure") admitted.reject(new TodoPortError("write-failed", "The controlled store rejected this change."));
        else {
          const request = requested;
          todos = cloneTodos(todos.map((todo) => todo.id === request.id ? { ...todo, completed: request.completed } : todo));
          admitted.resolve(cloneTodos(todos));
        }
      }
    },
    dispose(): void {
      const abandoned = pending;
      pending = undefined;
      phase = "disposed";
      abandoned?.reject(new TodoPortError("write-failed", "The controlled fixture was disposed."));
    },
  });
}
