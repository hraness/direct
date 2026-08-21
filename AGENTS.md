<!-- kb:context scopes/repository--cdb4ee2aea69 -->
# Contents

- `src/core/` – product-neutral scenario, fixture, logical-time, store, effect, resource, and coverage contracts.
- `src/testing/` – deterministic session, world-free manifest, evidence, activity, probe, and exact scripted-transport utilities.
- `src/react.ts` – opt-in React bindings for a Direct store.
- `src/web/` – atomic exact browser-session bridge installation plus low-level bridge and fail-closed application-fetch firewall.
- `src/tooling/` – opt-in Bun/Node browser-verification and emitted-bundle scanning mechanics kept outside browser/runtime graphs.
- `docs/` – architecture, adoption, verification, and wire-format reference.
- `examples/todos/` – runnable React example with separate production and Direct entries.
- `examples/react-native/` – runnable Expo example with platform-resolved native production and React Native Web Direct entries.
- `skills/direct/` – one installable Agent Skill for Direct installation, adoption, verification, and production exclusion.
- `kb/` – authored repository rationale, maintained synthesis, and durable plans.
- `.agents/skills/` – portable KB and phased-execution workflows.
- `WRITING.md` and `STYLE.md` – internal and public prose contracts.
- `.github/workflows/` – read-only branch validation and checks-gated immutable GitHub Release automation.
- `README.md` – installation, quick start, scope, and command index.

# Guidelines

- Use Bun 1.3.14 for repository commands. Keep the published ESM runtime portable to modern Node.js and browsers according to each export's documented boundary.
- Follow `WRITING.md` for internal prose and `STYLE.md` for public prose.
- Apply unreasonably robust programming when agent work is cheap. Prefer coherent cross-file correctness and focused deterministic evidence to a knowingly weaker design.
- Deliver changes to `main` through a current-head pull request. Keep the stable `Required` CI job green, resolve every review thread, and serialize merges. Human approval stays optional while one regular maintainer would otherwise self-review. Never force-push or bypass the gate.
- Keep core code product-, platform-, and framework-neutral. Put React, browser globals, and Node-only tooling behind explicit subpaths.
- Build `@hraness/direct/tooling/*` separately for Bun. Keep those host-only exports out of the default, core, React, testing, and web graphs, and prove the separation through the packed-consumer boundary gate.
- Keep React Native and Expo imports in the reference example; `@hraness/direct/react` remains the platform-neutral React binding.
- Keep `.js` extensions on relative TypeScript import and export specifiers; the published source type surface must compile under both Bundler and NodeNext resolution.
- Treat this repository as the complete project. Files and Git prose may use only its public names, paths, commands, and examples; do not refer to or infer any non-public source, system, product, package, path, or implementation detail.
- Let each product own its semantic ports, strict versioned JSON world, deterministic adapters, scenarios, coverage claims, and workbench.
- Prefer one validated definition, one owned session, and one atomic browser installation over assembling raw catalogs, stores, manifests, probes, and globals in each product.
- Keep Direct development-only. Production entries and emitted production assets must not import the package, fixture worlds, scenario catalogs, workbench code, or browser bridge.
- Keep this repository package-only. Link to the canonical product page at `https://hraness.com/direct`; do not add a website or deployment contract here.
- Model invalid states out of existence. Parse foreign input from `unknown`, reject unknown reserved keys and object fields, and preserve atomic store, generation-fencing, cancellation, and exact-script invariants.
- Publish one exact driver-neutral session manifest from the browser bridge. Parse
  the exact v2 schema, manifest, and probe from one synchronous page sample.
  Require the expected source, scenario, route, and matching activation hashes
  before treating browser output as evidence.
- Pair readable deterministic regression examples with property tests for parsers, round trips, ordering, resets, cancellation, and other general laws.
- Pin Hraness dependencies to reviewed immutable releases or full commits. Never connect repositories with sibling paths, Git submodules, or coordinated `main` assumptions.
- Extract a shared abstraction only after two concrete consumers need the same stable interface. Keep Direct product-neutral and independently releasable; consumers upgrade on their own validation schedule.
- Keep Direct headless and development-only at consumer boundaries. Do not add a design-system dependency or product composition to the package.
- Freeze public interfaces before parallel lanes begin. Give manifests, lockfiles, generated files, and other convergence surfaces one owner while lanes edit disjoint paths.
- Keep mandatory rules in the closest `AGENTS.md`, current procedures in `docs/`, executable contracts in types and tests, and pull-based rationale and plans in `kb/`.
- Run `bun run kb:check:lane` in an independent KB lane. The integrating agent runs `bun run kb:refresh` and `bun run kb:check`.
- State proof limits precisely. Fixture evidence does not prove the live adapter, service, host, operating system, or device behavior that the composition replaces.
- Run `bun run check` before handing off a change. Run the todo example's production build and marker scan when changing the example or package boundaries.
- Run the React Native example's iOS, Android, and web export gate when changing mobile integration or production boundaries.
- Treat a `v*` tag as a release request, not a completed release. Before tagging, confirm repository-level immutable releases are enabled; use a strictly increasing stable package version, keep the tag equal to `v<package.json version>` on `main`, and let the read-only verification job complete before its write-scoped publisher creates the Release. Do not create the next tag until that workflow and Release are verified because GitHub concurrency is not a durable queue. After tagging, verify the matching non-draft immutable Release is Latest.
