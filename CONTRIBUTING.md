# Contributing

Issues and focused pull requests are welcome in the public repository.

Open an issue before starting a broad API, wire-format, or architecture change so the design and compatibility expectations can be agreed first. Maintainers review pull requests for scope, behavior, tests, documentation, and the production-exclusion boundary.

Install the locked dependencies, run focused local checks for the changed behavior, and obtain independent impact and diff review before final source admission:

```sh
bun install --frozen-lockfile --ignore-scripts
```

Complete CI is the final source aggregate. Its `check` job runs the entire root `bun run check`: type and Effect checks, release contracts, build, installed-package smoke, source tests, lint, todo tests/types/build boundaries, and React Native tests/types/iOS/Android/web export boundaries. It then requires clean committed `dist` and `bun.lock`, checks packing, and imports the built runtime entries. Both `check` and the unconditional `Required` job must succeed in the same completed run attempt. A skipped, cancelled, failed, or incomplete job cannot admit the change.

Before merging, record the exact PR head, the authoritative current `refs/heads/main` SHA, the checked integration commit and tree, the CI run ID and attempt, both job conclusions, and the lockfile and toolchain identity. Re-read the actual main ref; PR base metadata can lag. If the head or base moves, qualify the new integration candidate with focused checks for changed inputs and fresh complete CI. Earlier results remain diagnostic evidence and do not admit a different final tree.

Review workflow, command, test-discovery, deadline, and platform changes against the prior required coverage. Keep `scripts/ci-source-coverage.test.ts` passing; intentional coverage changes require independent review and corresponding evidence. Retain `bun run check` as the complete local aggregate when CI coverage or equivalence is uncertain:

```sh
bun run check
```

Source CI does not replace an explicit local, native, browser, install, release, npm-mirror, or provider acceptance criterion. Ubuntu export checks do not prove behavior on an iOS or Android device, macOS, or a live browser or provider. Run the relevant platform checks when a change depends on those behaviors. Diagnose known failures before requalification; retries and a previously passing tree do not resolve an unexplained failure.

Keep core changes product-, framework-, and platform-neutral. Add readable example tests for concrete behavior. Add a property test for parsers, round trips, ordering, reset behavior, cancellation, and other laws over arbitrary input.

Changes to a wire schema or reserved activation key require a versioned migration and compatibility tests. Changes to the todo example must preserve separate production and Direct entries and pass the emitted production-boundary scan.
