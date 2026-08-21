# Adopt Direct

## Inspect the product boundary

1. Read every applicable `AGENTS.md`, the package manifest, build configuration, production entry, feature state, and existing tests.
2. Trace the external dependency that makes the target state slow or nondeterministic.
3. Choose the lowest product-owned semantic port above that dependency and below the behavior under review.
4. State which adapter, service, host, platform, or device behavior the deterministic composition will replace and therefore cannot prove.

Do not simulate a provider SDK or wire protocol when the product can own a smaller domain port. Do not fork product UI or reducers into fixture-only copies.

## Separate production first

1. Define the port in production-safe product code.
2. Move provider, native-module, storage, or service imports into a production adapter.
3. Compose production from a production-only graph.
4. Add Direct as a development dependency and create a distinct Direct graph and output directory. Use a separate entry when both compositions target the same platform; a non-shipping Expo web fixture may instead sit behind an extensionless import with `.native` and `.web` implementations below a shared route tree.

Reject a design that conditionally imports fixtures from a query string, build flag, or runtime environment variable inside the production graph. Keep platform-specific navigation providers below shared routes and screens so route discovery sees one stable module while the bundler selects one composition.

## Define the deterministic surface

1. Define one bounded JSON world with a literal version.
2. Parse it from `unknown`; reject unknown keys, unsupported versions, duplicate identifiers, inconsistent states, and exceeded bounds.
3. Call `defineDirect` with a validated default, stable scenario IDs, and exact `fixture`, `mixed`, or `direct` coverage entries. Authored invalid configuration should fail during startup. Use `tryDefineDirect` for typed configuration assembled dynamically and `parseDirectDefinition` for genuinely unknown configuration.
   Keep each definition within the public discovery bounds of 256 scenarios
   and 256 coverage entries.
4. Implement deterministic adapters for the same product ports. Use logical time for product delays and activity scopes for asynchronous work.
5. Use exact scripts only when request or event order is part of the claim. Keep arbitrary valid interactive behavior stateful in the product adapter.
6. Call `createDirectSession` to own activation, store, clock, activity,
   harness construction, the world-free session manifest, probe observation,
   cancellation, and reverse-order cleanup.

Treat the shared world store as a scenario seed and activity ledger. Let product adapters own mutable repositories or event streams after construction.

A scenario contains initial world, route, and optional logical-runtime state. Product-verifier actions, semantic assertions, and evidence policy do not belong in the scenario catalog.

## Add the development entry

Render the real product interface with deterministic adapters from
`session.harness`. Call `installDirectBrowser({ session })` only in a browser
Direct entry. It atomically publishes the exact session manifest, live probe,
and reset action, installs the fail-closed application-fetch firewall by
default, tracks fetch work in the session activity scope, and registers
cleanup with the session. Configure blocked-request and activity-error
observers as named violations. Pass `firewall: false` only when another
checked boundary owns the same application-`fetch` policy. The verifier still
needs pre-navigation egress containment.

Do not create a product-specific scenario-discovery global. The manifest
already publishes the query keys, default scenario, ordered scenario metadata,
active identity, and coverage contract without exposing worlds, scripts, or
product assertions. Its catalog drift fingerprint covers the query keys,
default scenario, ordered metadata, and exact coverage snapshot. The scenario
route is the expected product route; the product still owns whether its Direct
entry lives at that route or inside one wrapper URL.

Display activation failures. Never fall back from malformed explicit activation to a nearby valid scenario.

Keep browser process and session policy in the product verifier, outside the
product composition. Direct's browser runtime remains driver-neutral. Prefer
the optional `@hraness/direct/tooling/browser-verification` Bun/Node helpers
for atomic bridge reads, bounded agent-browser commands, server leases, and
artifacts when they fit the repository. The helpers invoke the consumer's
local agent-browser installation; they do not bundle a driver, coordinate
parallel work, supervise cleanup, or own product commands and evidence.

Use one task-owned local Chromium session and process for a sequential batch of
at most eight scenarios. Call `window new` before every scenario to create a
fresh BrowserContext. Inventory its tabs and attempt to close scenario-owned
tabs, retaining each command result and the post-attempt inventory.
agent-browser 0.32.3 can ignore `Target.closeTarget` errors, so do not claim
proven per-tab closure. Keep the inert no-URL bootstrap tab until the final
whole-browser close, which is the stronger disposal boundary. Do not reuse a
context, substitute `tab new`, or launch one process per scenario. Capture
semantic and visual evidence in the same exact Chromium context.

Pass an exact `--allowed-domains` list for the target and required asset hosts
before the first navigation. Start Chromium with `open` and no URL so
agent-browser installs the allowlist while creating its inert internal
`about:blank` tab. Do not pass `about:blank` as an explicit URL; 0.32.3 rejects
that hostname-free navigation under the allowlist. Keep the Direct
application-`fetch` firewall as instrumentation; it does not contain
navigation, subresources, WebSockets, workers, service workers, beacons,
WebRTC, native traffic, or another realm.
Forbid ordinary browser-wide `--cdp` attachment because named sessions do not
isolate contexts and agent-browser 0.32.3 cannot combine that attachment with
`--allowed-domains`.

Run locally serial unless a real external coordinator enforces shared
admission. Direct does not integrate or enforce a process cap. Use one explicit
session, empty task-owned config, fresh socket directory, sanitized
environment, exact allowlist, and bounded idle timeout for every batch command.
Record the exact agent-browser version.

Require a successful final browser close. A close failure invalidates the
batch; preserve task metadata and do not claim disposal or performance.
The idle timeout is only an orphan backstop. Parallel-admission or crash-safe
cleanup claims require a real external supervisor that owns both the
agent-browser daemon and Chromium roots, or one containing job. The roots can
occupy different process groups, so daemon exit alone is not cleanup proof.

## Prove behavior and exclusion

Add focused tests for:

- accepted and rejected worlds;
- scenario and coverage drift;
- session-manifest round trips, active identity, and catalog drift;
- deterministic adapter success, declared failure, cancellation, and cleanup;
- exact-script consumption and remaining work when scripts are used; and
- emitted production output containing a forbidden marker.

Build production and Direct separately. Scan emitted production assets for package names, wire schemas, reserved query keys, fixture and workbench markers, and browser globals. Prefer `@hraness/direct/tooling/bundle-boundary` for the shared scan mechanics while keeping included paths, product markers, and positive production identity evidence product-owned. Fail a scan that inspects no executable files.

For native bundles, emit a paired source map for each production platform. Positively require stable path suffixes for the shared screen and state, native composition, and production adapters in every map; reject the Direct package, `.web` composition, fixtures, and workbench sources. Apply the inverse positive selection to a web fixture map. An absence-only scan of an unrelated clean bundle is not proof.

Update the nearest `AGENTS.md`, package README, and command documentation. Run the narrow tests while iterating, then the repository's complete in-scope gate.

## Report the result

Name the selected port, deterministic scenarios, proof modes, commands run, production surfaces scanned, and direct evidence that still remains. Do not describe fixture evidence as proof of a replaced external system.
When browser verification is in scope, also name the process and session
policy. Require each evidence record to carry the exact browser-driver version,
configured backend, allowed hosts, observed browser identity, batch index and
size, verifier-assigned scenario/context label, fresh `window new` command and
result, tab inventories and close-attempt results, execution mode, and final
close result. Only when a performance comparison is explicitly requested, report wall time
separately from local host CPU and peak resident memory; lower host load is not
itself a faster result. Direct provides no browser-run or performance evidence;
require external product evidence for either claim.
