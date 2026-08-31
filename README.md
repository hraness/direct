# Direct

[![skills.sh](https://skills.sh/b/hraness/direct)](https://skills.sh/hraness/direct)

A TypeScript harness for deterministic frontend testing and development with
repeatable scenarios, local fixtures, and browser verification for coding
agents.
Direct makes hard-to-reach frontend states addressable by URL. It runs your real
interface and feature code against named, validated local fixture worlds, so
signed-in, empty, and error states are repeatable without clicking through setup
or depending on live systems.

[Install @hraness/direct from npm](https://www.npmjs.com/package/@hraness/direct) ·
[Direct source on GitHub](https://github.com/hraness/direct) ·
[Direct overview](https://hraness.com/direct)

```text
real interface and feature state
              │
      product-owned port
          ┌───┴────┐
   production   direct
     adapter     harness
```

## Why Direct

- **Keep product behavior real.** The interface and feature logic keep using a
  product-owned port. Only the external adapters needed for the scenario are
  replaced. Direct does not automate browser actions, and fixture evidence does
  not prove those live systems.
- **Know when the page settled.** A versioned browser contract exposes the
  active scenario, coverage catalog, and deterministic activity probe. A quiet
  probe says declared work settled; product-owned assertions must still decide
  whether the result is correct.

## Install

Pin Direct as a development dependency:

```sh
bun add --dev @hraness/direct@0.7.15
# or
npm install --save-dev @hraness/direct@0.7.15
```

Keep Direct in `devDependencies`. A production entry must not import Direct,
its fixture worlds, or its workbench.

## Open one deterministic state

The repository's Todo example runs the same React interface against a Direct
composition. It requires Git and Bun 1.3.14, then downloads the source and its
development dependencies:

```sh
git clone --branch v0.7.15 --depth 1 https://github.com/hraness/direct.git
cd direct
bun install --frozen-lockfile --ignore-scripts
bun run example:direct
```

Open
[`http://127.0.0.1:5173/direct/?__direct_scenario=todos.populated`](http://127.0.0.1:5173/direct/?__direct_scenario=todos.populated).
The page starts with the named populated world and stays available for browser
inspection. The example reserves that exact local address and exits instead of
silently choosing another port when it is occupied. Stop the development server
when the review is complete.

## Install the Agent Skill

Install Direct's single bundled skill from the public repository:

```sh
npx skills add hraness/direct#v0.7.15
# or
bunx skills add hraness/direct#v0.7.15
```

The skill is invoked as `$direct`. It routes installation, adoption, and
verification work while keeping the development-only production boundary
visible. Restart or reload an agent runner that does not discover newly
installed skills during the current session.

### Tell your coding agent to install it

Copy this prompt into Codex, Claude Code, or another coding agent:

```text
Use $direct to install hraness/direct from
the npm registry at the exact 0.7.15 version. Follow the repository README, add
`@hraness/direct` to devDependencies only, and verify that the production
dependency graph excludes Direct. Do not add a fixture composition until I
ask.
```

The repository and tagged package carry the same skill. Installing the skill
does not add Direct to a consumer project. The skills CLI remains the preferred
way to let runners discover it; the packaged copy supports runners and tools
that read skills from installed development dependencies.

Pin the public npm package to an exact immutable version:

```json
{
  "devDependencies": {
    "@hraness/direct": "0.7.15"
  }
}
```

Then install with the package manager already used by the project:

```sh
bun install
# or, in an npm project
npm install
```

## Agent skills

Packages built from this source include one Agent Skill under
`node_modules/@hraness/direct/skills/direct/`. `$direct` guides a product-owned
port and deterministic composition, then audits scenario behavior,
quiescence, coverage claims, cleanup, and emitted production boundaries. The
package smoke test keeps that future packaged copy byte-identical to the
repository skill.

Prefer `npx skills add hraness/direct#v0.7.15` or
`bunx skills add hraness/direct#v0.7.15` for runner discovery. You can also copy
or link that one skill directory into a runner's configured location, then
invoke `$direct`. Package installation leaves the skill inert: it does not run
a `postinstall` hook or edit repository or user configuration.

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

See the [Todo example](examples/todos) for a strict parser, product-owned port,
React workbench, and emitted-graph boundary verifier. The
[React Native example](examples/react-native) uses the same session model in a
platform-resolved Expo composition while keeping native production graphs
Direct-free.

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
| `@hraness/direct/tooling/bombadil-campaign` | Direct property and conservative action factories for a Bombadil specification | Bombadil 0.7.2 specification compiler |
| `@hraness/direct/tooling/bombadil` | Local server ownership, native Bombadil lifecycle, serial campaign matrices, trace attestation and summaries, replay, and diagnostic artifacts | Bun 1.3.14 with Node APIs |
| `@hraness/direct/tooling/bundle-boundary` | Deterministic emitted-file scans and exact versioned-wire evidence | Bun 1.3.14 with Node APIs |

The tooling subpaths are development-only. They are built separately from the
browser runtime and never enter the default, core, React, testing, or web
graphs. Tooling type checks require Bun and Node type definitions. The
Bombadil subpaths require a consumer-installed exact
`@antithesishq/bombadil@0.7.2` development dependency. That peer stays
optional for Direct consumers that do not use fuzzing. The campaign export
points to its shipped TypeScript source because Bombadil 0.7.2 resolves package
exports without standard `import` or `types` conditions; use it only from a
Bombadil specification.

`readDirectBrowserContract` binds the exact package bridge schema and Direct's
manifest and probe parsers. Use `createDirectBrowserContractReader` when a
verifier supplies another compatible protocol. `createAgentBrowser` expects
agent-browser 0.32.3 at `node_modules/.bin/agent-browser` below the supplied
`repositoryRoot` and an empty task-owned config at
`scripts/direct/agent-browser.verify.json`. The product supplies its explicit
launch arguments, allowed domains, scenario commands, and final close policy.

### Fuzz one Direct scenario

Bombadil can explore a rendered Direct scenario with four recurring bounded
health properties. The host then attests the complete trace for one stable
scenario, route, activation identity and catalog, exact contracts, zero
declared violation counters, and final quiescence. Install the supported release
directly in the consumer:

```sh
bun add --dev @antithesishq/bombadil@0.7.2
```

A product campaign re-exports Bombadil's browser properties, then names the
Direct formulas and conservative action generator:

```ts
import {
  createDirectBombadilActions,
  createDirectBombadilProperties,
} from "@hraness/direct/tooling/bombadil-campaign";

export * from "@antithesishq/bombadil/browser/defaults/properties";

const direct = createDirectBombadilProperties();
export const direct_safe_actions = createDirectBombadilActions();
export const direct_startup_contract = direct.startupContract;
export const direct_exact_contract = direct.exactContract;
export const direct_stable_catalog = direct.stableCatalog;
export const direct_no_declared_violations = direct.noDeclaredViolations;
export const direct_eventual_quiescence = direct.eventualQuiescence;
```

The product keeps its own scenario, semantic assertions, server command, entry
path, and any additional safe actions. Call `runDirectBombadilFuzz` from
`@hraness/direct/tooling/bombadil` in a small Bun wrapper. The runner accepts
only an explicit local HTTP origin, starts an argv-only server command, invokes
the exact native 0.7.2 binary, attests the bounded trace with Direct's canonical
parsers, writes pass or failure artifacts plus a compact exploration summary,
and releases its owned processes. Use `runDirectBombadilFuzzMatrix` when a
product owns several scenarios; it runs them serially and requires one exact
campaign selector for replay. Matrix upload plans are public-summary only and
publish one atomic parent leaf; run a selected campaign directly for bounded
access-controlled private diagnostics.

Scheduled wrappers should precompute one lowercase UUID and pass it through
the runner's `artifactRun` option. Resolve the exact leaf with
`resolveDirectBombadilUploadLeaf` and upload only that leaf with `if: always()`.
Its default
public mode contains a bounded sanitized receipt and summary, including for
rejected or failed runs. Raw traces, logs, screenshots, paths, labels, typed
values, queries, and foreign errors stay local unless an access-controlled job
explicitly selects the bounded `private-vetted` mode.
Parse retained JSON from `unknown` with the four exported
`parseDirectBombadil*Receipt` and `parseDirectBombadil*Summary` functions;
never cast `JSON.parse` output to an evidence type.

Startup is the only repairable contract phase. It must reach one exact Direct
observation within ten seconds. From that sample onward, activation identity,
route, scenario, catalog, and zero declared violations are immediate safety
invariants; only quiescence remains bounded liveness.

Keep liveness formulas time-bounded. Prefer guarded product actions with
explicit weights over unrestricted browser actions, and name small JSON
snapshots that expose semantic state without retaining page content. Run short
12–30 second campaigns while editing and longer 60–300 second matrices in a
scheduled diagnostic lane. Inspect and replay a retained failing trace, then
promote the smallest readable failure to a deterministic product regression.
Give every product-owned named snapshot an exact fail-closed parser or type
predicate. A local random walk discovers reachable surprises; an Antithesis
environment supplies deterministic simulation and reproducibility around the
same bounded properties. Do not treat either one as a replacement for Direct's
deterministic scenarios, semantic assertions, production-boundary checks, or
ordinary browser gates.
When a campaign must exercise an interaction, require a named product value to
change after the intended action kind, as well as after a non-Wait action, so
bootstrap, idle, prerequisite, and unrelated transitions do not satisfy the
exploration policy. Attribution requires adjacent exact Direct observations;
it is temporal response evidence rather than proof of causality.
If the full product snapshot includes viewport dimensions, put that requirement
on a separate interaction snapshot without viewport fields and require an
opposite-size `SetViewport` independently. Latch the first ready product state
for initial-world properties so later actions cannot repair a bad initial state.
The raw trace remains authoritative and may contain screenshots, URLs, typed
text, accessible labels, and local paths; treat it as potentially sensitive.
Summary counts and hashes help triage exploration but are not Direct coverage.
See [Verification](./docs/verification.md#run-a-bounded-bombadil-campaign) for
the complete configuration and proof limits.

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

This repository contains the deterministic kernel, browser bridge, production-exclusion scanner, bounded host-verification helpers, agent skills, a small React example, and an Expo/React Native reference app. It does not bundle a browser driver, shared process coordinator, browser-worker pool, or browser benchmark. The optional agent-browser helper invokes the consumer's local installation. The optional Bombadil helper supervises one explicitly configured local server and native Bombadil process tree, but does not coordinate concurrent repositories or turn diagnostic fuzzing into product-specific proof. The product owns semantic assertions and evidence claims, and external proof remains required for replaced systems, browser custody, or performance.

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

The [public Todo example](examples/todos) uses one `TodoPort` in both
compositions. The component receives whichever implementation the entry point
owns:

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
