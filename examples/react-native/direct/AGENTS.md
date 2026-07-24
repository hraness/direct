# Contents

- `world.ts` – bounded exact versioned JSON world and owned device fixture.
- `definition.ts` – stable scenarios, viewport metadata, and fixture/direct coverage catalog.
- `deterministic-device-status-port.ts` – logical-time, activity-accounted implementation of the product port.
- `session.ts` – activation, store, cancellation, probe counters, and cleanup composition.
- `mount.ts` – effect-owned canonical browser installation and session-owned idempotent teardown.
- `workbench.tsx` – React Native Web scenario navigation and phone/tablet frame.
- `web-provider.tsx` – fail-closed activation and real-screen composition over a mounted Direct session.
- `check-native-boundary.ts` – emitted iOS and Android entry, source-map, and marker scanner.
- `*.test.ts` and `*.property.test.ts` – parser, definition, adapter, lifecycle, and scanner evidence.

# Guidelines

- Keep every world value JSON-safe, strictly parsed from `unknown`, bounded, versioned, cloned, and frozen.
- Use the product-owned port rather than simulating React Native or Expo APIs.
- Keep web globals inside this directory and reachable only from `root.web.tsx`.
- Fail closed on malformed activation, blocked application fetches, deterministic failures, and disposed work.
- Give every fixture claim a stable scenario; keep native platform behavior explicit as direct evidence.
- Make every browser mount own a fresh session and complete teardown so React effect replay cannot revive disposed resources.
- Require executable files, source maps, and native entry markers; reject Direct and web-composition module paths plus defense-in-depth content markers.
