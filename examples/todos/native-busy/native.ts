import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireVerificationServer, runVerificationCommand, spawnVerificationServer, stopVerificationServer } from "@hraness/direct/tooling/browser-verification";
import { assertStaticCss, createNativeBatch, sampleProgram, todoBuildInventory } from "../native-appearance.js";
import { absolutePath, assertTodoConsole, assertTodoStable, compareTodoAppearance, digest, exactRecord, parseTodoAppearanceSample, todoFailureText, withTodoCleanup,
  type TodoAppearanceInput, type TodoAppearanceSample } from "../native-appearance-contract.js";
import { BUSY_PAINT_PATH, BUSY_PAINT_PHASES, proveBusyPaintCase } from "./native-proof.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const nativeServer = join(root, "examples/todos/native-appearance.ts");
const schema = "direct.todo-busy-native/v1";
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const settlePaint = `(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true; })()`;
const cases = ([1280, 390] as const).flatMap(width => (["success", "failure"] as const).map(outcome => ({ width, outcome })));
const expectedSamples = cases.flatMap(({ width, outcome }) => BUSY_PAINT_PHASES.map(phase => `${width}-${outcome}/${phase}`));
const prefix = "examples/todos/";
const fixturePaths = ["controlled-port.test.ts", "controlled-port.ts", "entry.tsx"].map(path => `${prefix}native-busy/${path}`);
const driverPath = `${prefix}native-busy/build-busy.mjs`;
const templatePath = `${prefix}native-busy/index.html`;
const recipePath = `${prefix}src/todo.stylex.ts`;
const runtimePaths = ["native-busy/controlled-port.ts", "native-busy/entry.tsx", "src/TodoApp.tsx", "src/todo-port.ts"].map(path => prefix + path);
const buildLimits = ["compilation only, not native busy paint", "standalone TodoApp, not workbench busy layout", "controlled port, not production persistence timing"];
function inside(parent: string, path: string): boolean {
  const child = relative(parent, path);
  return child !== "" && !isAbsolute(child) && child !== ".." && !child.startsWith("../");
}
interface Source {
  readonly repository: string;
  readonly commit: string;
  readonly tree: string;
  readonly receiptPath: string;
  readonly receiptSha256: string;
}
export interface BusyNativeInput {
  readonly schema: typeof schema;
  readonly baseline: Source;
  readonly current: Source;
  readonly browser: TodoAppearanceInput["browser"];
  readonly artifactParent: string;
  readonly port: number;
}
function source(value: unknown): Source {
  const row = exactRecord(value, ["repository", "commit", "tree", "receiptPath", "receiptSha256"], "busy source");
  return { repository: absolutePath(row.repository, "repository"), commit: digest(row.commit, 40, "commit"), tree: digest(row.tree, 40, "tree"),
    receiptPath: absolutePath(row.receiptPath, "build receipt"), receiptSha256: digest(row.receiptSha256, 64, "build receipt hash") };
}
export function parseBusyNativeInput(value: unknown): BusyNativeInput {
  const row = exactRecord(value, ["schema", "baseline", "current", "browser", "artifactParent", "port"], "busy native input");
  assert.equal(row.schema, schema);
  const browser = exactRecord(row.browser, ["driver", "driverSha256", "executable", "executableSha256", "version"], "browser");
  assert.ok(typeof browser.version === "string" && /^\d+\.\d+\.\d+\.\d+$/u.test(browser.version));
  assert.ok(typeof row.port === "number" && Number.isSafeInteger(row.port) && row.port >= 1024 && row.port <= 65535);
  const baseline = source(row.baseline), current = source(row.current);
  assert.notEqual(baseline.repository, current.repository); assert.notEqual(baseline.receiptPath, current.receiptPath);
  assert.notEqual(baseline.commit, current.commit);
  return { schema, baseline, current, artifactParent: absolutePath(row.artifactParent, "artifacts"), port: row.port, browser: {
    driver: absolutePath(browser.driver, "driver"), driverSha256: digest(browser.driverSha256, 64, "driver hash"),
    executable: absolutePath(browser.executable, "browser"), executableSha256: digest(browser.executableSha256, 64, "browser hash"), version: browser.version,
  } };
}
async function ordinary(path: string, maximum = 8 * 1024 * 1024): Promise<Buffer> {
  assert.equal(await realpath(path), path, "canonical ordinary file required");
  const before = await lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= maximum);
  const identity = (row: typeof before) => [row.dev, row.ino, row.mode, row.size, row.mtimeMs, row.ctimeMs];
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert.deepEqual(identity(await file.stat()), identity(before));
    const bytes = await file.readFile();
    assert.equal(bytes.length, before.size);
    assert.deepEqual(identity(await file.stat()), identity(before));
    assert.deepEqual(identity(await lstat(path)), identity(before));
    assert.equal(await realpath(path), path);
    return bytes;
  } finally { await file.close(); }
}
async function git(repository: string, ...args: string[]): Promise<string> {
  // This public helper returns a trimmed diagnostic tail, not arbitrary bytes.
  // Use it only for short IDs/status; source bytes are descriptor-bound below.
  return runVerificationCommand({ command: ["/usr/bin/git", "--no-optional-locks", "-C", repository, ...args], cwd: root,
    label: "busy source identity", timeoutMs: 10_000 });
}
interface InventoryRow { readonly path: string; readonly mode: number; readonly bytes: number; readonly sha256: string }
export function parseBusyInventory(value: unknown): InventoryRow[] {
  assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 256);
  const rows = value.map(item => {
    const row = exactRecord(item, ["path", "mode", "bytes", "sha256"], "inventory");
    assert.ok(typeof row.path === "string" && /^[A-Za-z0-9_.-][A-Za-z0-9_./-]*$/u.test(row.path)
      && row.path.split("/").every(part => part !== "" && part !== "." && part !== ".."));
    assert.ok(typeof row.mode === "number" && [0o600, 0o644, 0o755].includes(row.mode));
    assert.ok(typeof row.bytes === "number" && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= 32 * 1024 * 1024);
    return { path: row.path, mode: row.mode, bytes: row.bytes, sha256: digest(row.sha256, 64, "file hash") };
  });
  const names = rows.map(row => row.path);
  assert.deepEqual(names, [...new Set(names)].sort(), "closed canonical inventory required");
  assert.ok(rows.reduce((total, row) => total + row.bytes, 0) <= 128 * 1024 * 1024, "inventory total bound");
  return rows;
}
/** Bind the full ordinary bytes (including whitespace/binary tails) to Git's
 * exact object identity without routing contents through a diagnostic logger. */
export function assertBusyGitBlob(item: InventoryRow, bytes: Uint8Array, tree: string): void {
  assert.ok(item.mode === 0o644 || item.mode === 0o755, "Git source mode required");
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  assert.equal(tree.trim(), `${item.mode === 0o755 ? "100755" : "100644"} blob ${blob}\t${item.path}`, "exact Git blob/mode/path required");
  assert.equal(bytes.length, item.bytes, `source size: ${item.path}`);
  assert.equal(sha256(bytes), item.sha256, `source bytes: ${item.path}`);
}
export function deriveBusyTemplate(original: string): string {
  const originalScript = '<script type="module" src="/src/main.tsx"></script>';
  const fixtureScript = '<script type="module" src="/native-busy/entry.tsx"></script>';
  assert.equal(original.split(originalScript).length, 2, "one exact original entry required");
  assert.equal(original.split("</head>").length, 2);
  assert.equal(original.includes(fixtureScript), false);
  return original.replace(originalScript, fixtureScript);
}
function relativePath(value: unknown): string {
  assert.ok(typeof value === "string" && value.length <= 2048 && /^[A-Za-z0-9_@()[\]./-]+$/u.test(value));
  assert.ok(!value.startsWith("/") && value.split("/").every(part => part !== "" && part !== "." && part !== ".."));
  assert.ok(value.split("/").every(part => (!part.startsWith(".") || part === ".bun") && !/^(?:credentials|secrets?|sessions?)(?:[._-]|$)/iu.test(part)), "protected source path");
  return value;
}
export function parseBusyBuildReceipt(value: unknown, identity: Source, role: "baseline" | "current") {
  const receipt = exactRecord(value, ["schema", "state", "role", "request", "preparationProvenance", "output", "sourceBeforeSha256", "sourceAfterSha256", "fixtureSha256", "compilerEvidence", "boundary", "limits"], "build receipt");
  assert.equal(receipt.schema, "direct.todo-busy-build/v1"); assert.equal(receipt.state, "complete"); assert.equal(receipt.role, role);
  assert.equal(receipt.preparationProvenance, "source commit/tree declared by preparation owner; independently bound source bytes verified here");
  assert.deepEqual(receipt.limits, buildLimits);
  const request = exactRecord(receipt.request, ["schema", "role", "root", "outputParent", "receiptPath", "sourceCommit", "sourceTree", "sourceFiles", "fixtureFiles", "originalTemplateSha256", "node", "packages", "compilerModules"], "build request");
  assert.equal(request.schema, receipt.schema); assert.equal(request.role, role); assert.equal(request.receiptPath, identity.receiptPath);
  assert.equal(request.sourceCommit, identity.commit); assert.equal(request.sourceTree, identity.tree);
  const preparedRoot = absolutePath(request.root, "prepared root"), outputParent = absolutePath(request.outputParent, "output parent");
  if (role === "current") assert.equal(outputParent, join(preparedRoot, "busy-output"), "reserved in-root map publication required");
  else assert.ok(preparedRoot !== outputParent && !inside(preparedRoot, outputParent) && !inside(outputParent, preparedRoot));
  assert.equal(dirname(identity.receiptPath), outputParent);
  const directory = absolutePath(receipt.output, "busy output"); assert.ok(inside(outputParent, directory));
  if (role === "current") {
    assert.equal(basename(directory), "todo-native-busy");
    assert.equal(dirname(dirname(directory)), outputParent);
    assert.match(basename(dirname(directory)), /^todo-busy-current-[A-Za-z0-9]+$/u);
  }
  const files = parseBusyInventory(request.sourceFiles), fixtures = parseBusyInventory(request.fixtureFiles);
  const sourcePaths = ["bun.lock", "package.json", "tsconfig.json", `${prefix}tsconfig.json`, `${prefix}index.html`, `${prefix}src/styles.css`, driverPath, templatePath, ...runtimePaths, ...fixturePaths,
    ...(role === "current" ? [recipePath] : [])];
  assert.deepEqual(files.map(item => item.path), [...new Set(sourcePaths)].sort(), "exact prepared source closure required");
  assert.deepEqual(fixtures.map(item => item.path), fixturePaths);
  for (const item of fixtures) assert.deepEqual(files.find(row => row.path === item.path), item);
  assert.equal(receipt.sourceBeforeSha256, sha256(JSON.stringify(files))); assert.equal(receipt.sourceAfterSha256, receipt.sourceBeforeSha256);
  assert.equal(receipt.fixtureSha256, sha256(JSON.stringify(fixtures)));
  const original = files.find(row => row.path === `${prefix}index.html`); assert.ok(original);
  assert.equal(request.originalTemplateSha256, original.sha256);
  const node = exactRecord(request.node, ["path", "version", "sha256"], "build Node");
  absolutePath(node.path, "build Node path"); digest(node.sha256, 64, "build Node hash");
  assert.ok(typeof node.version === "string" && /^24\.\d+\.\d+$/u.test(node.version));
  const common = { react: "19.2.3", "react-dom": "19.2.3" };
  const versions: Readonly<Record<string, string>> = role === "baseline" ? { ...common, vite: "8.1.5", rolldown: "1.1.5", "@vitejs/plugin-react": "6.0.4" }
    : { ...common, vite: "8.2.1", rolldown: "1.2.8", "@hraness/ui": "0.5.9", "@stylexjs/stylex": "0.19.0" };
  assert.ok(Array.isArray(request.packages));
  const packages = request.packages.map(value => {
    const item = exactRecord(value, ["name", "version", "manifest", "entry", "manifestSha256", "entrySha256"], "build package");
    assert.ok(typeof item.name === "string"); assert.equal(item.version, versions[item.name]);
    for (const path of [item.manifest, item.entry]) assert.ok(relativePath(path).startsWith("node_modules/"));
    digest(item.manifestSha256, 64, "manifest hash"); digest(item.entrySha256, 64, "entry hash"); return item;
  });
  assert.deepEqual(packages.map(item => item.name).sort(), Object.keys(versions).sort());
  assert.ok(Array.isArray(request.compilerModules));
  const modules = request.compilerModules.map(value => {
    const item = exactRecord(value, ["specifier", "path", "sha256"], "build compiler module");
    assert.ok(relativePath(item.path).startsWith("node_modules/")); digest(item.sha256, 64, "compiler module hash"); return item;
  });
  assert.deepEqual(modules.map(item => item.specifier), role === "baseline" ? ["@vitejs/plugin-react", "vite"]
    : ["@hraness/ui/stylex-build", "@hraness/ui/stylex-build/vite", "@hraness/ui/stylex-manifest.json", "vite"]);
  const boundary = exactRecord(receipt.boundary, ["inventory", "inventorySha256", "maps", "sources", "references"], "output boundary");
  const outputRows = parseBusyInventory(boundary.inventory);
  assert.equal(boundary.inventorySha256, sha256(JSON.stringify(outputRows)));
  assert.ok(outputRows.some(item => item.path === "native-busy/index.html"));
  assert.ok(Array.isArray(boundary.maps) && boundary.maps.length > 0);
  const maps = boundary.maps.map(value => {
    const item = exactRecord(value, ["path", "sha256"], "build map");
    const path = relativePath(item.path); assert.ok(path.endsWith(".js.map"));
    assert.equal(outputRows.find(row => row.path === path)?.sha256, digest(item.sha256, 64, "map hash")); return path;
  });
  assert.deepEqual(maps, outputRows.filter(item => /\.(?:m?js|cjs)$/u.test(item.path)).map(item => `${item.path}.map`));
  assert.ok(Array.isArray(boundary.sources) && boundary.sources.length <= 256);
  const mappedSources = boundary.sources.map(value => {
    const item = exactRecord(value, ["path", "physicalPath", "bytes", "sha256"], "mapped source");
    const path = relativePath(item.path), physicalPath = relativePath(item.physicalPath);
    assert.ok(typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= 32 * 1024 * 1024);
    const hash = digest(item.sha256, 64, "mapped source hash");
    if (path.startsWith("node_modules/")) assert.ok(physicalPath.startsWith("node_modules/"));
    else {
      assert.ok([...runtimePaths, ...(role === "current" ? [recipePath] : [])].includes(path), "foreign mapped first-party source");
      assert.equal(path, physicalPath);
      const authored = files.find(row => row.path === path); assert.ok(authored);
      assert.equal(item.bytes, authored.bytes); assert.equal(hash, authored.sha256);
    }
    return { path, physicalPath, bytes: item.bytes, sha256: hash };
  });
  assert.deepEqual(mappedSources.map(item => item.path), [...new Set(mappedSources.map(item => item.path))].sort());
  for (const path of runtimePaths) assert.ok(mappedSources.some(item => item.path === path), `missing runtime map source ${path}`);
  assert.ok(Array.isArray(boundary.references) && boundary.references.length === (role === "current" ? 3 : 2));
  for (const value of boundary.references) {
    assert.ok(typeof value === "string" && value.startsWith("/") && outputRows.some(item => item.path === relativePath(value.slice(1))));
  }
  assert.equal(new Set(boundary.references).size, boundary.references.length);
  if (role === "baseline") assert.equal(receipt.compilerEvidence, null);
  else assert.equal(boundary.references.at(-1), "/stylex.css");
  const complete = role === "baseline" ? null : assertBusyCompilerEvidence(receipt.compilerEvidence, files, outputRows);
  return { receipt, request, preparedRoot, directory, files, fixtures, original, boundary, outputRows, mappedSources, complete };
}
export function assertBusyCompilerEvidence(value: unknown, files: readonly InventoryRow[], outputRows: readonly InventoryRow[]) {
  const compiler = exactRecord(value, ["complete", "graph", "graphReceiptSource"], "compiler receipt");
  assert.ok(typeof compiler.graphReceiptSource === "string" && compiler.graphReceiptSource.length <= 8 * 1024 * 1024);
  assert.deepEqual(JSON.parse(compiler.graphReceiptSource), compiler.graph);
  const complete = exactRecord(compiler.complete, ["artifacts", "compilerSha256", "finalCss", "generationId", "graphs", "kind", "packages", "planSha256", "schemaVersion", "state", "unionPolicySha256"], "complete generation");
  assert.equal(complete.kind, "hraness-stylex-complete-generation"); assert.equal(complete.schemaVersion, 2);
  assert.equal(complete.state, "complete"); assert.equal(complete.generationId, "todo-native-busy");
  for (const key of ["compilerSha256", "planSha256", "unionPolicySha256"]) digest(complete[key], 64, key);
  assert.deepEqual(complete.graphs, [{ id: "client", receiptSha256: sha256(compiler.graphReceiptSource) }]);
  const graph = exactRecord(compiler.graph, ["adapter", "compilerSha256", "edges", "entrypoints", "generationId", "graphId", "inputs", "kind", "outputRoot", "outputs", "packages", "planSha256", "rules", "rulesSha256", "schemaVersion", "state", "target"], "graph receipt");
  assert.equal(graph.kind, "hraness-stylex-graph-receipt"); assert.equal(graph.schemaVersion, 1); assert.equal(graph.state, "complete");
  assert.equal(graph.adapter, "vite"); assert.equal(graph.target, "client"); assert.equal(graph.graphId, "client"); assert.equal(graph.generationId, "todo-native-busy");
  assert.deepEqual(graph.entrypoints, [`${prefix}native-busy/entry.tsx`]);
  assert.equal(graph.planSha256, complete.planSha256); assert.equal(graph.compilerSha256, complete.compilerSha256);
  const recipe = files.find(item => item.path === recipePath); assert.ok(recipe);
  assert.ok(Array.isArray(graph.inputs) && graph.inputs.length <= 256 && Array.isArray(graph.rules) && graph.rules.length > 0);
  const inputs = graph.inputs.map((value: unknown) => exactRecord(value, ["path", "bytes", "sha256"], "graph source input"));
  assert.deepEqual(inputs.filter(item => item.path === recipePath), [{ path: recipePath, bytes: recipe.bytes, sha256: recipe.sha256 }], "recipe must be an actual graph input");
  assert.ok(Array.isArray(complete.artifacts) && complete.artifacts.length <= 256);
  const artifacts = [...complete.artifacts, complete.finalCss].map((value: unknown) => {
    const item = exactRecord(value, ["path", "bytes", "sha256"], "complete artifact");
    return { path: relativePath(item.path), bytes: item.bytes, sha256: item.sha256 };
  });
  assert.deepEqual(artifacts.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    outputRows.filter(item => item.path !== "stylex-complete.json").map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })));
  assert.ok(outputRows.some(item => item.path === "stylex-complete.json"));
  return complete;
}
interface VerifiedBuild {
  readonly directory: string;
  readonly inventorySha256: string;
  readonly fixtureSha256: string;
  readonly originalTemplateSha256: string;
}
/** The preparation/build receipt is an explicitly hash-bound input, not an
 * inferred artifact. Rejoin its real Git source blobs and current output bytes. */
async function verifyBuild(identity: Source, role: "baseline" | "current", current: Source): Promise<VerifiedBuild> {
  assert.equal(await realpath(identity.repository), identity.repository);
  assert.equal((await git(identity.repository, "rev-parse", "HEAD")).trim(), identity.commit);
  assert.equal((await git(identity.repository, "rev-parse", "HEAD^{tree}")).trim(), identity.tree);
  assert.equal((await git(identity.repository, "status", "--porcelain=v1", "--untracked-files=all")).trim(), "", "source must be committed and clean");
  const bytes = await ordinary(identity.receiptPath);
  assert.equal(sha256(bytes), identity.receiptSha256);
  const { receipt, request, preparedRoot, directory, files, fixtures, original, outputRows, mappedSources, complete } = parseBusyBuildReceipt(JSON.parse(bytes.toString()), identity, role);
  assert.equal(await realpath(preparedRoot), preparedRoot);
  const ownedOutput = role === "current" ? join(preparedRoot, "busy-output") : null;
  if (ownedOutput !== null) {
    for (const path of [ownedOutput, dirname(directory)]) {
      assert.equal(await realpath(path), path);
      const info = await lstat(path); assert.ok(info.isDirectory() && !info.isSymbolicLink());
    }
    assert.equal(request.outputParent, ownedOutput);
    assert.deepEqual((await readdir(ownedOutput)).sort(), [basename(identity.receiptPath), basename(dirname(directory))].sort(), "unexpected retained output entry");
    assert.deepEqual(await readdir(dirname(directory)), ["todo-native-busy"], "unexpected generation sibling");
  }
  const preparedNames: string[] = [];
  let directories = 0;
  const visit = async (path: string): Promise<void> => {
    assert.ok(++directories <= 32, "prepared directory bound");
    const before = await lstat(path); assert.ok(before.isDirectory() && !before.isSymbolicLink());
    assert.equal(await realpath(path), path);
    for (const name of (await readdir(path)).sort()) {
      if (path === preparedRoot && name === "node_modules") continue;
      const target = join(path, name), logical = relative(preparedRoot, target);
      if (target === ownedOutput) continue;
      assert.ok(!name.startsWith(".") && !/^(?:credentials|secrets?|sessions?)(?:[._-]|$)/iu.test(name), "protected prepared state");
      const info = await lstat(target); assert.ok(!info.isSymbolicLink());
      if (info.isDirectory()) await visit(target);
      else { assert.ok(info.isFile() && preparedNames.length < 256); preparedNames.push(logical); }
    }
    const after = await lstat(path);
    assert.ok(before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs, "prepared directory changed");
  };
  await visit(preparedRoot);
  assert.deepEqual(preparedNames.sort(), files.map(item => item.path), "prepared source closure changed");
  for (const item of files) {
    const preparedPath = join(preparedRoot, item.path), prepared = await ordinary(preparedPath, 32 * 1024 * 1024);
    assert.equal(prepared.length, item.bytes); assert.equal(sha256(prepared), item.sha256);
    assert.equal((await lstat(preparedPath)).mode & 0o777, item.mode);
    if (item.path === templatePath) {
      const originalBytes = await ordinary(join(preparedRoot, original.path));
      assert.equal(sha256(originalBytes), original.sha256);
      assert.equal(prepared.toString("utf8"), deriveBusyTemplate(originalBytes.toString("utf8")));
      assert.equal(item.mode, 0o644); continue;
    }
    const shared = fixtures.some(row => row.path === item.path) || item.path === driverPath;
    const repository = shared ? current.repository : identity.repository;
    const commit = shared ? current.commit : identity.commit;
    const path = join(repository, item.path), sourceBytes = await ordinary(path, 32 * 1024 * 1024);
    assert.equal((await lstat(path)).mode & 0o777, item.mode);
    assertBusyGitBlob(item, sourceBytes, await git(repository, "ls-tree", commit, "--", item.path));
  }
  for (const item of mappedSources) {
    const lexical = join(preparedRoot, item.path), physical = join(preparedRoot, item.physicalPath);
    assert.equal(await realpath(lexical), physical, "mapped source resolution changed");
    const bytes = await ordinary(physical, 32 * 1024 * 1024);
    assert.equal(bytes.length, item.bytes); assert.equal(sha256(bytes), item.sha256);
  }
  if (complete !== null) {
    assert.deepEqual(JSON.parse((await ordinary(join(directory, "stylex-complete.json"))).toString()), complete, "actual output complete record changed");
  }
  const actual = await todoBuildInventory(directory);
  assert.deepEqual(actual.files, outputRows.map(row => [row.path, row.mode, row.bytes, row.sha256]));
  return { directory, inventorySha256: actual.sha256, fixtureSha256: String(receipt.fixtureSha256), originalTemplateSha256: original.sha256 };
}

async function runSource(input: BusyNativeInput, build: VerifiedBuild, role: string, directory: string, progress: string[]): Promise<Map<string, TodoAppearanceSample>> {
  const result = new Map<string, TodoAppearanceSample>();
  let number = 0, receiptBytes = 0;
  const record = async (key: string, value: unknown) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`); receiptBytes += bytes.length;
    assert.ok(bytes.length <= 1024 * 1024 && receiptBytes <= 128 * 1024 * 1024 && number < 8000, "bounded receipts required");
    await writeFile(join(directory, `${String(++number).padStart(5, "0")}-${key}.json`), bytes, { mode: 0o600, flag: "wx" });
  };
  const baseUrl = `http://127.0.0.1:${input.port}`;
  const lease = await acquireVerificationServer({ baseUrl, label: `${role} busy paint`, reuseExistingLocalServer: false,
    readinessPath: `${BUSY_PAINT_PATH}?outcome=success`, startupTimeoutMs: 10_000,
    startServer: () => spawnVerificationServer({ command: [process.execPath, nativeServer, "--serve", build.directory, String(input.port), build.inventorySha256], cwd: root, detachedProcessGroup: true, logLimit: 12_000 }) });
  // A reused lease owns no process. The public acquisition contract rejects it
  // above; never attempt to stop a foreign server if that contract changes.
  if (lease.source !== "started") throw new Error("busy proof cannot adopt a server");
  await withTodoCleanup(async () => {
    // Two finite outcome contexts per browser retain the proven command cap.
    for (let offset = 0; offset < cases.length; offset += 2) {
      const batchDirectory = join(directory, `batch-${offset / 2}`); await mkdir(batchDirectory, { mode: 0o700 });
      const batch = await createNativeBatch(input, batchDirectory, (key, value) => record(`batch-${offset / 2}-${key}`, value));
      await withTodoCleanup(async () => {
        for (const scenario of cases.slice(offset, offset + 2)) {
          const label = `${scenario.width}-${scenario.outcome}`;
          await batch.newContext(label);
          await withTodoCleanup(async () => {
            await proveBusyPaintCase(batch.browser, `${baseUrl}/`, scenario.width, scenario.outcome, async phase => {
              await assertStaticCss(batch.browser);
              const first = parseTodoAppearanceSample(await batch.browser.evaluate(sampleProgram));
              await batch.browser.evaluate(settlePaint);
              const second = parseTodoAppearanceSample(await batch.browser.evaluate(sampleProgram));
              assertTodoStable(first, second);
              const key = `${label}/${phase}`; assert.ok(!result.has(key)); result.set(key, second);
              await record(`${label}-${phase}-sample`, second);
              const path = join(batchDirectory, `${label}-${phase}.png`);
              await batch.browser.run(["screenshot", path]);
              const image = await ordinary(path); receiptBytes += image.length;
              assert.ok(receiptBytes <= 128 * 1024 * 1024);
              await record(`${label}-${phase}-screenshot`, { file: basename(path), bytes: image.length, sha256: sha256(image) });
              progress.push(key);
            });
            const errors = exactRecord(await batch.browser.run(["errors"]), ["errors"], "busy browser errors");
            assert.deepEqual(errors.errors, []); await record(`${label}-errors`, errors);
            const console = await batch.browser.run(["console"]); assertTodoConsole(console); await record(`${label}-console`, console);
          }, () => batch.parkContext());
        }
      }, () => batch.close());
    }
    assert.deepEqual([...result.keys()], expectedSamples, "complete pending/settled sample census required");
    const response = await fetch(`${baseUrl}/__todo_native_receipt`, { signal: AbortSignal.timeout(1500) });
    assert.equal(response.status, 200);
    const receipt = exactRecord(await response.json(), ["inventorySha256", "requests", "denied"], "busy server receipt");
    assert.equal(receipt.inventorySha256, build.inventorySha256); assert.deepEqual(receipt.denied, []); await record("server", receipt);
  }, async () => {
    await withTodoCleanup(() => stopVerificationServer(lease.server, 5000), async () => {
      const responding = await fetch(`${baseUrl}/__todo_native_receipt`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
      const output = lease.server.outputSnapshot?.();
      const exited = lease.server.exitCode() !== undefined && lease.server.exitCode() !== null;
      await record("server-close", { exited, responding, output });
      assert.ok(exited && !responding && output?.stdout.state === "eof" && output.stderr.state === "eof", "owned server collection incomplete");
    });
  });
  assert.equal((await todoBuildInventory(build.directory)).sha256, build.inventorySha256);
  return result;
}

export async function runBusyNative(input: BusyNativeInput): Promise<string> {
  input = parseBusyNativeInput(input);
  assert.equal(Bun.version, "1.3.14");
  assert.equal(input.current.repository, root, "run the committed current-source verifier");
  assert.equal(basename(input.browser.driver), `agent-browser-${process.platform}-${process.arch}`);
  assert.equal(sha256(await ordinary(input.browser.driver, 128 * 1024 * 1024)), input.browser.driverSha256);
  assert.equal(sha256(await ordinary(input.browser.executable, 256 * 1024 * 1024)), input.browser.executableSha256);
  assert.equal((await runVerificationCommand({ command: [input.browser.driver, "--version"], cwd: root, label: "busy driver version", timeoutMs: 5000 })).trim(), "agent-browser 0.32.3");
  assert.ok((await runVerificationCommand({ command: [input.browser.executable, "--version"], cwd: root, label: "busy browser version", timeoutMs: 5000 })).trim().endsWith(input.browser.version));
  const baseline = await verifyBuild(input.baseline, "baseline", input.current), current = await verifyBuild(input.current, "current", input.current);
  assert.equal(current.fixtureSha256, baseline.fixtureSha256); assert.equal(current.originalTemplateSha256, baseline.originalTemplateSha256);
  assert.ok(baseline.directory !== current.directory && !inside(baseline.directory, current.directory) && !inside(current.directory, baseline.directory));
  for (const path of [baseline.directory, current.directory, input.baseline.repository, input.current.repository]) {
    assert.ok(input.artifactParent !== path && !inside(path, input.artifactParent), "proof output must not mutate a sealed input");
  }
  assert.equal(await realpath(input.artifactParent), input.artifactParent);
  const directory = await mkdtemp(join(input.artifactParent, "todo-busy-native-")); await chmod(directory, 0o700);
  await writeFile(join(directory, "input.json"), `${JSON.stringify(input)}\n`, { mode: 0o600, flag: "wx" });
  let accepted = false, failure: string | null = null;
  const observed = { baseline: [] as string[], current: [] as string[] };
  const differences: ReturnType<typeof compareTodoAppearance> = [];
  return withTodoCleanup(async () => { try {
    const beforeDirectory = join(directory, "before"), afterDirectory = join(directory, "after");
    await mkdir(beforeDirectory, { mode: 0o700 }); await mkdir(afterDirectory, { mode: 0o700 });
    const before = await runSource(input, baseline, "baseline", beforeDirectory, observed.baseline), after = await runSource(input, current, "current", afterDirectory, observed.current);
    assert.deepEqual([...before.keys()], expectedSamples); assert.deepEqual([...after.keys()], expectedSamples);
    for (const key of expectedSamples) { const a = before.get(key), b = after.get(key); assert.ok(a && b); differences.push(...compareTodoAppearance(key, a, b)); }
    assert.deepEqual(differences, [], "native busy-state appearance differs from its independently built baseline");
    assert.deepEqual(await verifyBuild(input.baseline, "baseline", input.current), baseline);
    assert.deepEqual(await verifyBuild(input.current, "current", input.current), current);
    accepted = true; return directory;
  } catch (error) { failure = todoFailureText(error); throw error; } }, async () => {
    await writeFile(join(directory, "receipt.json"), `${JSON.stringify({ schema, accepted, failure, browser: input.browser.version,
      inputs: { baseline: input.baseline.receiptSha256, current: input.current.receiptSha256 }, expectedSamples, observedSamples: observed, differences,
      limits: ["standalone real TodoApp with controlled promises, not production persistence timing", "does not establish workbench pending-state geometry", "original ordinary/focus/stylesheet negative-control suite remains independently required", "screenshots retained; comparison uses named geometry and exact computed presentation"] })}\n`, { mode: 0o600, flag: "wx" });
  });
}
if (import.meta.main) {
  assert.equal(process.argv.length, 4, "Pass one private input path and its exact SHA-256");
  const path = absolutePath(process.argv[2], "input path"), expected = digest(process.argv[3], 64, "input hash");
  const bytes = await ordinary(path, 64 * 1024); assert.equal(sha256(bytes), expected);
  console.log(await runBusyNative(parseBusyNativeInput(JSON.parse(bytes.toString()))));
}
