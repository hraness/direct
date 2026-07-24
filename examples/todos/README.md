# Todo example

This example runs one React interface against two implementations of a product-owned `TodoPort`:

```text
TodoApp
   |
TodoPort
  /   \
local  deterministic
storage world + logical time
```

The production entry under `src/` uses browser local storage and contains no Direct import. The separate entry under `direct/` uses `defineDirect` for its strict worlds and claims, `createDirectSession` for one activated harness, and `installDirectBrowser` for one atomic bridge and fail-closed fetch boundary.

## Run it

From the repository root:

```sh
bun run example:dev
bun run example:direct
```

The workbench provides three stable scenarios:

- `todos.empty` renders the real empty state.
- `todos.populated` loads two tasks and permits deterministic completion changes.
- `todos.write-failure` loads the same interface and reports a declared persistence failure when a task is changed.

## Verify it

```sh
bun run example:test
bun run example:typecheck
bun run example:verify
```

`example:verify` builds production and Direct into an isolated temporary directory, proves both emitted source-map graphs contain their expected entry modules, scans every emitted production file for forbidden markers, and removes the directory even when verification fails. The individual build commands are useful while iterating:

```sh
bun run example:build
bun run example:check-boundary
bun run example:build:direct
```

The boundary command requires emitted HTML and source-mapped JavaScript, proves the production graph contains the real UI and local-storage composition, rejects sources outside `src/`, and scans every emitted file for package names, query keys, wire schemas, browser globals, and workbench markers. The full verifier separately proves that the Direct graph contains the development entry, deterministic port, shared UI, and atomic browser installation without importing the production storage composition.

The fixture claims cover interface behavior through the deterministic port. The coverage catalog keeps local-storage serialization as a direct claim because the in-memory adapter does not exercise browser storage behavior.
