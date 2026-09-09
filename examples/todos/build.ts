import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version } from "vite";
import {
  createStylexGeneration,
  finalizeStylexGeneration,
  prepareStylexProducedTemplate,
  sealStylexProducedTemplate,
} from "@hraness/ui/stylex-build";
import { stylexVite } from "@hraness/ui/stylex-build/vite";

import { scanTodoDirectOutput, scanTodoProductionOutput } from "./direct/check-production-boundary.ts";
import { parseTodoBuildTarget, renderTodoBuildHtml, type TodoBuildTarget } from "./build-contract.ts";

/** Each invocation publishes one new generation; no active preview is overwritten. */
export async function buildTodo(target: TodoBuildTarget): Promise<string> {
  assert.match(process.versions.node, /^24\./u, "The example compiler requires Node 24");
  assert.equal(typeof globalThis.Bun, "undefined", "Run the Vite compiler in Node, not Bun");
  assert.equal(version, "8.2.1");
  const rootDirectory = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
  const engine: unknown = JSON.parse(await readFile(join(rootDirectory, "node_modules/rolldown/package.json"), "utf8"));
  assert.ok(engine !== null && typeof engine === "object" && "version" in engine);
  assert.equal(engine.version, "1.2.8");
  const entry = target === "production" ? "examples/todos/src/main.tsx" : "examples/todos/direct/main.tsx";
  const sourcePath = target === "production" ? "examples/todos/index.html" : "examples/todos/direct/index.html";
  const outputPath = target === "production" ? "index.html" : "direct/index.html";
  const source = await readFile(join(rootDirectory, sourcePath), "utf8");
  const artifacts = join(rootDirectory, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const outputDirectory = await realpath(await mkdtemp(join(artifacts, `todo-${target}-`)));
  const generation = await createStylexGeneration({
    expectedGraphs: [{ adapter: "vite", entrypoints: [entry], id: "client", kind: "client" }],
    generationId: target,
    outputDirectory,
    packageManifests: [import.meta.resolve("@hraness/ui/stylex-manifest.json")],
    rootDirectory,
    templates: [{ cssHref: "/stylex.css", graphId: "client", outputPath, sourcePath, stylesheetGraphId: "client" }],
  });
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: { minify: true, target: "es2022" },
    plugins: [stylexVite({ generation, graphId: "client", rootDirectory, sourceMaps: "external" })],
  });
  assert.ok(!Array.isArray(result) && "output" in result, "Expected one finite client build");
  const entries = result.output.filter((item) => item.type === "chunk" && item.isEntry);
  const stylesheets = result.output.filter((item) => item.type === "asset" && item.fileName.endsWith(".css"));
  assert.equal(entries.length, 1);
  assert.equal(stylesheets.length, 1);
  const entryFile = entries[0]!.fileName;
  const foundationFile = stylesheets[0]!.fileName;
  const html = renderTodoBuildHtml(source, target, entryFile, foundationFile);
  const produced = await prepareStylexProducedTemplate(generation, outputPath);
  await writeFile(produced.sourcePath, html, { flag: "wx" });
  assert.equal(await readFile(join(rootDirectory, sourcePath), "utf8"), source, "Authored template changed during compilation");
  await sealStylexProducedTemplate(generation, outputPath);
  const published = await finalizeStylexGeneration({ generation, outputDirectory, rootDirectory });
  const boundary = target === "production" ? await scanTodoProductionOutput(published) : await scanTodoDirectOutput(published);
  assert.deepEqual(boundary.violations, [], "Compiled example violates its source boundary");
  return published;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await buildTodo(parseTodoBuildTarget(process.argv[2])));
}
