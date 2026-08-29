# Verification

Direct reports deterministic activity and proof boundaries. The definition owns
the declared scenarios and coverage claims. A session owns one activation,
harness, probe, and validated manifest. The product verifier decides which
scenarios to run, which interactions to perform, and which evidence closes
each claim. Parse `window.__direct.manifest` with
`parseDirectSessionManifest`, then bind `manifest.coverage` to the owned
definition with `parseDefinitionCoverageSnapshot` so a valid but stale catalog
cannot be mistaken for the catalog under review.

The repository carries one `$direct` Agent Skill under `skills/direct`.
Install it with `npx skills add hraness/direct#v0.7.9` or
`bunx skills add hraness/direct#v0.7.9`, or copy that directory into the runner's
discovery location. Invoke `$direct` for the workflow below. The skill is
independent from library package installation and structures the audit; it
does not turn deterministic evidence into proof of a substituted live system.

## Run one bounded local Chromium batch

Direct's browser runtime is driver-neutral and never launches a process. The
optional Bun/Node host tooling can invoke a consumer-installed agent-browser
CLI. A separate Bombadil helper can own one explicitly configured local server
and native fuzzing process tree. Neither path bundles a driver or coordinates
work across repositories. The product verifier still owns semantic commands,
proof claims, and any host-wide scheduling policy.

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

### Reuse the host mechanics

Import `createAgentBrowser`, `acquireVerificationServer`,
`createArtifactRun`, and `readDirectBrowserContract` from
`@hraness/direct/tooling/browser-verification`. The ready-bound reader uses
Direct's exact bridge schema, session-manifest parser, and probe parser. Use
`createDirectBrowserContractReader` to inject a different compatible protocol.

Run this subpath with Bun 1.3.14 and Node type definitions. It uses Node
filesystem, path, and crypto APIs plus Bun process, sleep, and file APIs.
`createAgentBrowser` resolves the consumer's agent-browser 0.32.3 executable at
`node_modules/.bin/agent-browser` and its task-owned configuration at
`scripts/direct/agent-browser.verify.json` below `repositoryRoot`. The helper
sanitizes inherited `AGENT_BROWSER_*` variables, bounds command and close
deadlines, and rotates a namespace after an unresponsive process. The product
still supplies allowed-domain launch flags, commands, semantic assertions,
context inventory, and the final close decision.

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

## Run a bounded Bombadil campaign

Use Bombadil for diagnostic browser exploration when the product already has
an exact Direct scenario and wants generated interactions in addition to its
deterministic checks. This path does not replace product-owned semantic or
accessibility assertions. It also does not prove a substituted service,
adapter, browser host, operating system, or device.

Bombadil is an experimental 0.x tool. Review the official
[manual](https://antithesishq.github.io/bombadil/) when changing its pinned
version, specification, actions, properties, or CLI invocation; minor releases
may change interfaces or trace details.

Install the one supported release directly in the consumer. Direct declares
it as an exact optional peer so products that do not use fuzzing do not install
a browser tool:

```sh
bun add --dev @antithesishq/bombadil@0.7.2
```

Bombadil 0.7.2 resolves specification dependencies without standard package
export conditions. Direct therefore exposes the campaign subpath as shipped
TypeScript source. Import it only from a Bombadil specification; use the built
`@hraness/direct/tooling/bombadil` subpath for the Bun host wrapper.

Create a specification such as `direct/bombadil-campaign.ts`:

```ts
import { always, eventually } from "@antithesishq/bombadil";
import {
  createDirectBombadilActions,
  createDirectBombadilNamedSnapshot,
  createDirectBombadilProperties,
  createDirectBombadilResourceLeakProperty,
} from "@hraness/direct/tooling/bombadil-campaign";

export * from "@antithesishq/bombadil/browser/defaults/properties";

const direct = createDirectBombadilProperties();
const phase = createDirectBombadilNamedSnapshot({
  fallback: "unavailable",
  name: "todos.phase",
  read: ({ window }) => Reflect.get(window, "__todosPhase"),
  validate: (value): value is string => typeof value === "string",
});

export const direct_safe_actions = createDirectBombadilActions();
export const direct_startup_contract = direct.startupContract;
export const direct_exact_contract = direct.exactContract;
export const direct_stable_catalog = direct.stableCatalog;
export const direct_no_declared_violations = direct.noDeclaredViolations;
export const direct_eventual_quiescence = direct.eventualQuiescence;
export const todos_phase_is_known = always(
  eventually(() => phase.current !== "unavailable").within(5, "seconds"),
);
export const no_dom_node_leak = createDirectBombadilResourceLeakProperty({
  metric: "dom_nodes",
  growthLimit: 500,
  windowMillis: 10_000,
});
```

The Direct action generator deliberately excludes reload, history traversal,
visible links, anchors, href targets, form submission, reset controls,
destructive labels such as delete, remove, clear, discard, unlink, and close,
all labels because their fingerprints do not expose the associated control's
submit, reset, or button type, and the Enter key. It retains ordinary buttons,
text input, scrolling, and an
always-eligible low-weight wait. This preserves the post-handshake contract
within one document. Add product actions only when their navigation, form, and
destructive effects are understood, and keep product-specific assertions in
the campaign.
Guard domain actions on the state that makes them valid, then weight valuable
state-changing actions above Wait. Do not increase throughput by admitting
reload, navigation, submission, destructive controls, or arbitrary generated
input. A generated action sequence is useful only while it preserves the
scenario boundary and exercises behavior the product can interpret.

`createDirectBombadilNamedSnapshot` gives product properties and post-run
diagnostics a small semantic signal. It requires a safe bounded name distinct
from `direct` and JavaScript prototype names, an explicit product type
predicate over Direct's owned plain-JSON clone, at
most 64 JSON levels, and at most 2 MiB of UTF-8 JSON. It fails closed to the
validated fallback when a page getter throws or returns unsuitable data. Extract
state, not page content or credentials. Named values are represented only by
canonical SHA-256 hashes in the exploration summary; the authoritative raw
trace still contains the original values.

Bombadil's 0.7.2 manual documents a sliding-window resource property at
`@antithesishq/bombadil/browser/extras/resources`, but the published npm
package omits that subpath from its `exports` map. Use Direct's
`createDirectBombadilResourceLeakProperty` implementation until a reviewed
Bombadil release exports the official helper. Add a tuned property when
repeated product actions allocate DOM nodes, listeners, layout objects, or
heap. Prefer DOM-node or listener thresholds when they express the defect
because heap samples move with garbage collection. Measure a normal run in
Inspect before setting a growth limit, and keep the window longer than ordinary
rendering bursts. The summary's resource high-water marks help choose and
review those thresholds; a maximum alone does not prove or disprove a leak.

Create a Bun wrapper such as `direct/fuzz-browser.ts`:

```ts
#!/usr/bin/env bun
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDirectBombadilFuzz } from "@hraness/direct/tooling/bombadil";

const directRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(directRoot, "../../..");

await runDirectBombadilFuzz({
  artifactName: "todos",
  baseUrl: "http://127.0.0.1:5173",
  entryPath: "/direct/",
  expectedRoute: "/",
  label: "Todo Direct Bombadil fuzzing",
  repositoryRoot,
  scenario: "todos.populated",
  specificationPath: resolve(directRoot, "bombadil-campaign.ts"),
  viewport: { width: 1_024, height: 768, deviceScaleFactor: 2 },
  explorationPolicy: {
    minNonWaitActions: 1,
    requiredNamedSnapshots: ["direct", "todos.phase"],
    minDistinctNamedSnapshotValues: { "todos.phase": 2 },
    minNamedSnapshotChangesAfterActionKind: {
      "todos.phase": { Click: 1 },
    },
    minNamedSnapshotChangesAfterNonWait: { "todos.phase": 1 },
    requireStableTargetUrl: true,
  },
  server: {
    command: [
      process.execPath,
      "run",
      "example:direct",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      "{port}",
      "--strictPort",
    ],
    cwd: repositoryRoot,
    env: { CI: "1" },
    readinessPath: "/direct/",
    startupTimeoutMs: 30_000,
  },
}, process.argv.slice(2));
```

`baseUrl` must be an HTTP root origin on `127.0.0.1` or `localhost` with an
explicit port. `entryPath` locates the Direct page while `expectedRoute`
states the semantic product route published by the active manifest. The
server command is an argv array with exactly one literal `{port}` token. The
runner refuses to reuse a process already listening on that local port. Use
the optional `targetQuery` object only for bounded product-owned query state;
the runner rejects Direct's reserved scenario and fixture keys there because
it binds the requested scenario itself. The repository root, campaign path,
server working directory, and replay trace are resolved canonically before use;
a symlink that escapes the configured repository is rejected.
`viewport` is optional and defaults to Bombadil 0.7.2's 1024×768 viewport at a
device scale factor of 2. The runner always passes the validated exact values
to random and replay invocations and records them in `run.json`.
Assign one reviewed viewport to each existing scenario campaign. Alternate a
stable wide and narrow viewport across the matrix instead of duplicating every
scenario at every size; add a second size only when the scenario owns a
responsive behavior that needs separate exploration.

`explorationPolicy` is optional. When present, it can require a minimum count
of non-Wait actions, particular action kinds and named snapshots, minimum
distinct hashed values for named snapshots, named-value changes observed after
a non-Wait action or one particular action kind, and an exact stable target
URL. The change requirement keeps
bootstrap or Wait-only transitions from satisfying a product-interaction
threshold. Per-kind attribution requires exact Direct observations and the
same named snapshot in both immediately adjacent samples. The trace records
the last action with the resulting state, so this count identifies a named
value transition associated with an active product action. It does not prove
causality. The runner strictly validates every 0.7.2 action payload before
crediting its kind. The policy detects a campaign that passed
its properties without doing the intended exploration. It is a diagnostic
sufficiency check, not a coverage claim. Start with observed stable behavior
and raise thresholds only when the action generator makes them reliably
reachable.

Do not let responsive evidence stand in for product interaction. When a full
product snapshot includes viewport dimensions, name a second compact
interaction snapshot that excludes them and put the distinct-value and
post-action-change requirements on that snapshot. Require `SetViewport`
separately, and generate only a width or height different from the current
viewport. Likewise, latch the first product-ready observation for initial-world
properties so a later generated action cannot repair an incorrect initial
state before the bounded formula completes.

Run random exploration for 12 to 300 seconds. The default is 20 seconds:

```sh
bun direct/fuzz-browser.ts --time-limit 20s
```

Use 12–30 seconds in the edit loop. A scheduled diagnostic lane can run each
campaign for 60–300 seconds, serially, with an outer job timeout and retained
failure artifacts. Random exploration should supplement the deterministic
required gate rather than make an otherwise healthy pull request depend on one
particular random path.

For multiple product scenarios, pass a bounded matrix to the shared runner:

```ts
import { runDirectBombadilFuzzMatrix } from "@hraness/direct/tooling/bombadil";

await runDirectBombadilFuzzMatrix([
  { id: "populated", config: populatedCampaign },
  { id: "empty", config: emptyCampaign },
], process.argv.slice(2));
```

Without `--campaign`, the matrix runs every unique campaign serially. Select
one for focused work with `--campaign empty`. Replay is intentionally rejected
without that selector so a trace cannot be applied to the wrong scenario.

Use `--base-url` to select another local root origin. Use `--replay` with a
repository-local `.jsonl` trace instead of `--time-limit` to reproduce a prior
run. The native runner supports Bombadil 0.7.2 on Apple silicon macOS and x64
or arm64 Linux. Unsupported platform and architecture pairs fail before a
server starts.

Bombadil's browser Inspect UI is the fastest way to examine the actions,
screenshots, resource timeline, snapshots, and violations in a retained run:

```sh
bunx bombadil browser inspect artifacts/direct-bombadil/todos/<run>/bombadil
bun direct/fuzz-browser.ts --replay artifacts/direct-bombadil/todos/<run>/bombadil/trace.jsonl
```

Use the same campaign, viewport, specification, scenario, application tree,
and server configuration for replay. Bombadil rejects a replay that diverges,
so reproduction is strong debugging evidence but not guaranteed after the
product changes.

The startup formula requires an exact scenario contract within ten seconds.
After that first exact sample, the browser formulas require continuous
activation identity, catalog identity, and zero declared violations. Only
quiescence may recover within a bounded ten-second liveness window. Keep every
liveness obligation bounded to a product latency budget. A finite run cannot
decide an unbounded future obligation, and nesting unbounded `always` inside
bounded `eventually` does not make it decidable. The host attestation below
rechecks the full trace independently. A formula result and Bombadil exit status
are not sufficient evidence because a short or incomplete trace could otherwise
pass vacuously.

After every random run or replay, the host runner streams the bounded 0.7.2
JSONL trace from foreign input and requires one named `direct` observation per
line. Bridge absence is allowed only before the first exact observation. The
first exact observation must be a scenario activation matching `scenario` and
`expectedRoute`. Every exact observation is parsed with Direct's canonical
manifest and probe parsers, must retain the initial scenario, route, activation
hash, and catalog hash, and must report zero declared violations. Any later
missing or invalid bridge fails the run. The final observation must remain
exact, use the bound activation and catalog, have zero violations, and be
quiescent.

The runner invokes the exact native binary at the consumer repository root
with headless mode, JavaScript instrumentation disabled, a bounded output
directory, and exit-on-violation for random exploration. An outer wall-clock
deadline covers the native process. Timeout, interruption, or exit triggers
bounded process-group cleanup; timeout and interruption use TERM then KILL,
while a completed leader cannot leave descendants holding output pipes. The
configured local server is always stopped through the shared
browser-verification lease helpers, and its output drain remains bounded even
when cleanup itself fails.

Each attempt writes `run.json`, `exploration-summary.json`, `bombadil.log`, and `server.log` below
`artifacts/direct-bombadil/<artifactName>/<run>/`, including failures. The
rolling `manifest.json` points to the latest record. `rawTracePath` reports a
regular nonempty trace even if attestation fails; `tracePath` is present only
after exact attestation. The v2 summary strictly parses the 0.7.2 envelopes and
records the raw trace SHA-256, action-kind and safe target-tag counts, non-Wait
count and longest Wait streak, origin-relative URL fingerprints, non-null
transition-hash cardinality, canonical named-snapshot value hashes, property
violation names and counts, named-value changes after non-Wait actions and
specific action kinds, and browser resource high-water marks. Action, URL,
transition, and named-snapshot policy evidence starts at the first exact Direct
observation. Separate raw URL and transition hashes, property violations, and
resource maxima retain strictly parsed startup-prefix diagnostics. It excludes
typed text, accessible names, snapshot values, URLs, screenshots, and absolute
paths. These diagnostics describe what Bombadil happened to explore. They do
not measure code, state, interaction, or Direct catalog coverage, and the raw
trace remains authoritative.

Keep all generated artifacts out of source control by default. Upload a failed
scheduled run to access-controlled CI storage with a bounded retention period;
the raw trace can contain screenshots, query values, typed text, accessibility
labels, extracted values, and local paths. Preserve it long enough to inspect
and replay. Once the defect is understood, add the smallest deterministic
regression at the owning parser, reducer, port, component, semantic browser, or
Direct scenario boundary. Verify that regression fails before the fix and
passes after it. Retain a reviewed trace fixture only when replay itself adds
durable value; otherwise remove the sensitive trace after promotion.

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

Use `checkBundleBoundary`, `DIRECT_WIRE_MARKERS`, and
`inspectExactVersionedMarkers` from
`@hraness/direct/tooling/bundle-boundary` for the shared deterministic scan.
The product still owns the directory, included file patterns, exclusions,
product markers, and required positive identity evidence.

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
