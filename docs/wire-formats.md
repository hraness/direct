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

Schema: `direct.browser-bridge/v1`

`installDirectBrowser({ session })` installs the canonical bridge as `window.__direct`. It derives the validated probe and coverage snapshot from the session and exposes:

- `snapshot()` for the current validated probe value;
- `reset()` for the synchronous product-owned reset action; and
- `coverage` for the JSON-safe coverage catalog.

The reset callback must complete synchronously and return `undefined`. If an asserted or hostile callback returns a thenable, the bridge contains its settlement and throws a controlled synchronous-completion error.

The coverage value uses schema `direct.coverage/v2` and has the exact shape:

```json
{
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
```

Coverage entries cite scenarios rather than duplicating a singular route. The scenario catalog owns each route, and one coverage claim may intentionally span scenarios on different routes.

Consumers must parse the coverage value before using it. Unknown fields, duplicate keys, invalid modes, and inconsistent scenario requirements are rejected.

The bridge is a development automation seam. Do not install it from a production entry.
