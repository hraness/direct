# Adopt Direct in a product

Add Direct after identifying the product behavior and external boundary under review. Do not begin by designing fixtures around a provider SDK.

The installed package carries the `direct-setup` Agent Skill under
`skills/direct-setup`. Copy or link that directory into your agent runner's
discovery location and invoke `$direct-setup` to apply this workflow from a
coding-agent task. Package installation does not activate the skill
automatically.

## 1. Define the product port

Put a semantic interface beside the product feature. Move provider, storage, native-module, or service imports into a production adapter. Compose that adapter from the production entry.

The interface and feature code must not import Direct.

## 2. Define the world

Create a development-only Direct directory. Define one JSON-safe world with a literal version and bounded product data. Parse from `unknown`; reject extra fields, invalid identifiers, duplicate records, unbounded strings, unsupported versions, and non-JSON values.

Add example tests for useful worlds and rejected regressions. Add property tests when the parser has meaningful arbitrary-input or round-trip laws.

## 3. Define scenarios and coverage

Call `defineDirect` once with the world parser, one validated default, stable scenario identifiers, and explicit coverage entries. Authored invalid configuration throws during startup because it is a programming error. Use `tryDefineDirect` for typed configuration assembled dynamically. Use `parseDirectDefinition` for a genuinely unknown value; its result deliberately retains broad JSON-world and string-route types.

One definition may contain at most 256 scenarios and 256 coverage entries.
These are public discovery limits, not suggestions for one large workbench.

A scenario contains initial world, route, and optional logical-runtime state. Browser actions, semantic assertions, and evidence policy belong to the product verifier rather than the scenario catalog.

- Use `fixture` when deterministic ports support the full claim.
- Use `mixed` when the fixture claim requires named direct adapter or service evidence.
- Use `direct` when the real external system is the claim.

Do not attach scenarios to a direct claim. Do not leave a fixture claim without a scenario.
Coverage cites scenario IDs rather than copying a route; resolve each cited scenario through the catalog when the verifier needs its route. A single claim may span scenarios on different routes.

## 4. Implement deterministic adapters

Implement the same product ports as production. Seed adapters from the active world. Use logical time for product delays, activity scopes for asynchronous work, and exact scripts when request or event order is part of the claim.

Unknown requests and unmapped operations must fail. Keep remaining scripted work and product-specific leaked activity visible to the probe.

## 5. Create one session

Use `createDirectSession` from `@hraness/direct/testing` to activate the query, create the store, clock, activity scope, product adapters, observation counters, cancellation signal, and cleanup stack.

Return the product-owned ports and diagnostics as the session's `harness`.
Register cleanup while constructing it. Dispose subscriptions, timers,
scripts, repositories, and event sources when the session ends. The session
also exposes a validated, world-free manifest for browser automation. It
contains the ordered public scenario catalog, active identity, coverage
snapshot, query keys, and a catalog drift fingerprint. Callers do not need to
serialize or duplicate the definition's catalog themselves.

## 6. Add a separate composition boundary

Render the real product interface with deterministic adapters from a distinct Direct graph. A web or desktop product may use a separate entry. An Expo product may keep a shared entry and route tree while an extensionless import resolves to nested `.native` and `.web` composition modules. In either shape, production modules cannot reach the Direct graph.

Call `installDirectBrowser({ session })` only in the Direct browser
composition, never in a production entry or native platform variant. The
atomic installation publishes the session manifest, probe, and reset action
through `window.__direct`, installs the fail-closed fetch firewall by default,
and returns one disposable handle. It also registers that cleanup with the
session. A failed installation rolls back both browser hooks.

Use `session.harness` from application composition code. Configure `firewall.onBlocked` and `firewall.onActivityError` when the product needs named violation counters. Pass `firewall: false` only when another checked boundary owns network containment.

## 7. Verify behavior and exclusion

Test the parser, definition, deterministic adapters, failures, cancellation, cleanup, and exact-script drain behavior. Build the production and Direct graphs independently. Scan emitted production output for Direct markers. Drive representative scenario URLs with the browser tool used by the product.

Read the `direct.browser-bridge/v2` schema, manifest, and probe in one
synchronous page evaluation after every navigation. Parse both values from
`unknown`. Confirm the requested activation source, scenario, and product
route, then require the manifest and probe activation hashes to match. Retain
one catalog hash across the run and bind every sampled coverage value to the
authored definition. Wait for a stable quiet probe, reject relevant violations
and runtime errors, assert behavior in product terms, and retain the evidence
needed by each coverage claim.

The [todo example](https://github.com/hraness/direct/tree/main/examples/todos) implements this sequence without a backend or credentials.

## React Native and Expo

Use platform resolution rather than a runtime flag. A small app can split `root.native.tsx` from `root.web.tsx`. With Expo Router or a shared navigation entry, put the split lower in the graph:

1. Keep the Expo Router entry, route modules, layouts, shared screens, reducers, and feature state common.
2. Import a narrow composition or navigation-provider module without an extension.
3. Implement its `.native.tsx` variant with production adapters and native navigation providers.
4. Implement its `.web.tsx` variant with the Direct world, session, deterministic ports, workbench, and atomic browser installation.
5. Pass the same product-owned ports and shared state into the same screens from both variants.

Do not copy route behavior or feature state into the web variant. If native-only navigation chrome cannot render on web, provide the smallest substitute needed to reach the shared screens and label its proof boundary explicitly.

This `.web` fixture pattern assumes web is not also a production target. When the product ships a real web app, keep its web variants production-only and give Direct a distinct development entry or app graph.

| Evidence | Supports | Does not support |
| --- | --- | --- |
| Direct web behavior | Shared screen semantics, shared feature state, deterministic port interactions, and a literally shared navigation reducer | Substituted stacks, tabs, headers, safe areas, gestures, transitions, native back handling, deep links, or OS integration |
| Native source-map selection | The emitted graph selected the claimed shared modules, `.native` composition, and production adapters while excluding the web fixture graph | Correct runtime behavior, layout, module responses, or device behavior |
| Web source-map selection | The emitted graph selected the claimed shared modules, `.web` composition, and Direct provider | Native navigator or platform behavior |

Export iOS and Android independently with external source maps. Require at least one executable with a paired map for each platform. In every native map, positively match stable normalized path suffixes for the expected shared route, screen, and state modules, the `.native` composition, and the production adapter. Reject `.web` composition, workbench, fixture, bridge, and Direct package paths. For the web export, positively require the shared behavior modules and the `.web` Direct composition. Keep content-marker scans as defense in depth; a clean map that never selected the intended product graph must fail.

These gates prove structural selection and exclusion. Native layout, modules, platform values, navigation chrome, operating-system behavior, and physical-device behavior remain direct evidence. Split coverage entries when the shared feature and the platform shell require different proof modes.

The [React Native example](https://github.com/hraness/direct/tree/main/examples/react-native) is a minimal Expo implementation of this split.
