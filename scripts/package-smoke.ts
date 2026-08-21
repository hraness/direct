import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageName = "@hraness/direct";
const runtimeImportSpecifiers = [
  "@hraness/direct",
  "@hraness/direct/core",
  "@hraness/direct/react",
  "@hraness/direct/testing",
  "@hraness/direct/web",
];
const toolingImportSpecifiers = [
  "@hraness/direct/tooling/browser-verification",
  "@hraness/direct/tooling/bundle-boundary",
];
const importSpecifiers = [...runtimeImportSpecifiers, ...toolingImportSpecifiers];
const binNames = [];
const verificationPackages = ["@eslint/js@^9.39.2","@expo/metro-runtime@~57.0.6","@types/bun@^1.3.14","@types/node@^24.10.0","@types/react@^19.2.14","@types/react-dom@^19.2.3","@vitejs/plugin-react@^6.0.3","eslint@^9.39.2","expo@~57.0.9","fast-check@^4.8.0","react@19.2.3","react-dom@19.2.3","react-native@0.86.2","react-native-web@~0.21.2","typescript@^6.0.3","typescript-eslint@^8.53.0","vite@^8.1.5"];

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
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
  const immutablePin = `github:hraness/direct#v${packageVersion}`;
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

function typeImportSource(specifiers: readonly string[]): string {
  return `${specifiers
    .map((specifier, index) => `import * as surface${String(index)} from ${JSON.stringify(specifier)};`)
    .join("\n")}\nvoid [${specifiers.map((_, index) => `surface${String(index)}`).join(", ")}];\n`;
}

function typeScriptConfig(options: {
  readonly include: string;
  readonly module: "NodeNext" | "Preserve";
  readonly moduleResolution: "Bundler" | "NodeNext";
  readonly tooling: boolean;
}): string {
  return `${JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      lib: ["ES2023", "DOM", "DOM.Iterable"],
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
      skipLibCheck: options.tooling,
      ...(options.tooling ? { types: ["bun", "node"] } : {}),
      module: options.module,
      moduleResolution: options.moduleResolution,
    },
    include: [options.include],
  }, null, 2)}\n`;
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
const work = await mkdtemp(join(tmpdir(), "hraness-package-smoke-"));
try {
  const archive = join(work, "package.tgz");
  const consumer = join(work, "consumer");
  await mkdir(consumer);
  await run([
    process.execPath,
    "pm",
    "pack",
    "--filename",
    archive,
    "--ignore-scripts",
    "--quiet",
  ], repository);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run([process.execPath, "add", archive, "--ignore-scripts"], consumer);
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
  await writeFile(join(consumer, "tooling-index.ts"), typeImportSource(toolingImportSpecifiers));
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
  await writeFile(join(consumer, "installed-tooling-smoke.ts"), `
    import {
      normalizeRootHttpOrigin,
      readDirectBrowserContract,
    } from "@hraness/direct/tooling/browser-verification";
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
} finally {
  await rm(work, { recursive: true, force: true });
}
