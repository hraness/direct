import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";

import { TodoPortError, type TodoItem, type TodoPort } from "./todo-port";
import { todoStyles } from "./todo.stylex.js";

export interface TodoAppProps {
  readonly port: TodoPort;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof TodoPortError) return reason.message;
  if (reason instanceof Error) return reason.message;
  return "Todos could not be loaded.";
}

export function TodoApp({ port }: TodoAppProps) {
  const [todos, setTodos] = useState<readonly TodoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailure(null);
    void port.readTodos().then(
      (next) => {
        if (!active) return;
        setTodos(next);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!active) return;
        setFailure(errorMessage(reason));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [port, reload]);

  const setCompleted = async (todo: TodoItem): Promise<void> => {
    setBusyId(todo.id);
    setFailure(null);
    try {
      setTodos(await port.setCompleted(todo.id, !todo.completed));
    } catch (reason) {
      setFailure(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main {...stylex.props(todoStyles.shell)} data-todo-shell aria-busy={loading || busyId !== null}>
      <header {...stylex.props(todoStyles.header)}>
        <p {...stylex.props(todoStyles.eyebrow)}>Todo example</p>
        <h1 {...stylex.props(todoStyles.heading)}>Today</h1>
        <span {...stylex.props(todoStyles.remaining)}>{todos.filter((todo) => !todo.completed).length} remaining</span>
      </header>

      {failure === null ? null : (
        <div {...stylex.props(todoStyles.surface, todoStyles.error)} role="alert">
          <p {...stylex.props(todoStyles.errorMessage)}>{failure}</p>
          {todos.length === 0 ? (
            <button {...stylex.props(todoStyles.retry)} type="button" onClick={() => setReload((value) => value + 1)}>Retry loading</button>
          ) : null}
        </div>
      )}

      {loading ? <p {...stylex.props(todoStyles.surface, todoStyles.state)}>Loading todos…</p> : null}
      {!loading && todos.length === 0 && failure === null ? (
        <p {...stylex.props(todoStyles.surface, todoStyles.state)}>No tasks in this list.</p>
      ) : null}
      {todos.length > 0 ? (
        <ul {...stylex.props(todoStyles.list)}>
          {todos.map((todo) => (
            <li {...stylex.props(todoStyles.surface)} key={todo.id}>
              <label {...stylex.props(todoStyles.label)}>
                <input
                  {...stylex.props(todoStyles.checkbox)}
                  checked={todo.completed}
                  disabled={busyId !== null}
                  onChange={() => void setCompleted(todo)}
                  type="checkbox"
                />
                <span {...stylex.props(todoStyles.title, todo.completed && todoStyles.completed)}>{todo.title}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
