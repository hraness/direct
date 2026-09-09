// Verification-only compiler for Direct's StyleX native busy-state acceptance.
// Importing this module never builds or writes.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

export const BUSY_BUILD_SCHEMA = "direct.todo-busy-build/v1";
export const BUSY_HTML = "native-busy/index.html";
const PREFIX = "examples/todos/";
const ENTRY = `${PREFIX}native-busy/entry.tsx`;
const DRIVER = `${PREFIX}native-busy/build-busy.mjs`;
const RECIPE = `${PREFIX}src/todo.stylex.ts`;
const RUNTIME = ["src/TodoApp.tsx", "src/todo-port.ts", "native-busy/entry.tsx", "native-busy/controlled-port.ts"].map((path) => PREFIX + path);
const FIXTURE = ["controlled-port.test.ts", "controlled-port.ts", "entry.tsx"].map((path) => `${PREFIX}native-busy/${path}`).sort();
const ORIGINAL_SCRIPT = '<script type="module" src="/src/main.tsx"></script>';
const FIXTURE_SCRIPT = '<script type="module" src="/native-busy/entry.tsx"></script>';
const GENERATION = "todo-native-busy";
// The qualified Node 24 executable is approximately 121 MB on macOS.
const MAX_FILE = 128 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const FORBIDDEN = ["@hraness/direct", "direct.browser-bridge/v", "direct.coverage/v", "direct.fixture/v", "direct.probe/v", "direct.runtime/v", "direct.session-manifest/v", "__direct", "Direct blocked an unmapped network request.", "Todo Direct"];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const busySha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function record(value, keys, label) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: object required`);
  assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)), `${label}: plain object required`);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort(), `${label}: exact fields required`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(descriptor && "value" in descriptor && descriptor.enumerable, `${label}: ordinary fields required`);
  }
  return value;
}
function digest(value, length = 64) {
  assert.ok(typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value), "exact digest required");
  return value;
}
export function busyRelativePath(value) {
  assert.ok(typeof value === "string" && value.length < 2048 && /^[A-Za-z0-9_@()[\]./-]+$/u.test(value), "finite relative path required");
  assert.ok(!value.startsWith("/") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "relative path escape");
  return value;
}
function absolute(value) {
  assert.ok(typeof value === "string" && isAbsolute(value) && value !== "/" && value.length < 4096 && !/[\0\r\n]/u.test(value));
  assert.equal(resolve(value), value, "canonical absolute path required");
  return value;
}
function inside(root, path) {
  const logical = relative(root, path);
  return logical !== "" && !isAbsolute(logical) && logical !== ".." && !logical.startsWith("../");
}
function realDirectory(path) {
  absolute(path);
  assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), "ordinary directory required");
  assert.equal(realpathSync(path), path, "directory link traversal forbidden");
  return path;
}
function identity(info) {
  return [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.size, info.mtimeMs, info.ctimeMs];
}
export function busyOrdinaryBytes(path) {
  absolute(path);
  assert.equal(realpathSync(path), path, "file link traversal forbidden");
  const initial = lstatSync(path);
  assert.ok(initial.isFile() && initial.size <= MAX_FILE, "bounded ordinary file required before open");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    assert.deepEqual(identity(before), identity(initial), "file replaced before open");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert.ok(count > 0, "file truncated during read");
      offset += count;
    }
    assert.equal(readSync(fd, Buffer.alloc(1), 0, 1, offset), 0, "file grew during read");
    assert.deepEqual(identity(fstatSync(fd)), identity(before), "file changed during read");
    assert.deepEqual(identity(lstatSync(path)), identity(before), "path replaced during read");
    assert.equal(realpathSync(path), path);
    return bytes;
  } finally { closeSync(fd); }
}
function json(path) { return JSON.parse(busyOrdinaryBytes(path).toString("utf8")); }
function missing(path) {
  try { lstatSync(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Receipt/output already exists; overwriting is forbidden");
}
function row(path, root) {
  const bytes = busyOrdinaryBytes(join(root, path));
  return { path, mode: lstatSync(join(root, path)).mode & 0o777, bytes: bytes.length, sha256: busySha256(bytes) };
}
export function parseBusyInventory(value) {
  assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 20_000, "bounded nonempty inventory required");
  const rows = value.map((entry) => {
    const item = record(entry, ["path", "mode", "bytes", "sha256"], "inventory row");
    busyRelativePath(item.path);
    assert.ok(Number.isSafeInteger(item.mode) && item.mode >= 0 && item.mode <= 0o777);
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= MAX_FILE);
    digest(item.sha256);
    return { ...item };
  });
  assert.deepEqual(rows.map((item) => item.path), [...new Set(rows.map((item) => item.path))].sort(compare), "unique sorted inventory required");
  assert.ok(rows.reduce((total, item) => total + item.bytes, 0) <= MAX_TOTAL, "inventory exceeds total bound");
  return rows;
}
function walk(root, excludeDependencies, ownedOutput = null) {
  realDirectory(root);
  const files = [];
  const visit = (logical) => {
    if (excludeDependencies && logical === "node_modules") return;
    if (ownedOutput !== null && join(root, logical) === ownedOutput) { realDirectory(ownedOutput); return; }
    busyRelativePath(logical);
    // Reject before reading or traversing hidden/provider/session source state.
    if (excludeDependencies) assert.ok(logical.split("/").every((part) => !part.startsWith(".") && !/^(?:credentials|secrets?|sessions?)(?:[._-]|$)/iu.test(part)), "protected state in prepared source");
    const path = join(root, logical);
    const info = lstatSync(path);
    assert.ok(!info.isSymbolicLink(), "inventory symlinks forbidden");
    if (info.isDirectory()) {
      realDirectory(path);
      for (const name of readdirSync(path).sort(compare)) visit(`${logical}/${name}`);
    } else {
      assert.ok(info.isFile(), "special inventory file forbidden");
      assert.ok(files.length < 20_000, "inventory file bound");
      files.push(logical);
    }
  };
  for (const name of readdirSync(root).sort(compare)) visit(name);
  return files.sort(compare);
}
export function checkBusyPreparedSource(input, outputLeaf = null) {
  const ownedOutput = input.role === "current" ? input.outputParent : null;
  if (ownedOutput !== null) {
    assert.equal(ownedOutput, join(input.root, "busy-output"), "one reserved in-root output parent required");
    realDirectory(ownedOutput);
    assert.deepEqual(readdirSync(ownedOutput).sort(compare), outputLeaf === null ? [] : [basename(outputLeaf)], "unexpected prepared output entry");
    if (outputLeaf !== null) {
      assert.equal(dirname(outputLeaf), ownedOutput);
      assert.match(basename(outputLeaf), /^todo-busy-current-[A-Za-z0-9]+$/u);
      realDirectory(outputLeaf);
      assert.deepEqual(readdirSync(outputLeaf), [GENERATION], "only the finalized generation may remain");
      realDirectory(join(outputLeaf, GENERATION));
    }
  }
  const names = walk(input.root, true, ownedOutput);
  assert.deepEqual(names, input.sourceFiles.map((item) => item.path), "prepared source additions/removals");
  const observed = names.map((path) => row(path, input.root));
  assert.deepEqual(observed, input.sourceFiles, "prepared source byte/mode drift");
  return observed;
}
export function deriveBusyHtml(original) {
  assert.equal(typeof original, "string");
  assert.equal(original.split(ORIGINAL_SCRIPT).length, 2, "exact original entry cardinality");
  assert.equal(original.split("</head>").length, 2, "exact original head cardinality");
  assert.ok(!original.includes(FIXTURE_SCRIPT), "fixture entry already present");
  return original.replace(ORIGINAL_SCRIPT, FIXTURE_SCRIPT);
}
export function renderBusyHtml(source, entry, stylesheet, placeholder) {
  busyRelativePath(entry); busyRelativePath(stylesheet);
  assert.equal(source.split(FIXTURE_SCRIPT).length, 2);
  assert.equal(source.split("</head>").length, 2);
  assert.equal(placeholder, "__HRANESS_STYLEX_CSS__");
  assert.ok(!source.includes(placeholder));
  return source.replace(FIXTURE_SCRIPT, `<script type="module" src="/graphs/client/${entry}"></script>`)
    .replace("</head>", `<link rel="stylesheet" href="/graphs/client/${stylesheet}">\n    <link rel="stylesheet" href="${placeholder}">\n  </head>`);
}
export function finiteBusyOutputs(result) {
  assert.ok(result && !Array.isArray(result) && Array.isArray(result.output), "one finite output result required");
  const entries = result.output.filter((item) => item.type === "chunk" && item.isEntry === true);
  const styles = result.output.filter((item) => item.type === "asset" && typeof item.fileName === "string" && item.fileName.endsWith(".css"));
  assert.equal(entries.length, 1); assert.equal(styles.length, 1);
  const [entry] = entries, [stylesheet] = styles;
  assert.ok(entry && stylesheet);
  return { entry: busyRelativePath(entry.fileName), stylesheet: busyRelativePath(stylesheet.fileName) };
}
export function expectedBusyPackages(role) {
  assert.ok(role === "baseline" || role === "current");
  const common = { react: "19.2.3", "react-dom": "19.2.3" };
  return role === "baseline" ? { ...common, vite: "8.1.5", rolldown: "1.1.5", "@vitejs/plugin-react": "6.0.4" }
    : { ...common, vite: "8.2.1", rolldown: "1.2.8", "@hraness/ui": "0.5.9", "@stylexjs/stylex": "0.19.0" };
}
export function expectedBusyCompilerModules(role) {
  expectedBusyPackages(role);
  return role === "baseline" ? ["@vitejs/plugin-react", "vite"]
    : ["@hraness/ui/stylex-build", "@hraness/ui/stylex-build/vite", "@hraness/ui/stylex-manifest.json", "vite"];
}
export function parseBusyBuildInput(value) {
  const input = record(value, ["schema", "role", "root", "sourceCommit", "sourceTree", "sourceFiles", "fixtureFiles", "originalTemplateSha256", "node", "packages", "compilerModules", "outputParent", "receiptPath"], "busy build request");
  assert.equal(input.schema, BUSY_BUILD_SCHEMA);
  expectedBusyPackages(input.role);
  absolute(input.root); absolute(input.outputParent); absolute(input.receiptPath);
  if (input.role === "current") assert.equal(input.outputParent, join(input.root, "busy-output"), "Vite maps require the reserved in-root publication parent");
  else assert.ok(!inside(input.root, input.outputParent) && !inside(input.outputParent, input.root) && input.root !== input.outputParent, "baseline output parent must be separate from source");
  assert.equal(dirname(input.receiptPath), input.outputParent, "receipt must be a direct child of approved output parent");
  digest(input.sourceCommit, 40); digest(input.sourceTree, 40); digest(input.originalTemplateSha256);
  const sourceFiles = parseBusyInventory(input.sourceFiles), fixtureFiles = parseBusyInventory(input.fixtureFiles);
  assert.ok(sourceFiles.every(item => item.path !== "busy-output" && !item.path.startsWith("busy-output/")), "output cannot be an authored source");
  assert.deepEqual(fixtureFiles.map((item) => item.path), FIXTURE, "exact three reviewed fixture files required");
  assert.deepEqual(sourceFiles.filter((item) => FIXTURE.includes(item.path)), fixtureFiles, "shared fixture bytes/modes must match prepared source");
  for (const path of ["package.json", "bun.lock", DRIVER, `${PREFIX}index.html`, `${PREFIX}${BUSY_HTML}`, `${PREFIX}src/styles.css`, ...RUNTIME, ...(input.role === "current" ? [RECIPE] : [])]) {
    assert.equal(sourceFiles.filter((item) => item.path === path).length, 1, `missing prepared input: ${path}`);
  }
  const node = record(input.node, ["path", "version", "sha256"], "Node identity");
  absolute(node.path); digest(node.sha256); assert.match(node.version, /^24\.\d+\.\d+$/u);
  const versions = expectedBusyPackages(input.role);
  assert.ok(Array.isArray(input.packages));
  assert.deepEqual(input.packages.map((item) => item.name).sort(compare), Object.keys(versions).sort(compare), "exact compiler package set required");
  for (const item of input.packages) {
    record(item, ["name", "version", "manifest", "entry", "manifestSha256", "entrySha256"], "package identity");
    assert.equal(item.version, versions[item.name]);
    for (const path of [item.manifest, item.entry]) assert.ok(busyRelativePath(path).startsWith("node_modules/"), "package identity must remain installed in this snapshot");
    digest(item.manifestSha256); digest(item.entrySha256);
  }
  assert.ok(Array.isArray(input.compilerModules));
  assert.deepEqual(input.compilerModules.map((item) => item.specifier), expectedBusyCompilerModules(input.role));
  for (const item of input.compilerModules) {
    record(item, ["specifier", "path", "sha256"], "public compiler module identity");
    assert.ok(busyRelativePath(item.path).startsWith("node_modules/")); digest(item.sha256);
  }
  return { ...input, sourceFiles, fixtureFiles };
}
function checkToolchain(input) {
  assert.equal(typeof globalThis.Bun, "undefined", "compiler requires genuine Node");
  assert.equal(process.versions.node, input.node.version);
  assert.equal(realpathSync(process.execPath), input.node.path);
  assert.equal(busySha256(busyOrdinaryBytes(input.node.path)), input.node.sha256);
  const dependencies = realDirectory(join(input.root, "node_modules"));
  const resolved = {};
  for (const item of input.packages) {
    // This exact copied driver lives below the prepared root. ESM resolution
    // is required: UI's public compiler exports deliberately have no require
    // condition. No parent/sibling dependency fallback is accepted below.
    const entry = realpathSync(fileURLToPath(import.meta.resolve(item.name)));
    assert.ok(inside(dependencies, entry), "compiler resolved outside prepared installation");
    assert.equal(relative(input.root, entry), item.entry);
    const manifest = join(input.root, item.manifest);
    assert.ok(inside(dependencies, realpathSync(manifest)));
    const bytes = busyOrdinaryBytes(manifest), metadata = JSON.parse(bytes.toString("utf8"));
    assert.equal(metadata.name, item.name); assert.equal(metadata.version, item.version);
    assert.equal(busySha256(bytes), item.manifestSha256);
    assert.equal(busySha256(busyOrdinaryBytes(entry)), item.entrySha256);
    // Resolve the nearest package owner, not an unrelated identically named manifest.
    let owner = dirname(entry);
    while (inside(dependencies, owner)) {
      try { lstatSync(join(owner, "package.json")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; owner = dirname(owner); }
    }
    assert.equal(join(owner, "package.json"), manifest, "entry/manifest owner mismatch");
    resolved[item.name] = entry;
  }
  const modules = {};
  for (const item of input.compilerModules) {
    const path = realpathSync(fileURLToPath(import.meta.resolve(item.specifier)));
    assert.ok(inside(dependencies, path)); assert.equal(relative(input.root, path), item.path);
    assert.equal(busySha256(busyOrdinaryBytes(path)), item.sha256);
    modules[item.specifier] = path;
  }
  return { resolved, modules };
}
export function resolveBusyMapSource(root, mapPath, source, sourceRoot = "") {
  assert.ok(typeof source === "string" && source.length > 0 && source.length < 4096 && !/[\0\\?#]/u.test(source));
  assert.ok(sourceRoot === "" || sourceRoot === undefined, "unqualified map sourceRoot");
  let absoluteSource;
  if (source.startsWith("file:")) {
    const url = new URL(source); assert.equal(url.search, ""); assert.equal(url.hash, "");
    absoluteSource = fileURLToPath(url);
  } else {
    assert.ok(!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source), "remote/virtual map source forbidden");
    absoluteSource = resolve(dirname(mapPath), source);
  }
  assert.ok(inside(root, absoluteSource), "mapped source escapes prepared tree");
  return relative(root, absoluteSource);
}
export function assertBusyMapClosure(sources, role) {
  assert.ok(Array.isArray(sources) && sources.length > 0);
  const allowed = new Set([...RUNTIME, `${PREFIX}src/styles.css`, `${PREFIX}${BUSY_HTML}`, ...(role === "current" ? [RECIPE] : [])]);
  for (const source of sources) assert.ok(busyRelativePath(source).startsWith("node_modules/") || allowed.has(source), `foreign first-party source: ${source}`);
  for (const path of RUNTIME) assert.ok(sources.includes(path), `missing actual runtime source: ${path}`);
}
export function busyMapReference(executable, filename) {
  const matches = [...executable.matchAll(/\/\/[#@]\s*sourceMappingURL=([^\r\n]+)/gu)];
  assert.equal(matches.length, 1, "exactly one external source map reference required");
  const [match] = matches;
  assert.ok(match && match[1] === `${basename(filename)}.map`, "incorrect adjacent external source map");
  return `${filename}.map`;
}
export function assertBusyRecipeReceipt(receipt, expectedArtifact) {
  assert.equal(receipt.kind, "hraness-stylex-graph-receipt"); assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.state, "complete"); assert.equal(receipt.adapter, "vite"); assert.equal(receipt.target, "client");
  assert.equal(receipt.graphId, "client"); assert.equal(receipt.generationId, GENERATION);
  assert.deepEqual(receipt.entrypoints, [ENTRY]);
  assert.ok(Array.isArray(receipt.inputs) && Array.isArray(receipt.rules) && receipt.rules.length > 0);
  assert.deepEqual(receipt.inputs.filter((item) => item.path === RECIPE), [{ path: RECIPE, bytes: expectedArtifact.bytes, sha256: expectedArtifact.sha256 }], "actual recipe compiler membership required");
}
export function busyHtmlReferences(html, outputPaths, role) {
  assert.ok(!/<style\b|\sstyle\s*=/iu.test(html), "fixture must not introduce inline style");
  const references = [];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)];
  assert.equal(scripts.length, 1, "one compiled fixture entry required");
  for (const [, attributes, body] of scripts) {
    assert.equal(body.trim(), ""); assert.match(attributes, /\btype="module"/u);
    const match = /\bsrc="([^"]+)"/u.exec(attributes); assert.ok(match); references.push(match[1]);
  }
  const styles = [...html.matchAll(/<link\b([^>]*)>/giu)].filter(([, attributes]) => /\brel="stylesheet"/u.test(attributes));
  assert.equal(styles.length, role === "current" ? 2 : 1);
  for (const [, attributes] of styles) {
    const match = /\bhref="([^"]+)"/u.exec(attributes); assert.ok(match); references.push(match[1]);
  }
  for (const url of references) {
    assert.ok(typeof url === "string" && url.startsWith("/") && !url.startsWith("//"));
    const logical = busyRelativePath(url.slice(1));
    assert.ok(outputPaths.includes(logical), "HTML reference absent from sealed output");
  }
  if (role === "current") assert.equal(references.at(-1), "/stylex.css", "foundation must precede finalized union");
  return references;
}
function scanOutput(input, output) {
  const names = walk(output, false);
  const inventory = names.map((path) => row(path, output));
  parseBusyInventory(inventory);
  assert.ok(names.includes(BUSY_HTML));
  const scripts = names.filter((path) => /\.(?:m?js|cjs)$/u.test(path));
  assert.ok(scripts.length > 0, "nonempty executable inventory required");
  const sources = new Set(), contents = [], mapRecords = [];
  for (const script of scripts) {
    const code = busyOrdinaryBytes(join(output, script)).toString("utf8"); contents.push(code);
    const mapName = busyMapReference(code, script); assert.ok(names.includes(mapName));
    const map = json(join(output, mapName));
    assert.equal(map.version, 3); assert.ok(Array.isArray(map.sources) && map.sources.length > 0 && map.sources.length <= 20_000);
    assert.ok(Array.isArray(map.sourcesContent) && map.sourcesContent.length === map.sources.length);
    assert.ok(typeof map.mappings === "string" && map.mappings.length > 0);
    for (const source of map.sources) sources.add(resolveBusyMapSource(input.root, join(output, mapName), source, map.sourceRoot));
    mapRecords.push({ path: mapName, sha256: busySha256(busyOrdinaryBytes(join(output, mapName))) });
  }
  const observed = [...sources].sort(compare); assertBusyMapClosure(observed, input.role);
  const sourceIdentities = observed.map((path) => {
    const lexical = join(input.root, path), physical = realpathSync(lexical);
    assert.ok(inside(input.root, physical));
    if (path.startsWith("node_modules/")) assert.ok(inside(join(input.root, "node_modules"), physical));
    else assert.equal(physical, lexical);
    const bytes = busyOrdinaryBytes(physical);
    return { path, physicalPath: relative(input.root, physical), bytes: bytes.length, sha256: busySha256(bytes) };
  });
  for (const marker of ["todo.busy-paint-fixture/v1", "__todoBusyFixture"]) assert.ok(contents.some((code) => code.includes(marker)), "missing executable fixture identity");
  for (const marker of FORBIDDEN) assert.ok(contents.every((code) => !code.includes(marker)), `foreign executable marker: ${marker}`);
  const references = busyHtmlReferences(busyOrdinaryBytes(join(output, BUSY_HTML)).toString("utf8"), names, input.role);
  return { inventory, inventorySha256: busySha256(JSON.stringify(inventory)), maps: mapRecords, sources: sourceIdentities, references };
}
export async function writeBusyReceipt(path, value) {
  missing(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

/** Source provenance belongs to the preparation owner. This driver verifies the
 * exact prepared bytes, never treats a declared commit as Git provenance. */
export async function buildBusy(value) {
  const input = parseBusyBuildInput(value);
  realDirectory(input.root); realDirectory(input.outputParent); missing(input.receiptPath);
  assert.equal(fileURLToPath(import.meta.url), join(input.root, DRIVER), "run the identical copied driver in its prepared snapshot");
  const before = checkBusyPreparedSource(input), toolchain = checkToolchain(input);
  const original = busyOrdinaryBytes(join(input.root, PREFIX, "index.html")).toString("utf8");
  assert.equal(busySha256(original), input.originalTemplateSha256, "baseline/current original document identity must match");
  const template = busyOrdinaryBytes(join(input.root, PREFIX, BUSY_HTML)).toString("utf8");
  assert.equal(template, deriveBusyHtml(original));
  const outputParent = realDirectory(await mkdtemp(join(input.outputParent, `todo-busy-${input.role}-`)));
  assert.deepEqual(readdirSync(outputParent), []);
  // No fallback/cleanup on a compiler red: this exact fresh root remains evidence.
  console.log(JSON.stringify({ kind: "todo-busy-build-started", role: input.role, outputParent }));
  const vite = await import(pathToFileURL(toolchain.resolved.vite).href);
  assert.equal(vite.version, expectedBusyPackages(input.role).vite);
  let output, compilerEvidence = null;
  if (input.role === "baseline") {
    const { default: react } = await import(pathToFileURL(toolchain.resolved["@vitejs/plugin-react"]).href);
    await vite.build({ configFile: false, root: join(input.root, PREFIX), plugins: [react()],
      build: { outDir: outputParent, sourcemap: true, rollupOptions: { input: join(input.root, PREFIX, BUSY_HTML) } } });
    output = outputParent;
  } else {
    const resolveUi = (specifier) => {
      const path = toolchain.modules[specifier]; assert.ok(typeof path === "string");
      const ui = input.packages.find((item) => item.name === "@hraness/ui"); assert.ok(ui);
      assert.ok(inside(dirname(join(input.root, ui.manifest)), path), "public UI export escaped its exact installation");
      return path;
    };
    const api = await import(pathToFileURL(resolveUi("@hraness/ui/stylex-build")).href);
    const { stylexVite } = await import(pathToFileURL(resolveUi("@hraness/ui/stylex-build/vite")).href);
    const manifestPath = resolveUi("@hraness/ui/stylex-manifest.json");
    const packageManifest = await api.readStylexPackageManifest(manifestPath);
    const generation = await api.createStylexGeneration({ generationId: GENERATION, outputDirectory: outputParent, rootDirectory: input.root,
      expectedGraphs: [{ adapter: "vite", id: "client", kind: "client", entrypoints: [ENTRY] }],
      packageManifests: [pathToFileURL(manifestPath).href],
      templates: [{ cssHref: "/stylex.css", graphId: "client", stylesheetGraphId: "client", outputPath: BUSY_HTML, sourcePath: `${PREFIX}${BUSY_HTML}` }] });
    const result = await vite.build({ configFile: false, logLevel: "silent", build: { minify: true, target: "es2022" },
      plugins: [stylexVite({ generation, graphId: "client", rootDirectory: input.root, sourceMaps: "external" })] });
    const outputs = finiteBusyOutputs(result);
    const produced = await api.prepareStylexProducedTemplate(generation, BUSY_HTML);
    await writeFile(produced.sourcePath, renderBusyHtml(template, outputs.entry, outputs.stylesheet, api.STYLEX_TEMPLATE_CSS_PLACEHOLDER), { flag: "wx" });
    assert.equal(busyOrdinaryBytes(join(input.root, PREFIX, BUSY_HTML)).toString("utf8"), template);
    await api.sealStylexProducedTemplate(generation, BUSY_HTML);
    // Public v1 receipt data, not a private implementation import. Keep these
    // bytes in the success receipt before normal finalization removes staging.
    const receiptBytes = busyOrdinaryBytes(join(generation.directory, ".stylex-generation/receipts/client.json"));
    const graph = JSON.parse(receiptBytes.toString("utf8"));
    const recipe = input.sourceFiles.find((item) => item.path === RECIPE); assert.ok(recipe);
    assertBusyRecipeReceipt(graph, recipe);
    output = await api.finalizeStylexGeneration({ generation, outputDirectory: outputParent, rootDirectory: input.root });
    const complete = json(join(output, "stylex-complete.json"));
    assert.equal(complete.state, "complete"); assert.equal(complete.generationId, GENERATION);
    assert.equal(complete.compilerSha256, api.compilerSha256); assert.equal(graph.compilerSha256, api.compilerSha256);
    assert.equal(complete.planSha256, generation.planSha256); assert.equal(graph.planSha256, generation.planSha256);
    assert.deepEqual(complete.graphs, [{ id: "client", receiptSha256: busySha256(receiptBytes) }]);
    const css = busyOrdinaryBytes(join(output, "stylex.css")).toString("utf8");
    assert.equal(busySha256(css), complete.finalCss.sha256);
    assert.equal(css, api.serializeStylexRuleUnionV1([...packageManifest.rules, ...graph.rules], [packageManifest.standaloneSerializer]),
      "final CSS must be the exact public serialization of the recipe-bearing graph and immutable package");
    compilerEvidence = { complete, graph, graphReceiptSource: receiptBytes.toString("utf8") };
  }
  realDirectory(output);
  const boundary = scanOutput(input, output);
  if (compilerEvidence !== null) {
    const complete = compilerEvidence.complete;
    assert.deepEqual(boundary.inventory.filter((item) => item.path !== "stylex-complete.json")
      .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    [...complete.artifacts, complete.finalCss].sort((a, b) => compare(a.path, b.path)), "final complete artifact inventory drift");
  }
  const after = checkBusyPreparedSource(input, outputParent); assert.deepEqual(after, before);
  checkToolchain(input);
  for (const source of boundary.sources) {
    assert.equal(relative(input.root, realpathSync(join(input.root, source.path))), source.physicalPath, "mapped dependency resolution changed");
    assert.equal(busySha256(busyOrdinaryBytes(join(input.root, source.physicalPath))), source.sha256, "mapped source/dependency bytes changed");
  }
  assert.deepEqual(walk(output, false).map((path) => row(path, output)), boundary.inventory, "public output changed during proof");
  const receipt = { schema: BUSY_BUILD_SCHEMA, state: "complete", role: input.role, request: input,
    preparationProvenance: "source commit/tree declared by preparation owner; independently bound source bytes verified here",
    output, sourceBeforeSha256: busySha256(JSON.stringify(before)), sourceAfterSha256: busySha256(JSON.stringify(after)),
    fixtureSha256: busySha256(JSON.stringify(input.fixtureFiles)), compilerEvidence, boundary,
    limits: ["compilation only, not native busy paint", "standalone TodoApp, not workbench busy layout", "controlled port, not production persistence timing"] };
  await writeBusyReceipt(input.receiptPath, receipt);
  return receipt;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, "Usage: node build-busy.mjs /absolute/request.json exact-request-sha256");
  const bytes = busyOrdinaryBytes(absolute(process.argv[2]));
  assert.equal(busySha256(bytes), digest(process.argv[3]), "request changed after preparation review");
  const receipt = await buildBusy(JSON.parse(bytes.toString("utf8")));
  console.log(JSON.stringify({ kind: "todo-busy-build-complete", role: receipt.role, output: receipt.output }));
}
