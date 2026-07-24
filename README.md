# Direct

Hraness Direct makes frontend loops faster by running a product's real interface and state machinery against deterministic implementations of product-owned ports—without pretending to prove the systems it replaces.

Read the full article at [hraness.direct](https://hraness.direct), or inspect the package and examples below.

```text
real interface and feature state
              │
      product-owned port
          ┌───┴────┐
   production   Direct
     adapter     harness
```

The normal lifecycle has three owners: a definition validates named worlds and claims, a session owns one deterministic composition, and a browser installation publishes its probe behind a fail-closed network boundary.

## Install

### Tell your coding agent to install it

Copy this prompt into Codex, Claude Code, or another coding agent:

```text
Install hraness/direct and its bundled Agent Skills from
https://github.com/hraness/direct at the immutable v0.4.0 tag. Follow the
repository README, add `@cclrte/direct` to devDependencies only, copy or link
`direct-setup` and `direct-verify` into this agent runner's configured
skills directory, and verify that the production dependency graph excludes
Direct. Do not add a fixture composition until I ask.
```

The tagged package and repository carry the same skill directories. Package
installation leaves them inert until an agent places them in its
runner-specific discovery path.

Pin the public repository to an immutable version tag:

```json
{
  "devDependencies": {
    "@cclrte/direct": "github:hraness/direct#v0.4.0"
  }
}
```

Then install with Bun:

```sh
bun install
```

Keep Direct in `devDependencies`. A production entry must not import Direct, its fixture worlds, or its workbench.

## Agent skills

Beginning with v0.4.0, the packed package includes two Agent Skills under `node_modules/@cclrte/direct/skills/`. `direct-setup` guides a product-owned port, deterministic composition, and production-exclusion proof. `direct-verify` audits scenario behavior, quiescence, coverage claims, cleanup, and emitted production boundaries.

Agent runners do not share one discovery directory. Copy or link the desired skill directory into the location configured by your runner, then invoke `$direct-setup` or `$direct-verify`. Package installation leaves the skills inert: it does not run a `postinstall` hook or edit repository or user configuration.

## A complete browser composition

Extract a strict world parser and product harness into product-owned files, then compose the lifecycle in one entry:

```ts
import { defineDirect } from "@cclrte/direct";
import { createDirectSession } from "@cclrte/direct/testing";
import { installDirectBrowser } from "@cclrte/direct/web";

import { parseGreetingWorld } from "./world.js";

const definition = defineDirect({
  parseWorld: parseGreetingWorld,
  defaultScenario: "greeting.ready",
  scenarios: [{
    id: "greeting.ready",
    title: "Ready greeting",
    route: "/",
    world: { version: 1, greeting: "Hello" },
  }],
  coverage: [{
    key: "greeting.render",
    mode: "fixture",
    claim: "The real greeting view renders a deterministic greeting.",
    scenarios: ["greeting.ready"],
  }],
});

const opened = createDirectSession({
  definition,
  activation: { kind: "query", source: globalThis.location.search },
  create: ({ world }) => Object.freeze({ greeting: world.greeting }),
});
if (!opened.ok) throw new Error(opened.error.message);

const session = opened.value;
const installed = installDirectBrowser({ session });
if (!installed.ok) {
  session.dispose();
  throw new Error(installed.error.message);
}

renderGreeting(session.harness.greeting);
globalThis.addEventListener("pagehide", session.dispose, { once: true });
```

`defineDirect` is the concise authored-config path; scenario defaults and coverage citations are checked against the same scenario tuple. Use `tryDefineDirect` for typed configuration assembled dynamically. Use `parseDirectDefinition` for a genuinely `unknown` value; it returns a `Result` with an intentionally broad JSON world and string route because foreign data cannot supply compile-time refinements.

The session supplies the parsed world, generation-safe store, logical clock, activity scope, cancellation signal, probe, coverage value, and reverse-order cleanup. The browser installer derives its probe and coverage from that session, blocks unmapped `fetch` calls by default, rolls back partial installation, and registers teardown with `session.dispose()`.

See the [Todo example](https://github.com/hraness/direct/tree/main/examples/todos) for a strict parser, product-owned port, React workbench, and emitted-graph boundary verifier. The [React Native example](https://github.com/hraness/direct/tree/main/examples/react-native) uses the same session model in a platform-resolved Expo composition while keeping native production graphs Direct-free.

## Keep evidence honest

Coverage entries have one proof mode:

| Mode | Meaning |
| --- | --- |
| `fixture` | The real interface and product logic ran through deterministic ports. Replaced adapters and platforms were not exercised. |
| `mixed` | Fixture evidence is paired with named direct adapter or service evidence. Neither half is sufficient alone. |
| `direct` | The claim requires the real host, service, runtime, filesystem, operating system, or device. |

Coverage cites scenario IDs rather than duplicating a singular route. Each scenario owns its route, so one claim may span scenarios on different routes without inventing a second routing abstraction.

A quiet probe means the declared deterministic work settled. It does not prove that the rendered result is correct. Pair quiescence with product-owned semantic assertions, visual inspection where relevant, and direct tests for every replaced boundary named by the coverage catalog.

## Package surfaces

| Import | Purpose | Runtime boundary |
| --- | --- | --- |
| `@cclrte/direct` | Authored definitions plus the scenario, coverage, fixture, JSON, activation, and logical-time types needed to describe them | Framework-free |
| `@cclrte/direct/core` | Advanced catalog, parser, store, runtime, effect, resource, ID, and `Result` mechanics | Framework-free |
| `@cclrte/direct/react` | Typed context, provider, and external-store hooks for React DOM or React Native | Optional React peer |
| `@cclrte/direct/testing` | Sessions, evidence classification, canonical wire parsers, activity scopes, probes, and exact scripted transports | Development and verification |
| `@cclrte/direct/web` | Atomic browser installation, with low-level bridge and firewall escape hatches | Browser only |

## Activate scenarios

The browser query boundary reserves:

- `__direct_scenario=<id>` for a named catalog scenario.
- `__direct_fixture=<encoded-json>` for a portable `direct.fixture/v1` envelope.

Malformed encoding, duplicate activation, unknown reserved keys, unknown scenarios, route mismatches, invalid worlds, and oversized input fail closed. An empty activation selects the definition's validated default scenario.

## Repository scope

This repository contains the deterministic kernel, browser bridge, production-exclusion pattern, agent skills, a small React example, and an Expo/React Native reference app. It does not contain a browser driver, browser-worker pool, screenshot deduplication, video recording, PySceneDetect integration, or storyboard generation. Use the browser tooling that fits your product and treat recorded media as evidence, not as the definition of correctness.

<!-- article:direct-a-harness-for-your-frontend:start -->
## [Hraness Direct makes frontend loops faster](<https://hraness.pub/articles/direct-a-harness-for-your-frontend>)

> Run the real interface against named deterministic worlds, reset it quickly, and keep direct tests for every system the development harness replaces.

Frontend checks slow down when the state worth reviewing sits behind a login, a cloud service, a native module, a model process, or a device permission. The interface may need only seconds of attention after minutes of setup.

[Hraness Direct](<https://hraness.direct>) makes frontend loops faster with a deterministic product harness. The product keeps its real interface and feature state while deterministic adapters replace slow external systems. A Direct definition names the available worlds and evidence claims, a session owns one activated world's lifecycle, and one browser installation exposes its probe while denying unmapped application requests. The product's verifier still chooses the actions, assertions, browser driver, and evidence.

![The same interface cycles through named scenes, instant resets, and repeatable checks.](<https://hraness.pub/article-diagrams/direct-a-harness-for-your-frontend.light.webp>)

*Hraness Direct keeps the interface while making scenes quick to reset and check.*

### Change the composition below the behavior

A product-owned port is a small interface between product behavior and an external system. Production supplies the live implementation. The Direct composition supplies a deterministic implementation of the same contract. Components, reducers, parsing, and navigation above that seam stay on their ordinary code paths.

A minimal product-specific layout makes that boundary visible:

**Conceptual Direct layout**

```text
product/
├── src/
│   ├── TodoApp.tsx                  # real interface and feature state
│   ├── todo-port.ts                 # product-owned semantic boundary
│   └── production.ts                # live adapter and entry
└── direct/
    ├── definition.ts                # worlds, routes, and evidence claims
    ├── deterministic-port.ts        # deterministic implementation
    ├── entry.tsx                    # development composition
    └── verify.ts                    # actions, assertions, and evidence
```

The filenames are illustrative. The ownership rule is fixed: production and deterministic adapters implement the same product-owned port, the real interface stays above both, and the Direct definition, workbench, and verifier stay outside the production graph. A scenario is named initial state, route, and logical-runtime state. It is not a script of browser actions.

The [public Todo example](<https://github.com/hraness/direct/tree/main/examples/todos>) shows that boundary in code. The real `TodoApp` knows only the product's `TodoPort`. The production entry supplies browser storage. The Direct session supplies a deterministic port:

**todo-port.ts composition (illustrative excerpt)**

```typescript
export interface TodoItem {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
}

export interface TodoPort {
  readonly readTodos: () => Promise<readonly TodoItem[]>;
  readonly setCompleted: (
    id: string,
    completed: boolean,
  ) => Promise<readonly TodoItem[]>;
}

// Production entry
<TodoApp port={createLocalStorageTodoPort(globalThis.localStorage)} />

// Direct workbench
<TodoApp port={props.harness.port} />
```

The interface speaks in product terms: todos and completion. It contains no storage calls or Direct types. Behind the port, the deterministic runtime can use a world and a logical clock without changing the component under review.

The deterministic side starts with one strict, versioned JSON world parsed from an unknown value. The session gives the validated, immutable seed to the product adapter, which can initialize its own mutable repository or event stream. Above the port, the frontend handles each response through its normal state-update path. Unknown requests fail instead of falling through to a live service. The world becomes a bounded executable model of the state needed by the interface.

Use the lowest port that preserves the behavior under review. A task interface should depend on a task repository rather than a simulated database client. A desktop renderer should depend on a renderer-safe transport rather than a simulated native protocol. If the deterministic adapter must copy the behavior named by the claim, the seam is too high and the fixture would imitate its subject instead of testing it.

### Own the lifecycle once

The public API follows the same ownership model. `defineDirect` from the framework-free package root validates authored scenarios and coverage claims once. `createDirectSession` from the testing entry activates one scenario and owns its world, logical clock, activity, deterministic harness, cancellation signal, probe, and reverse-order cleanup. `installDirectBrowser` from the web entry publishes that session through the canonical browser bridge and installs a fail-closed application-fetch boundary as one disposable operation.

The authored definition type keeps the default and coverage citations inside the same scenario tuple. Typed configuration assembled dynamically uses `tryDefineDirect`. A genuinely unknown value uses `parseDirectDefinition`, preserving structured failure without asserting foreign data into narrow owned types.

The extracted scenario, coverage, and harness values in this entry are ordinary product-owned data and code. Direct owns their lifecycle and browser boundary:

**direct/entry.ts (abridged)**

```typescript
const definition = defineDirect({
  parseWorld: parseTodoWorld,
  defaultScenario: "todos.populated",
  scenarios: todoScenarios,
  coverage: todoCoverage,
});

const opened = createDirectSession({
  definition,
  activation: { kind: "query", source: location.search },
  create: createTodoHarness,
});
if (!opened.ok) throw new Error(opened.error.message);

const session = opened.value;
const installed = installDirectBrowser({ session });
if (!installed.ok) {
  session.dispose();
  throw new Error(installed.error.message);
}
```

The default browser policy denies application calls through `fetch`. A product may allow exact URLs, record blocked calls, or disable the firewall when another checked boundary owns containment. The installation derives the probe and coverage snapshot from the session, tracks allowed and blocked fetch work in the same activity scope, and rolls back its own changes if setup fails. It registers cleanup with the session; its returned handle can remove the browser hooks earlier.

Each store reset advances the session generation. Transactions and tracked operations from an earlier generation cannot update or settle the new world. The browser reset action is a synchronous handoff, normally to a reload; it cannot return a Promise that automation could mistake for completed work. Logical time can accelerate product delays without changing browser motion. A product runner may reuse a compatible browser process or application bundle, but reuse is not a package guarantee.

### Quiescence replaces sleeps

A fixed delay waits for a duration. Quiescence means that the active scenario has reached its declared readiness conditions. The session probe requires no active operations and all product-named pending counters at zero. The product verifier then checks that the generation, revision, activity totals, and counters remain unchanged for a short, bounded interval. It may separately wait for fonts, nearby images, or document stability when a claim needs visual evidence.

The probe reports violation counters and remaining scripted work outside the quiescence gate. A verifier must separately reject an unhandled request, unused required script step, console error, runtime error, leaked work token, or malformed transport value when that signal matters to the claim. [Types and property tests in an agent-operated codebase](<https://hraness.pub/articles/the-ai-codebase-types-and-property-tests>) help at this boundary. Strict parsers reject malformed worlds, while generated tests challenge reset, cancellation, serialization, and ordering laws across many inputs.

The browser-driver helper remains product-owned. In this illustrative Playwright check, `waitForQuiescence` reads the probe until those readiness conditions remain stable. It then rejects relevant violations and required remaining work:

**todo.browser.test.ts (illustrative)**

```typescript
test("completes a populated todo", async ({ page }) => {
  await page.goto(
    "/direct/?__direct_scenario=todos.populated",
  );
  await waitForQuiescence(page);

  const todo = page.getByRole("checkbox", {
    name: "Write the public guide",
  });
  await todo.check();
  await waitForQuiescence(page);

  await expect(todo).toBeChecked();
});
```

The check needs no login, seed request, CSS selector, or fixed sleep. The named scenario supplies only the starting world and route. The product verifier supplies the checkbox action and assertion, while the port carries the interaction through real frontend state. The second `waitForQuiescence` call waits for that state to settle.

Quiescence does not prove that the rendered result is correct. It proves only that the readiness conditions held. The verifier must reject relevant violations and remaining work separately; semantic assertions, visual review, and direct integration tests still decide whether the result supports the claim.

### Stop the claim at the substituted port

Every coverage claim names one proof mode and cites the scenarios that supply its deterministic evidence. Routes stay on scenarios, where they are executable facts, instead of being repeated as one potentially misleading representative route on a claim. A fixture claim covers real interface and product behavior through deterministic ports. A mixed claim combines that fixture evidence with a named direct adapter or service check. A direct claim requires the real host, service, browser assembly, filesystem, operating system, or device. A completed run is verified only when every kind of evidence required by its declared mode has passed.

### Carry the workflow with the package

An Agent Skill is a directory of task instructions and display metadata that a compatible coding-agent runner can load. Beginning with the v0.4.0 release, an installed `@cclrte/direct` package carries `direct-setup` for adoption and `direct-verify` for evidence review under its `skills/` directory. A repository can copy or link either directory into its runner's discovery location, so the workflow stays versioned with the API and examples it describes.

Installation leaves both skills inert because agent runners do not share one discovery path. The setup skill encodes the product-port and production-exclusion sequence; the verification skill encodes quiescence, semantic assertions, coverage classification, and direct-evidence limits. They organize the work, but they do not supply evidence or promote a fixture claim.

Use Hraness Direct when external setup hides frontend state and a small product-owned port can replace that setup without copying the behavior under review. Keep direct integration and end-to-end tests when the backend, native host, browser assembly, or operating system is the subject. Direct makes the composition deterministic; the product verifier still decides whether the resulting interface supports the claim.
<!-- article:direct-a-harness-for-your-frontend:end -->

## Develop

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run example:test
bun run example:typecheck
bun run example:verify
bun run example:build
bun run example:check-boundary
bun run example:build:direct
bun run example:react-native:test
bun run example:react-native:typecheck
bun run example:react-native:verify
```

Run the production app with `bun run example:dev`. Run the deterministic workbench with `bun run example:direct`, then select `empty`, `populated`, or `write failure` from its scenario navigation.

Run the Expo workbench with `bun run example:react-native`. Its verification command exports iOS and Android production bundles plus the deterministic React Native Web composition with paired source maps, proves the expected shared and platform-specific modules were selected, and rejects native/web cross-contamination. It does not replace browser-driven semantic assertions or direct device evidence.

See [Architecture](./docs/architecture.md), [Adoption](./docs/adoption.md), [Verification](./docs/verification.md), and [Wire formats](./docs/wire-formats.md) for durable contracts.

## Contribute and report vulnerabilities

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Report suspected vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

Direct is available under the [MIT License](./LICENSE).
