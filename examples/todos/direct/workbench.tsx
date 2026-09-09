import { SCENARIO_QUERY_KEY } from "@hraness/direct";
import * as stylex from "@stylexjs/stylex";

import { TodoApp } from "../src/TodoApp";
import { todoDirectDefinition } from "./definition";
import type { TodoDirectHarness } from "./session";
import { workbenchStyles } from "./workbench.stylex.js";

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
    <main {...stylex.props(workbenchStyles.shell)} data-workbench-shell>
      <aside {...stylex.props(workbenchStyles.sidebar)}>
        <header>
          <p {...stylex.props(workbenchStyles.eyebrow)}>Deterministic development</p>
          <h1 {...stylex.props(workbenchStyles.heading, workbenchStyles.h1)}>Direct</h1>
          <span {...stylex.props(workbenchStyles.description)}>Real todo interface, in-memory port, no network.</span>
        </header>
        <nav {...stylex.props(workbenchStyles.navigation)} aria-label="Todo scenarios">
          {todoDirectDefinition.scenarios.list().map((scenario) => (
            <a
              {...stylex.props(workbenchStyles.scenario, scenario.id === props.activeScenario && workbenchStyles.currentScenario)}
              aria-current={scenario.id === props.activeScenario ? "page" : undefined}
              href={scenarioHref(scenario.id)}
              key={scenario.id}
            >
              <strong>{scenario.title}</strong>
              <small {...stylex.props(workbenchStyles.scenarioDescription)}>{scenario.description}</small>
            </a>
          ))}
        </nav>
        <details {...stylex.props(workbenchStyles.details)}>
          <summary {...stylex.props(workbenchStyles.summary)}>{todoDirectDefinition.coverage.size} coverage claims</summary>
          <ul {...stylex.props(workbenchStyles.claims)}>
            {todoDirectDefinition.coverage.list().map((entry) => (
              <li {...stylex.props(workbenchStyles.claim)} key={entry.key}><strong>{entry.mode}</strong> {entry.claim}</li>
            ))}
          </ul>
        </details>
      </aside>
      <section {...stylex.props(workbenchStyles.stage)} aria-label={`${active.value.title} scenario`}>
        <header {...stylex.props(workbenchStyles.stageHeader)}>
          <p {...stylex.props(workbenchStyles.eyebrow, workbenchStyles.stageDescription)}>{active.value.id}</p>
          <h2 {...stylex.props(workbenchStyles.heading, workbenchStyles.h2)}>{active.value.title}</h2>
          <span {...stylex.props(workbenchStyles.description, workbenchStyles.stageDescription)}>{active.value.description}</span>
        </header>
        <div {...stylex.props(workbenchStyles.frame)} data-workbench-frame>
          <TodoApp port={props.harness.port} />
        </div>
      </section>
    </main>
  );
}

export function TodoDirectError({ message }: { readonly message: string }) {
  return (
    <main {...stylex.props(workbenchStyles.error)} role="alert">
      <p {...stylex.props(workbenchStyles.eyebrow)}>Activation rejected</p>
      <h1 {...stylex.props(workbenchStyles.heading, workbenchStyles.h1)}>Todo Direct could not start</h1>
      <span {...stylex.props(workbenchStyles.description, workbenchStyles.errorDescription)}>{message}</span>
      <a {...stylex.props(workbenchStyles.recoveryLink)} href={scenarioHref("todos.populated")}>Open the default scenario</a>
    </main>
  );
}
