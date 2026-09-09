---
title: Compile the Todo web examples with StyleX
description: Migrate both Todo browser presentations while preserving production exclusion, deterministic scenarios, and the headless package.
type: plan
area: todo-web
status: in-progress
repository_scopes:
  - examples/todos
  - package.json
  - bun.lock
---

# Compile the Todo web examples with StyleX

## Outcome

The production Todo interface and separate Direct workbench use compiled StyleX recipes. Both retain their current behavior and responsive layout, and every production executable still has a real source map that proves its complete source boundary.

## Scope and decisions

The authored presentation currently lives in `examples/todos/src/styles.css` and `examples/todos/direct/workbench.css`. Convert component rules and finite checked/active states to recipes. Keep reviewed document resets in CSS. Preserve the 520px and 840px breakpoints, native controls, loading and failure states, strict local-storage parser, deterministic ports, catalog, and browser bridge.

The [[notes/repository-seams|headless package boundary]] remains unchanged. Compiler dependencies are development-only; no new runtime or peer design-system edge, export, published file, package version, or release operation belongs to this example migration. The React Native example continues to use its native renderer and requires a separate re-audit if that implementation changes.

Use the immutable UI v0.5.9 Vite compiler with its external-source-map profile, exact Vite 8.2.1/Rolldown 1.2.8, and pinned compiler peers. Its native qualification does not cover the React Vite plugin or HMR. The example therefore uses compiled previews: build a complete fresh generation, serve it, and rebuild/restart/manual-refresh after an edit. Do not claim HMR or retained application state. Preserve ordinary command entrypoints and explain this change in the example README.

Production and Direct need separate complete generations. A combined published directory would make the existing all-file production marker scan correctly reject the workbench. Keep each generation in the repository so external maps retain their source coordinates. Do not move a published tree to a different relative position or rewrite native maps after publication.

## Execution

1. [x] Audit authoritative main and current example contracts. Start an isolated branch from `ba671caad2fcf0d3fe44ad7264fa20f9d9ab139c`; preserve prior completed worktrees and the v0.7.21 release.
2. [x] Pin the released compiler and add separate production/Direct generation orchestration without changing the package runtime graph. Prove the existing map and marker scans against the real outputs.
3. [ ] Convert the two presentations, retain only reviewed resets, and add static recipe/production-boundary regression tests.
4. [ ] Prove native production local-storage behavior and all three deterministic scenarios, malformed activation, responsive layouts, focus, busy/error states, no runtime CSS injection, and a real edit/rebuild/restart/manual-refresh cycle.
5. [ ] Run independent source and KB reviews, focused local checks and explicit example acceptance, then require complete current-head/current-main integration CI and merge through a pull request.

## Verification and recovery

The existing production and Direct source-map scanners remain authoritative and cannot accept an empty graph, missing executable maps, unexpected source modules, or leaked Direct markers. Add generated stylesheet/link identity checks and native browser evidence; source inspection alone does not prove presentation.

Compare the fresh migration to a separately built immutable baseline. Bind browser evidence to exact source, dependency, compiler, generation, and browser identities. Preserve first-red outputs and diagnostics. Build into a new owned generation; never overwrite an active server's output. Stop publication on incomplete compilation or failed boundary checks.

The normal full CI retains the root `bun run check`, package boundaries, Todo checks, and React Native coverage. No timeout, marker, source-map, release, or platform gate is waived. Before merge, a normal current-main join preserves independently landed work. A post-merge repair uses another reviewed commit; existing release tags and package bytes remain unchanged.

## Execution evidence

- 2026-09-09: Read-only audit found no open Direct PR. Main and v0.7.21 are separate from prior example-boundary PR 45. The unchanged Todo verifier requires source-mapped production and workbench builds; the Vite compiler's newly qualified external-map profile satisfies that prerequisite, pending immutable v0.5.9 release completion and consumer validation.
- 2026-09-09: UI v0.5.9 is published immutable. The development-only dependency join resolved under Bun 1.3.14 with lifecycle scripts disabled: 585 packages installed in 4.88 seconds; the lock binds the immutable annotated tag. Both presentations now use finite recipes, with only document/reset CSS retained. The real-Node build driver creates separate immutable production and workbench generations, seals authored-document output, and runs the original positive source-map/marker scanners after finalization.
- 2026-09-09: Independent static review corrected two integration defects before acceptance: the boundary CLI now requires the exact absolute generated path instead of obsolete implicit `dist`, and preview shutdown uses Vite's public close operation. Added finite-target/template and CLI regressions; updated both command guides. Focused checks are queued through the host and repository schedulers. This draft checkpoint is implementation, not a claim of green builds, browser parity, complete migration, or release.
- 2026-09-09: Created an isolated detached baseline at the audited pre-migration commit and retained exact original source/manifests. Its frozen script-disabled install is queued. Native comparison, all three deterministic scenarios, production storage, focus/responsive states, and rebuild/restart/manual-refresh evidence remain open; the public package version and runtime/React Native graphs remain untouched.
- 2026-09-09: The first native build exposed a Vite source-map attribution failure when the compiler foundation stylesheet was imported directly by JavaScript. A partial CSS-chain repair passed production but still failed the workbench; both failed generations remain retained. The reviewed repair uses the qualified public CSS import chain: foundation first in the document stylesheet, and the document stylesheet last in both JavaScript entries. No source-map, source-census, marker, or package gate was relaxed. A typed-AST regression protects the import order. Independent review found no remaining P0–P2 issue in this five-file repair.
- 2026-09-09: After that repair, the scheduled example typecheck, 32 tests with 135 assertions, and both real production/workbench builds with their complete positive source-map and all-file marker scans passed. The separately installed original baseline also built both targets successfully under its exact original Vite/Rolldown dependencies: four output files per target, 14 production mapped sources and 26 workbench mapped sources. Generated outputs are retained in place for native comparison. These results do not yet establish browser parity or a completed migration.
- 2026-09-09: The first draft CI reached 439 source tests with 73,636 assertions, then rejected two non-null assertions in the new build driver. Explicit finite-output guards replace those assertions without changing the accepted graph. Root lint, example types and both real builds with the unchanged source-map/marker gates pass after the repair. Current-head complete CI and native appearance acceptance still govern delivery.
