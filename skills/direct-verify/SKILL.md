---
name: direct-verify
description: Verify an existing Direct composition, including strict activation, deterministic settlement, semantic scenario behavior, coverage truthfulness, cleanup, and exclusion from production output. Use when asked to test, audit, validate, review, or report the proof boundary of a Direct workbench or frontend verification run.
---

# Direct verification

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

The manifest is driver-neutral. The product verifier chooses a backend from
the target and required browser capabilities. Kitesurf is an optional
remote-CDP backend for an eligible, non-sensitive built or deployed public
HTTPS preview. Local Chromium covers development servers, local or private
targets, credentials, and features that require Chromium compatibility.

Before every agent-browser run, create a fresh task-owned empty config and
socket directory, then define one sanitized wrapper. These commands use new
paths and do not overwrite a user or project config:

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

This removes all inherited `AGENT_BROWSER_*` and proxy variables, then
restores only the required process paths and fresh socket directory. Use the
same wrapper, config, socket directory, and explicit `--session` on every open,
evaluation, wait, action, diagnostic, and close command. Parallel runs need
distinct session names and isolation directories. Run the prelude again
before changing backends. Direct does not provide or pin agent-browser. The
recipe was exercised with agent-browser 0.32.3; record the version printed for
the current run.

For an eligible Kitesurf run, attach before navigation:

```sh
PUBLIC_DIRECT_URL='https://preview.example/direct/?__direct_scenario=todos.populated'
DIRECT_BROWSER_SESSION='direct-kitesurf'
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" \
  --cdp 'wss://kitesurf.cloudflare.app/devtools/browser' \
  --json open "$PUBLIC_DIRECT_URL"
```

The public endpoint needs no token. Do not send credentials, cookies,
preview-bypass secrets, or private fixture data. It is a beta, stateless
browser that accepts public HTTPS navigation with a current 20-second CPU and
60-second wall-time budget per navigation. It implements a subset of CDP and
web-platform behavior. Do not assume development-module, exact-rendering,
video, WebGL, bot-challenge TLS, or persistent authenticated-session
compatibility.

For local Chromium, run the isolation prelude again and choose a new session
before navigation:

```sh
LOCAL_DIRECT_URL='http://127.0.0.1:5173/direct/?__direct_scenario=todos.populated'
DIRECT_BROWSER_SESSION='direct-chromium'
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --engine chrome \
  --json open "$LOCAL_DIRECT_URL"
```

If Kitesurf is incompatible, retain that attempt as failed or unsupported and
restart the scenario from its initial state in the isolated Chromium run. Do
not silently retry under another backend.

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
The published scenario `route` is the product route under review, not
necessarily the wrapper workbench's entry path. Record the exact agent-browser
version, selected backend, CDP endpoint origin when applicable, and the
sample's `browserIdentity`. Kitesurf currently reports a `Kitesurf/` user-agent
prefix and `Cloudflare Workers` platform; do not pin the version suffix or
treat a user-agent string as security proof. Close only after final evidence:

```sh
direct_agent_browser --session "$DIRECT_BROWSER_SESSION" --json close
```

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

## Verify production exclusion

Build the real production graph independently. Run its emitted-boundary scanner across every declared production surface. Require at least one executable bundle and reject package names, wire schemas, reserved query keys, fixtures, workbench strings, and browser bridge globals.

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
catalog hash, activation hashes, final probes, production surfaces scanned,
retained artifacts, and exact failures. Treat the catalog hash as a drift
fingerprint, not a security digest or deployed-bundle identity. Report absent
property tests, browser probes, or artifacts as `not present` or `not
observed`. State skipped direct gates once. Do not use credentials, contact
live services, or expand into device testing unless the user placed those
systems in scope.

Only when a backend performance comparison is explicitly in scope, report
end-to-end wall time separately from local host CPU and peak resident memory.
Provider-side CPU and memory require provider metrics and must not be inferred
from the local agent-browser process. Keep target, scenario, actions,
assertions, concurrency, and cold or warm policy equal across backends.
