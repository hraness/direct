# Contents

- `todo-port.ts` – product-owned todo records, errors, cloning, and persistence contract.
- `local-storage-todo-port.ts` – strict production implementation over browser local storage.
- `TodoApp.tsx` – real React interface driven only by the product port.
- `main.tsx` – production composition.
- `styles.css` – shared product presentation.
- `*.test.ts` – production-adapter behavior and malformed-storage regressions.

# Guidelines

- Do not import Direct or read scenario activation in this directory.
- Parse local-storage JSON from `unknown`, reject unknown fields and duplicate IDs, and return owned records.
- Keep UI errors actionable and preserve the last successfully loaded list after a failed write.
- Keep controls accessible by name and native semantics so browser verification can act in product terms.
