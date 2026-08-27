# Verify Direct

## Discover the declared contract

1. Read applicable `AGENTS.md` files, package scripts, Direct definition, world parser, deterministic adapters, session construction, browser installation, verifier, and production-boundary policy.
2. If a Direct page is running, read and parse
   `window.__direct.manifest` first. Use it to list every scenario and coverage
   entry, then compare it with the authored definition when source is
   available.
3. Map each `fixture`, `mixed`, and `direct` claim to the evidence required to close it.
4. Identify the production adapter, service, host, operating system, or device behavior replaced by each deterministic port.
5. Inspect each command before treating it as evidence. A script named `verify` may build and scan boundaries without driving a browser.

Do not infer a stronger proof mode from a passing screenshot or fixture interaction.

## Run deterministic checks

Run the repository's narrow Direct typecheck, unit tests, property tests, and Direct build when those commands exist. Report a missing property suite or browser verifier as `not present`; do not synthesize evidence. Prefer an existing isolated verifier or temporary output directory so builds do not dirty the source tree.

Verify that tests cover malformed worlds, explicit activation failures, adapter failures, cancellation, cleanup, and exact-script drain behavior when applicable.

When a browser verifier exists, drive stable scenario URLs and interact in
product terms. Read only the canonical `window.__direct` bridge. Parse the
complete manifest and every probe; bind `manifest.coverage` to the authored
definition with `parseDefinitionCoverageSnapshot`. Do not accept compatibility
or product-specific globals as equivalent evidence.

The manifest and browser runtime remain driver-neutral. Prefer the optional
`@hraness/direct/tooling/browser-verification` Bun/Node helpers for exact
package-bound bridge reads, bounded agent-browser commands, server leases, and
artifacts when they fit the repository. They invoke the consumer's local
agent-browser installation; they do not bundle a driver, coordinate parallel
work, supervise cleanup, or own product commands and evidence.

When a product already has a Bombadil campaign, prefer the shared
`@hraness/direct/tooling/bombadil-campaign` factories and
`@hraness/direct/tooling/bombadil` host runner instead of copying Direct
extractors, temporal formulas, trace parsers, server leases, process-group
cleanup, or artifact code. Pin `@antithesishq/bombadil@0.7.2` directly in the
consumer. Keep the default browser properties, exported Direct formulas, and
conservative Direct action generator in the campaign; keep product-specific
actions and assertions local. Random runs must be 12 to 300 seconds. Require
the runner's canonical post-run trace attestation even when Bombadil exits
zero, and retain raw trace, process log, server log, and failure artifacts.
Treat the result as diagnostic fuzz evidence, not as a semantic product check
or proof of any replaced system.

For the agent-browser path, use one task-owned local Chromium session and process for a sequential batch of
at most eight scenarios. Before each scenario, call `window new` for a fresh
BrowserContext. Inventory its tabs and attempt to close scenario-owned tabs,
retaining each command result and the post-attempt inventory. agent-browser
0.32.3 can ignore `Target.closeTarget` errors, so do not claim proven per-tab
closure. Keep the inert no-URL bootstrap tab until the final whole-browser
close, which is the stronger disposal boundary. Do not reuse a context,
substitute `tab new`, or launch one process per scenario. Capture semantic and
visual evidence in the same exact Chromium context.

Pass an exact `--allowed-domains` list for the target and required asset hosts
before the first navigation. Direct's application-`fetch` firewall is
instrumentation, not full egress containment for navigation, subresources,
WebSockets, workers, service workers, beacons, WebRTC, native traffic, or
another realm. Forbid ordinary browser-wide `--cdp` attachment. Multiple
session names do not isolate contexts, and agent-browser 0.32.3 rejects
`--allowed-domains` with `--cdp`.

Run serially unless a real external coordinator enforces a shared host-wide
limit. Direct does not enforce a process cap. Parallel-admission or crash-safe
cleanup claims require an external supervisor that owns both the agent-browser
daemon and Chromium roots, or one containing job. The roots can occupy
different process groups, so daemon exit alone is not cleanup proof.

Create an empty task-owned config and fresh socket directory. Remove inherited
agent-browser and proxy settings, set a bounded idle timeout, and use the same
wrapper and session for every batch command:

```sh
set -eu
DIRECT_AGENT_BROWSER_BIN="$(command -v agent-browser)"
test -x "$DIRECT_AGENT_BROWSER_BIN"
DIRECT_BROWSER_SESSION='direct-chromium'
DIRECT_BROWSER_BACKEND='local-chromium'
DIRECT_BROWSER_ALLOWED_DOMAINS='127.0.0.1'
DIRECT_BROWSER_SCENARIO_URL='http://127.0.0.1:5173/direct/?__direct_scenario=todos.populated'
DIRECT_BROWSER_IDLE_TIMEOUT_MS=60000
DIRECT_BROWSER_CONFIG_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/direct-browser-config.XXXXXX")"
DIRECT_BROWSER_SOCKET_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/direct-browser-socket.XXXXXX")"
DIRECT_BROWSER_CONFIG="$DIRECT_BROWSER_CONFIG_DIRECTORY/agent-browser.json"
printf '%s\n' '{}' > "$DIRECT_BROWSER_CONFIG"
test "$(tr -d '[:space:]' < "$DIRECT_BROWSER_CONFIG")" = '{}'

direct_agent_browser() {
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    TMPDIR="${TMPDIR:-/tmp}" \
    AGENT_BROWSER_SOCKET_DIR="$DIRECT_BROWSER_SOCKET_DIRECTORY" \
    AGENT_BROWSER_IDLE_TIMEOUT_MS="$DIRECT_BROWSER_IDLE_TIMEOUT_MS" \
    "$DIRECT_AGENT_BROWSER_BIN" \
    --config "$DIRECT_BROWSER_CONFIG" \
    --allowed-domains "$DIRECT_BROWSER_ALLOWED_DOMAINS" "$@"
}

direct_agent_browser --version
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --engine chrome \
  --json open
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --json tab
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --json window new
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" \
  --json open "$DIRECT_BROWSER_SCENARIO_URL"
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --json tab
```

The no-URL `open` installs the allowlist and creates the inert internal
`about:blank` tab. Do not pass `about:blank` as an explicit URL; agent-browser
0.32.3 rejects that hostname-free navigation under the allowlist. Repeat
fresh-context creation, navigation, evidence, and tab-close attempts for each
scenario, rejecting a ninth before launch. Assign each scenario context a
verifier label and retain the fresh `window new` command and result. Keep the
inert no-URL bootstrap tab until final whole-browser close because
agent-browser 0.32.3 cannot close the last tab. Permissions, IndexedDB, Cache
Storage, and service workers cannot be reset reliably enough to reuse a
context.

Read one synchronous bridge sample through the same wrapper and session:

```sh
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --json eval "(() => { const bridge = window.__direct; return { browserIdentity: { userAgent: navigator.userAgent, platform: navigator.platform }, bridgeSchema: bridge?.schema, manifest: bridge?.manifest, probe: typeof bridge?.snapshot === 'function' ? bridge.snapshot() : undefined }; })()"
```

The JSON command envelope stores that sample at `data.result`; parse the
result, not the envelope, as the Direct contract. With Playwright MCP, call
`browser_evaluate` with the same page function:

```json
{
  "function": "() => { const bridge = window.__direct; return { browserIdentity: { userAgent: navigator.userAgent, platform: navigator.platform }, bridgeSchema: bridge?.schema, manifest: bridge?.manifest, probe: typeof bridge?.snapshot === 'function' ? bridge.snapshot() : undefined }; }"
}
```

No Direct-specific browser plugin or MCP server is required. Add
`manifest.queries.scenario` to the product's known Direct entry URL, navigate,
and reacquire the complete sample because navigation replaces the document.
An alternative driver must independently establish the same pre-navigation
containment, fresh-context isolation, execution mode, and final-close policy;
reading the Direct bridge does not prove those properties.
The published scenario `route` is the product route under review, not
necessarily the wrapper workbench's entry path. Record the exact agent-browser
version, configured backend, allowed hosts, execution mode, verifier-assigned
scenario/context label, fresh `window new` command and result, tab inventories
and close-attempt results, and the sample's `browserIdentity`. A user-agent
string is metadata, not proof of browser or context custody. After each
scenario, run `tab close <id>` for its scenario-owned IDs and retain every
command result plus a post-attempt inventory. agent-browser 0.32.3 can ignore
`Target.closeTarget` errors, so do not report those attempts as proven closure.

After every scenario navigation, require:

- `bridgeSchema` equals `direct.browser-bridge/v2`;
- `manifest.active.source` equals the requested activation source;
- `manifest.active.scenario` equals the requested scenario;
- `manifest.active.route` equals the expected product route; and
- the parsed manifest's `active.selectionHash` binds that public selection to
  its activation hash; and
- the parsed probe activation hash equals
  `manifest.active.activationHash`.

Retain the complete initial manifest and probe with each result. After product
interactions, atomically sample the bridge again and require unchanged public
catalog metadata, coverage, catalog hash, full active selection, and probe
activation identity. Bind every sampled `manifest.coverage` to the authored
definition.

## Join the probe

Wait until the same generation, revision, activity totals, and pending counters
remain quiet for the verifier's bounded settle interval. A quiet probe requires
zero current activity and zero pending counters. One successful
`wait --fn "window.__direct?.snapshot().isQuiescent === true"` observes only a
single quiet sample; it does not prove stability. Parse another probe after the
settle interval and compare the complete quiet state.

After each interaction:

1. Join quiescence again.
2. Reject relevant nonzero violation counters.
3. Reject page errors, unexpected console errors, unmapped or failed network calls, malformed transport values, leaked activity, and required script steps left unused.
4. Assert the route, visible semantics, accessibility state, and product result required by the scenario.

Never replace the probe join with a fixed sleep. Treat remaining work as a diagnostic unless the declared claim requires it to drain.

Definition activation, parser tests, and adapter unit tests do not close a claim about the real rendered interface. Such a claim requires the declared semantic and accessibility assertions against that interface.

## Tear down the browser batch

After the final scenario evidence, retain one last tab inventory and every
tab-close attempt result. Keep the inert no-URL bootstrap tab open, then use
final whole-browser close as the stronger batch disposal boundary:

```sh
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --json close
```

Treat a nonzero final close as a failed batch. Preserve task metadata and do
not claim disposal or performance evidence. Remove only task-created temporary
directories, and only after close succeeds. The idle timeout is a backstop,
not crash-safe cleanup proof.

## Verify production exclusion

Build the real production graph independently. Run its emitted-boundary scanner across every declared production surface. Prefer `@hraness/direct/tooling/bundle-boundary` for shared scan mechanics while keeping included paths, product markers, and positive production identity evidence product-owned. Require at least one executable bundle and reject package names, wire schemas, reserved query keys, fixtures, workbench strings, and browser bridge globals.

When a bundler selects platform variants, require a paired source map for every executable and every production platform. Positively match the declared shared behavior, native composition, and production-adapter modules in each map; reject Direct and web-fixture paths. Verify the inverse selection for the fixture graph. A clean marker scan proves only absence of those markers in those files, and a clean unrelated bundle proves nothing. Source selection still does not prove native linkage, service behavior, runtime loading, or device behavior.

## Classify the evidence

Report every coverage entry as one of:

- `verified` when every fixture scenario and direct gate required by the claim's declared mode ran through the named behavior and passed its claim-specific assertions;
- `fixture-verified` when every declared fixture scenario for a mixed claim passed while its direct half remains open;
- `partial` when some required evidence passed;
- `not-exercised` when the run produced no evidence for the claim; or
- `direct-required` when deterministic evidence cannot close the claim.

A browser-only run keeps a direct claim `direct-required` and can report at most `fixture-verified` for a mixed claim. A wider run may report a mixed or direct claim as `verified` after every named direct behavior is exercised. Note supporting unit or structural evidence separately when it does not close the direct gate.

Use `classifyCoverageEvidence` from `@hraness/direct/testing`. Pass only scenario IDs whose claim-specific assertions succeeded, and set direct evidence to verified only for a current passing direct gate. Do not hand-roll a looser status promotion.

Include `HEAD` plus dirty or clean working-tree status, commands, scenario
results, exact browser-driver version, browser backend and observed identity,
allowed hosts, batch index and size, verifier-assigned scenario/context labels,
fresh `window new` commands and results, tab inventories and close-attempt
results, execution mode, final close result, catalog hash, activation hashes,
final probes, production surfaces scanned, retained artifacts, and exact
failures. Treat the catalog hash as a drift
fingerprint, not a security digest or deployed-bundle identity. Report absent
property tests, browser probes, or artifacts as `not present` or `not
observed`. State skipped direct gates once. Do not use credentials, contact
live services, or expand into device testing unless the user placed those
systems in scope.

Direct contains no browser-run or performance evidence for this policy. Only
when an external product comparison is explicitly in scope, report end-to-end
wall time separately from local host CPU and peak resident memory. Keep target,
scenarios, actions, assertions, batch bound, admitted concurrency, context
policy, containment, and cold or warm policy equal. Report browser launches,
contexts created, and the final close result. State leakage or incomplete
disposal is not a valid speed improvement.
