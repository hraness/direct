---
type: plan
area: effect-architecture
status: in-progress
---

# Effect architecture constraints

## Outcome

Make the development checker recognize native capabilities reached through immutable aliases and actual Effect values imported from local modules. Keep injected services and pure consumers outside those rules. Maintain Direct's optional Effect export and its independent core, testing, browser, and React entrypoints.

## Context and decisions

The starting source is `f19d0fdac747e4359d6e2f915537cc826269b2d7`. Its checker is edition 1.2.1. Adopt the reviewed 1.4 predecessor before adding the new rules, preserving its typed generator-catch checks and positive controls. The next checker edition is maintained here as development source; its version is independent of the npm package version.

In that starting source, a declared non-adapter can capture `Date.now` in a const alias and invoke that alias without the ambient-I/O diagnostic. A local module in that version can also import and discard a genuine Effect value without an architecture role because source discovery recognizes direct package imports. Both gaps need paired regressions on ordinarily valid TypeScript.

Resolve actual declarations and stable aliases instead of relying on spelling. Discover Effect-valued runtime bindings, expressions and exports without recursively classifying every importer of a mixed module. Preserve existing direct Effect import policy and the explicit role map. Do not expand adapter permissions to make adoption pass.

The checker remains a bounded static constraint. Native settlement, physical resource cleanup, failure precedence and safe replay require causal tests at the operation's real boundary. Arbitrary mutable dataflow, reflection and erased types remain outside the alias resolver's claimed coverage.

## Work and ownership

1. Adopt the 1.4 source and preserve Direct's relative `.js` imports and fixtures.
2. Add declaration-backed ambient alias/capture checks and shadowed-service controls.
3. Discover local Effect values before skipping undeclared production modules; preserve pure and type-only consumers.
4. Review alias cycles, mutations, mixed barrels and ordinary compiler diagnostics independently.
5. Record canonical source provenance and the supported boundary in the development reference. Keep scripts excluded from package exports and files.
6. Run focused checks, KB convergence and the unchanged repository aggregate, then deliver through a current-head PR and required CI.

One implementer owns checker source and paired fixtures. Integration owns the role map, provenance, documentation, generated files and final validation. Consumers may copy an accepted immutable source and its hashes independently; they do not import another repository's working tree.

## Verification

Use `bun run check:effect`, ordinary typecheck and changed-file lint. Pair each rejected native/local-value case with a declared adapter, injected service, shadowed declaration, pure member or type-only consumer that must pass. Preserve existing generator, runtime-root and channel fixtures. Add bounded generated alias-chain laws without treating unresolved TypeScript as a valid fixture.

Run an independent `bun run kb:check:lane`, followed by integration's KB refresh/check. Run the complete `bun run check` on the converged source, preserving its package, browser and React Native boundary checks. Record exact results here before completion.

## Recovery

The change touches development constraints and their documentation. No package export, production runtime or wire format changes. A failed consumer adoption remains isolated until its source or explicit role is corrected; preserve the stricter checker and its failing evidence instead of adding broad exemptions.

## Implementation evidence

Edition 1.5.0 implements the reviewed 1.4 baseline, immutable callback origin
checks and local Effect-value discovery. All 43 predecessor fixtures and nine
tests remain; the suite now has 13 tests and 146 assertions. The paired
same-interface service regression failed before the value-origin repair and
passes afterward. Ordinary typecheck, actual policy and changed-file lint pass
on the implemented engine. Independent source review found no remaining defect
in those additions. The final edition-header change affects no executable code.

The canonical hashes and qualified toolchain are recorded in
`scripts/effect-architecture-source.json`; supported rules, proof limits and
consumer steps are maintained in `docs/effect-architecture.md`. Direct's existing
role wrapper, package manifest and lockfile remain unchanged. No new runtime
export is needed. KB convergence and the repository aggregate remain pending;
no new merge or release is claimed yet.
