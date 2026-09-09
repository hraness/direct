import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Row = { path: string; mode: number; bytes: number; sha256: string };
// The dynamic URL imports the Node driver without invoking its CLI or resolving
// compiler dependencies; this explicit interface bounds the untyped JS seam.
const driver = await import(new URL("./build-busy.mjs", import.meta.url).href) as {
  BUSY_BUILD_SCHEMA: string;
  busySha256(value: string | Uint8Array): string;
  busyRelativePath(value: unknown): string;
  busyOrdinaryBytes(path: string): Buffer;
  parseBusyInventory(value: unknown): Row[];
  parseBusyBuildInput(value: unknown): unknown;
  checkBusyPreparedSource(input: { role: string; root: string; outputParent: string; sourceFiles: Row[] }, outputLeaf?: string): Row[];
  deriveBusyHtml(value: string): string;
  renderBusyHtml(source: string, entry: string, css: string, placeholder: string): string;
  finiteBusyOutputs(value: unknown): { entry: string; stylesheet: string };
  expectedBusyPackages(role: string): Record<string, string>;
  expectedBusyCompilerModules(role: string): string[];
  resolveBusyMapSource(root: string, map: string, source: string, sourceRoot?: string): string;
  assertBusyMapClosure(sources: string[], role: string): void;
  busyMapReference(code: string, filename: string): string;
  assertBusyRecipeReceipt(receipt: unknown, artifact: unknown): void;
  busyHtmlReferences(html: string, outputs: string[], role: string): string[];
  writeBusyReceipt(path: string, value: unknown): Promise<void>;
};
const prefix = "examples/todos/";
const runtime = ["src/TodoApp.tsx", "src/todo-port.ts", "native-busy/entry.tsx", "native-busy/controlled-port.ts"].map((path) => prefix + path);
const original = '<!doctype html><html><head><title>Todo example</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';
const placeholder = "__HRANESS_STYLEX_CSS__";
const row = (path: string): Row => ({ path, mode: 420, bytes: 1, sha256: "a".repeat(64) });
function request(role: "baseline" | "current" = "current") {
  const outputParent = role === "current" ? "/private/tmp/prepared-source/busy-output" : "/private/tmp/qualified-output";
  const fixtureFiles = ["controlled-port.test.ts", "controlled-port.ts", "entry.tsx"].map((path) => row(`${prefix}native-busy/${path}`)).sort((a, b) => a.path.localeCompare(b.path));
  const paths = ["package.json", "bun.lock", `${prefix}native-busy/build-busy.mjs`, `${prefix}index.html`, `${prefix}native-busy/index.html`, `${prefix}src/styles.css`, ...runtime,
    ...(role === "current" ? [`${prefix}src/todo.stylex.ts`] : []), ...fixtureFiles.map((item) => item.path)];
  return {
    schema: driver.BUSY_BUILD_SCHEMA, role, root: "/private/tmp/prepared-source", sourceCommit: "1".repeat(40), sourceTree: "2".repeat(40),
    sourceFiles: [...new Set(paths)].sort().map(row), fixtureFiles, originalTemplateSha256: "b".repeat(64),
    node: { path: "/qualified/node", version: "24.18.1", sha256: "c".repeat(64) },
    packages: Object.entries(driver.expectedBusyPackages(role)).map(([name, version]) => ({ name, version,
      manifest: `node_modules/${name}/package.json`, entry: `node_modules/${name}/index.js`, manifestSha256: "d".repeat(64), entrySha256: "e".repeat(64) })),
    compilerModules: driver.expectedBusyCompilerModules(role).map((specifier) => ({ specifier, path: `node_modules/${specifier}/index.js`, sha256: "f".repeat(64) })),
    outputParent, receiptPath: `${outputParent}/receipt.json`,
  };
}

test("prepared request has only the two exact toolchains and shared fixture byte/mode inventory", () => {
  for (const role of ["baseline", "current"] as const) expect(driver.parseBusyBuildInput(request(role))).toEqual(request(role));
  expect(driver.expectedBusyPackages("baseline")["@vitejs/plugin-react"]).toBe("6.0.4");
  expect(() => driver.expectedBusyPackages("fallback")).toThrow();
  for (const change of [
    (value: ReturnType<typeof request>) => ({ ...value, extra: true }),
    (value: ReturnType<typeof request>) => ({ ...value, packages: value.packages.map((item) => ({ ...item, version: "latest" })) }),
    (value: ReturnType<typeof request>) => ({ ...value, node: { ...value.node, version: "22.0.0" } }),
    (value: ReturnType<typeof request>) => ({ ...value, compilerModules: value.compilerModules.slice(1) }),
    (value: ReturnType<typeof request>) => ({ ...value, fixtureFiles: value.fixtureFiles.map((item) => ({ ...item, mode: 493 })) }),
    (value: ReturnType<typeof request>) => ({ ...value, sourceFiles: value.sourceFiles.filter((item) => item.path !== `${prefix}src/TodoApp.tsx`) }),
    (value: ReturnType<typeof request>) => ({ ...value, outputParent: `${value.root}/dist` }),
    (value: ReturnType<typeof request>) => ({ ...value, outputParent: "/private/tmp/foreign-output" }),
    (value: ReturnType<typeof request>) => ({ ...value, sourceFiles: [...value.sourceFiles, row("busy-output/foreign.ts")].sort((a, b) => a.path.localeCompare(b.path)) }),
    (value: ReturnType<typeof request>) => ({ ...value, receiptPath: `${value.root}/receipt.json` }),
  ]) expect(() => driver.parseBusyBuildInput(change(request()))).toThrow();
});

test("current source census excludes only its canonical empty or finalized owned output", async () => {
  const scope = await realpath(await mkdtemp(join(tmpdir(), "todo-busy-owned-output-")));
  try {
    const root = join(scope, "prepared"), outputParent = join(root, "busy-output");
    await mkdir(outputParent, { recursive: true });
    await writeFile(join(root, "source.ts"), "x");
    const sourceFiles = [{ path: "source.ts", mode: 0o644, bytes: 1, sha256: driver.busySha256("x") }];
    const input = { role: "current", root, outputParent, sourceFiles };
    expect(driver.checkBusyPreparedSource(input)).toEqual(sourceFiles);
    expect(() => driver.checkBusyPreparedSource({ ...input, outputParent: join(root, "other") })).toThrow();
    const leaf = join(outputParent, "todo-busy-current-ABC123");
    await mkdir(join(leaf, "todo-native-busy"), { recursive: true });
    expect(() => driver.checkBusyPreparedSource(input)).toThrow();
    expect(driver.checkBusyPreparedSource(input, leaf)).toEqual(sourceFiles);
    await writeFile(join(leaf, "foreign.txt"), "must not disappear");
    expect(() => driver.checkBusyPreparedSource(input, leaf)).toThrow();
    await rm(join(leaf, "foreign.txt"));
    await writeFile(join(outputParent, "foreign.txt"), "must not disappear");
    expect(() => driver.checkBusyPreparedSource(input, leaf)).toThrow();
    await rm(join(outputParent, "foreign.txt"));
    await writeFile(join(root, "foreign.ts"), "must not disappear");
    expect(() => driver.checkBusyPreparedSource(input, leaf)).toThrow();
    await rm(join(root, "foreign.ts"));
    const linkedRoot = join(scope, "linked-prepared"); await mkdir(linkedRoot);
    await symlink(outputParent, join(linkedRoot, "busy-output"));
    expect(() => driver.checkBusyPreparedSource({ ...input, root: linkedRoot, outputParent: join(linkedRoot, "busy-output") }, leaf)).toThrow();
  } finally { await rm(scope, { recursive: true, force: true }); }
});

test("identical template transformation preserves every non-entry byte and rejects ambiguous metadata", () => {
  const derived = driver.deriveBusyHtml(original);
  expect(derived.replace("/native-busy/entry.tsx", "/src/main.tsx")).toBe(original);
  for (const invalid of ["", original.replace("/src/main.tsx", "/elsewhere.tsx"), original + original, original.replace("</head>", "</head></head>")]) {
    expect(() => driver.deriveBusyHtml(invalid)).toThrow();
  }
  const produced = driver.renderBusyHtml(derived, "assets/entry.js", "assets/document.css", placeholder).replace(placeholder, "/stylex.css");
  expect(driver.busyHtmlReferences(produced, ["graphs/client/assets/entry.js", "graphs/client/assets/document.css", "stylex.css"], "current"))
    .toEqual(["/graphs/client/assets/entry.js", "/graphs/client/assets/document.css", "/stylex.css"]);
  for (const path of ["../escape.js", "/absolute.js", "assets//entry.js", "assets/./entry.js", "https://foreign/x.js"]) {
    expect(() => driver.renderBusyHtml(derived, path, "assets/style.css", placeholder)).toThrow();
  }
  expect(() => driver.busyHtmlReferences(produced.replace("/stylex.css", "//foreign/stylex.css"), ["stylex.css"], "current")).toThrow();
  expect(() => driver.busyHtmlReferences(produced, [], "current")).toThrow();
  expect(() => driver.busyHtmlReferences(produced.replace("<body>", '<body style="color:red">'), ["stylex.css"], "current")).toThrow();
});

test("one finite real entry and document stylesheet are required", () => {
  const output = [{ type: "chunk", isEntry: true, fileName: "assets/main.js" }, { type: "asset", fileName: "assets/main.css" }];
  expect(driver.finiteBusyOutputs({ output })).toEqual({ entry: "assets/main.js", stylesheet: "assets/main.css" });
  for (const invalid of [undefined, [], { output: [] }, { output: output.slice(0, 1) }, { output: [...output, output[0]] }, { output: [...output, output[1]] }]) {
    expect(() => driver.finiteBusyOutputs(invalid)).toThrow();
  }
});

test("compiled script census rejects malformed browser end tags and hidden extra entries", () => {
  for (const role of ["baseline", "current"] as const) {
    const script = `<script type="module"${role === "baseline" ? " crossorigin" : ""} src="/assets/entry.js"></script>`;
    const styles = '<link rel="stylesheet" href="/assets/document.css">'
      + (role === "current" ? '<link rel="stylesheet" href="/stylex.css">' : "");
    const html = `<!doctype html><html><head>${styles}</head><body>${script}</body></html>`;
    const outputs = ["assets/entry.js", "assets/document.css", ...(role === "current" ? ["stylex.css"] : [])];
    expect(driver.busyHtmlReferences(html, outputs, role)).toEqual(outputs.map(path => `/${path}`));
    expect(driver.busyHtmlReferences(html.replace("<body>", "<body>İ"), outputs, role)).toEqual(outputs.map(path => `/${path}`));
    const malformedEnds = ["</script >", "</script\t>", "</script\n>", "</script/>", '</script foo="bar">', "</SCRIPT>", "</script"];
    for (const closing of malformedEnds) {
      expect(() => driver.busyHtmlReferences(html.replace("</script>", closing), outputs, role)).toThrow();
      const extra = `<script>alert(1)${closing}`;
      expect(() => driver.busyHtmlReferences(html.replace("</body>", `${extra}</body>`), outputs, role)).toThrow();
    }
    for (const extra of ["<ScRiPt>alert(1)</ScRiPt >", "<script/src=foreign.js></script>", "<!-- <script -->", "<scripture>"]) {
      expect(() => driver.busyHtmlReferences(html + extra, outputs, role)).toThrow();
    }
    for (const replacement of [script + script, script.replace("<script", "<SCRIPT"), script.replace('src="', 'onload="bad()" src="'),
      script.replace("></script>", ">alert(1)</script>"), script.replace("></script>", "> </script>"), script.replace("</script>", "")]) {
      expect(() => driver.busyHtmlReferences(html.replace(script, replacement), outputs, role)).toThrow();
    }
  }
});

test("positive map closure requires every real runtime and excludes production/workbench/test sources", () => {
  for (const role of ["baseline", "current"]) driver.assertBusyMapClosure([...runtime, "node_modules/react/index.js"], role);
  for (let index = 0; index < runtime.length; index += 1) expect(() => driver.assertBusyMapClosure(runtime.filter((_, item) => item !== index), "current")).toThrow();
  for (const foreign of ["src/main.tsx", "src/local-storage-todo-port.ts", "direct/main.tsx", "direct/workbench.tsx", "native-busy/controlled-port.test.ts"]) {
    expect(() => driver.assertBusyMapClosure([...runtime, prefix + foreign], "current")).toThrow();
  }
  driver.assertBusyMapClosure([...runtime, `${prefix}src/todo.stylex.ts`], "current");
  expect(() => driver.assertBusyMapClosure([...runtime, `${prefix}src/todo.stylex.ts`], "baseline")).toThrow();
});

test("map source resolution stays anchored to the actual map and prepared tree", () => {
  expect(driver.resolveBusyMapSource("/prepared", "/outputs/assets/a.js.map", "../../prepared/examples/todos/src/TodoApp.tsx")).toBe(`${prefix}src/TodoApp.tsx`);
  expect(driver.resolveBusyMapSource("/prepared", "/outputs/a.js.map", "file:///prepared/examples/todos/src/TodoApp.tsx")).toBe(`${prefix}src/TodoApp.tsx`);
  for (const source of ["https://foreign/TodoApp.tsx", "file:///other-tree/TodoApp.tsx", "../../other-tree/TodoApp.tsx", "data:x", "x?query", "x\\y"]) {
    expect(() => driver.resolveBusyMapSource("/prepared", "/outputs/a.js.map", source)).toThrow();
  }
  expect(() => driver.resolveBusyMapSource("/prepared", "/outputs/a.js.map", "/prepared/x.ts", "https://foreign/")).toThrow();
  expect(driver.busyMapReference("code\n//# sourceMappingURL=a.js.map", "assets/a.js")).toBe("assets/a.js.map");
  for (const code of ["code", "//# sourceMappingURL=data:application/json,{}", "//# sourceMappingURL=other.map", "//# sourceMappingURL=a.js.map\n//# sourceMappingURL=a.js.map"]) {
    expect(() => driver.busyMapReference(code, "assets/a.js")).toThrow();
  }
});

test("recipe membership requires its exact authored hash in the completed graph, not a text mention", () => {
  const artifact = { bytes: 123, sha256: "f".repeat(64) };
  const receipt = { kind: "hraness-stylex-graph-receipt", schemaVersion: 1, state: "complete", adapter: "vite", target: "client", graphId: "client",
    generationId: "todo-native-busy", entrypoints: [`${prefix}native-busy/entry.tsx`], inputs: [{ path: `${prefix}src/todo.stylex.ts`, ...artifact }], rules: [["x", { ltr: ".x{color:red}" }, 1]] };
  driver.assertBusyRecipeReceipt(receipt, artifact);
  for (const changed of [{ ...receipt, inputs: [] }, { ...receipt, rules: [] }, { ...receipt, state: "failed" }, { ...receipt, graphId: "foreign" },
    { ...receipt, inputs: [{ path: `${prefix}src/todo.stylex.ts`, ...artifact, sha256: "e".repeat(64) }] }]) {
    expect(() => driver.assertBusyRecipeReceipt(changed, artifact)).toThrow();
  }
});

test("inventory canonical ordering and parser closure hold over finite permutations and every missing field", () => {
  for (let count = 1; count <= 16; count += 1) {
    const rows = Array.from({ length: count }, (_, index) => row(`source-${String(index).padStart(2, "0")}.ts`));
    expect(driver.parseBusyInventory(rows)).toEqual(rows);
    expect(() => driver.parseBusyInventory([...rows, rows[0]])).toThrow();
    if (count > 1) expect(() => driver.parseBusyInventory([...rows].reverse())).toThrow();
    for (const key of ["path", "mode", "bytes", "sha256"] as const) {
      expect(() => driver.parseBusyInventory([Object.fromEntries(Object.entries(row("x.ts")).filter(([name]) => name !== key))])).toThrow();
    }
  }
  for (const invalid of ["../x", "/x", "x//y", "x/./y", "x/../y", "x\0y", "x?y"]) expect(() => driver.busyRelativePath(invalid)).toThrow();
});

test("receipt writes are exclusive and ordinary evidence never follows links", async () => {
  const scope = await realpath(await mkdtemp(join(tmpdir(), "todo-busy-build-unit-")));
  try {
    const path = join(scope, "receipt.json");
    await driver.writeBusyReceipt(path, { state: "complete" });
    const bytes = await readFile(path);
    await expect(driver.writeBusyReceipt(path, { state: "replacement" })).rejects.toThrow();
    expect(await readFile(path)).toEqual(bytes);
    const linked = join(scope, "linked.json");
    await symlink(path, linked);
    expect(() => driver.busyOrdinaryBytes(linked)).toThrow();
    expect(() => driver.busyOrdinaryBytes(scope)).toThrow();
    await writeFile(join(scope, "plain"), "proof");
    expect(driver.busyOrdinaryBytes(join(scope, "plain")).toString()).toBe("proof");
  } finally { await rm(scope, { recursive: true, force: true }); }
});
