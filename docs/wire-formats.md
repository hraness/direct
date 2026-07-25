# Wire formats

Direct wire values are exact, versioned JSON. Parse every value from `unknown`; reject unknown object keys rather than silently accepting a nearby format.

## Reserved query keys

- `__direct_scenario=<id>` activates a scenario from the product catalog.
- `__direct_fixture=<encoded-json>` activates a portable fixture envelope.

Both keys may appear together only when they name the same scenario. Duplicate keys, malformed percent encoding, unknown `__direct_*` keys, unknown scenarios, oversized queries, and mismatched routes fail closed. Other product query parameters are preserved and ignored by Direct activation.

## Fixture envelope

Schema: `direct.fixture/v1`

```json
{
  "schema": "direct.fixture/v1",
  "scenario": "todos.populated",
  "route": "/",
  "world": {
    "version": 1,
    "todos": [],
    "writeFailure": null
  },
  "runtime": {
    "schema": "direct.runtime/v1",
    "nowMs": 0,
    "nextOperation": 1,
    "acceleration": 100
  }
}
```

The route is derived from the catalog when a fixture is created. Parsing requires it to match the named scenario. The product world parser still runs; a fixture cannot bypass product validation.

## Logical runtime

Schema: `direct.runtime/v1`

The runtime snapshot records non-negative logical milliseconds, the next positive operation sequence, and an acceleration in the supported finite range. Logical waits advance in call order and do not advance after cancellation.

## Probe

Schema: `direct.probe/v1`

A probe snapshot contains the activation hash, store generation and revision, conserved activity totals, product-named pending counters, product-named violation counters, JSON-safe remaining-work diagnostics, and derived quiescence.

Consumers must parse a snapshot before trusting it. The parser rejects unknown fields, invalid counters, inconsistent activity conservation, and a quiescence bit that disagrees with activity and pending counters.

## Browser bridge

Schema: `direct.browser-bridge/v2`

`installDirectBrowser({ session })` installs the canonical bridge as
`window.__direct`. It derives the validated session manifest and probe from
the session. The exact v2 object exposes:

- `schema` with the literal value `direct.browser-bridge/v2`;
- `manifest` for runtime discovery and evidence identity;
- `snapshot()` for the current validated probe value;
- `reset()` for the synchronous product-owned reset action.

The reset callback must complete synchronously and return `undefined`. If an asserted or hostile callback returns a thenable, the bridge contains its settlement and throws a controlled synchronous-completion error.

Every successful probe read must have the same activation hash as the
installed manifest. A mismatched probe fails closed rather than publishing
evidence from a nearby session.

## Session manifest

Schema: `direct.session-manifest/v1`

The manifest is a world-free runtime description of the deterministic
composition:

```json
{
  "schema": "direct.session-manifest/v1",
  "catalogHash": "fnv1a-64:9417ef4983bf35da",
  "queries": {
    "scenario": "__direct_scenario",
    "fixture": "__direct_fixture"
  },
  "defaultScenario": "todos.populated",
  "active": {
    "source": "scenario",
    "scenario": "todos.populated",
    "route": "/",
    "activationHash": "fnv1a-64:fedcba9876543210",
    "selectionHash": "fnv1a-64:86d1632d6b418cd8"
  },
  "scenarios": [
    {
      "id": "todos.populated",
      "title": "Populated list",
      "description": "Two open tasks.",
      "route": "/"
    }
  ],
  "coverage": {
    "schema": "direct.coverage/v2",
    "entries": [
      {
        "key": "todos.completion",
        "mode": "fixture",
        "claim": "The real todo interface completes tasks through its product port.",
        "scenarios": ["todos.populated"]
      }
    ]
  }
}
```

The active activation hash identifies the selected source, scenario, route,
world, and logical runtime. The selection hash binds that opaque identity to
the manifest's public source, scenario, and route, so changing any one field
without replacing the complete selection fails closed. The catalog hash
covers the two published query keys, default scenario, ordered public scenario
metadata, and exact coverage snapshot. All three use deterministic FNV-1a-64
only as consistency and drift fingerprints, not as security digests or hashes
of parser, harness, or application code.

The manifest deliberately excludes scenario worlds, runtime scripts, product
actions, semantic assertions, secrets, and source paths. Its scenario `route`
is the product route expected after activation; a wrapper workbench may still
use one separate Direct entry URL for every scenario.

Coverage entries cite scenarios rather than duplicating a singular route. The
scenario catalog owns each route, and one coverage claim may intentionally
span scenarios on different routes.

One definition and manifest may contain at most 256 scenarios and 256 coverage
entries. The creator and foreign-value parser enforce the same limits.

Consumers must parse the complete manifest before using it. Unknown fields,
duplicate scenarios, missing default or active scenarios, route drift, unknown
coverage citations, malformed coverage, selection-hash drift, and catalog-hash
drift are rejected.

## Migrate from v0.4.0

Direct v0.5.0 replaces the exact `direct.browser-bridge/v1` shape with v2.
Top-level `window.__direct.coverage` no longer exists; read
`window.__direct.manifest.coverage`. Low-level bridge callers must pass
`manifest` instead of `coverage`, and every probe activation hash must use the
exact `fnv1a-64:<16 lowercase hexadecimal digits>` format. The v1 session
manifest's active selection includes a `selectionHash` that its parser
recomputes before any browser evidence is accepted.

Sample `schema`, `manifest`, and `snapshot()` in one synchronous page
evaluation. Require the v2 schema, parse the manifest and probe from `unknown`,
confirm the expected activation source, scenario, and product route, and
require both activation hashes to match. Keep v0.4.0 pinned until a consumer
can move as one exact-shape migration; do not publish or accept a hybrid bridge.

The bridge is a development automation seam. Do not install it from a production entry.
