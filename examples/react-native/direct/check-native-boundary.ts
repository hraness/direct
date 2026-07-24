import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const FORBIDDEN_MARKERS = [
  "@cclrte/direct",
  "__direct_scenario",
  "__direct_fixture",
  "direct.browser-bridge/v1",
  "direct.react-native-example/v1",
  "Direct activation failed",
  "Direct hooks require their matching Direct Provider",
  "The deterministic device status port is disposed",
] as const;

const REQUIRED_WEB_MARKERS = [
  "__direct_scenario",
  "direct.browser-bridge/v1",
  "direct.react-native-example/v1",
  "ios-ready",
] as const;

const REQUIRED_NATIVE_MARKERS = [
  "device-status-example/screen/v1",
  "device-status-example/native-port/v1",
] as const;

const REQUIRED_NATIVE_SOURCES = [
  "/src/root.native.tsx",
  "/src/DeviceStatusApp.tsx",
  "/src/native-device-status-port.ts",
] as const;

const REQUIRED_WEB_SOURCES = [
  "/src/root.web.tsx",
  "/src/DeviceStatusApp.tsx",
  "/src/device-status-port.ts",
  "/direct/web-provider.tsx",
  "/direct/workbench.tsx",
  "/direct/deterministic-device-status-port.ts",
] as const;

const FORBIDDEN_WEB_SOURCES = [
  "/src/root.native.tsx",
  "/src/native-device-status-port.ts",
] as const;

const SCANNED_EXTENSIONS = new Set([
  ".bundle",
  ".hbc",
  ".html",
  ".js",
  ".json",
  ".map",
]);

const EXECUTABLE_EXTENSIONS = new Set([".bundle", ".hbc", ".js"]);

const FORBIDDEN_SOURCE_PREFIXES = ["/../../src/", "/../../dist/", "/direct/"] as const;

function sourceMapSources(contents: Buffer, file: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error(`React Native production boundary could not parse source map ${file}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`React Native production boundary found an invalid source map object in ${file}`);
  }
  const candidate = (parsed as { readonly sources?: unknown }).sources;
  if (!Array.isArray(candidate)) {
    throw new Error(`React Native production boundary found no source list in ${file}`);
  }
  const sources: string[] = [];
  for (const source of candidate as unknown[]) {
    if (typeof source !== "string") {
      throw new Error(`React Native production boundary found a non-string source in ${file}`);
    }
    sources.push(source);
  }
  return Object.freeze(sources);
}

function forbiddenSource(source: string): boolean {
  return source === "/src/root.web.tsx"
    || FORBIDDEN_SOURCE_PREFIXES.some((prefix) => source.startsWith(prefix));
}

async function* walk(root: string, directory = root): AsyncGenerator<string> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(root, path);
    else if (entry.isFile() && SCANNED_EXTENSIONS.has(extname(entry.name).toLowerCase())) yield path;
  }
}

export interface NativeBoundaryViolation {
  readonly file: string;
  readonly markers: readonly string[];
}

export async function scanReactNativeProductionOutput(root: string): Promise<{
  readonly scanned: readonly string[];
  readonly violations: readonly NativeBoundaryViolation[];
}> {
  const scanned: string[] = [];
  const violations: NativeBoundaryViolation[] = [];
  let executableFiles = 0;
  let sourceMaps = 0;
  const executablePaths = new Set<string>();
  const mappedExecutablePaths = new Set<string>();
  const observedNativeMarkers = new Set<string>();
  const observedNativeSources = new Set<string>();
  for await (const path of walk(root)) {
    const file = relative(root, path);
    const contents = await readFile(path);
    const extension = extname(file).toLowerCase();
    scanned.push(file);
    if (EXECUTABLE_EXTENSIONS.has(extension)) {
      executableFiles += 1;
      executablePaths.add(file);
      for (const marker of REQUIRED_NATIVE_MARKERS) {
        if (contents.includes(Buffer.from(marker))) observedNativeMarkers.add(marker);
      }
    }
    const markers: string[] = FORBIDDEN_MARKERS
      .filter((marker) => contents.includes(Buffer.from(marker)));
    if (extension === ".map") {
      sourceMaps += 1;
      mappedExecutablePaths.add(file.slice(0, -".map".length));
      for (const source of sourceMapSources(contents, file)) {
        observedNativeSources.add(source);
        if (forbiddenSource(source)) markers.push(`source-map:${source}`);
      }
    }
    if (markers.length > 0) violations.push(Object.freeze({ file, markers: Object.freeze(markers) }));
  }
  if (scanned.length === 0) {
    throw new Error(`React Native production boundary scanned no emitted files under ${root}`);
  }
  if (executableFiles === 0) {
    throw new Error(`React Native production boundary scanned no emitted executable bundles under ${root}`);
  }
  if (sourceMaps === 0) {
    throw new Error(`React Native production boundary scanned no emitted source maps under ${root}`);
  }
  const unmappedExecutables = [...executablePaths]
    .filter((file) => !mappedExecutablePaths.has(file));
  if (unmappedExecutables.length > 0) {
    throw new Error(
      `React Native production output has executables without paired source maps: ${unmappedExecutables.join(", ")}`,
    );
  }
  const missingNativeMarkers = REQUIRED_NATIVE_MARKERS
    .filter((marker) => !observedNativeMarkers.has(marker));
  if (missingNativeMarkers.length > 0) {
    throw new Error(
      `React Native production output is missing native composition markers: ${missingNativeMarkers.join(", ")}`,
    );
  }
  const missingNativeSources = REQUIRED_NATIVE_SOURCES
    .filter((source) => !observedNativeSources.has(source));
  if (missingNativeSources.length > 0) {
    throw new Error(
      `React Native production source maps are missing native composition modules: ${missingNativeSources.join(", ")}`,
    );
  }
  return Object.freeze({
    scanned: Object.freeze(scanned),
    violations: Object.freeze(violations),
  });
}

export async function scanReactNativeDirectWebOutput(root: string): Promise<{
  readonly scanned: readonly string[];
  readonly observedMarkers: readonly string[];
}> {
  const scanned: string[] = [];
  const observed = new Set<string>();
  const observedSources = new Set<string>();
  let executableFiles = 0;
  let sourceMaps = 0;
  const executablePaths = new Set<string>();
  const mappedExecutablePaths = new Set<string>();
  for await (const path of walk(root)) {
    const file = relative(root, path);
    scanned.push(file);
    const contents = await readFile(path);
    const extension = extname(file).toLowerCase();
    if (EXECUTABLE_EXTENSIONS.has(extension)) {
      executableFiles += 1;
      executablePaths.add(file);
      for (const marker of REQUIRED_WEB_MARKERS) {
        if (contents.includes(Buffer.from(marker))) observed.add(marker);
      }
    }
    if (extension === ".map") {
      sourceMaps += 1;
      mappedExecutablePaths.add(file.slice(0, -".map".length));
      for (const source of sourceMapSources(contents, file)) observedSources.add(source);
    }
  }
  if (scanned.length === 0) {
    throw new Error(`React Native Direct web boundary scanned no emitted files under ${root}`);
  }
  if (executableFiles === 0) {
    throw new Error(`React Native Direct web boundary scanned no emitted executable bundles under ${root}`);
  }
  if (sourceMaps === 0) {
    throw new Error(`React Native Direct web boundary scanned no emitted source maps under ${root}`);
  }
  const unmappedExecutables = [...executablePaths]
    .filter((file) => !mappedExecutablePaths.has(file));
  if (unmappedExecutables.length > 0) {
    throw new Error(
      `React Native Direct web output has executables without paired source maps: ${unmappedExecutables.join(", ")}`,
    );
  }
  const missing = REQUIRED_WEB_MARKERS.filter((marker) => !observed.has(marker));
  if (missing.length > 0) {
    throw new Error(`React Native Direct web output is missing markers: ${missing.join(", ")}`);
  }
  const missingSources = REQUIRED_WEB_SOURCES.filter((source) => !observedSources.has(source));
  if (missingSources.length > 0) {
    throw new Error(
      `React Native Direct web source maps are missing composition modules: ${missingSources.join(", ")}`,
    );
  }
  const forbiddenSources = FORBIDDEN_WEB_SOURCES.filter((source) => observedSources.has(source));
  if (forbiddenSources.length > 0) {
    throw new Error(
      `React Native Direct web source maps contain native composition modules: ${forbiddenSources.join(", ")}`,
    );
  }
  return Object.freeze({
    scanned: Object.freeze(scanned),
    observedMarkers: Object.freeze(REQUIRED_WEB_MARKERS.filter((marker) => observed.has(marker))),
  });
}
