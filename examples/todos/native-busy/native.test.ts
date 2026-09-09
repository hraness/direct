import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fc from "fast-check";
import { assertBusyCompilerEvidence, assertBusyGitBlob, deriveBusyTemplate, parseBusyBuildReceipt, parseBusyInventory, parseBusyNativeInput } from "./native.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sha = "a".repeat(64);
const baseline = { repository: "/source/baseline", commit: "1".repeat(40), tree: "2".repeat(40), receiptPath: "/outputs/baseline/build-receipt.json", receiptSha256: sha };
const current = { repository: "/source/current", commit: "3".repeat(40), tree: "4".repeat(40), receiptPath: "/prepared/current/busy-output/build-receipt.json", receiptSha256: sha };
const input = { schema: "direct.todo-busy-native/v1" as const, baseline, current, browser: { driver: "/tools/agent-browser-darwin-arm64", driverSha256: sha,
  executable: "/tools/Chrome", executableSha256: sha, version: "151.0.7922.34" }, artifactParent: "/proofs", port: 52927 };
const fixturePaths = ["controlled-port.test.ts", "controlled-port.ts", "entry.tsx"].map(path => `examples/todos/native-busy/${path}`);
const runtimePaths = ["native-busy/controlled-port.ts", "native-busy/entry.tsx", "src/TodoApp.tsx", "src/todo-port.ts"].map(path => `examples/todos/${path}`);
const recipePath = "examples/todos/src/todo.stylex.ts";
const row = (path: string) => ({ path, mode: 0o644, bytes: 1, sha256: sha });
const sortRows = <T extends { path: string }>(rows: T[]) => rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function build(role: "baseline" | "current") {
  const identity = role === "baseline" ? baseline : current;
  const files = sortRows([...new Set(["bun.lock", "package.json", "tsconfig.json", "examples/todos/tsconfig.json", "examples/todos/index.html", "examples/todos/src/styles.css",
    "examples/todos/native-busy/index.html", "examples/todos/native-busy/build-busy.mjs", ...runtimePaths, ...fixturePaths, ...(role === "current" ? [recipePath] : [])])].map(row));
  const fixtures = fixturePaths.map(row);
  const outputRows = sortRows(["assets/index.js", "assets/index.js.map", "assets/index.css", "native-busy/index.html", ...(role === "current" ? ["stylex.css", "stylex-complete.json"] : [])].map(row));
  const common = { react: "19.2.3", "react-dom": "19.2.3" };
  const versions = role === "baseline" ? { ...common, vite: "8.1.5", rolldown: "1.1.5", "@vitejs/plugin-react": "6.0.4" }
    : { ...common, vite: "8.2.1", rolldown: "1.2.8", "@hraness/ui": "0.5.9", "@stylexjs/stylex": "0.19.0" };
  const graph = { kind: "hraness-stylex-graph-receipt", schemaVersion: 1, state: "complete", adapter: "vite", target: "client", graphId: "client", generationId: "todo-native-busy",
    entrypoints: ["examples/todos/native-busy/entry.tsx"], inputs: [{ path: recipePath, bytes: 1, sha256: sha }], rules: [["x", { ltr: ".x{color:red}" }, 1]],
    planSha256: sha, compilerSha256: sha, edges: [], outputRoot: "graphs/client", outputs: [], packages: [], rulesSha256: sha };
  const graphReceiptSource = JSON.stringify(graph);
  const complete = { kind: "hraness-stylex-complete-generation", schemaVersion: 2, state: "complete", generationId: "todo-native-busy", compilerSha256: sha, planSha256: sha, unionPolicySha256: sha,
    graphs: [{ id: "client", receiptSha256: hash(graphReceiptSource) }], packages: [], finalCss: { path: "stylex.css", bytes: 1, sha256: sha },
    artifacts: outputRows.filter(item => !["stylex.css", "stylex-complete.json"].includes(item.path)).map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
  const outputParent = role === "current" ? "/prepared/current/busy-output" : "/outputs/baseline";
  return { schema: "direct.todo-busy-build/v1", state: "complete", role,
    output: role === "current" ? `${outputParent}/todo-busy-current-ABC123/todo-native-busy` : `${outputParent}/generation`,
    preparationProvenance: "source commit/tree declared by preparation owner; independently bound source bytes verified here",
    request: { schema: "direct.todo-busy-build/v1", role, root: `/prepared/${role}`, outputParent, receiptPath: identity.receiptPath,
      sourceCommit: identity.commit, sourceTree: identity.tree, sourceFiles: files, fixtureFiles: fixtures, originalTemplateSha256: sha,
      node: { path: "/tools/node", version: "24.18.1", sha256: sha },
      packages: Object.entries(versions).map(([name, version]) => ({ name, version, manifest: `node_modules/${name}/package.json`, entry: `node_modules/${name}/index.js`, manifestSha256: sha, entrySha256: sha })),
      compilerModules: (role === "baseline" ? ["@vitejs/plugin-react", "vite"] : ["@hraness/ui/stylex-build", "@hraness/ui/stylex-build/vite", "@hraness/ui/stylex-manifest.json", "vite"])
        .map(specifier => ({ specifier, path: "node_modules/compiler/index.js", sha256: sha })) },
    sourceBeforeSha256: hash(JSON.stringify(files)), sourceAfterSha256: hash(JSON.stringify(files)), fixtureSha256: hash(JSON.stringify(fixtures)),
    compilerEvidence: role === "baseline" ? null : { graph, graphReceiptSource, complete },
    boundary: { inventory: outputRows, inventorySha256: hash(JSON.stringify(outputRows)), maps: [{ path: "assets/index.js.map", sha256: sha }],
      sources: sortRows([...runtimePaths, ...(role === "current" ? [recipePath] : [])].map(path => ({ path, physicalPath: path, bytes: 1, sha256: sha }))),
      references: ["/assets/index.js", "/assets/index.css", ...(role === "current" ? ["/stylex.css"] : [])] },
    limits: ["compilation only, not native busy paint", "standalone TodoApp, not workbench busy layout", "controlled port, not production persistence timing"] };
}

test("native input is finite and rejects unknown fields, aliases and accessors before invocation", () => {
  expect(parseBusyNativeInput(input)).toEqual(input);
  let accessed = false;
  for (const value of [null, { ...input, extra: true }, { ...input, port: 80 }, { ...input, port: 52927.5 },
    { ...input, baseline: current }, { ...input, current: { ...current, commit: baseline.commit } },
    { ...input, artifactParent: "/proofs/../outside" }, { ...input, browser: { ...input.browser, version: "latest" } },
    { ...input, current: { ...current, extra: true } }, { ...input, get port() { accessed = true; return 52927; } },
    { ...input, [Symbol("extra")]: true }, { ...input, current: Object.create(current) as unknown }]) {
    expect(() => parseBusyNativeInput(value)).toThrow();
  }
  expect(accessed).toBe(false);
});

test("Git binding preserves full binary and whitespace content beyond diagnostic tail limits", () => {
  const bytes = Buffer.concat([Buffer.from(" \n\t"), Buffer.alloc(151_515, 0xa5), Buffer.from("\0\n ")]);
  const item = { path: "bun.lock", mode: 0o644, bytes: bytes.length, sha256: hash(bytes) };
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const tree = `100644 blob ${blob}\tbun.lock\n`;
  expect(() => assertBusyGitBlob(item, bytes, tree)).not.toThrow();
  for (const content of [bytes.subarray(-12_000), bytes.subarray(1), Buffer.from(bytes.toString().trim())]) expect(() => assertBusyGitBlob(item, content, tree)).toThrow();
  for (const metadata of [tree.replace("100644", "100755"), tree.replace(blob, "f".repeat(40)), tree.replace("bun.lock", "package.json"), `${tree}${tree}`]) {
    expect(() => assertBusyGitBlob(item, bytes, metadata)).toThrow();
  }
  fc.assert(fc.property(fc.uint8Array({ maxLength: 4096 }), value => {
    const oid = createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
    expect(() => assertBusyGitBlob({ ...item, bytes: value.length, sha256: hash(value) }, value, `100644 blob ${oid}\tbun.lock`)).not.toThrow();
  }), { numRuns: 40 });
});

test("template substitution retains every other byte and rejects ambiguous original documents", () => {
  const script = '<script type="module" src="/src/main.tsx"></script>';
  const original = ` \n<html><head>\t<title>Original</title></head><body>${script}</body></html>\n `;
  expect(deriveBusyTemplate(original)).toBe(original.replace("/src/main.tsx", "/native-busy/entry.tsx"));
  for (const value of [original.replace(script, ""), `${original}${script}`, `${original}</head>`, original.replace("</head>", ""), deriveBusyTemplate(original)]) {
    expect(() => deriveBusyTemplate(value)).toThrow();
  }
});

test("inventory rejects path escape, duplicate or reordered entries and physical size overflow", () => {
  expect(parseBusyInventory([row("a"), row("b")])).toEqual([row("a"), row("b")]);
  for (const value of [[], [row("b"), row("a")], [row("a"), row("a")], [row("../outside")], [row("a//b")], [row("/absolute")],
    [{ ...row("a"), mode: 0o777 }], [{ ...row("a"), bytes: -1 }], [{ ...row("a"), sha256: "x" }],
    Array.from({ length: 5 }, (_, index) => ({ ...row(String(index)), bytes: 32 * 1024 * 1024 }))]) expect(() => parseBusyInventory(value)).toThrow();
});

test("build admission requires exact source, fixture, toolchain, map and output closure for both roles", () => {
  for (const role of ["baseline", "current"] as const) {
    const receipt = build(role), identity = role === "baseline" ? baseline : current;
    expect(parseBusyBuildReceipt(receipt, identity, role).directory).toBe(receipt.output);
    const request = receipt.request, boundary = receipt.boundary;
    for (const changed of [
      { ...receipt, accepted: true }, { ...receipt, state: "pending" }, { ...receipt, role: "other" }, { ...receipt, limits: [] },
      { ...receipt, output: `/outputs/${role}/../other` }, { ...receipt, output: `/prepared/${role}` },
      { ...receipt, sourceAfterSha256: "b".repeat(64) }, { ...receipt, fixtureSha256: "b".repeat(64) },
      { ...receipt, request: { ...request, sourceCommit: "5".repeat(40) } }, { ...receipt, request: { ...request, fixtureFiles: request.fixtureFiles.slice(1) } },
      { ...receipt, request: { ...request, sourceFiles: request.sourceFiles.slice(1) } },
      { ...receipt, request: { ...request, sourceFiles: sortRows([...request.sourceFiles, row("credentials.json")]) } },
      { ...receipt, request: { ...request, packages: request.packages.map(item => ({ ...item, version: "latest" })) } },
      { ...receipt, request: { ...request, compilerModules: [] } }, { ...receipt, request: { ...request, root: `/outputs/${role}/source` } },
      { ...receipt, request: { ...request, outputParent: `${request.root}/arbitrary-output` } },
      ...(role === "current" ? [{ ...receipt, output: `${request.outputParent}/foreign/todo-native-busy` },
        { ...receipt, output: `${request.outputParent}/todo-busy-current-ABC123/wrong-generation` },
        { ...receipt, request: { ...request, outputParent: "/outside/current" } }] : []),
      { ...receipt, boundary: { ...boundary, maps: [] } }, { ...receipt, boundary: { ...boundary, maps: [...boundary.maps, ...boundary.maps] } },
      { ...receipt, boundary: { ...boundary, sources: boundary.sources.slice(1) } },
      { ...receipt, boundary: { ...boundary, sources: boundary.sources.map(item => ({ ...item, physicalPath: "../outside" })) } },
      { ...receipt, boundary: { ...boundary, references: ["/missing.js", ...boundary.references.slice(1)] } },
      { ...receipt, boundary: { ...boundary, inventorySha256: "b".repeat(64) } },
    ]) expect(() => parseBusyBuildReceipt(changed, identity, role)).toThrow();
  }
});

test("current output must retain its recipe-bearing graph and complete emitted-file inventory", () => {
  const receipt = build("current"), evidence = receipt.compilerEvidence;
  expect(evidence).not.toBeNull();
  if (evidence === null) throw new Error("Current test requires compiler evidence");
  const check = (value: unknown) => assertBusyCompilerEvidence(value, receipt.request.sourceFiles, receipt.boundary.inventory);
  expect(() => check(evidence)).not.toThrow();
  for (const graph of [{ ...evidence.graph, inputs: [] }, { ...evidence.graph, adapter: "other" }, { ...evidence.graph, rules: [] },
    { ...evidence.graph, entrypoints: ["examples/todos/src/main.tsx"] }, { ...evidence.graph, extra: true }]) {
    const graphReceiptSource = JSON.stringify(graph);
    expect(() => check({ ...evidence, graph, graphReceiptSource, complete: { ...evidence.complete, graphs: [{ id: "client", receiptSha256: hash(graphReceiptSource) }] } })).toThrow();
  }
  for (const complete of [{ ...evidence.complete, state: "pending" }, { ...evidence.complete, artifacts: [] }, { ...evidence.complete, graphs: [] },
    { ...evidence.complete, finalCss: { ...evidence.complete.finalCss, sha256: "b".repeat(64) } }]) expect(() => check({ ...evidence, complete })).toThrow();
});
