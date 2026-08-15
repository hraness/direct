# Architecture

Direct changes the development composition below the behavior under review. The real interface, feature state, reducers, parsing, and navigation remain. Deterministic adapters replace the external boundary that makes a state slow, unavailable, or nondeterministic.

## Own the semantic port in the product

Define a port in product vocabulary above a provider protocol:

```text
interface and feature state
            |
    product-owned port
       /           \
production         deterministic
adapter            adapter
```

Use the lowest port that preserves the behavior under review. A task interface should depend on a task repository, not a simulated database client. A desktop renderer should depend on a renderer-safe runtime transport, not a simulated native message protocol. The product owns request, response, event, and failure meanings.

Direct presents three public abstractions:

- A **definition** validates the product's world parser, named scenarios, default activation, and `fixture`, `mixed`, or `direct` coverage claims. Use `defineDirect` for authored configuration, `tryDefineDirect` for typed configuration assembled dynamically, and `parseDirectDefinition` for a genuinely unknown value.
- A **session** activates one scenario and owns its immutable world seed,
  logical clock, generation-fenced store, activity scope, product harness,
  world-free manifest, probe, cancellation signal, and reverse-order cleanup.
- A **browser installation** publishes the exact `direct.browser-bridge/v2`
  manifest, live probe, and reset surface through `window.__direct` and
  optionally installs the fail-closed application-`fetch` firewall.
  Installation and rollback are atomic. The session registers its cleanup, and
  one disposable handle can remove both browser hooks earlier.

React bindings and low-level deterministic mechanics remain available as escape hatches. They are not additional lifecycle owners.

The manifest is the driver-neutral integration point. It contains the query
keys, default scenario, ordered public scenario catalog, active identity, and
coverage, but no worlds or product actions. Its catalog drift fingerprint
covers the query keys, default scenario, ordered scenario metadata, and exact
coverage snapshot. agent-browser, Playwright MCP, and other browser tools can
read the same exact value through page evaluation. Direct does not own their
browser sessions, selectors, navigation, screenshots, or action histories.

Direct remains driver-neutral and has no browser launcher. The product
verifier owns the driver, process lifetime, context policy, navigation, and
evidence capture.

The canonical local policy uses one task-owned agent-browser session and one
Chromium process for a sequential batch of at most eight scenarios. The
verifier calls `window new` before every scenario for a fresh BrowserContext,
inventories the tabs that context creates, and attempts to close its
scenario-owned tabs. agent-browser 0.32.3 can ignore `Target.closeTarget`
errors, so the verifier retains each command result and a post-attempt
inventory instead of claiming proven tab closure. It keeps the inert no-URL
bootstrap tab until the final whole-browser close, which is the stronger
disposal boundary. It never reuses a context or substitutes `tab new`.
Semantic and visual evidence describe the same exact Chromium context.

The verifier passes an exact `--allowed-domains` list for the target and every
required asset host before navigation. Direct's application-`fetch` firewall
still reports unmapped fetches in its JavaScript realm, but it is
instrumentation rather than full containment for navigation, subresources,
WebSockets, workers, service workers, beacons, WebRTC, native traffic, or
another realm.

Local batches run serially unless an external shared coordinator enforces
admission. Direct does not integrate or enforce a process cap. Ordinary
browser-wide `--cdp` attachment is forbidden because named agent-browser
sessions do not isolate contexts; agent-browser 0.32.3 also rejects
`--allowed-domains` with `--cdp`.

Every batch uses an explicit session, empty task-owned config, fresh socket
directory, sanitized environment, exact allowlist, and bounded idle timeout.
A nonzero final browser close invalidates the batch. The idle timeout is an
orphan backstop, not crash-safe cleanup proof. Parallel-admission or crash-safe
cleanup claims require an external supervisor that owns both the agent-browser
daemon and Chromium roots, or one containing job. Those roots can occupy
different process groups, so daemon exit alone cannot prove cleanup.

Direct provides no coordinator, supervisor, browser-run evidence, or
performance evidence. Reports record the driver version, allowed hosts,
execution mode, verifier-assigned scenario/context label, fresh `window new`
command and result, tab inventories and close-attempt results, browser
identity, and final close result.

## Treat the world as a seed

Define one bounded, strict, versioned JSON world. Parse it from `unknown`, reject unknown fields, and return owned values. A scenario selects a world, route, and logical-runtime snapshot.

The shared store retains the immutable scenario seed and activity ledger. A product adapter may create mutable repositories, event streams, or projections from that seed. Do not turn the world store into a generic replay database for every product mutation.

Activation, reset, and ordinary `transact` calls always pass through the strict
world parser. A measured hot path may opt into `transactReplacements` for a
bounded set of existing primitive leaves. Direct parses the exact replacement
rows, rejects container changes and any increase in the world's aggregate raw
UTF-8 string bytes, copies and freezes only touched ancestors, and presents both
the base and candidate worlds to a semantic validator captured when the store is
constructed. Publication requires that validator to approve the exact
generation, operation, replacements, and candidate synchronously. This path is
not a foreign-input parser bypass.

## Keep production exclusion structural

Use distinct entries and compositions:

```text
production entry                 Direct entry
      |                                |
production adapters + UI      deterministic adapters + UI
      |                                |
browser/service/platform       @hraness/direct
```

Do not conditionally import fixtures from a query string, build flag, or runtime environment variable inside the production entry. Put Direct in `devDependencies`, compile it from a separate entry, and scan emitted production assets for package, wire, query, fixture, and workbench markers.

A clean marker scan is narrow evidence: the scanned files did not contain the configured markers. It does not prove native linkage, runtime loading, service behavior, or operating-system behavior.

## Keep optional surfaces isolated

The default `@hraness/direct` export is the curated definition and activation path. Advanced JSON, fixture, catalog, store, runtime, effect, and resource mechanics live under `@hraness/direct/core`. React bindings live under `@hraness/direct/react`, sessions and scripted test utilities under `@hraness/direct/testing`, and browser installation under `@hraness/direct/web`. None of the default, core, or testing surfaces imports React or browser globals. The package runtime does not import React Native or Expo; the React Native example composes these surfaces from a platform-resolved web entry.

`installDirectBrowser` enables the fetch firewall by default. It intercepts application calls to `fetch` in its JavaScript realm and denies a request unless the product's allow predicate accepts its parsed URL. It does not intercept WebSockets, EventSource, navigation, asset loading, native calls, or traffic in another realm. Use it only in a Direct browser entry. Pass `firewall: false` only when another checked boundary owns network containment.

## Resolve React Native compositions structurally

For a small Expo app, Metro can choose distinct roots:

```text
root.native.tsx                 root.web.tsx
       |                              |
native product adapters       Direct session + adapters
       |                              |
       +-------- real screen --------+
```

A root split is the simplest shape, not a requirement. Metro applies platform resolution to extensionless imports below the root too. An Expo Router app can keep its shared entry, route tree, layouts, screens, and feature state while moving only the composition seam into `.native` and `.web` variants:

```text
Expo Router entry + shared routes/layouts
                  |
     import "./app-composition"
          /                         \
app-composition.native.tsx   app-composition.web.tsx
native providers, chrome,    Direct session, deterministic
and production adapters      adapters, and web fixture chrome
          \                         /
             shared screens/state
```

The shared module imports `./app-composition` without a platform suffix. The native variant owns production adapters and native navigation providers. In a native product whose web target is the fixture surface, the web variant owns the Direct session and deterministic adapters. Route files, screens, reducers, and other feature state stay shared unless platform behavior is itself the subject of a direct test. Do not duplicate feature behavior across the variants or choose a composition with a runtime flag.

If web is also a production target, keep its `.web` composition production-safe. Give Direct a distinct development entry or app graph instead of replacing the production web composition. Platform suffixes define build graphs; they are not a substitute for a second entry when two compositions target the same platform.

The web variant may substitute browser-renderable chrome for native-only stacks, tabs, headers, safe areas, or gestures. Browser fixture evidence can then support claims about the shared screen, shared feature state, and product-port interactions. It cannot prove the substituted chrome's native layout, transitions, back behavior, deep linking, gesture handling, or operating-system integration. Record those as separate direct or mixed claims instead of treating a visually similar web shell as the native navigator.

Keep the default root production-safe and Direct in `devDependencies`. Export iOS, Android, and the Direct web composition separately with source maps. For each native map, positively require the claimed shared route, screen, and state modules plus the `.native` composition and production adapter; reject the `.web` composition and Direct modules. For the web map, positively require those same shared behavior modules plus the `.web` composition and Direct provider. An absence-only scan can pass on an unrelated bundle, so it is not sufficient structural evidence.
