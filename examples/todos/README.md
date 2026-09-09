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

Use Node 24 and the frozen repository dependencies. Each command compiles one immutable StyleX generation with the pinned Vite 8.2.1/Rolldown 1.2.8 toolchain, then serves it on `127.0.0.1:5173`. Run only one preview at a time. Production opens at `/`; the workbench opens at `/direct/`. After editing a recipe or component, stop the command, rebuild/restart it, and refresh the browser. This compiled preview does not claim HMR or React-plugin support. Ctrl-C closes the owned Vite preview server.

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

`example:verify` builds production and Direct in separate fresh `artifacts/todo-*` generations. It proves both emitted source-map graphs contain their expected entry modules and scans every emitted production file for forbidden markers. Both successful generations and failed-build evidence remain retained; existing previews are never overwritten. The individual build commands also scan their newly published output and print its exact directory:

```sh
bun run example:build
bun run example:build:direct
## To recheck one already published production generation:
bun run example:check-boundary -- /absolute/path/printed/by/the/production/build
```

The boundary command requires an explicit generation path, emitted HTML and source-mapped JavaScript. It proves the production graph contains the real UI and local-storage composition, rejects first-party sources outside `src/`, and scans every emitted file for package names, query keys, wire schemas, browser globals, and workbench markers. The full verifier separately proves that the Direct graph contains the development entry, deterministic port, shared UI, and atomic browser installation without importing the production storage composition. These build/source-boundary checks do not replace native-browser appearance and interaction verification.

The fixture claims cover interface behavior through the deterministic port. The coverage catalog keeps local-storage serialization as a direct claim because the in-memory adapter does not exercise browser storage behavior.

## Bounded native appearance comparison

`native-appearance.ts` compares two explicitly identified, already-built Todo
generations. It never edits source, installs a tool, rebuilds, adopts a server,
or searches for a browser. Use Bun 1.3.14, the pinned agent-browser 0.32.3 bundled
native executable (not its JavaScript shim), and an independently provisioned
Chromium executable with exact SHA-256 and four-component version. On macOS,
run the complete invocation through the host and repository native schedulers.
The driver and browser remain development-only verification tools, not public
package dependencies.

First seal each source checkout and retain its build outputs. An old baseline
may have untracked outputs only under the two explicitly inventoried build
roots; all other tracked and untracked work must be clean. Obtain each output's
inventory with `bun examples/todos/native-appearance.ts --inventory
/absolute/build/directory`. This read-only command hashes sorted JSON rows of
relative path, ordinary-file mode, byte length, and SHA-256; links are rejected.

Pass one private JSON input file to
`bun examples/todos/native-appearance.ts /absolute/private/input.json`.
The exact input object has these fields:

- `schema`: `direct.todo-appearance/v1`; `mode`: `compare`.
- `baseline` and `current`: `{ repository, commit, tree, lockSha256, production,
  direct }`. Repository paths are absolute; commit/tree are full Git object IDs.
  Both build fields are `{ directory, inventorySha256 }` from the inventory.
- `browser`: `{ driver, driverSha256, executable, executableSha256, version }`.
  Executable paths must be absolute and canonical, with independently checked
  hashes. The driver basename must match the bundled native platform binary.
- `artifactParent`: an existing canonical private output parent; `port`: one
  reserved, otherwise unused unprivileged loopback port; `canary`: `null`.

The finite comparison covers production local-storage empty, persisted, invalid
JSON and recovery states; all three deterministic scenarios; explicit unknown
and duplicate activation failures; 1280px/390px viewports; and the 519/520/521
and 839/840/841 breakpoint edges. Native keyboard assertions cover checkbox,
summary, scenario navigation, retry and recovery focus/activation. Scenario
links are bound to their exact declared href, label, description and aria-current;
one native Enter navigation must bind the resulting scenario contract. Named authored
geometry uses a 1px comparison tolerance and a separate 0.5px settlement check;
computed presentation properties compare exactly. Candidate-only negative
controls disable the final StyleX stylesheet, suppress a native focus outline,
and hide one scenario description through opacity in-page, require the corresponding
oracle to reject, then recover by navigation
from the unchanged generation.

Each case receives a fresh BrowserContext through `window new`. Batches contain
at most eight contexts. Completed contexts navigate to the exact owned-loopback
`/__todo_native_park` document and remain
parked, not disposed, until the batch ends; their complete tab inventory stays
bound to the original browser. This avoids the pinned driver's stale-target
network-control failure on tab close without disabling its domain allowlist.
The reserved parking response contains no scripts or styles and has a sandboxed
`default-src 'none'` policy. It admits no query, foreign origin, or artifact
replacement. The initial bootstrap alone remains at `about:blank`, which the
pinned driver's explicit navigation parser rejects as a hostless URL.
A final close-only request goes to the exact
already-owned private daemon socket, without the CLI's respawn path. The final
receipt requires whole-browser/daemon descendant absence and owned server
shutdown. Failures, including cleanup failures, remain fatal and retained.
Native console/error observations are cumulative and sampled while each case
is active and after parking. They are not continuous background-context monitoring.
There is no automatic rerun or cleanup of failed evidence.

For a real edit/rebuild canary, prepare and seal a separate current-source
variant and rebuild it outside this verifier. Use `mode: "canary"` and
`canary: { source, sample, box, property }`, where `source` has the same explicit
source/build identity format and the other fields name the exact expected
computed-style or geometry difference. This mode compares current to that
separate rebuilt artifact and requires the named difference. It does not edit
files, and it is not a substitute for a green baseline comparison.

Receipts, command terminal results, screenshots, exact contract/probe evidence,
and failure details are retained in a new mode-0700 output directory. JSON and
screenshots share a bounded per-source quota. The runtime CSS observer checks
settled STYLE/adopted-sheet absence and subsequent insertion; it does not claim
to observe transient insertion before attachment. Screenshots support review;
this is not a screenshot-similarity score. Appearance samples are taken only
after quiescence; transient loading and busy-state paint is not observed.
Browser fixtures do not prove remote
services, storage quota behavior, device appearance or production deployment.
