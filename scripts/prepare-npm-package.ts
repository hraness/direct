import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { inspectPackageArtifact } from "./package-artifact.js";

const packageName = "@hraness/direct";
const requiredNpmVersion = "11.19.0";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return field;
}

function integerField(value: Record<string, unknown>, key: string, label: string): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < 0) {
    throw new Error(`${label}.${key} must be a non-negative safe integer`);
  }
  return field as number;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(source[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function exactField(
  value: Record<string, unknown>,
  key: string,
  expected: unknown,
  label: string,
): void {
  if (canonicalJson(value[key]) !== canonicalJson(expected)) {
    throw new Error(`${label}.${key} does not match the public package contract`);
  }
}

function verifyPublicManifest(manifest: Record<string, unknown>): string {
  const manifestName = stringField(manifest, "name", "package.json");
  const manifestVersion = stringField(manifest, "version", "package.json");
  if (manifestName !== packageName) {
    throw new Error(`package.json name is ${manifestName}, expected ${packageName}`);
  }
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(manifestVersion)) {
    throw new Error(`package.json version is not a stable semantic version: ${manifestVersion}`);
  }
  stringField(manifest, "description", "package.json");
  exactField(manifest, "license", "MIT", "package.json");
  exactField(manifest, "type", "module", "package.json");
  exactField(manifest, "packageManager", "bun@1.3.14", "package.json");
  exactField(manifest, "repository", {
    type: "git",
    url: "git+https://github.com/hraness/direct.git",
  }, "package.json");
  exactField(manifest, "homepage", "https://hraness.com/direct", "package.json");
  exactField(manifest, "bugs", {
    url: "https://github.com/hraness/direct/issues",
  }, "package.json");
  exactField(manifest, "publishConfig", {
    access: "public",
    registry: "https://registry.npmjs.org",
  }, "package.json");
  if (manifest.private === true) throw new Error("package.json cannot be private");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("package.json.files must be a non-empty allowlist");
  }
  if (
    typeof manifest.exports !== "object"
    || manifest.exports === null
    || Array.isArray(manifest.exports)
  ) {
    throw new Error("package.json.exports must be an object");
  }
  if (manifest.dependencies !== undefined) {
    const dependencies = record(manifest.dependencies, "package.json.dependencies");
    if (Object.keys(dependencies).length > 0) {
      throw new Error("Direct's public package cannot add runtime dependencies implicitly");
    }
  }
  return manifestVersion;
}

async function capture(
  command: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
): Promise<string> {
  const process = Bun.spawn([...command], env === undefined
    ? { cwd, stdout: "pipe", stderr: "inherit" }
    : {
        cwd,
        env: { ...globalThis.process.env, ...env },
        stdout: "pipe",
        stderr: "inherit",
      });
  const stdout = await new Response(process.stdout).text();
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
  }
  return stdout.trim();
}

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === undefined) {
  throw new Error("Usage: bun run scripts/prepare-npm-package.ts <output-directory>");
}

const repository = process.cwd();
const outputDirectory = resolve(repository, args[0]);
const manifest = record(
  JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as unknown,
  "package.json",
);
const manifestName = stringField(manifest, "name", "package.json");
const manifestVersion = verifyPublicManifest(manifest);

const work = await mkdtemp(join(tmpdir(), "direct-npm-pack-"));
try {
  const npmEnvironment = { NPM_CONFIG_CACHE: join(work, "npm-cache") };
  const npmVersion = await capture(["npm", "--version"], repository, npmEnvironment);
  if (npmVersion !== requiredNpmVersion) {
    throw new Error(`npm ${requiredNpmVersion} is required, received ${npmVersion}`);
  }

  await mkdir(outputDirectory, { recursive: true });
  const existingOutput = await readdir(outputDirectory);
  if (existingOutput.length > 0) {
    throw new Error(`Package output directory must be empty: ${outputDirectory}`);
  }
  const packOutput = await capture([
    "npm",
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    outputDirectory,
  ], repository, npmEnvironment);
  const parsed = JSON.parse(packOutput) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack must report exactly one package");
  }
  const result = record(parsed[0], "npm pack result");
  const resultName = stringField(result, "name", "npm pack result");
  const resultVersion = stringField(result, "version", "npm pack result");
  const filename = stringField(result, "filename", "npm pack result");
  if (resultName !== manifestName || resultVersion !== manifestVersion) {
    throw new Error(
      `npm pack reported ${resultName}@${resultVersion}, expected ${manifestName}@${manifestVersion}`,
    );
  }
  if (filename !== basename(filename) || !filename.endsWith(".tgz")) {
    throw new Error(`npm pack returned an unsafe filename: ${filename}`);
  }
  const expectedFilename = `hraness-direct-${manifestVersion}.tgz`;
  if (filename !== expectedFilename) {
    throw new Error(`npm pack returned ${filename}, expected ${expectedFilename}`);
  }

  const archive = join(outputDirectory, filename);
  const inventory = await inspectPackageArtifact(archive);
  const reportedFileCount = integerField(result, "entryCount", "npm pack result");
  const reportedPackedBytes = integerField(result, "size", "npm pack result");
  const reportedUnpackedBytes = integerField(result, "unpackedSize", "npm pack result");
  if (
    reportedFileCount !== inventory.fileCount
    || reportedPackedBytes !== inventory.packedBytes
    || reportedUnpackedBytes !== inventory.unpackedBytes
  ) {
    throw new Error("npm pack summary does not match the inspected tar archive");
  }

  console.log(`npm integrity: ${stringField(result, "integrity", "npm pack result")}`);
  console.log(`Prepared npm package: ${archive}`);
} finally {
  await rm(work, { force: true, recursive: true });
}
