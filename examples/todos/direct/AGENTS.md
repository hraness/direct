# Contents

- `world.ts` – bounded, strict, versioned JSON world parser and fixtures.
- `definition.ts` – stable empty, populated, and write-failure scenarios plus exact proof catalog.
- `deterministic-todo-port.ts` – in-memory implementation of the product port with logical time and activity accounting.
- `session.ts` – one definition-driven product session, world-free manifest, and probe observation boundary.
- `workbench.tsx` and `main.tsx` – scenario navigation and the real todo interface.
- `vite.config.ts` and `index.html` – separate Direct browser entry.
- `check-production-boundary.ts` – positive production/Direct source-map graph proof plus emitted production-marker scan.
- `*.test.ts` – parser, definition, adapter, session, and boundary evidence.

# Guidelines

- Keep this directory development-only. Production source and emitted assets must not import or contain it.
- Parse every world value from `unknown`; reject unsupported versions, unknown keys, duplicate IDs, and exceeded bounds.
- Use `defineDirect` and `createDirectSession`; do not hand-roll activation, store, clock, manifest, probe, or teardown.
- Install the browser integration only through `installDirectBrowser` in `main.tsx`; let the session own teardown. Count blocked requests and activity failures as probe violations.
- Treat expected write rejection as product behavior, not a verifier violation.
- Use exported activation constants rather than spelling reserved query keys in TypeScript.
