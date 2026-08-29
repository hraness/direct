import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  inspectPackageArtifact,
  type PackageArtifactInventory,
} from "./package-artifact.js";

const packageName = "@hraness/direct";
const npmRegistry = "https://registry.npmjs.org";
const runtimeImportSpecifiers = [
  "@hraness/direct",
  "@hraness/direct/core",
  "@hraness/direct/react",
  "@hraness/direct/testing",
  "@hraness/direct/web",
];
const toolingRuntimeImportSpecifiers = [
  "@hraness/direct/tooling/browser-verification",
  "@hraness/direct/tooling/bombadil",
  "@hraness/direct/tooling/bundle-boundary",
];
const toolingTypeImportSpecifiers = [
  ...toolingRuntimeImportSpecifiers,
  "@hraness/direct/tooling/bombadil-campaign",
];
const importSpecifiers = [...runtimeImportSpecifiers, ...toolingRuntimeImportSpecifiers];
const binNames: readonly string[] = [];
const verificationPackages = ["@antithesishq/bombadil@0.7.2","@eslint/js@^9.39.2","@expo/metro-runtime@~57.0.6","@types/bun@^1.3.14","@types/node@^24.10.0","@types/react@^19.2.14","@types/react-dom@^19.2.3","@vitejs/plugin-react@^6.0.3","eslint@^9.39.2","expo@~57.0.9","fast-check@^4.8.0","react@19.2.3","react-dom@19.2.3","react-native@0.86.2","react-native-web@~0.21.2","typescript@^6.0.3","typescript-eslint@^8.53.0","vite@^8.1.5"];

type PackageInput = Readonly<{
  archive?: string;
  packJson?: string;
}>;

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

function resolveInputPath(repository: string, path: string): string {
  return isAbsolute(path) ? path : resolve(repository, path);
}

function parsePackageInput(args: readonly string[], repository: string): PackageInput {
  if (args.length === 0) return {};
  if (args.length === 1 && args[0] !== undefined && !args[0].startsWith("--")) {
    return { archive: resolveInputPath(repository, args[0]) };
  }
  if (args.length !== 4) {
    throw new Error(
      "Usage: bun run scripts/package-smoke.ts [package.tgz] | --archive <package.tgz> --pack-json <npm-pack.json>",
    );
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--archive" && flag !== "--pack-json") || value === undefined || values.has(flag)) {
      throw new Error(
        "Usage: bun run scripts/package-smoke.ts [package.tgz] | --archive <package.tgz> --pack-json <npm-pack.json>",
      );
    }
    values.set(flag, resolveInputPath(repository, value));
  }
  const archive = values.get("--archive");
  const packJson = values.get("--pack-json");
  if (archive === undefined || packJson === undefined) {
    throw new Error(
      "Usage: bun run scripts/package-smoke.ts [package.tgz] | --archive <package.tgz> --pack-json <npm-pack.json>",
    );
  }
  return { archive, packJson };
}

async function verifyExactNpmPackMetadata(
  archive: string,
  packJson: string,
  packageVersion: string,
  inventory: PackageArtifactInventory,
): Promise<void> {
  const value = JSON.parse(await readFile(packJson, "utf8")) as unknown;
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("npm-pack.json must contain exactly one package");
  }
  const result = record(value[0], "npm pack result");
  const expectedFilename = `hraness-direct-${packageVersion}.tgz`;
  if (
    stringField(result, "id", "npm pack result") !== `${packageName}@${packageVersion}`
    || stringField(result, "name", "npm pack result") !== packageName
    || stringField(result, "version", "npm pack result") !== packageVersion
    || stringField(result, "filename", "npm pack result") !== expectedFilename
    || basename(archive) !== expectedFilename
  ) {
    throw new Error("npm pack identity does not match the exact Direct archive");
  }
  const entryCount = integerField(result, "entryCount", "npm pack result");
  const packedBytes = integerField(result, "size", "npm pack result");
  const unpackedBytes = integerField(result, "unpackedSize", "npm pack result");
  if (
    entryCount !== inventory.fileCount
    || packedBytes !== inventory.packedBytes
    || unpackedBytes !== inventory.unpackedBytes
  ) {
    throw new Error("npm pack metrics do not match the exact Direct archive");
  }

  if (!Array.isArray(result.files) || result.files.length !== entryCount) {
    throw new Error("npm pack file inventory does not match entryCount");
  }
  const reportedFiles = new Map<string, Readonly<{ mode: number; size: number }>>();
  for (const [index, value] of result.files.entries()) {
    const file = record(value, `npm pack result file ${String(index + 1)}`);
    const path = stringField(file, "path", `npm pack result file ${String(index + 1)}`);
    const size = integerField(file, "size", `npm pack result file ${String(index + 1)}`);
    const mode = integerField(file, "mode", `npm pack result file ${String(index + 1)}`);
    if (
      path.includes("\\")
      || path.startsWith("/")
      || path.split("/").some((part) => part === "" || part === "." || part === "..")
      || reportedFiles.has(path)
    ) {
      throw new Error(`npm pack file inventory contains an unsafe or duplicate path: ${path}`);
    }
    if (mode !== 0o644 && mode !== 0o755) {
      throw new Error(`npm pack file inventory contains an unsafe mode for ${path}`);
    }
    reportedFiles.set(path, Object.freeze({ mode, size }));
  }
  for (const file of inventory.files) {
    const reported = reportedFiles.get(file.path);
    if (reported?.size !== file.size || reported.mode !== file.mode) {
      throw new Error(
        `npm pack file inventory differs from the exact archive mode or size for ${file.path}`,
      );
    }
  }
  if (reportedFiles.size !== inventory.files.length) {
    throw new Error("npm pack file inventory contains a path absent from the exact archive");
  }

  const archiveBytes = await readFile(archive);
  const actualIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
  const actualShasum = createHash("sha1").update(archiveBytes).digest("hex");
  if (
    stringField(result, "integrity", "npm pack result") !== actualIntegrity
    || stringField(result, "shasum", "npm pack result") !== actualShasum
  ) {
    throw new Error("npm pack SHA-1 or SHA-512 does not match the exact Direct archive");
  }
}

async function run(
  command: string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
): Promise<void> {
  const process = Bun.spawn(command, env === undefined
    ? { cwd, stdout: "inherit", stderr: "inherit" }
    : {
        cwd,
        env: { ...globalThis.process.env, ...env },
        stdout: "inherit",
        stderr: "inherit",
      });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
}

async function verifyPackagedSkill(
  consumer: string,
  packageVersion: string,
): Promise<void> {
  const skillsRoot = join(
    consumer,
    "node_modules",
    "@hraness",
    "direct",
    "skills",
  );
  const skillRoot = join(skillsRoot, "direct");
  const skillPath = join(skillRoot, "SKILL.md");
  const installedSkillDirectories = (await readdir(skillsRoot, {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (installedSkillDirectories.join(",") !== "direct") {
    throw new Error(
      `Expected one packaged Direct skill, received ${installedSkillDirectories.join(", ")}`,
    );
  }

  await access(skillPath);
  const skill = await readFile(skillPath, "utf8");
  if (!skill.includes("name: direct")) {
    throw new Error("Packaged skill frontmatter does not declare Direct");
  }

  const referenceLinks = [...skill.matchAll(/\]\((references\/[^)#]+)(?:#[^)]*)?\)/g)]
    .map((match) => match[1]);
  const requiredReferences = [
    "references/adoption.md",
    "references/install.md",
    "references/verification.md",
  ];
  for (const reference of requiredReferences) {
    if (!referenceLinks.includes(reference)) {
      throw new Error(`Packaged skill does not route to ${reference}`);
    }
    await access(join(skillRoot, reference));
  }

  const install = await readFile(join(skillRoot, "references", "install.md"), "utf8");
  const immutablePin = `@hraness/direct@${packageVersion}`;
  if (!install.includes(immutablePin)) {
    throw new Error(`Packaged skill install guide is missing ${immutablePin}`);
  }

  const interfaceMetadata = await readFile(
    join(skillRoot, "agents", "openai.yaml"),
    "utf8",
  );
  if (!interfaceMetadata.includes("$direct")) {
    throw new Error("Packaged skill UI metadata does not invoke $direct");
  }
}

async function verifyInstalledManifest(
  consumer: string,
  packageVersion: string,
): Promise<void> {
  const [value, sourceValue] = await Promise.all([
    readFile(
      join(consumer, "node_modules", "@hraness", "direct", "package.json"),
      "utf8",
    ).then((source) => JSON.parse(source) as unknown),
    readFile(join(repository, "package.json"), "utf8")
      .then((source) => JSON.parse(source) as unknown),
  ]);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Installed Direct package manifest is not an object");
  }
  const sourceManifest = record(sourceValue, "source Direct package manifest");
  const manifest = value as Record<string, unknown>;
  const repositoryMetadata = manifest.repository;
  const bugs = manifest.bugs;
  const publishConfig = manifest.publishConfig;
  if (
    manifest.name !== packageName
    || manifest.version !== packageVersion
    || typeof sourceManifest.description !== "string"
    || !Array.isArray(sourceManifest.keywords)
    || manifest.description !== sourceManifest.description
    || JSON.stringify(manifest.keywords) !== JSON.stringify(sourceManifest.keywords)
    || manifest.license !== "MIT"
    || manifest.homepage !== "https://hraness.com/direct"
    || typeof repositoryMetadata !== "object"
    || repositoryMetadata === null
    || Array.isArray(repositoryMetadata)
    || (repositoryMetadata as Record<string, unknown>).type !== "git"
    || (repositoryMetadata as Record<string, unknown>).url
      !== "git+https://github.com/hraness/direct.git"
    || typeof bugs !== "object"
    || bugs === null
    || Array.isArray(bugs)
    || (bugs as Record<string, unknown>).url
      !== "https://github.com/hraness/direct/issues"
    || typeof publishConfig !== "object"
    || publishConfig === null
    || Array.isArray(publishConfig)
    || (publishConfig as Record<string, unknown>).access !== "public"
    || (publishConfig as Record<string, unknown>).registry
      !== "https://registry.npmjs.org"
  ) {
    throw new Error("Installed Direct package manifest does not match the public contract");
  }
}

function typeImportSource(specifiers: readonly string[]): string {
  return `${specifiers
    .map((specifier, index) => `import * as surface${String(index)} from ${JSON.stringify(specifier)};`)
    .join("\n")}\nvoid [${specifiers.map((_, index) => `surface${String(index)}`).join(", ")}];\n`;
}

function typeScriptConfig(options: {
  readonly include: string;
  readonly module: "NodeNext" | "Preserve";
  readonly moduleResolution: "Bundler" | "NodeNext";
  readonly skipLibCheck?: boolean;
  readonly tooling: boolean;
}): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
      skipLibCheck: options.skipLibCheck ?? options.tooling,
      ...(options.tooling ? { types: ["bun", "node"] } : {}),
      module: options.module,
      moduleResolution: options.moduleResolution,
    },
    include: [options.include],
  }, null, 2)}\n`;
}

type BombadilFeatureProfile = "artifact-delivery" | "baseline" | "matrix";

function selectBombadilFeatureProfile(version: string): BombadilFeatureProfile {
  if (Bun.semver.order(version, "0.7.8") >= 0) return "artifact-delivery";
  if (Bun.semver.order(version, "0.7.6") >= 0) return "matrix";
  return "baseline";
}

function bombadilToolingTypeChecks(profile: BombadilFeatureProfile): string {
  if (profile === "artifact-delivery") {
    return `
    type BombadilRunnerArity = Parameters<typeof surface1.runDirectBombadilFuzz>["length"];
    type BombadilRunnerInput = Parameters<typeof surface1.runDirectBombadilFuzz>[1];
    type BombadilMatrixInput = Parameters<typeof surface1.runDirectBombadilFuzzMatrix>[1];
    const supportedBombadilRunnerArities: readonly BombadilRunnerArity[] = [1, 2];
    const supportedBombadilArguments = ["--time-limit=12s"] as const;
    const supportedBombadilRunnerInput: BombadilRunnerInput = {
      arguments: supportedBombadilArguments,
      artifactRun: {
        repositoryRoot: "/absolute/repository",
        runId: "00000000-0000-4000-8000-000000000001",
        uploadMode: "public-summary",
      },
    };
    const supportedBombadilTupleInput: BombadilRunnerInput = supportedBombadilArguments;
    const supportedBombadilMatrixInput: BombadilMatrixInput = {
      arguments: supportedBombadilArguments,
      artifactRun: {
        repositoryRoot: "/absolute/repository",
        runId: "00000000-0000-4000-8000-000000000002",
        uploadMode: "public-summary",
      },
    };
    const unsupportedPrivateBombadilMatrixInput: BombadilMatrixInput = {
      artifactRun: {
        repositoryRoot: "/absolute/repository",
        runId: "00000000-0000-4000-8000-000000000003",
        // @ts-expect-error Packaged matrix uploads are public-summary only.
        uploadMode: "private-vetted",
      },
    };
    // @ts-expect-error Public tooling does not expose dependency injection.
    const unsupportedBombadilRunnerArity: BombadilRunnerArity = 3;
    void [supportedBombadilMatrixInput, supportedBombadilRunnerArities, supportedBombadilRunnerInput, supportedBombadilTupleInput, unsupportedBombadilRunnerArity, unsupportedPrivateBombadilMatrixInput];
  `;
  }
  const matrixChecks = profile === "matrix"
    ? `
    type BombadilMatrixInput = Parameters<typeof surface1.runDirectBombadilFuzzMatrix>[1];
    const supportedBombadilMatrixInput: BombadilMatrixInput = supportedBombadilArguments;
    void supportedBombadilMatrixInput;
  `
    : "";
  return `
    type BombadilRunnerArity = Parameters<typeof surface1.runDirectBombadilFuzz>["length"];
    type BombadilRunnerInput = Parameters<typeof surface1.runDirectBombadilFuzz>[1];
    const supportedBombadilRunnerArities: readonly BombadilRunnerArity[] = [1, 2];
    const supportedBombadilArguments = ["--time-limit=12s"] as const;
    const supportedBombadilRunnerInput: BombadilRunnerInput = supportedBombadilArguments;
    // @ts-expect-error Public tooling does not expose dependency injection.
    const unsupportedBombadilRunnerArity: BombadilRunnerArity = 3;
    void [supportedBombadilRunnerArities, supportedBombadilRunnerInput, unsupportedBombadilRunnerArity];
  ${matrixChecks}`;
}

function bombadilRuntimeImports(profile: BombadilFeatureProfile): string {
  const importedNames = profile === "artifact-delivery"
    ? [
        "parseDirectBombadilArtifactReceipt",
        "parseDirectBombadilMatrixReceipt",
        "parseDirectBombadilMatrixSummary",
        "parseDirectBombadilSanitizedRunSummary",
        "resolveDirectBombadilUploadLeaf",
        "runDirectBombadilFuzz",
      ]
    : ["runDirectBombadilFuzz"];
  return `import {\n${importedNames.map((name) => `      ${name},`).join("\n")}\n    } from "@hraness/direct/tooling/bombadil";`;
}

function bombadilArtifactDeliverySmoke(profile: BombadilFeatureProfile): string {
  if (profile !== "artifact-delivery") return "";
  return `
    const sha256 = "a".repeat(64);
    const policy = {
      maxDepth: 32,
      maxEntries: 4096,
      maxFileBytes: 67108864,
      maxFiles: 2048,
      maxPathBytes: 4096,
      maxTotalBytes: 134217728,
    };
    const runId = "00000000-0000-4000-8000-000000000001";
    const receipt = {
      schema: "direct.bombadil-artifact-receipt/v1",
      completedAt: "2026-08-29T00:00:00.000Z",
      diagnosticsRetained: false,
      failureCode: null,
      inventory: { entryCount: 1, fileCount: 1, inventorySha256: sha256, totalBytes: 1 },
      mode: "public-summary",
      policy,
      runId,
      status: "passed",
    };
    const summary = {
      schema: "direct.bombadil-upload-summary/v1",
      artifactName: "package-smoke",
      attestation: { invalidObservationCount: 0, observationCount: 1, validObservationCount: 1 },
      exploration: {
        actionCount: 0,
        nonWaitActionCount: 0,
        policySatisfied: true,
        traceBytes: 1,
        traceLineCount: 1,
        traceSha256: sha256,
      },
      failureCode: null,
      scenario: "package.ready",
      status: "passed",
    };
    const matrixReceipt = {
      schema: "direct.bombadil-matrix-receipt/v1",
      campaigns: [{
        campaignId: "package-smoke",
        index: 0,
        receipt: "campaigns/package-smoke/receipt.json",
        status: "passed",
      }],
      completedAt: "2026-08-29T00:00:00.000Z",
      failureCode: null,
      mode: "public-summary",
      omittedCampaignCount: 0,
      runId,
      status: "passed",
    };
    const matrixSummary = {
      schema: "direct.bombadil-matrix-summary/v1",
      campaigns: {
        failed: 0,
        notRun: 0,
        notSelected: 0,
        omitted: 0,
        passed: 1,
        rejected: 0,
        total: 1,
      },
      failureCode: null,
      status: "passed",
    };
    if (
      !parseDirectBombadilArtifactReceipt(receipt).ok
      || !parseDirectBombadilSanitizedRunSummary(summary).ok
      || !parseDirectBombadilMatrixReceipt(matrixReceipt).ok
      || !parseDirectBombadilMatrixSummary(matrixSummary).ok
    ) {
      throw new Error("Bombadil package evidence parsers rejected exact valid fixtures");
    }
    if (
      parseDirectBombadilArtifactReceipt({ ...receipt, extra: true }).ok
      || parseDirectBombadilMatrixReceipt({ ...matrixReceipt, schema: "wrong" }).ok
      || parseDirectBombadilSanitizedRunSummary({ ...summary, failureCode: "unknown" }).ok
    ) {
      throw new Error("Bombadil package evidence parsers accepted malformed fixtures");
    }
    const uploadLeaf = resolveDirectBombadilUploadLeaf({
      repositoryRoot: "/absolute/repository",
      runId,
      uploadMode: "public-summary",
    });
    if (uploadLeaf !== "/absolute/repository/artifacts/direct-bombadil-upload/" + runId) {
      throw new Error("Bombadil upload-leaf resolver returned an unexpected path");
    }
  `;
}

const repository = process.cwd();
const packageManifest = await Bun.file(join(repository, "package.json")).json();
if (
  typeof packageManifest !== "object"
  || packageManifest === null
  || !("version" in packageManifest)
  || typeof packageManifest.version !== "string"
) {
  throw new Error("package.json must declare a string version");
}
const bombadilFeatureProfile = selectBombadilFeatureProfile(packageManifest.version);
const work = await mkdtemp(join(tmpdir(), "hraness-package-smoke-"));
try {
  const packageInput = parsePackageInput(process.argv.slice(2), repository);
  const suppliedArchive = packageInput.archive;
  const archive = suppliedArchive === undefined
    ? join(work, "package.tgz")
    : suppliedArchive;
  const consumer = join(work, "consumer");
  const npmConsumer = join(work, "npm-consumer");
  await mkdir(consumer);
  if (suppliedArchive === undefined) {
    await run([
      process.execPath,
      "pm",
      "pack",
      "--filename",
      archive,
      "--ignore-scripts",
      "--quiet",
    ], repository);
  }
  const inventory = await inspectPackageArtifact(archive);
  if (packageInput.packJson !== undefined) {
    await verifyExactNpmPackMetadata(
      archive,
      packageInput.packJson,
      packageManifest.version,
      inventory,
    );
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run([process.execPath, "add", archive, "--ignore-scripts"], consumer);
  await verifyInstalledManifest(consumer, packageManifest.version);
  await verifyPackagedSkill(consumer, packageManifest.version);
  await run(["node", "--input-type=module", "-e", `await import(${JSON.stringify(packageName)})`], consumer);
  for (const binName of binNames) {
    await run([join(consumer, "node_modules", ".bin", binName), "--help"], consumer);
  }
  if (verificationPackages.length > 0) {
    await run([process.execPath, "add", ...verificationPackages, "--ignore-scripts"], consumer);
  }
  await run([
    "node",
    "--input-type=module",
    "-e",
    `await Promise.all(${JSON.stringify(importSpecifiers)}.map((specifier) => import(specifier)))`,
  ], consumer);
  await writeFile(join(consumer, "runtime-index.ts"), typeImportSource(runtimeImportSpecifiers));
  await writeFile(
    join(consumer, "tooling-index.ts"),
    `${typeImportSource(toolingTypeImportSpecifiers)}${bombadilToolingTypeChecks(bombadilFeatureProfile)}`,
  );
  await writeFile(join(consumer, "tsconfig.bundler.json"), typeScriptConfig({
    include: "runtime-index.ts",
    module: "Preserve",
    moduleResolution: "Bundler",
    tooling: false,
  }));
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.bundler.json"], consumer);
  await writeFile(join(consumer, "tsconfig.nodenext.json"), typeScriptConfig({
    include: "runtime-index.ts",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    tooling: false,
  }));
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.nodenext.json"], consumer);
  await writeFile(join(consumer, "tsconfig.tooling-bundler.json"), typeScriptConfig({
    include: "tooling-index.ts",
    module: "Preserve",
    moduleResolution: "Bundler",
    tooling: true,
  }));
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.tooling-bundler.json"], consumer);
  await writeFile(join(consumer, "tsconfig.tooling-nodenext.json"), typeScriptConfig({
    include: "tooling-index.ts",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    tooling: true,
  }));
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.tooling-nodenext.json"], consumer);
  await writeFile(join(consumer, "campaign-index.ts"), `
    import {
      createDirectBombadilActions,
      createDirectBombadilProperties,
    } from "@hraness/direct/tooling/bombadil-campaign";
    void [createDirectBombadilActions, createDirectBombadilProperties];
  `);
  await writeFile(join(consumer, "tsconfig.campaign.json"), typeScriptConfig({
    include: "campaign-index.ts",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    skipLibCheck: false,
    tooling: false,
  }));
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.campaign.json"], consumer);
  await writeFile(join(consumer, "installed-tooling-smoke.ts"), `
    import type {
      DirectBombadilProperties,
    } from "@hraness/direct/tooling/bombadil-campaign";
    import {
      normalizeRootHttpOrigin,
      readDirectBrowserContract,
    } from "@hraness/direct/tooling/browser-verification";
    ${bombadilRuntimeImports(bombadilFeatureProfile)}
    import { findForbiddenMarkers } from "@hraness/direct/tooling/bundle-boundary";

    if (normalizeRootHttpOrigin("https://example.test/") !== "https://example.test") {
      throw new Error("browser verification tooling did not normalize the origin");
    }
    const found = findForbiddenMarkers(
      Buffer.from("prefix\\0direct.fixture/v1\\0suffix"),
      ["direct.fixture/v1"],
    );
    if (found.length !== 1 || found[0] !== "direct.fixture/v1") {
      throw new Error("bundle-boundary tooling did not find the marker");
    }
    if (typeof readDirectBrowserContract !== "function") {
      throw new Error("the package-bound Direct browser reader is missing");
    }
    if (typeof runDirectBombadilFuzz !== "function") {
      throw new Error("Bombadil host tooling runner is missing");
    }
    ${bombadilArtifactDeliverySmoke(bombadilFeatureProfile)}
    type CampaignProperties = DirectBombadilProperties;
    void (undefined as unknown as CampaignProperties);
  `);
  await run([process.execPath, "run", "./installed-tooling-smoke.ts"], consumer);

  await writeFile(join(consumer, "browser-runtime.ts"), `
    import { defineDirect } from "@hraness/direct";
    import { installDirectBrowser } from "@hraness/direct/web";
    Object.defineProperty(globalThis, "__directPackageRuntimeSmoke", {
      value: Object.freeze({ defineDirect, installDirectBrowser }),
    });
  `);
  await run([
    process.execPath,
    "build",
    "./browser-runtime.ts",
    "--outdir",
    "./browser-dist",
    "--target",
    "browser",
    "--format",
    "esm",
  ], consumer);
  await writeFile(join(consumer, "verify-runtime-boundary.ts"), `
    import {
      checkBundleBoundary,
      inspectExactVersionedMarkers,
    } from "@hraness/direct/tooling/bundle-boundary";

    const result = await checkBundleBoundary({
      directory: "./browser-dist",
      markers: [
        "@hraness/direct/tooling/",
        "browser-verification",
        "@antithesishq/bombadil",
        "direct.bombadil-run/v1",
        "direct.bombadil-artifact-receipt/v1",
        "direct.bombadil-upload-summary/v1",
        "direct.bombadil-matrix-receipt/v1",
        "direct.bombadil-matrix-summary/v1",
        "bundle-boundary",
        "node:crypto",
        "node:fs",
        "node:path",
        "Bun.Glob",
        "Bun.spawn",
      ],
      patterns: ["**/*.js"],
    });
    if (result.scanned.length === 0) throw new Error("no browser output was scanned");
    if (result.violations.length > 0) {
      throw new Error(JSON.stringify(result.violations));
    }
    const markerEvidence = inspectExactVersionedMarkers(
      await Promise.all(result.scanned.map(async (path) => (
        new Uint8Array(await Bun.file(path).arrayBuffer())
      ))),
      ["direct.browser-bridge/v2", "direct.fixture/v1"],
    );
    if (markerEvidence.missing.length > 0 || markerEvidence.unexpected.length > 0) {
      throw new Error(JSON.stringify(markerEvidence));
    }
  `);
  await run([process.execPath, "run", "./verify-runtime-boundary.ts"], consumer);

  if (suppliedArchive !== undefined) {
    await mkdir(npmConsumer);
    await writeFile(
      join(npmConsumer, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    await run([
      "npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--registry=${npmRegistry}`,
      archive,
    ], npmConsumer, {
      NPM_CONFIG_CACHE: join(work, "npm-cache"),
      NPM_CONFIG_REGISTRY: npmRegistry,
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
    });
    await verifyInstalledManifest(npmConsumer, packageManifest.version);
    await verifyPackagedSkill(npmConsumer, packageManifest.version);
    await run([
      "node",
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(packageName)})`,
    ], npmConsumer);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
