# Effect architecture checker

Direct maintains a development checker for explicitly reviewed Effect modules.
The canonical source is `scripts/check-effect-architecture.ts`, paired with
`scripts/check-effect-architecture.test.ts`. Edition 1.5.0 is source distributed
independently of the npm version. Both files are excluded from the package.

## Rules and roles

The checker builds an ordinary TypeScript Program from the repository's config.
It recognizes genuine Effect types through their declaration-backed variance
symbol. Production Effect imports, exports, values and functions returning an
Effect require a named module role. Pure members of mixed local barrels and
erased local type-only consumers do not inherit that role. Direct imports from
the Effect package retain the explicit-role requirement, including type imports.

Every governed module rejects floating or unused Effect work, asserted or erased
error channels, explicit `any`, and JavaScript catches that cannot handle typed
failures yielded in a genuine Effect generator. Runtime creation and execution
belong to named runtime roots. Native imports and ambient capabilities belong
to named adapters. Adapter status does not exempt runtime ownership or failure
handling.

Edition 1.5 follows immutable native callback aliases, literal member accesses,
destructuring and local raw callback re-exports. A captured `Date.now` or callback
passed to `Effect.sync` is checked at its actual value origin. Injected services
typed as `DateConstructor`, `Math` or `Window` remain valid. The checker does not
follow mutable object dataflow, reflection, arbitrary wrapper bodies or values
whose genuine Effect type has been erased. It cannot prove physical resource
settlement, durable authority or safe retries; those need causal domain tests.

Direct's role map is `scripts/effect-policy.ts`. Its public checker API remains
`EffectArchitecturePolicy`, `ArchitectureFinding`, `createArchitectureProgram`
and `inspectEffectArchitecture`. Findings are deduplicated and deterministically
ordered by file, line and rule.

## Adopt an immutable edition

1. Select a reviewed commit containing the canonical source and paired fixtures.
   Record its full Git SHA, source edition and both SHA-256 hashes. The sibling
   `scripts/effect-architecture-source.json` records the canonical file hashes;
   the selected containing commit supplies its immutable identity.
2. Copy both files into the consuming repository. Retain the canonical tests and
   product-specific cases. If its relative engine import needs adjustment,
   record the adaptation and resulting fixture hash.
3. Use that repository's declared TypeScript and Effect dependencies. The paired
   fixtures additionally require Bun and a development dependency on fast-check.
   This edition was qualified with Bun 1.3.14, TypeScript 6.0.3, Effect 3.22.1 and
   fast-check 4.9.0. Qualify a different toolchain through its own checks.
4. Review actual modules, native adapters and runtime roots in a product-owned
   wrapper. Keep ordinary compilation enabled. Resolve new diagnostics through
   code or a justified exact role; do not exclude an application directory.
5. Run the copied fixtures, actual wrapper, ordinary typecheck and the consuming
   repository's required aggregate before merging adoption. Preserve its own
   release and deployment workflow.

No consumer imports this checker from a sibling checkout, adds a compiler plugin
or gains a production runtime dependency on Direct to run the source checker.
Each repository accepts and upgrades an immutable edition independently.

## Verify changes here

From Direct's root, run `bun run check:effect`, `bun run typecheck`, and the
changed-file lint while editing. Keep new fixtures valid under ordinary
TypeScript before interpreting architecture findings. Pair rejection examples
with valid injected, shadowed, pure and type-only controls. The bounded alias
law uses seed 1415 and depths zero through eight.

Run the unchanged `bun run check` aggregate after convergence. It retains the
packed-consumer boundaries, browser example and React Native checks. Changes to
these excluded scripts do not require a new npm version or a site deployment.
