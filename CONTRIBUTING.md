# Contributing

Issues and focused pull requests are welcome in the public repository.

Open an issue before starting a broad API, wire-format, or architecture change so the design and compatibility expectations can be agreed first. Maintainers review pull requests for scope, behavior, tests, documentation, and the production-exclusion boundary.

Run the standalone gate before opening a pull request:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Keep core changes product-, framework-, and platform-neutral. Add readable example tests for concrete behavior. Add a property test for parsers, round trips, ordering, reset behavior, cancellation, and other laws over arbitrary input.

Changes to a wire schema or reserved activation key require a versioned migration and compatibility tests. Changes to the todo example must preserve separate production and Direct entries and pass the emitted production-boundary scan.
