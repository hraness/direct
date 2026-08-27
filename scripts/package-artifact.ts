import { readFile, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const blockSize = 512;
const packagePrefix = "package/";

const packageBudget = Object.freeze({
  fileCount: { min: 50, max: 60 },
  packedBytes: { min: 140_000, max: 180_000 },
  unpackedBytes: { min: 650_000, max: 750_000 },
});

const requiredPaths = Object.freeze([
  "LICENSE",
  "README.md",
  "package.json",
  "dist/core/index.js",
  "dist/index.js",
  "dist/react.js",
  "dist/testing/index.js",
  "dist/tooling/bombadil.js",
  "dist/tooling/browser-verification-entry.js",
  "dist/tooling/bundle-boundary.js",
  "dist/web.js",
  "skills/direct/SKILL.md",
  "skills/direct/agents/openai.yaml",
  "skills/direct/references/adoption.md",
  "skills/direct/references/install.md",
  "skills/direct/references/verification.md",
  "src/index.ts",
  "src/react.ts",
  "src/tooling/bombadil-campaign.ts",
  "src/web.ts",
]);

export interface PackageArtifactInventory {
  readonly fileCount: number;
  readonly files: readonly Readonly<{ path: string; size: number }>[];
  readonly packedBytes: number;
  readonly unpackedBytes: number;
}

function readString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  const boundedEnd = end === -1 || end > start + length ? start + length : end;
  return block.subarray(start, boundedEnd).toString("utf8");
}

function readOctal(block: Buffer, start: number, length: number, label: string): number {
  const value = readString(block, start, length).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new Error(`Package tar ${label} is not an octal integer`);
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Package tar ${label} is outside the safe integer range`);
  }
  return parsed;
}

function verifyHeaderChecksum(block: Buffer, offset: number): void {
  const expected = readOctal(block, 148, 8, `header checksum at byte ${String(offset)}`);
  let actual = 0;
  for (let index = 0; index < block.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : block[index] ?? 0;
  }
  if (actual !== expected) {
    throw new Error(
      `Package tar header checksum at byte ${String(offset)} is ${String(actual)}, expected ${String(expected)}`,
    );
  }
}

function relativePackagePath(path: string): string {
  if (!path.startsWith(packagePrefix)) {
    throw new Error(`Package tar entry is outside ${packagePrefix}: ${path}`);
  }
  const relative = path.slice(packagePrefix.length);
  if (
    relative.length === 0
    || relative.startsWith("/")
    || relative.includes("\\")
    || relative.split("/").includes("..")
  ) {
    throw new Error(`Package tar entry has an unsafe path: ${path}`);
  }
  return relative;
}

function verifyAllowedPath(path: string): void {
  const allowed = path === "LICENSE"
    || path === "README.md"
    || path === "package.json"
    || path.startsWith("dist/")
    || path.startsWith("skills/direct/")
    || path.startsWith("src/");
  if (!allowed) throw new Error(`Unexpected package path: ${path}`);
  if (/\.(?:property\.)?test\.[cm]?[jt]sx?$/u.test(path)) {
    throw new Error(`Test source entered the package: ${path}`);
  }
  if (path.endsWith("/AGENTS.md") && path !== "skills/direct/AGENTS.md") {
    throw new Error(`Repository guidance entered the package: ${path}`);
  }
  if (/(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|node_modules(?:\/|$))/u.test(path)) {
    throw new Error(`Private or development state entered the package: ${path}`);
  }
}

function verifyBound(label: string, value: number, range: Readonly<{ min: number; max: number }>): void {
  if (value < range.min || value > range.max) {
    throw new Error(
      `Package ${label} ${String(value)} is outside the reviewed range ${String(range.min)}-${String(range.max)}`,
    );
  }
}

export async function inspectPackageArtifact(
  archive: string,
): Promise<PackageArtifactInventory> {
  const compressed = await readFile(archive);
  const tar = gunzipSync(compressed);
  const files: { path: string; size: number }[] = [];
  const seen = new Set<string>();

  let offset = 0;
  while (offset + blockSize <= tar.length) {
    const header = tar.subarray(offset, offset + blockSize);
    if (header.every((byte) => byte === 0)) break;
    verifyHeaderChecksum(header, offset);

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const size = readOctal(header, 124, 12, `entry size for ${path}`);
    const type = String.fromCharCode(header[156] ?? 0);
    const nextOffset = offset + blockSize + Math.ceil(size / blockSize) * blockSize;
    if (nextOffset > tar.length) {
      throw new Error(`Package tar entry exceeds the archive: ${path}`);
    }

    if (type === "\0" || type === "0") {
      const relative = relativePackagePath(path);
      verifyAllowedPath(relative);
      if (seen.has(relative)) throw new Error(`Duplicate package path: ${relative}`);
      seen.add(relative);
      files.push({ path: relative, size });
    } else if (type !== "5") {
      throw new Error(`Unsupported package tar entry type ${JSON.stringify(type)}: ${path}`);
    }
    offset = nextOffset;
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  for (const path of requiredPaths) {
    if (!seen.has(path)) throw new Error(`Required package path is missing: ${path}`);
  }

  const packedBytes = (await stat(archive)).size;
  const unpackedBytes = files.reduce((total, file) => total + file.size, 0);
  verifyBound("file count", files.length, packageBudget.fileCount);
  verifyBound("packed byte count", packedBytes, packageBudget.packedBytes);
  verifyBound("unpacked byte count", unpackedBytes, packageBudget.unpackedBytes);

  console.log(`Reviewed package inventory (${String(files.length)} files):`);
  for (const file of files) {
    console.log(`${String(file.size).padStart(8, " ")}  ${file.path}`);
  }
  console.log(
    `Package budget: ${String(packedBytes)} packed bytes; ${String(unpackedBytes)} unpacked bytes; ${String(files.length)} files.`,
  );

  return Object.freeze({
    fileCount: files.length,
    files: Object.freeze(files),
    packedBytes,
    unpackedBytes,
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === undefined) {
    throw new Error("Usage: bun run scripts/package-artifact.ts <package.tgz>");
  }
  await inspectPackageArtifact(args[0]);
}
