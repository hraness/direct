# Direct

[![skills.sh](https://skills.sh/b/hraness/direct)](https://skills.sh/hraness/direct)

Direct gives browser agents repeatable app states for frontend testing. The
development-only TypeScript library opens signed-in, empty, and error states by
URL.

Direct runs your real interface and feature code against named, validated
fixture data, so a browser agent can reach a hard-to-set-up state without
clicking through setup or depending on live systems.

[GitHub releases](https://github.com/hraness/direct/releases) ·
[Install @hraness/direct from npm](https://www.npmjs.com/package/@hraness/direct) ·
[Direct source on GitHub](https://github.com/hraness/direct) ·
[Direct overview](https://hraness.com/direct)

```text
real interface and feature code
              │
       your app's port
          ┌───┴────┐
   production   Direct
     adapter    fixtures
```

## Why Direct

Your interface and feature logic run unchanged. They reach external systems
through a port, a small interface your app owns. In a Direct build, only the
adapters a scenario needs are replaced with deterministic ones that read
fixture data.

The page tells your verifier when it is ready. A versioned page API,
`window.__direct`, exposes the active scenario, the coverage claims, and a
readiness probe. A quiet probe means the work your app reports to Direct has
settled; your own assertions still decide whether the result is right.

Each coverage claim says what a check exercised: `fixture` (fixture data
only), `mixed` (fixture data plus a named live check), or `direct` (the real
system). A verifier reads the scenario, route, coverage claims,
and probe from the page in one read before it reports a result. Direct doesn't
click anything, and a fixture run doesn't test the live systems behind the
replaced adapters.

Direct is built on the design every Hraness project shares: your app keeps its
own port, only the adapters a scenario needs are replaced, and each run leaves
coverage claims a verifier can check.
[The thread through hraness](https://hraness.com/writing/the-thread-through-hraness)
follows that design across the projects, and the
[ALGAL vision](https://algal.computer/docs/vision/) states the bet behind it.

## Install

Install the [v0.7.22 release](https://github.com/hraness/direct/releases/tag/v0.7.22)
from GitHub. Releases there are immutable, and npm mirrors the same archive.
The [publishing guide](docs/publishing.md#install-and-update-from-github)
explains how to verify the archive and its provenance.

Pin Direct as a development dependency:

```sh
bun add --dev https://github.com/hraness/direct/releases/download/v0.7.22/hraness-direct-0.7.22.tgz
# or
npm install --save-dev https://github.com/hraness/direct/releases/download/v0.7.22/hraness-direct-0.7.22.tgz
```

The same archive is on npm as `@hraness/direct@0.7.22`. Keep Direct in
`devDependencies`, and don't import Direct, its fixture worlds, or its
workbench from a production entry.

## Open one deterministic state

The repository's Todo example runs the same React interface against a Direct
composition. It requires Git and Bun 1.3.14, then downloads the source and its
development dependencies:

```sh
git clone --branch v0.7.22 --depth 1 https://github.com/hraness/direct.git
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

## Inspect one complete browser trace

Read the active scenario and its current probe from the page in one synchronous
evaluation. A browser driver can run this expression after it opens the URL
above:

```js
(() => {
  const bridge = window.__direct;
  const probe = bridge.snapshot();
  const claim = bridge.manifest.coverage.entries.find(
    (entry) => entry.key === "todos.completion",
  );
  return {
    schema: bridge.schema,
    scenario: bridge.manifest.active.scenario,
    route: bridge.manifest.active.route,
    coverage: claim?.mode,
    pending: probe.pending,
    violations: probe.violations,
    isQuiescent: probe.isQuiescent,
  };
})()
```

The released Todo composition returns this initial sample:

```json
{
  "schema": "direct.browser-bridge/v2",
  "scenario": "todos.populated",
  "route": "/",
  "coverage": "fixture",
  "pending": { "todoOperations": 0 },
  "violations": {
    "activityFailures": 0,
    "blockedNetworkRequests": 0
  },
  "isQuiescent": true
}
```

The driver can now complete “Write the public guide,” wait for a second stable
probe, and assert that the real Todo interface changed. The `fixture` mode
records what that run covered: the interface and the app's port ran, but
browser local storage did not. The example tracks local storage as a separate
`direct` claim, which needs real browser storage.

## Choose an interface

| Interface | Use it for | Limit |
| --- | --- | --- |
| `$direct` Agent Skill | Install Direct, design your app's port, add scenarios, and audit coverage claims | Guides an agent's work; it doesn't install the package or change a project on its own |
| TypeScript package | Define worlds, open sessions, install the `window.__direct` page API, and read results | Development-only; keep it out of production builds |
| Browser driver | Navigate, interact, inspect semantics, and capture screenshots | Not part of Direct; use agent-browser, Playwright, or another driver |

## Install the Agent Skill

Install Direct's single bundled skill from the public repository:

```sh
npx skills add hraness/direct#v0.7.22
# or
bunx skills add hraness/direct#v0.7.22
```

Invoke the skill as `$direct`. It guides installation, adoption, and
verification, including a check that production builds exclude Direct. Restart
or reload an agent runner that does not discover newly installed skills during
the current session.

### Tell your coding agent to install it

Copy this prompt into Codex, Claude Code, or another coding agent:

```text
Use $direct to install hraness/direct from the immutable v0.7.22 GitHub release
archive. Follow the repository README, add
`@hraness/direct` to devDependencies only, and verify that the production
dependency graph excludes Direct. Do not add a fixture composition until I
ask.
```

The repository and tagged package carry the same skill. Installing the skill
does not add Direct to a consumer project. The skills CLI is the preferred way
to let runners discover it; the packaged copy supports runners and tools
that read skills from installed development dependencies.

Pin the release archive in your project's manifest:

```json
{
  "devDependencies": {
    "@hraness/direct": "https://github.com/hraness/direct/releases/download/v0.7.22/hraness-direct-0.7.22.tgz"
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
`node_modules/@hraness/direct/skills/direct/`. `$direct` guides an agent
through adding your app's port and a Direct build, then audits scenario
behavior, readiness, coverage claims, cleanup, and production build output. The
package smoke test keeps the packaged copy byte-identical to the tagged
repository skill.

Prefer `npx skills add hraness/direct#v0.7.22` or
`bunx skills add hraness/direct#v0.7.22` for runner discovery. You can also copy
or link that one skill directory into a runner's configured location, then
invoke `$direct`. Installing the package doesn't activate the skill. It runs no
`postinstall` hook and changes no repository or user configuration.

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

`defineDirect` is the concise authored-config path; scenario defaults and coverage citations are checked against the same scenario tuple. Use `tryDefineDirect` for typed configuration assembled dynamically. Use `parseDirectDefinition` for untyped input, such as JSON loaded at runtime; it returns a `Result` with a broad JSON world and string route, because untyped data cannot carry compile-time types.

One definition may contain at most 256 scenarios and 256 coverage entries.

The session supplies the parsed world, a store that rejects writes left over
from before a reset, a logical clock,
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

## Coverage modes

Each coverage entry has one mode:

| Mode | Meaning |
| --- | --- |
| `fixture` | The real interface and product logic ran through deterministic ports. Replaced adapters and platforms were not exercised. |
| `mixed` | Fixture evidence is paired with named evidence from the real adapter or service. Neither half is enough alone. |
| `direct` | The claim requires the real host, service, runtime, filesystem, operating system, or device. |

Coverage cites scenario IDs rather than duplicating a singular route. Each scenario owns its route, so one claim may span scenarios on different routes without inventing a second routing abstraction.

A quiet probe means the declared deterministic work settled. It does not prove that the rendered result is correct. Pair quiescence with your own semantic assertions, visual inspection where relevant, and real-system tests for every replaced adapter the coverage catalog names.

## Package surfaces

| Import | Purpose | Runtime boundary |
| --- | --- | --- |
| `@hraness/direct` | Authored definitions plus the scenario, coverage, fixture, JSON, activation, and logical-time types needed to describe them | Framework-free |
| `@hraness/direct/core` | Advanced catalog, parser, store, runtime, effect, resource, ID, and `Result` mechanics | Framework-free |
| `@hraness/direct/react` | Typed context, provider, and external-store hooks for React DOM or React Native | Optional React peer |
| `@hraness/direct/testing` | Sessions, manifest and probe parsers, evidence classification, activity scopes, and exact scripted transports | Development and verification |
| `@hraness/direct/effect` | Scoped asynchronous operations, generation-bound commits and deadline testing | Optional Effect 3.22.1 peer; development and verification |
| `@hraness/direct/web` | Atomic browser installation, with low-level bridge and firewall escape hatches | Browser only |
| `@hraness/direct/tooling/browser-verification` | Protocol-bound bridge reads, product-owned named-box layout contracts, bounded agent-browser commands, local server leases, and artifact writes | Bun 1.3.14 with Node APIs |
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
The same tooling subpath parses named layout boxes and explicit product rules
for containment, selected no-overlap pairs, alignment, viewport clipping,
minimum size, and two-sample stability. It does not inspect the DOM or compare
every box pair.

### Test an Effect workflow

Install `effect@3.22.1` when you use `@hraness/direct/effect`. Existing entry
points do not import Effect. Keep Direct in the development graph and run the
same application workflow with a product-owned test Layer, as shown in the
[document controller example](examples/effect/document-controller.ts).

Construct `createDirectEffectDriver({ context, layer, clock: "deadline" })`
inside `createDirectSession`'s `create` callback and return `driver.observation`
from `observe`. Call `driver.runExit("operation", operation => program)` to
admit a scoped operation. Commit world changes through `operation.transact`;
it checks the captured generation and rejects closed or settled owners.

`driver.advance(milliseconds)` advances the existing Direct clock through
absolute deadlines and drains owned continuations. Concurrent 10/20 ms sleeps
finish by 20 ms. Existing FIFO waits still sum to 30 ms. Use only the driver's
advance operation in deadline mode; mixing it with `session.clock.wait` or
manual clock advancement is unsupported. Positive fractional Effect sleeps
round up to the next millisecond; infinite sleeps remain interruptible. Finite
time must stay within the safe integer range. Tied deadlines wake in admission
order, followed by Effect scheduler priority and insertion order. Synchronize
application races explicitly when their winner matters.

Call `session.dispose()` to fence admission and request interruption
synchronously, then await `driver.close()` to join operations and close Layer
resources. The close report retains operation and background failure Causes, activity
errors and the runtime teardown Exit separately. A Supervisor keeps suspended
Layer workers visible to the probe even after a root operation finishes.
`childFailures` retains observed operation-descendant Causes even when the
root succeeds; joins, races or retries may have handled these exits, so they
do not independently increment the violation counter. Background failure
records are observed Layer-fiber exits, not proof of application failure.
Inspect these results; expected
domain failures and interruption are not interchangeable with defects. A reset
interrupts old-generation operations but retains the Layer: recreate the
session when the product requires new services. Pending old-generation
finalizers remain visible in the probe after the store resets its ledger.

Deadline mode controls Effect timers and cooperative continuations. Native
callbacks and foreign Promises still execute on their real host. A Promise
that ignores cancellation can continue after its Effect fiber exits; the
product adapter must track that work and prevent late external writes.
Guarded world transactions do not revoke external authority. Async finalizers
that sleep need the test owner to keep advancing time while close is pending.
The default 10,000-step drain budget reports excessive cooperative work;
`drain()` can resume a paused queue during recovery. It cannot preempt a
synchronous infinite loop.

`bun run check:effect` enforces declared adapter/runtime ownership and rejects
typed floating Effects, unsafe channel assertions and failure-erasing
shortcuts. Its paired fixtures run in the aggregate check. These rules do not
prove domain correctness or linear resource lifetimes.

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

The npm binary remains the default. A consumer that must validate a reviewed
native fix before its next Bombadil release may set `bombadilToolchain` to one
exact repository-confined executable, SHA-256 digest, full source revision,
supported build contract, and version `0.7.2`. Direct rejects partial or mixed
matrix identities, symlinks, non-executable files, executables larger than 64
MiB, and digest drift while it opens the configured executable. It copies those
attested open-file bytes into
one private task-owned read/execute-only snapshot, then runs both the bounded
version probe and native campaign from that snapshot. Replacing the configured
path after this boundary cannot change the executed bytes. The consumer must
still install the exact `@antithesishq/bombadil@0.7.2` package for specification
imports. Local raw evidence records the reviewed identity; sanitized upload
receipts omit its path and provenance.

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

This repository contains the core library, the browser bridge, a scanner that checks production builds for Direct code, host-side verification helpers, the `$direct` Agent Skill, a small React example, an Effect workflow example, and an Expo/React Native reference app. It does not include a browser driver, a shared process coordinator, a pool of browser workers, or a browser benchmark. The optional agent-browser helper runs the copy installed in your project. The optional Bombadil helper supervises one local server and one Bombadil process tree that you configure. It doesn't coordinate runs across repositories, and its fuzzing results are diagnostics, not a test of your app's behavior. Your app owns its assertions and coverage claims. The systems Direct replaces, which browser and context produced a result, and performance each need evidence from outside Direct.

<!-- article:direct-a-harness-for-your-frontend:start -->
## [Direct gives browser agents repeatable app states](<https://hraness.com/direct>)

> Direct sets up the state behind a page, such as a signed-in account or a failed save, and gives it a URL your browser agent can open again and again. It stands in for live services with fixture data, so it does not test those services.

A browser agent can open a page, click a control, and inspect the result. What it can't do quickly is set up the state behind that page. A signed-in account, a particular database record, a device permission, a model response, or a failure at the right moment can take longer to arrange than the screen takes to review.

Direct handles that setup. Your app reaches each slow or unpredictable dependency through a port, a small interface your app owns. In a Direct build, the port returns fixture data instead of calling the live system, and each state gets a name and a URL. Your browser tool still does the clicking and checking.

### Browser control and app state are different jobs

[agent-browser](<https://agent-browser.dev/>) gives coding agents a compact command-line interface for opening pages, reading accessibility snapshots, and interacting with elements. Playwright and other browser drivers solve the same broad problem with different APIs. If the state you need is already fast and reliable to reach, use a browser tool by itself.

Direct helps when setup dominates the loop: repeated sign-in, slow seed requests, empty or error states that are hard to create, native modules that aren't available, paid model calls, or device permissions that automation can't reset cleanly. Direct doesn't drive the browser. It hands the browser tool a known page state to start from.

### Swap in fixture data behind your feature code

For example, a task view might read and update tasks through a task repository port. In production, that port connects to a live service. In a Direct build, the same port connects to a deterministic implementation. The interface, reducers, parsing, navigation, and feature logic above the port run the same code either way.

**Where Direct sits**

```text
agent-browser or Playwright
            │
   real interface + feature state
            │
     your app's port
        ┌───┴────┐
  live system   Direct world
```

A Direct world is validated JSON that describes one starting state. A scenario gives a world a name and a route. Scenarios contain no browser actions; your browser check decides what to click and what to assert.

The [public Todo example](examples/todos) uses one `TodoPort` in both
builds. The component receives whichever implementation its entry point
provides:

**One port, two builds**

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

The interface speaks in the app's own terms: todos and completion. It contains no Direct types and doesn't know whether storage is live or deterministic. Put the port as low as you can while keeping the behavior under review above it. If the Direct adapter has to copy the logic you're trying to test, the port is too high, and the fixture would imitate that logic instead of testing it.

### One session per scenario

At runtime, a Direct build has three parts:

- A definition lists the named scenarios, their routes, and which systems each check claims to exercise, and it checks that those declarations agree.
- A session activates one scenario and owns its deterministic state, controllable clock, pending work, reset, and cleanup.
- A browser installation publishes a small manifest of the available and active scenarios, exposes readiness and reset controls, and by default blocks `fetch` calls to URLs your app hasn't allowed.

The `fetch` block is on by default so that a fixture gap shows up as a failed request instead of a quiet call to a live service. Your app can allow specific URLs. The block covers only `fetch` calls made in the page where Direct is installed. Other traffic, such as XMLHttpRequest, WebSockets, EventSource, beacons, navigation, asset loads, and requests from workers or other frames, is not intercepted. Direct and its fixture worlds stay out of the production dependency graph.

An agent can read the manifest to list valid scenario IDs and routes, confirm that the page opened the scenario and route it asked for, and check readiness, all without reading your source files.

### Wait until the app is ready

A fixed delay says, “wait 500 milliseconds and hope.” Direct exposes a readiness snapshot instead: no tracked operation is active, and every pending counter your app names is zero. Your browser verifier polls until the active scenario, the revision of tracked work, and the counters stay the same for a settle interval you choose, then checks the interface.

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

`waitForQuiescence` is a helper in your own verifier that reads Direct's snapshot; Direct doesn't ship it. A settled snapshot shows only that the work Direct knows about has stopped changing. It doesn't show that the screen is correct, so the verifier still has to reject relevant console, runtime, and unhandled-request errors, then make its own assertions or visual checks.

### Follow one check from URL to result

The Todo example exposes each step of a check as something you can inspect:

| Step | What you can see |
| --- | --- |
| Open | `?__direct_scenario=todos.populated` selects the validated world. |
| Confirm | The manifest reports scenario `todos.populated`, route `/`, and the `todos.completion` coverage entry. |
| Wait | The probe reports zero `todoOperations`, zero on every declared violation counter, and a quiet revision that stays the same. |
| Act | The browser driver checks the “Write the public guide” box in the real Todo interface. |
| Check | A second stable probe and the checked box show that the change went through the app's port. |
| Limit | The claim stays `fixture` evidence. Local-storage parsing, quota behavior, and persistence need a separate `direct` check against real browser storage. |

You can read the same trace through the TypeScript package, or from the page itself with any browser driver that can run a script there. The `$direct` Agent Skill helps a coding agent add and audit this setup.

### Choose the smallest tool that covers the risk

- Use browser automation alone when the required state is already quick to reach, or when the live backend and browser assembly are part of the check.
- Pair Direct with agent-browser or Playwright when setup and reset dominate the loop and the substituted systems can sit behind a small port your app owns.
- Use unit or component tests when the subject is isolated logic or rendering that does not need the full application.
- Keep live integration and end-to-end tests when the backend, native host, browser assembly, filesystem, operating system, or device is the subject.

Each coverage claim records which systems a check exercised, using one of three labels. A `fixture` claim stops at the deterministic ports. A `mixed` claim pairs fixture evidence with a named live check. A `direct` claim requires the real system. The labels keep a fast development check from being reported as a test of a system it never touched. Direct never exercises the systems behind the ports it replaces, so cover those with live integration or end-to-end tests when their risk warrants it.
<!-- article:direct-a-harness-for-your-frontend:end -->

## Develop

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run example:test
bun run example:typecheck
bun run example:verify
bun run example:build
bun run example:build:direct
bun run example:react-native:test
bun run example:react-native:typecheck
bun run example:react-native:verify
```

Run the compiled production app with `bun run example:dev`. Run the compiled deterministic workbench with `bun run example:direct`, then select `empty`, `populated`, or `write failure` from its scenario navigation. Both require Node 24, build a fresh StyleX generation, and serve one loopback preview; after edits, stop, rebuild/restart, and refresh. They do not provide HMR. Each build performs its source-map and marker scan; to recheck a retained production generation, run `bun run example:check-boundary -- /absolute/path/printed/by/example:build`.

Run the Expo workbench with `bun run example:react-native`. Its verification command exports iOS and Android production bundles plus the deterministic React Native Web composition with paired source maps, proves the expected shared and platform-specific modules were selected, and rejects native/web cross-contamination. It does not replace browser-driven semantic assertions or evidence from a real device.

See [Architecture](./docs/architecture.md), [Adoption](./docs/adoption.md), [Verification](./docs/verification.md), and [Wire formats](./docs/wire-formats.md) for durable contracts.

## Contribute and report vulnerabilities

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Report suspected vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

Direct is available under the [MIT License](./LICENSE).

## Support Direct

Direct is free, and the library never shows support invitations. After useful
work, the `$direct` Agent Skill may show one short invitation to
[support Direct](https://account.hraness.com/support?product=direct#support);
run `node <skill-directory>/scripts/support.mjs support dismiss` to turn these
invitations off for every participating Hraness tool on your machine.
