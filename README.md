# direct

[![skills.sh](https://skills.sh/b/hraness/direct)](https://skills.sh/hraness/direct)

a general harness for repeatable app states.

name signed-in, empty, error, and other hard-to-reach app states once, then let
coding agents open them by URL during development. your interface and feature
code run normally. direct replaces only the outside systems needed for that
state with predictable local stand-ins. it does not click through the browser
or test the systems it replaces.

```sh
bun add --dev github:hraness/direct#v0.7.0
```

[overview](https://hraness.com/direct)

```text
real interface and feature state
              │
      product-owned port
          ┌───┴────┐
   production   direct
     adapter     harness
```

## Install

### Install the Agent Skill

Install Direct's single bundled skill from the public repository:

```sh
npx skills add hraness/direct
# or
bunx skills add hraness/direct
```

The skill is invoked as `$direct`. It routes installation, adoption, and
verification work while keeping the development-only production boundary
visible. Restart or reload an agent runner that does not discover newly
installed skills during the current session.

### Tell your coding agent to install it

Copy this prompt into Codex, Claude Code, or another coding agent:

```text
Use $direct to install hraness/direct from
https://github.com/hraness/direct at the immutable v0.7.0 tag. Follow the
repository README, add `@hraness/direct` to devDependencies only, and verify
that the production dependency graph excludes Direct. Do not add a fixture
composition until I ask.
```

The repository carries the skill independently from the released library.
Installing the skill does not add Direct to a consumer project. The current
`v0.7.0` runtime tag predates this single-skill layout, so use the skills CLI
for runner discovery until a later tagged package includes it.

Pin the public repository to an immutable version tag:

```json
{
  "devDependencies": {
    "@hraness/direct": "github:hraness/direct#v0.7.0"
  }
}
```

Then install with Bun:

```sh
bun install
```

Keep Direct in `devDependencies`. A production entry must not import Direct, its fixture worlds, or its workbench.

## Agent skills

Packages built from this source include one Agent Skill under
`node_modules/@hraness/direct/skills/direct/`. `$direct` guides a product-owned
port and deterministic composition, then audits scenario behavior,
quiescence, coverage claims, cleanup, and emitted production boundaries. The
package smoke test keeps that future packaged copy byte-identical to the
repository skill.

Prefer `npx skills add hraness/direct` or `bunx skills add hraness/direct` for
runner discovery. You can also copy or link that one skill directory into a
runner's configured location, then invoke `$direct`. Package installation
leaves the skill inert: it does not run a `postinstall` hook or edit repository
or user configuration.

## A complete browser composition

Extract a strict world parser and product harness into product-owned files, then compose the lifecycle in one entry:

```ts
import { defineDirect } from "@hraness/direct";
import { createDirectSession } from "@hraness/direct/testing";
import { installDirectBrowser } from "@hraness/direct/web";

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

One definition may contain at most 256 scenarios and 256 coverage entries.

The session supplies the parsed world, generation-safe store, logical clock,
activity scope, cancellation signal, world-free manifest, probe, coverage
value, and reverse-order cleanup. The browser installer publishes that
manifest with the live probe and reset action, blocks unmapped `fetch` calls
by default, rolls back partial installation, and registers teardown with
`session.dispose()`.

An external browser tool reads `window.__direct.schema`,
`window.__direct.manifest`, and `window.__direct.snapshot()` in one synchronous
evaluation. Require the exact `direct.browser-bridge/v2` schema, parse the
manifest and probe from `unknown`, confirm the expected activation source,
scenario, and product route, and require their activation hashes to match.
Retain one catalog hash across the run. Direct does not need a driver-specific
plugin: agent-browser, Playwright MCP, and other tools can read the same page
contract.

Direct's browser runtime remains driver-neutral and never launches a process.
The opt-in host tooling can invoke a consumer-installed agent-browser CLI; the
product verifier still owns its commands, process lifetime, and evidence. The
canonical
[verification workflow](./docs/verification.md#run-one-bounded-local-chromium-batch)
uses one task-owned local Chromium session and process for a sequential batch
of at most eight scenarios. It opens a fresh BrowserContext with `window new`
before every scenario and attempts to close scenario-owned tabs while
retaining the command results and tab inventories. It keeps the inert
no-URL bootstrap tab until the final whole-browser close, which is the
stronger disposal boundary. Semantic and visual evidence come from the same
exact Chromium context.

The product verifier declares exact `--allowed-domains` before navigation and
uses a bounded idle timeout. Direct's application-`fetch` firewall remains
instrumentation, not full egress containment. Runs stay serial unless a real
external coordinator enforces shared admission; Direct does not integrate or
enforce a process cap. Ordinary browser-wide `--cdp` attachment is forbidden
because named agent-browser sessions do not isolate contexts.

A nonzero final close fails the batch. Parallel-admission or crash-safe cleanup
claims require an external supervisor that owns both the agent-browser daemon
and Chromium roots, or one containing job; the roots can occupy different
process groups. Direct supplies neither that supervisor nor browser or
performance evidence.

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
| `@hraness/direct` | Authored definitions plus the scenario, coverage, fixture, JSON, activation, and logical-time types needed to describe them | Framework-free |
| `@hraness/direct/core` | Advanced catalog, parser, store, runtime, effect, resource, ID, and `Result` mechanics | Framework-free |
| `@hraness/direct/react` | Typed context, provider, and external-store hooks for React DOM or React Native | Optional React peer |
| `@hraness/direct/testing` | Sessions, manifest and probe parsers, evidence classification, activity scopes, and exact scripted transports | Development and verification |
| `@hraness/direct/web` | Atomic browser installation, with low-level bridge and firewall escape hatches | Browser only |
| `@hraness/direct/tooling/browser-verification` | Protocol-bound bridge reads, bounded agent-browser commands, local server leases, and artifact writes | Bun 1.3.14 with Node APIs |
| `@hraness/direct/tooling/bundle-boundary` | Deterministic emitted-file scans and exact versioned-wire evidence | Bun 1.3.14 with Node APIs |

The tooling subpaths are development-only. They are built separately from the
browser runtime and never enter the default, core, React, testing, or web
graphs. Tooling type checks require Bun and Node type definitions.

`readDirectBrowserContract` binds the exact package bridge schema and Direct's
manifest and probe parsers. Use `createDirectBrowserContractReader` when a
verifier supplies another compatible protocol. `createAgentBrowser` expects
agent-browser 0.32.3 at `node_modules/.bin/agent-browser` below the supplied
`repositoryRoot` and an empty task-owned config at
`scripts/direct/agent-browser.verify.json`. The product supplies its explicit
launch arguments, allowed domains, scenario commands, and final close policy.

## Activate scenarios

The browser query boundary reserves:

- `__direct_scenario=<id>` for a named catalog scenario.
- `__direct_fixture=<encoded-json>` for a portable `direct.fixture/v1` envelope.

Malformed encoding, duplicate activation, unknown reserved keys, unknown scenarios, route mismatches, invalid worlds, and oversized input fail closed. An empty activation selects the definition's validated default scenario.

## Upgrade from v0.4.0

v0.5.0 replaces `direct.browser-bridge/v1` with the exact v2 shape:
`schema`, `manifest`, `snapshot()`, and `reset()`. Coverage moved from
`window.__direct.coverage` to `window.__direct.manifest.coverage`. Low-level
bridge callers now pass `manifest` instead of `coverage`, and probe activation
hashes use `fnv1a-64:<16 lowercase hexadecimal digits>`. The manifest parser
also recomputes `active.selectionHash`, which binds the public source,
scenario, and route to that activation identity without exposing world or
runtime data.

Migrate the browser installation and each verifier together. Keep v0.4.0
pinned until a consumer can accept the complete v2 contract; do not support a
hybrid bridge shape.

## Repository scope

This repository contains the deterministic kernel, browser bridge, production-exclusion scanner, bounded host-verification helpers, agent skills, a small React example, and an Expo/React Native reference app. It does not bundle a browser driver or provide a process coordinator, cleanup supervisor, browser-worker pool, or browser benchmark. The optional helper invokes the consumer's local agent-browser installation; the product owns commands and evidence, and external proof remains required for browser or performance claims.

<!-- article:direct-a-harness-for-your-frontend:start -->
## [Direct gives browser agents deterministic app states](<https://hraness.com/direct>)

> Browser tools control a page. Direct makes the state behind it quick to reach and repeatable without claiming to test the external systems it replaces.

A browser agent can open a page, click a control, and inspect the result. It cannot make the state behind that page quick to reach. A signed-in account, a particular database record, a device permission, a model response, or a failure at the right moment may still take longer to arrange than the interface takes to review.

[Hraness Direct](<https://hraness.com/direct>) separates those two jobs. A browser tool controls the page. The product connects Direct's named, repeatable states to its existing interface and feature logic through deterministic adapters below a small product-owned boundary. Direct speeds up development and review; it does not drive the browser or prove that replaced systems work.

### Browser control and app state are different jobs

[agent-browser](<https://agent-browser.dev/>) gives coding agents a compact command-line interface for opening pages, reading accessibility snapshots, and interacting with elements. Playwright and other browser drivers solve the same broad problem with different APIs. If the state you need is already fast and reliable to reach, a browser tool by itself is the smaller and better choice.

Direct becomes useful when setup dominates the loop: repeated sign-in, slow seed requests, hard-to-create empty or error states, unavailable native modules, paid model calls, or device permissions that automation cannot reset cleanly. Direct does not click the page. It gives the browser tool a stable page state to act on.

### Replace setup below the behavior

A product-owned port is a small interface between product behavior and an external system. A task view might ask a task repository to read and update tasks. Production connects that port to a live service. A Direct composition connects the same port to a deterministic implementation. The interface, reducers, parsing, navigation, and feature decisions above the port stay on their normal code paths.

The boundary can be pictured without knowing the package API:

**Conceptual Direct boundary**

```text
agent-browser or Playwright
            │
   real interface + feature state
            │
     product-owned port
        ┌───┴────┐
  live system   Direct world
```

A Direct world is validated JSON that describes one starting state. A scenario gives that world a name and route. It does not contain browser actions. The browser check still decides what to click and what outcome to assert.

The [public Todo example](<https://github.com/hraness/direct/tree/main/examples/todos>) uses one `TodoPort` in both compositions. The component receives whichever implementation the entry point owns:

**One product port, two compositions**

```typescript
export interface TodoPort {
  readTodos(): Promise<readonly TodoItem[]>;
  setCompleted(id: string, completed: boolean):
    Promise<readonly TodoItem[]>;
}

const port = isDirect
  ? createDeterministicTodoPort(world)
  : createLiveTodoPort();

<TodoApp port={port} />
```

The interface speaks in product terms: todos and completion. It contains no Direct types and does not know whether storage is live or deterministic. Use the lowest port that preserves the behavior under review. If the Direct adapter must copy the logic named by the claim, the boundary is too high and the fixture would imitate its subject instead of testing it.

### Direct owns one deterministic session

Direct gives the development composition one lifecycle instead of a collection of unrelated fixture helpers:

- A definition lists the named scenarios, their routes, and which systems each check claims to exercise, then validates that those declarations agree.
- A session activates one scenario and owns its deterministic state, controllable clock, pending work, reset, and cleanup.
- A small browser-facing manifest identifies the available and active scenarios, exposes readiness and reset controls, and blocks unmapped application requests by default.

That default network policy matters. A deterministic page should not silently call a live service when a fixture misses a case. The product can allow exact URLs when needed, but unknown application calls fail visibly. Direct and its fixture worlds also stay outside the production dependency graph.

The published manifest is a machine-readable description of the deterministic page. An agent can discover valid scenario IDs and routes, confirm that the active session matches the requested scenario and route, and inspect readiness without reading a product-specific source file. The browser tool still owns navigation and interaction; Direct does not turn scenarios into commands.

### Wait for the app, not a guess

A fixed delay says, “wait 500 milliseconds and hope.” Direct exposes a readiness snapshot: no tracked operation is active, and each product-named pending counter is zero. The product's browser verifier polls until the active scenario, its tracked-work revision, and the counters remain unchanged for a bounded interval before checking the interface.

**Browser check using a named Direct scenario**

```typescript
await page.goto(
  "/direct/?__direct_scenario=todos.populated",
);
await waitForQuiescence(page);

await page.getByRole("checkbox", {
  name: "Write the public guide",
}).check();

await waitForQuiescence(page);
await expect(page.getByRole("checkbox", {
  name: "Write the public guide",
})).toBeChecked();
```

Here, `waitForQuiescence` is product-owned verifier code around Direct's snapshot, not a Direct browser driver. A settled snapshot proves only that the work Direct knows about has stopped changing. It does not prove that the screen is correct. The verifier must still reject relevant console, runtime, and unhandled-request errors, then make product-specific assertions or visual checks.

### Choose the smallest tool that covers the risk

- Use browser automation alone when the required state is already quick to reach, or when the live backend and browser assembly are part of the check.
- Pair Direct with agent-browser or Playwright when setup and reset dominate the loop and the substituted systems can sit behind a small product-owned port.
- Use unit or component tests when the subject is isolated logic or rendering that does not need the full application composition.
- Keep live integration and end-to-end tests when the backend, native host, browser assembly, filesystem, operating system, or device is the subject.

A coverage claim records which systems a check actually exercised. Direct uses three labels: a fixture claim stops at deterministic ports, a mixed claim combines fixture evidence with a named live check, and a direct claim requires the real system. The labels do not create evidence; they keep a fast development check from being reported as proof of a system it never touched.

Use Direct when the state behind the interface is the bottleneck and a small product-owned port can replace that setup without copying the behavior under review. Use the browser tool alone when it can already reach the state cheaply. In either case, the browser driver supplies the actions and assertions. Direct never exercises the systems behind replaced ports; cover those boundaries separately with live integration or end-to-end tests when their risk requires it.
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
