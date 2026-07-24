import type { LogicalRuntime } from "@cclrte/direct";
import type { DirectActivityScope } from "@cclrte/direct/testing";

import {
  cloneTodos,
  TodoPortError,
  type TodoItem,
  type TodoPort,
} from "../src/todo-port";
import type { TodoDirectWorld } from "./world";

export interface DeterministicTodoPort extends TodoPort {
  readonly dispose: () => undefined;
  readonly pendingOperations: () => number;
  readonly remainingWork: () => { readonly pendingOperations: number };
}

function workReason(error: {
  readonly message: string;
  readonly workError: unknown;
}): Error {
  return error.workError instanceof Error
    ? error.workError
    : new TodoPortError("write-failed", error.message);
}

export function createDeterministicTodoPort(options: {
  readonly world: TodoDirectWorld;
  readonly activity: DirectActivityScope;
  readonly clock: LogicalRuntime;
  readonly signal: AbortSignal;
}): DeterministicTodoPort {
  let todos = cloneTodos(options.world.todos);
  let pendingOperations = 0;
  let disposed = false;

  const run = async <Value>(
    namespace: string,
    work: () => Value,
  ): Promise<Value> => {
    if (disposed || options.signal.aborted) {
      throw new TodoPortError("write-failed", "The deterministic todo port is disposed.");
    }
    pendingOperations += 1;
    try {
      const result = await options.activity.run(namespace, async () => {
        const waited = await options.clock.wait(100, options.signal);
        if (!waited.ok) throw new TodoPortError("write-failed", waited.error.message);
        if (disposed || options.signal.aborted) {
          throw new TodoPortError("write-failed", "The deterministic todo operation was cancelled.");
        }
        return work();
      });
      if (!result.ok) throw workReason(result.error);
      return result.value;
    } finally {
      pendingOperations -= 1;
    }
  };

  return Object.freeze({
    dispose: () => {
      disposed = true;
      return undefined;
    },
    pendingOperations: () => pendingOperations,
    readTodos: () => run("todo-read", () => cloneTodos(todos)),
    remainingWork: () => Object.freeze({ pendingOperations }),
    setCompleted: (id: string, completed: boolean) => run("todo-write", () => {
      if (options.world.writeFailure !== null) {
        throw new TodoPortError("write-failed", options.world.writeFailure);
      }
      if (!todos.some((todo) => todo.id === id)) {
        throw new TodoPortError("todo-not-found", `Todo does not exist: ${id}`);
      }
      todos = cloneTodos(todos.map((todo: TodoItem) => (
        todo.id === id ? { ...todo, completed } : todo
      )));
      return cloneTodos(todos);
    }),
  });
}
