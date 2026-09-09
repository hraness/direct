# Contents

- `src/` – the real todo interface, product-owned port, and local-storage production adapter.
- `direct/` – the separate deterministic world, adapter, session, workbench, tests, and production-boundary scan.
- `index.html` – the authored production document.
- `build.ts` and `preview.ts` – real-Node public StyleX generation finalization and an owned compiled preview.
- `build-contract.ts` and its tests – finite targets and exact authored-document/graph URL binding.
- `vite.config.ts` – guard against uncompiled legacy Vite invocation.
- `tsconfig.json` – strict example typecheck boundary.
- `verify.ts` – bounded production and Direct build/scan gate with retained immutable generation outputs.
- `README.md` – commands, layout, scenarios, and proof limits.

# Guidelines

- Keep `src/` free of Direct imports and vocabulary. The real interface depends only on `TodoPort`.
- Keep the local-storage adapter production-safe and validate stored JSON before returning it.
- Keep the Direct entry separate, network-silent, and development-only.
- Use only public package names, repository paths, and commands in example code and documentation; do not refer to or infer non-public systems, products, paths, packages, or implementation details.
- Build production before running the marker scan; fail when the scanner finds no emitted files.
- Keep source-map coordinates in place after finalization. Never move published generations or infer a latest output for boundary verification.
- Keep all component presentation in finite StyleX recipes; `src/styles.css` is only the shared document/reset boundary. Preview changes require rebuild/restart/manual refresh, not an HMR claim.
- Update the scenario catalog, coverage catalog, example tests, and README together.
