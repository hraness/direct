# Contents

- `src/` – the real todo interface, product-owned port, and local-storage production adapter.
- `direct/` – the separate deterministic world, adapter, session, workbench, tests, and production-boundary scan.
- `index.html` and `vite.config.ts` – the production document and build graph.
- `tsconfig.json` – strict example typecheck boundary.
- `verify.ts` – temporary-directory production build/scan and Direct build gate.
- `README.md` – commands, layout, scenarios, and proof limits.

# Guidelines

- Keep `src/` free of Direct imports and vocabulary. The real interface depends only on `TodoPort`.
- Keep the local-storage adapter production-safe and validate stored JSON before returning it.
- Keep the Direct entry separate, network-silent, and development-only.
- Use only public package names, repository paths, and commands in example code and documentation; do not refer to or infer non-public systems, products, paths, packages, or implementation details.
- Build production before running the marker scan; fail when the scanner finds no emitted files.
- Update the scenario catalog, coverage catalog, example tests, and README together.
