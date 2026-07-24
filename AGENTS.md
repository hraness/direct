# Contents

- `src/core/` – product-neutral scenario, fixture, logical-time, store, effect, resource, and coverage contracts.
- `src/testing/` – deterministic session, evidence, activity, probe, and exact scripted-transport utilities.
- `src/react.ts` – opt-in React bindings for a Direct store.
- `src/web/` – atomic browser-session installation plus low-level bridge and fail-closed application-fetch firewall.
- `docs/` – architecture, adoption, verification, and wire-format reference.
- `examples/todos/` – runnable React example with separate production and Direct entries.
- `examples/react-native/` – runnable Expo example with platform-resolved native production and React Native Web Direct entries.
- `app/` – the statically generated `hraness.direct` product site with a concise landing page and a long-form Overview sourced from the synchronized README section.
- `public/og.png` – the site’s typography-led social-preview card.
- `skills/` – agent workflows for adding and verifying a Direct composition.
- `README.md` – installation, quick start, scope, and command index.

# Guidelines

- Use Bun 1.3.14 for repository commands. Keep the published ESM runtime portable to modern Node.js and browsers according to each export's documented boundary.
- Keep core code product-, platform-, and framework-neutral. Put React, browser globals, and Node-only tooling behind explicit subpaths.
- Keep React Native and Expo imports in the reference example; `@cclrte/direct/react` remains the platform-neutral React binding.
- Keep `.js` extensions on relative TypeScript import and export specifiers; the published source type surface must compile under both Bundler and NodeNext resolution.
- Treat this repository as the complete project. Files and Git prose may use only its public names, paths, commands, and examples; do not refer to or infer any non-public source, system, product, package, path, or implementation detail.
- Let each product own its semantic ports, strict versioned JSON world, deterministic adapters, scenarios, coverage claims, and workbench.
- Prefer one validated definition, one owned session, and one atomic browser installation over assembling raw catalogs, stores, probes, and globals in each product.
- Keep Direct development-only. Production entries and emitted production assets must not import the package, fixture worlds, scenario catalogs, workbench code, or browser bridge.
- Keep the public site server-rendered and static. Put installation and the browser-tool decision on the concise landing page, parse the Overview from the repository-controlled README’s exact marker boundary, and keep the site outside the packed runtime allowlist.
- Parse foreign input from `unknown`, reject unknown reserved keys and object fields, and preserve atomic store, generation-fencing, cancellation, and exact-script invariants.
- Pair concrete behavior tests with property tests for parsers, round trips, ordering, resets, and cancellation.
- State proof limits precisely. Fixture evidence does not prove the live adapter, service, host, operating system, or device behavior that the composition replaces.
- Run `bun run check` before handing off a change. Run the todo example's production build and marker scan when changing the example or package boundaries.
- Run the React Native example's iOS, Android, and web export gate when changing mobile integration or production boundaries.
- Run `bun run site:check` when changing the website, README article, metadata, or deployment contract.
