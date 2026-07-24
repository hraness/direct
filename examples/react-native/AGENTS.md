# Contents

- `src/` – the real React Native screen, product-owned device-status port, production adapter, and platform-resolved roots.
- `direct/` – strict worlds, definition, deterministic adapter, session, React Native Web workbench, tests, and native-output scanner.
- `app.json`, `index.ts`, and `metro.config.cjs` – minimal Expo application and package or local-source resolution.
- `verify.ts` – isolated iOS, Android, and web exports plus paired source-map selection and production-boundary scans.
- `README.md` – commands, structure, scenarios, and proof limits.

# Guidelines

- Keep `src/DeviceStatusApp.tsx` and `src/device-status-port.ts` free of Direct imports and vocabulary.
- Keep `root.native.tsx` production-only and `root.web.tsx` Direct-only; do not choose the deterministic composition with a runtime flag.
- Keep React Native imports in the example. The Direct package runtime remains independent of React Native and Expo.
- Use only public package names, repository paths, and commands in example code, documentation, and Git prose; do not refer to or infer non-public systems, products, paths, packages, or implementation details.
- Keep the deterministic port network-silent, abortable, activity-accounted, and seeded only from the active strict world.
- Export iOS, Android, and web bundles with paired source maps. Require the shared screen plus the expected native or Direct composition sources, and reject native/web cross-contamination structurally. This remains graph evidence, not device-behavior evidence.
- Treat browser rendering as fixture evidence; React Native platform detection, native layout, appearance, and device execution remain direct.
