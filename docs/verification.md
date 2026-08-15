# Verification

Direct reports deterministic activity and proof boundaries. The definition owns
the declared scenarios and coverage claims. A session owns one activation,
harness, probe, and validated manifest. The product verifier decides which
scenarios to run, which interactions to perform, and which evidence closes
each claim. Parse `window.__direct.manifest` with
`parseDirectSessionManifest`, then bind `manifest.coverage` to the owned
definition with `parseDefinitionCoverageSnapshot` so a valid but stale catalog
cannot be mistaken for the catalog under review.

The installed package carries the `direct-verify` Agent Skill under
`skills/direct-verify`. Copy or link that directory into your agent runner's
discovery location and invoke `$direct-verify` for the workflow below. The
skill structures the audit; it does not turn deterministic evidence into
proof of a substituted live system.

## Run one bounded local Chromium batch

Direct is driver-neutral. It provides deterministic state and a browser bridge,
not a browser launcher, driver, process coordinator, or cleanup supervisor. The
product verifier owns browser commands and process policy.

The canonical local policy uses one task-owned agent-browser session and one
Chromium process for a sequential batch of at most eight scenarios. Before each
scenario, call `window new` to create a fresh BrowserContext. Inventory its
tabs and attempt to close scenario-owned tabs, including popups. agent-browser
0.32.3 can ignore `Target.closeTarget` errors, so retain each command result
and a post-attempt inventory instead of claiming proven per-tab closure. Keep
the inert no-URL bootstrap tab until the final whole-browser close, which is
the stronger disposal boundary. Do not reuse a context, substitute `tab new`,
or launch one browser process per scenario. Semantic and visual evidence come
from the same exact Chromium context.

Declare the product target and every required asset host in
`--allowed-domains` before the first navigation. Direct's application-`fetch`
firewall remains deterministic instrumentation; it does not contain
navigations, subresources, WebSockets, workers, service workers, beacons,
WebRTC, native traffic, or another realm. Ordinary browser-wide `--cdp`
attachment is forbidden: multiple agent-browser session names do not create
isolated contexts, and agent-browser 0.32.3 rejects `--allowed-domains` with
`--cdp`.

Run batches serially unless a real external coordinator enforces a shared
host-wide limit. Direct does not enforce a process cap. A claim of parallel
admission or crash-safe cleanup also requires an external supervisor that owns
both the agent-browser daemon and Chromium roots, or one containing job.
agent-browser 0.32.3 may place those roots in different process groups, so
daemon exit alone is not cleanup proof.

### Isolate and run the session

This command path uses an empty task-owned config, a fresh socket directory, a
sanitized environment, an exact allowlist, and a one-minute idle timeout. A
no-URL `open` launches Chromium on its inert internal `about:blank` tab while
installing the allowlist. Do not pass `about:blank` as an explicit URL;
agent-browser 0.32.3 rejects that hostname-free navigation under the allowlist.

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
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --json eval "(() => { const bridge = window.__direct; return { browserIdentity: { userAgent: navigator.userAgent, platform: navigator.platform }, bridgeSchema: bridge?.schema, manifest: bridge?.manifest, probe: typeof bridge?.snapshot === 'function' ? bridge.snapshot() : undefined }; })()"
```

Use the same wrapper and session for every command in the batch. Repeat
`window new`, navigation, evidence, and tab-close attempts for each scenario;
reject a ninth scenario before launch. Assign each scenario context a verifier
label and retain the fresh `window new` command and result. Parse the JSON tab
inventories, run `tab close <id>` for scenario-owned tabs, and retain the
command results plus a post-attempt inventory. Keep the inert no-URL bootstrap
tab until whole-browser teardown because agent-browser 0.32.3 cannot close the
last tab. Do not invoke final `close` until all scenario verification
finishes. A fresh context is required because permissions, IndexedDB, Cache
Storage, and service workers cannot be reset reliably in place.

## Discover the running contract

The synchronous `eval` command above reads the bridge schema, manifest,
browser identity, and probe. Its JSON envelope carries the sample at
`data.result`; the envelope itself is not the manifest. With Playwright MCP,
call `browser_evaluate` with the same page function:

```json
{
  "function": "() => { const bridge = window.__direct; return { browserIdentity: { userAgent: navigator.userAgent, platform: navigator.platform }, bridgeSchema: bridge?.schema, manifest: bridge?.manifest, probe: typeof bridge?.snapshot === 'function' ? bridge.snapshot() : undefined }; }"
}
```

Both calls project the same page contract. No driver-specific Direct plugin is
required. `browserIdentity` is run metadata, not part of the Direct bridge.
An alternative driver must independently provide the same pre-navigation
containment, fresh-context isolation, execution mode, and final-close policy;
reading the bridge alone does not establish those properties. Retain the exact
agent-browser version, configured backend, allowed hosts, observed browser
identity, verifier-assigned scenario/context label, fresh `window new` command
and result, tab inventories and close-attempt results, batch index and size,
execution mode, and final close result. A user-agent string is descriptive
metadata, not proof of browser or context custody.

Require `bridgeSchema` to equal `direct.browser-bridge/v2`, then parse both
`manifest` and `probe` from `unknown`. Select only a declared scenario. Add
`manifest.queries.scenario` to the product's known Direct entry URL, navigate,
then reacquire the entire atomic sample because navigation replaced the
document. Require:

- `manifest.active.source` to equal the requested `scenario` or `fixture`
  activation source;
- `manifest.active.scenario` to equal the requested scenario;
- `manifest.active.route` to equal the product route under review; and
- the parsed manifest's `selectionHash` to bind that complete public active
  identity to its activation hash; and
- `manifest.active.activationHash` to equal the parsed probe's
  `activationHash`.

Retain the complete initial manifest and probe identity with each scenario
result. After product interactions, atomically re-read the bridge and require
the same public catalog metadata, coverage, catalog hash, full active
selection, and probe activation identity. Parse `manifest.coverage` against the
authored definition rather than re-reading an unbound coverage value from
whichever page happened to load last.

The scenario route is a semantic product route, not a universal workbench
entry path. A wrapper may mount every Direct scenario at one shell URL. Entry
URL policy remains with the product verifier.

## Wait for quiescence

Install the browser boundary with `installDirectBrowser({ session })`, then
read `window.__direct.snapshot()` through its canonical bridge. A snapshot is
quiet when:

- the current store generation has zero active operations;
- every product-named pending counter is zero; and
- the same generation, revision, and counter state remains stable for the verifier's bounded settle interval.

A single `wait --fn` result for `snapshot().isQuiescent` proves only one quiet
sample. Re-read the parsed probe after the bounded settle interval and require
the generation, revision, activity totals, and pending counters to be
unchanged. Do not replace this join with a fixed sleep. Logical fixture
duration does not determine when the browser, product state, or adapter work
is ready.

Quiescence excludes violation counters by design. A verifier must separately reject every violation relevant to its claim, including blocked network calls, unexpected requests, unused required script steps, malformed transport values, leaked subscriptions, page errors, and console errors.

## Assert product behavior

A quiet probe does not prove the interface is correct. After the join:

1. Assert the expected route and semantic content.
2. Perform the scenario's product action.
3. Join quiescence again.
4. Assert the resulting product state and relevant accessibility or layout conditions.
5. Capture bounded diagnostics or visual evidence when the claim needs them.

The package does not choose a browser driver or visual-comparison policy. Keep
those decisions in the product verifier. Under the canonical workflow, capture
visual evidence from the same exact local Chromium context that produced the
manifest, probe, actions, and semantic assertions.

## Tear down the browser batch

After the final scenario evidence, retain one last tab inventory and every
tab-close attempt result. agent-browser 0.32.3 can ignore
`Target.closeTarget` errors, so a successful tab-close command does not prove
that its target disappeared. Keep the inert no-URL bootstrap tab open and use
the whole-browser close as the stronger batch disposal boundary:

```sh
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --json close
```

Treat a nonzero final `close` as a failed batch. Preserve task metadata and do
not claim context disposal or performance evidence. Remove only the temporary
directories created by the task, and only after close succeeds. The idle
timeout is an orphan backstop, not crash-safe cleanup proof. Direct contains no
browser-run or performance evidence for this policy.

## Report coverage without promotion

Report each catalog entry against the scenarios and direct gates actually exercised:

- `verified`: every fixture scenario and direct gate required by the claim's declared mode ran and passed.
- `fixture-verified`: every declared fixture scenario for a mixed claim ran and passed, while its direct half remains open.
- `partial`: some declared evidence passed, but required scenarios or direct gates remain.
- `not-exercised`: the run produced no evidence for the claim.
- `direct-required`: the claim cannot be closed by this deterministic run.

A browser-only run therefore reports a completed fixture claim as `verified`, a completed fixture half of a mixed claim as `fixture-verified`, and a direct claim as `direct-required`. A wider verification run may report a mixed or direct claim as `verified` after its named direct evidence passes.

Use `classifyCoverageEvidence` from `@hraness/direct/testing` after the product-owned assertions finish. Pass only scenario IDs whose claim-specific assertions passed, plus `directEvidence: "verified"` only when the named direct gate is current and green. The mode-specific return type prevents a fixture claim from becoming `fixture-verified` or `direct-required`.

Never report a fixture scenario as proof of the adapter, service, host, browser assembly, operating system, or device it replaced.

## Scan production output

Build the production entry independently, then scan emitted JavaScript, source maps, HTML, CSS, native bundles, executables, or packaged assets as appropriate. Each product owns marker policy. Include the package name, wire schemas, reserved query keys, fixture identifiers, bridge globals, and product workbench markers. When a bundler removes import specifiers, inspect source-map module paths as structural evidence too.

Fail when no expected executable and source-map files were scanned, and positively require stable markers for the intended production entry. An empty, metadata-only, or unrelated clean bundle is not evidence.

## Preserve bounded evidence

Record the scenario identifier, catalog hash, activation hash, route, final
probe, exact browser-driver version, browser backend and identity, allowed
hosts, batch index and size, verifier-assigned scenario/context labels, fresh
`window new` commands and results, tab inventories and close-attempt results,
execution mode, final close result, semantic assertions, violations, console
and page errors, and artifact paths.

The catalog hash is a deterministic drift fingerprint, not a security digest
or a deployed-bundle identity. Keep generated evidence out of source control
unless the repository explicitly treats a fixture or baseline as reviewed
source.

## Compare performance only when requested

Direct contains no browser-run or performance evidence for this policy.
Collect such evidence externally in the product verifier only when a process
or context-policy comparison is explicitly in scope. Report end-to-end wall
time and local host load as different results. Wall time covers any admission
wait, process launch, context creation, navigation, settlement, interactions,
assertions, tab-close attempts, and final close. Host load covers the
local agent-browser client and all local Chromium descendants, with CPU time
and peak resident memory reported separately.

Use the same preview, scenarios, actions, assertions, batch bound, admitted
concurrency, context policy, containment, and cold or warm policy for every
comparison. Report browser launches and contexts created. Lower CPU or memory
does not by itself mean lower wall time, and state leakage or incomplete
cleanup is not a valid performance improvement.

Direct does not include a browser coordinator, browser broker, browser-worker
pool, screenshot deduplication, video capture, scene detection, storyboard
generation, or benchmark result. A product may add those mechanisms without
changing the manifest, probe, and coverage contracts, but must supply its own
external correctness and performance evidence.

## Verify React Native exclusion

An Expo web export may intentionally contain Direct while iOS and Android production exports must not. Build each platform through its real Metro entry resolution with external source maps. Require native product and adapter markers, reject Direct or web-composition modules from the maps, scan emitted contents as defense in depth, and positively require Direct markers from the web export. Keep native platform, module, layout, and device claims `direct` even when the React Native Web composition and both exclusion scans pass.
