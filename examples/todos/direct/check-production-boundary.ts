import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TODO_DIRECT_VERSIONED_EXECUTABLE_MARKERS = Object.freeze([
  "direct.browser-bridge/v2",
  "direct.session-manifest/v1",
  "direct.probe/v1",
]);

const TODO_DIRECT_LITERAL_EXECUTABLE_MARKERS = Object.freeze([
  "__direct",
  "Direct blocked an unmapped network request.",
]);

export const TODO_DIRECT_EXECUTABLE_MARKERS = Object.freeze([
  ...TODO_DIRECT_VERSIONED_EXECUTABLE_MARKERS,
  ...TODO_DIRECT_LITERAL_EXECUTABLE_MARKERS,
]);

export const TODO_PRODUCTION_MARKERS = Object.freeze([
  "@hraness/direct",
  "direct.browser-bridge/v",
  "direct.coverage/v",
  "direct.fixture/v",
  "direct.probe/v",
  "direct.runtime/v",
  "direct.session-manifest/v",
  "__direct",
  "Direct blocked an unmapped network request.",
  "__direct_scenario",
  "__direct_fixture",
  "direct/main",
  "Todo Direct",
]);

const directDirectory = dirname(fileURLToPath(import.meta.url));
const localModuleProtocol = new URL(import.meta.url).protocol;
const exampleRoot = resolve(directDirectory, "..");
const packageRoot = resolve(exampleRoot, "../..");
const productionSourceRoot = join(exampleRoot, "src");

const REQUIRED_PRODUCTION_SOURCES = Object.freeze([
  join(productionSourceRoot, "main.tsx"),
  join(productionSourceRoot, "TodoApp.tsx"),
  join(productionSourceRoot, "todo-port.ts"),
  join(productionSourceRoot, "local-storage-todo-port.ts"),
]);

const REQUIRED_DIRECT_SOURCES = Object.freeze([
  join(directDirectory, "main.tsx"),
  join(directDirectory, "workbench.tsx"),
  join(directDirectory, "session.ts"),
  join(directDirectory, "deterministic-todo-port.ts"),
  join(productionSourceRoot, "TodoApp.tsx"),
  join(productionSourceRoot, "todo-port.ts"),
]);

const REQUIRED_DIRECT_WEB_SOURCE_VARIANTS = Object.freeze([
  Object.freeze([
    join(packageRoot, "src/web/browser-bridge.ts"),
    join(packageRoot, "src/web/fetch-firewall.ts"),
  ]),
  Object.freeze([join(packageRoot, "dist/web.js")]),
]);

const FORBIDDEN_DIRECT_SOURCES = Object.freeze([
  join(productionSourceRoot, "main.tsx"),
  join(productionSourceRoot, "local-storage-todo-port.ts"),
]);

export interface ProductionBoundaryViolation {
  readonly file: string;
  readonly markers: readonly string[];
}

export interface TodoBoundaryResult {
  readonly observedSources: readonly string[];
  readonly scanned: readonly string[];
  readonly sourceMaps: readonly string[];
  readonly violations: readonly ProductionBoundaryViolation[];
}

export type ProductionBoundaryResult = TodoBoundaryResult;

interface SourceMapDocument {
  readonly sources: readonly string[];
}

interface BuildGraphPolicy {
  readonly forbiddenSources: readonly string[];
  readonly label: "Direct" | "production";
  readonly requiredExecutableLiteralMarkers: readonly string[];
  readonly requiredExecutableVersionedMarkers: readonly string[];
  readonly requiredSources: readonly string[];
  readonly requiredSourceVariants: readonly (readonly string[])[];
  readonly sourceAllowed: (source: string) => boolean;
}

async function* walk(directory: string): AsyncGenerator<string> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseSourceMap(input: unknown, file: string): SourceMapDocument {
  if (!isRecord(input) || input.version !== 3 || !Array.isArray(input.sources)) {
    throw new Error(`${file}: emitted JavaScript source map must use version 3 with a sources array.`);
  }
  const sources: string[] = [];
  for (const source of input.sources) {
    if (typeof source !== "string" || source.length === 0 || source.includes("\0")) {
      throw new Error(`${file}: emitted JavaScript source map contains an invalid source path.`);
    }
    sources.push(source);
  }
  if (sources.length === 0) {
    throw new Error(`${file}: emitted JavaScript source map must name at least one source.`);
  }
  return Object.freeze({ sources: Object.freeze(sources) });
}

function resolveMappedSource(mapFile: string, source: string): string {
  if (source.startsWith(localModuleProtocol)) {
    try {
      return resolve(fileURLToPath(source));
    } catch {
      throw new Error(`${mapFile}: emitted JavaScript source map contains an invalid file URL.`);
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source)) {
    throw new Error(`${mapFile}: emitted JavaScript source map contains an unsupported source URL.`);
  }
  return resolve(dirname(mapFile), source);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isDependencySource(source: string): boolean {
  return source.split(/[\\/]/u).includes("node_modules");
}

function executableOutput(file: string): boolean {
  return file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs");
}

function exactVersionedMarkerEvidence(
  contents: readonly string[],
  expectedMarkers: readonly string[],
): { readonly missing: readonly string[]; readonly unexpected: readonly string[] } {
  const expected = new Set(expectedMarkers);
  const observed = new Set<string>();
  for (const marker of expectedMarkers) {
    const family = marker.match(/^(?<family>.+\/v)[0-9]+$/u)?.groups?.["family"];
    if (family === undefined) {
      throw new Error(`Todo boundary has an invalid exact versioned-marker policy: ${marker}`);
    }
    const escapedFamily = family.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(
      `(?<![A-Za-z0-9._/-])${escapedFamily}[0-9]+(?![A-Za-z0-9._/-])`,
      "gu",
    );
    for (const executable of contents) {
      for (const match of executable.matchAll(pattern)) observed.add(match[0]);
    }
  }
  return Object.freeze({
    missing: Object.freeze(expectedMarkers.filter((marker) => !observed.has(marker))),
    unexpected: Object.freeze(
      [...observed]
        .filter((marker) => !expected.has(marker))
        .sort((left, right) => left.localeCompare(right)),
    ),
  });
}

async function inspectBuildGraph(
  scanned: readonly string[],
  policy: BuildGraphPolicy,
): Promise<{ readonly observedSources: readonly string[]; readonly sourceMaps: readonly string[] }> {
  if (!scanned.some((file) => file.endsWith(".html"))) {
    throw new Error(`Todo ${policy.label} boundary did not find an emitted HTML entry.`);
  }
  const executables = scanned.filter(executableOutput);
  if (executables.length === 0) {
    throw new Error(`Todo ${policy.label} boundary did not find emitted JavaScript.`);
  }
  const scannedSet = new Set(scanned);
  const sourceMaps: string[] = [];
  const observedSources = new Set<string>();
  const observedExecutableMarkers = new Set<string>();
  const executableContents: string[] = [];
  for (const executable of executables) {
    const mapFile = `${executable}.map`;
    if (!scannedSet.has(mapFile)) {
      throw new Error(`Todo ${policy.label} JavaScript is missing its source map: ${executable}`);
    }
    const executableText = await readFile(executable, "utf8");
    executableContents.push(executableText);
    for (const marker of policy.requiredExecutableLiteralMarkers) {
      if (executableText.includes(marker)) observedExecutableMarkers.add(marker);
    }
    if (!executableText.includes(`sourceMappingURL=${basename(mapFile)}`)) {
      throw new Error(`Todo ${policy.label} JavaScript does not reference its paired source map: ${executable}`);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(await readFile(mapFile, "utf8")) as unknown;
    } catch (reason) {
      if (reason instanceof SyntaxError) {
        throw new Error(`${mapFile}: emitted JavaScript source map is not valid JSON.`);
      }
      throw reason;
    }
    const sourceMap = parseSourceMap(decoded, mapFile);
    sourceMaps.push(mapFile);
    for (const source of sourceMap.sources) observedSources.add(resolveMappedSource(mapFile, source));
  }

  const missing = policy.requiredSources.filter((source) => !observedSources.has(source));
  if (missing.length > 0) {
    throw new Error([
      `Todo ${policy.label} build is missing required source modules:`,
      ...missing.map((source) => relative(exampleRoot, source)),
    ].join("\n"));
  }
  if (
    policy.requiredSourceVariants.length > 0
    && !policy.requiredSourceVariants.some((variant) => (
      variant.every((source) => observedSources.has(source))
    ))
  ) {
    throw new Error([
      `Todo ${policy.label} build is missing every accepted web-boundary source variant:`,
      ...policy.requiredSourceVariants.map((variant) => (
        variant.map((source) => relative(exampleRoot, source)).join(" + ")
      )),
    ].join("\n"));
  }
  const versionEvidence = policy.requiredExecutableVersionedMarkers.length === 0
    ? { missing: [], unexpected: [] }
    : exactVersionedMarkerEvidence(
        executableContents,
        policy.requiredExecutableVersionedMarkers,
      );
  const missingExecutableMarkers = [
    ...versionEvidence.missing,
    ...policy.requiredExecutableLiteralMarkers.filter((marker) => (
      !observedExecutableMarkers.has(marker)
    )),
  ];
  if (missingExecutableMarkers.length > 0 || versionEvidence.unexpected.length > 0) {
    throw new Error([
      ...(missingExecutableMarkers.length === 0
        ? []
        : [
            `Todo ${policy.label} build is missing required executable markers:`,
            ...missingExecutableMarkers,
          ]),
      ...(versionEvidence.unexpected.length === 0
        ? []
        : [
            `Todo ${policy.label} build contains unexpected executable marker versions:`,
            ...versionEvidence.unexpected,
          ]),
    ].join("\n"));
  }
  const forbidden = policy.forbiddenSources.filter((source) => observedSources.has(source));
  if (forbidden.length > 0) {
    throw new Error([
      `Todo ${policy.label} build includes forbidden source modules:`,
      ...forbidden.map((source) => relative(exampleRoot, source)),
    ].join("\n"));
  }
  const unexpected = [...observedSources].filter((source) => (
    !isDependencySource(source) && !policy.sourceAllowed(source)
  ));
  if (unexpected.length > 0) {
    throw new Error([
      `Todo ${policy.label} build includes source modules outside its allowed graph:`,
      ...unexpected.map((source) => relative(exampleRoot, source)),
    ].join("\n"));
  }

  return Object.freeze({
    observedSources: Object.freeze([...observedSources].sort()),
    sourceMaps: Object.freeze(sourceMaps.sort()),
  });
}

async function scanOutput(
  directory: string,
  policy: BuildGraphPolicy,
  markers: readonly string[],
): Promise<TodoBoundaryResult> {
  const scanned: string[] = [];
  const violations: ProductionBoundaryViolation[] = [];
  for await (const file of walk(resolve(directory))) {
    scanned.push(file);
    const bytes = await readFile(file);
    const found = markers.filter((marker) => bytes.includes(Buffer.from(marker)));
    if (found.length > 0) violations.push(Object.freeze({ file, markers: Object.freeze(found) }));
  }
  if (scanned.length === 0) throw new Error(`Todo ${policy.label} boundary did not scan any emitted files.`);
  const graph = await inspectBuildGraph(scanned, policy);
  return Object.freeze({
    observedSources: graph.observedSources,
    scanned: Object.freeze(scanned),
    sourceMaps: graph.sourceMaps,
    violations: Object.freeze(violations),
  });
}

export async function scanTodoProductionOutput(
  directory: string,
  markers: readonly string[] = TODO_PRODUCTION_MARKERS,
): Promise<ProductionBoundaryResult> {
  if (markers.length === 0 || markers.some((marker) => marker.length === 0)) {
    throw new Error("Production boundary markers must contain non-empty values.");
  }
  return scanOutput(directory, {
    forbiddenSources: [],
    label: "production",
    requiredExecutableLiteralMarkers: [],
    requiredExecutableVersionedMarkers: [],
    requiredSources: REQUIRED_PRODUCTION_SOURCES,
    requiredSourceVariants: [],
    sourceAllowed: (source) => isWithin(productionSourceRoot, source),
  }, markers);
}

export async function scanTodoDirectOutput(directory: string): Promise<TodoBoundaryResult> {
  return scanOutput(directory, {
    forbiddenSources: FORBIDDEN_DIRECT_SOURCES,
    label: "Direct",
    requiredExecutableLiteralMarkers: TODO_DIRECT_LITERAL_EXECUTABLE_MARKERS,
    requiredExecutableVersionedMarkers: TODO_DIRECT_VERSIONED_EXECUTABLE_MARKERS,
    requiredSources: REQUIRED_DIRECT_SOURCES,
    requiredSourceVariants: REQUIRED_DIRECT_WEB_SOURCE_VARIANTS,
    sourceAllowed: (source) => isWithin(packageRoot, source),
  }, []);
}

if (import.meta.main) {
  const directory = process.argv[2] ?? resolve(directDirectory, "../dist");
  const result = await scanTodoProductionOutput(directory);
  if (result.violations.length > 0) {
    throw new Error([
      "Todo production output contains Direct markers:",
      ...result.violations.map((violation) => `${violation.file}: ${violation.markers.join(", ")}`),
    ].join("\n"));
  }
  console.log([
    `Todo production boundary passed (${String(result.scanned.length)} files).`,
    `Verified ${String(result.observedSources.length)} mapped source modules.`,
  ].join("\n"));
}
