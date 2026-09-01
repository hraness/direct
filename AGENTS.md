<!-- kb:context scopes/repository--cdb4ee2aea69 -->
# Contents

- `src/core/` – product-neutral scenario, fixture, logical-time, store, effect, resource, and coverage contracts.
- `src/testing/` – deterministic session, world-free manifest, evidence, activity, probe, and exact scripted-transport utilities.
- `src/react.ts` – opt-in React bindings for a Direct store.
- `src/web/` – atomic exact browser-session bridge installation plus low-level bridge and fail-closed application-fetch firewall.
- `src/tooling/` – opt-in Bun/Node verification, Bombadil campaign and host lifecycle, and emitted-bundle scanning mechanics kept outside production runtime graphs.
- `docs/` – architecture, adoption, verification, publishing, and wire-format reference.
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
- Follow the shared [Hraness README guidelines](https://github.com/hraness/.github/blob/main/README_GUIDELINES.md) for the README trust path and its website projection. Adapt the structure to Direct's package and Agent Skill instead of copying a fixed template.
- Apply unreasonably robust programming when agent work is cheap. Prefer coherent cross-file correctness and focused deterministic evidence to a knowingly weaker design.
- Deliver changes to `main` through a current-head pull request. Keep the stable `Required` CI job green, resolve every review thread, and serialize merges. Human approval stays optional while one regular maintainer would otherwise self-review. Never force-push or bypass the gate.
- Keep core code product-, platform-, and framework-neutral. Put React, browser globals, and Node-only tooling behind explicit subpaths.
- Build Bun host `@hraness/direct/tooling/*` entries separately. Keep every development-only export out of the default, core, React, testing, and web graphs, and prove the separation through the packed-consumer boundary gate. Ship the Bombadil campaign subpath as TypeScript source because 0.7.2 resolves no package export conditions, and keep it free of filesystem and process APIs because its compiler loads that subpath into a browser specification.
- Pin optional browser tools exactly. The Bombadil integration supports 0.7.2 only, treats its JSONL trace as foreign bounded input, and must attest the canonical Direct manifest and probe after every run rather than trust a zero exit status.
- Constrain every Bombadil run to exclusive UUID leaves, owned process groups, bounded files and totals, a final descriptor-bound inventory, and a sanitized receipt. Public CI may upload only the exact receipt/summary leaf; raw traces and diagnostics require explicit bounded private vetting. Give each product-owned named snapshot an exact fail-closed parser or predicate.
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
- Follow `docs/publishing.md` for trusted npm publishing. Treat one protected `v*` tag on `main` as the complete release request. Restrict version-tag creation to organization administrators in a dedicated GitHub ruleset, and block tag updates and deletion for everyone in the separate immutable-tag ruleset. Keep checkout, install, build, test, pack, and artifact upload in a read-only job; only its minimal dependent publication job may request OIDC, and that job must rebind the downloaded exact artifact, every remote stable tag, and current `main` before `npm publish`. It must reject a candidate that is no longer the newest remote stable tag. Configure npm to trust only the calling `release.yml` workflow for direct publication and disallow traditional publishing tokens. After publication, let a read-only job compare the source and registry packages by exact extracted path, type, mode, size, and regular-file hashes before the write-scoped publisher creates the GitHub Release. Verify each transport's npm and registry integrity independently because compressed tarball bytes may vary across operating systems. A rerun may accept an existing npm version only when the later canonical comparison proves it matches. Recover a failed post-tag Release through the exact tag rerun or explicit current-`main` workflow dispatch; bind current helpers to reviewed Git blobs and invoke them by absolute path against the checked tagged tree, with tag-owned Bun config and environment loading disabled. Keep `npm pack --ignore-scripts` so recovery never runs a historical `prepack`. Never move a tag or replace an npm version. Finish and verify the npm package and matching non-draft immutable Latest Release before creating another tag.

<!-- hra-local-efficiency:start -->
- Preserve useful reasoning fan-out, but avoid unnecessary checkout fan-out. Prefer subagents in the current task for bounded research, review, diagnosis, and focused checks when they can safely share one working tree; create a separate task or worktree only for independently deliverable divergent edits, an isolated verification tree, or a different execution environment.
- Give each expensive focused validation command and external wait one owner. The integration owner reviews that evidence and runs the repository-required aggregate or final gate once after convergence. Reuse evidence only for the exact Git tree, command, lockfiles, toolchain, relevant environment, and validity period, and never to skip a required final integration, merge, release, deployment, or production-verification gate.
- On Hraness development machines, use `$hra-local-efficiency` and the installed host scheduler for heavyweight top-level commands when available. Keep ordinary work in the compute lane; give authenticated browser/dev-server/Chromium work one `browser-auth` owner and Mac-only validation one `mac-native` owner.
- When a CI or policy gate scans complete Git history, check out the exact governed SHA and fetch only the fully qualified governed refs before scanning. Preserve the complete-history gate and reject unexpected refs instead of importing unrelated concurrent heads.
- At closeout, record applicable branch, PR, check, merge, release, deployment, and production evidence. Archive only conclusively finished tasks, never from silence alone, and reclaim only freshly revalidated clean merged worktrees through the guarded exact-path flow.
<!-- hra-local-efficiency:end -->
