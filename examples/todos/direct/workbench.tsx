import { SCENARIO_QUERY_KEY } from "@hraness/direct";

import { TodoApp } from "../src/TodoApp";
import { todoDirectDefinition } from "./definition";
import type { TodoDirectHarness } from "./session";

function scenarioHref(id: string): string {
  const url = new URL("/direct/", globalThis.location.origin);
  url.searchParams.set(SCENARIO_QUERY_KEY, id);
  return `${url.pathname}${url.search}`;
}

export function TodoDirectWorkbench(props: {
  readonly activeScenario: string;
  readonly harness: TodoDirectHarness;
}) {
  const active = todoDirectDefinition.scenarios.resolve(props.activeScenario);
  if (!active.ok) throw new Error(active.error.message);

  return (
    <main className="workbench-shell">
      <aside className="workbench-sidebar">
        <header>
          <p>Deterministic development</p>
          <h1>Direct</h1>
          <span>Real todo interface, in-memory port, no network.</span>
        </header>
        <nav aria-label="Todo scenarios">
          {todoDirectDefinition.scenarios.list().map((scenario) => (
            <a
              aria-current={scenario.id === props.activeScenario ? "page" : undefined}
              href={scenarioHref(scenario.id)}
              key={scenario.id}
            >
              <strong>{scenario.title}</strong>
              <small>{scenario.description}</small>
            </a>
          ))}
        </nav>
        <details>
          <summary>{todoDirectDefinition.coverage.size} coverage claims</summary>
          <ul>
            {todoDirectDefinition.coverage.list().map((entry) => (
              <li key={entry.key}><strong>{entry.mode}</strong> {entry.claim}</li>
            ))}
          </ul>
        </details>
      </aside>
      <section className="workbench-stage" aria-label={`${active.value.title} scenario`}>
        <header>
          <p>{active.value.id}</p>
          <h2>{active.value.title}</h2>
          <span>{active.value.description}</span>
        </header>
        <div className="workbench-frame">
          <TodoApp port={props.harness.port} />
        </div>
      </section>
    </main>
  );
}

export function TodoDirectError({ message }: { readonly message: string }) {
  return (
    <main className="workbench-error" role="alert">
      <p>Activation rejected</p>
      <h1>Todo Direct could not start</h1>
      <span>{message}</span>
      <a href={scenarioHref("todos.populated")}>Open the default scenario</a>
    </main>
  );
}
