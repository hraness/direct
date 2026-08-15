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

## Isolate and select the browser backend

The product verifier chooses a backend from the target and required browser
capabilities. Kitesurf is an optional remote-CDP backend for an eligible,
non-sensitive built or deployed public HTTPS preview. Local Chromium covers
development servers, localhost, private or credential-bearing targets, and
features that require Chromium compatibility.

Before either backend, create a fresh task-owned config and socket directory,
then define one sanitized wrapper. The config path is new, so these commands do
not overwrite a user or project config:

```sh
DIRECT_AGENT_BROWSER_BIN="$(command -v agent-browser)"
test -x "$DIRECT_AGENT_BROWSER_BIN"
DIRECT_BROWSER_CONFIG_DIRECTORY="$(mktemp -d)"
DIRECT_BROWSER_SOCKET_DIRECTORY="$(mktemp -d)"
DIRECT_BROWSER_CONFIG="$DIRECT_BROWSER_CONFIG_DIRECTORY/agent-browser.json"
printf '%s\n' '{}' > "$DIRECT_BROWSER_CONFIG"
test "$(tr -d '[:space:]' < "$DIRECT_BROWSER_CONFIG")" = '{}'
direct_agent_browser() {
  env -i \
    PATH="$PATH" \
    HOME="$HOME" \
    TMPDIR="${TMPDIR:-/tmp}" \
    AGENT_BROWSER_SOCKET_DIR="$DIRECT_BROWSER_SOCKET_DIRECTORY" \
    "$DIRECT_AGENT_BROWSER_BIN" \
    --config "$DIRECT_BROWSER_CONFIG" "$@"
}
direct_agent_browser --version
```

`env -i` removes every inherited `AGENT_BROWSER_*` setting and ambient proxy
variable. The wrapper restores only the process paths agent-browser needs and
the fresh socket directory. Use this same wrapper, config, socket directory,
and explicit `--session` for every open, evaluation, wait, action, diagnostic,
and close command in one run. Parallel runs need different session names and
different isolation directories. Run the prelude again before changing
backends.

Direct neither provides nor pins agent-browser. Retain the exact version
printed by the wrapper. This recipe was exercised with agent-browser 0.32.3,
but every verification report records the version it actually used.

For eligible Kitesurf runs, set the known emitted preview URL and attach before
navigation:

```sh
PUBLIC_DIRECT_URL='https://preview.example/direct/?__direct_scenario=todos.populated'
DIRECT_BROWSER_SESSION='direct-kitesurf'
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" \
  --cdp 'wss://kitesurf.cloudflare.app/devtools/browser' \
  --json open "$PUBLIC_DIRECT_URL"
```

The [public playground endpoint](https://kitesurf.cloudflare.app/) requires no
API token. Do not add credentials, cookies, preview-bypass secrets, or private
fixture data. It accepts public HTTPS navigation, with a current playground
limit of 20 seconds of CPU time and 60 seconds of wall time per navigation.
The service is beta, stateless, and implements a subset of CDP and browser
behavior. Do not assume compatibility with development-only module graphs,
exact Chromium rendering, video, WebGL, bot-challenge TLS behavior, or long
authenticated sessions with persistent state.

For local Chromium, run the isolation prelude again, then select a new session
before navigation:

```sh
LOCAL_DIRECT_URL='http://127.0.0.1:5173/direct/?__direct_scenario=todos.populated'
DIRECT_BROWSER_SESSION='direct-chromium'
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --engine chrome \
  --json open "$LOCAL_DIRECT_URL"
```

If Kitesurf proves incompatible, retain that failed or unsupported attempt,
then restart the scenario from its initial state through a new isolated
Chromium run. Never describe a retry under another backend as one continuous
result. Close only after collecting the final evidence:

```sh
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --json close
```

## Discover the running contract

Read the bridge schema, manifest, browser identity, and probe in one
synchronous evaluation through the selected session:

```sh
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --json eval "(() => { const bridge = window.__direct; return { browserIdentity: { userAgent: navigator.userAgent, platform: navigator.platform }, bridgeSchema: bridge?.schema, manifest: bridge?.manifest, probe: typeof bridge?.snapshot === 'function' ? bridge.snapshot() : undefined }; })()"
```

The command's JSON envelope carries the sample at `data.result`; the envelope
itself is not the manifest. With Playwright MCP, call `browser_evaluate` with a
function:

```json
{
  "function": "() => { const bridge = window.__direct; return { browserIdentity: { userAgent: navigator.userAgent, platform: navigator.platform }, bridgeSchema: bridge?.schema, manifest: bridge?.manifest, probe: typeof bridge?.snapshot === 'function' ? bridge.snapshot() : undefined }; }"
}
```

Both calls project the same page contract. No driver-specific Direct plugin is
required. `browserIdentity` is run metadata, not part of the Direct bridge.
Retain the exact agent-browser version, selected backend, CDP endpoint origin
when one was used, and observed identity. Kitesurf currently reports a user
agent beginning with `Kitesurf/` and platform `Cloudflare Workers`; do not pin
the version suffix or treat a user-agent string as proof of backend custody.

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

The package does not choose a browser driver or visual-comparison policy. Keep those decisions in the product verifier.

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
probe, exact browser-driver version, browser backend and identity, semantic
assertions, violations, console and page errors, and artifact paths. The
catalog hash is a deterministic drift fingerprint, not a security digest or a
deployed-bundle identity. Keep generated evidence out of source control unless
the repository explicitly treats a fixture or baseline as reviewed source.

## Compare performance only when requested

Collect performance evidence only when a backend comparison is explicitly in
scope. Report end-to-end wall time and local host load as different results.
Wall time covers backend connection, navigation, settlement, interactions,
assertions, and teardown. Host load covers the local agent-browser client and
all local browser descendants, with CPU time and peak resident memory reported
separately. Provider-side CPU and memory are a third category and require
provider metrics; do not infer them from the local client process.

Use the same preview, scenario, actions, assertions, concurrency, and cold or
warm policy for both backends. Lower local CPU or memory does not by itself
mean lower wall time. [Cloudflare's August 2026 vendor
benchmark](https://blog.cloudflare.com/kitesurf/) reported medians of five
Browser Run Quick Action runs across 14 URLs. Against a warm Chromium pool,
Kitesurf used 3.1 to 3.8 times less service-side CPU and 4.7 to 7.0 times less
service-side memory, while each Quick Action took 1.7 to 1.8 times longer in
wall time. Those figures provide context only; they are not Direct,
agent-browser, host-load, or product-verification evidence.

Direct does not include browser-worker reuse, screenshot deduplication, video capture, scene detection, or storyboard generation. A product may add those mechanisms without changing the manifest, probe, and coverage contracts.

## Verify React Native exclusion

An Expo web export may intentionally contain Direct while iOS and Android production exports must not. Build each platform through its real Metro entry resolution with external source maps. Require native product and adapter markers, reject Direct or web-composition modules from the maps, scan emitted contents as defense in depth, and positively require Direct markers from the web export. Keep native platform, module, layout, and device claims `direct` even when the React Native Web composition and both exclusion scans pass.
