import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  inspectPackageArtifact,
  type PackageArtifactInventory,
} from "./package-artifact.js";
import { verifyNpmPackageIdentity } from "./npm-package-identity.js";

const publishWorkflowUrl = new URL("../.github/workflows/npm-publish.yml", import.meta.url);
const releaseWorkflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const ciWorkflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const manifestUrl = new URL("../package.json", import.meta.url);
const bombadilCampaignUrl = new URL(
  "../src/tooling/bombadil-campaign.ts",
  import.meta.url,
);
const bombadilNamedSnapshotUrl = new URL(
  "../src/tooling/bombadil-named-snapshot.ts",
  import.meta.url,
);
const readmeUrl = new URL("../README.md", import.meta.url);
const packageSmokeUrl = new URL("./package-smoke.ts", import.meta.url);
const packagePreparationUrl = new URL("./prepare-npm-package.ts", import.meta.url);
const packageArtifactUrl = new URL("./package-artifact.ts", import.meta.url);
const packageIdentityUrl = new URL("./npm-package-identity.ts", import.meta.url);
const publishingGuideUrl = new URL("../docs/publishing.md", import.meta.url);
const agentGuideUrl = new URL("../AGENTS.md", import.meta.url);
const npmRegistry = "https://registry.npmjs.org";
const repository = fileURLToPath(new URL("../", import.meta.url));
const historicalRecoverySources = [
  {
    commit: "c6aa5a49c531b45216e3fb043b6e0ab8a392c13d",
    expectedFileCount: 56,
    expectedUnpackedBytes: 697_651,
    version: "0.7.5",
  },
  {
    commit: "3f7c821ffaff1d28ccbde1c635d95f584c1af875",
    version: "0.7.6",
  },
  {
    commit: "8953550e298df061e9b9f4081aced158e497b906",
    version: "0.7.7",
  },
  {
    commit: "13e5fa5d4628706d113252420b57579090363ffc",
    version: "0.7.8",
  },
  {
    commit: "2d702f22916321bea55c2290b791f59fb3430bd1",
    expectedFileCount: 56,
    expectedUnpackedBytes: 997_768,
    version: "0.7.9",
  },
  {
    commit: "14a9fe4cb80d6fdab5fadadaaad02c7bf97b0004",
    expectedFileCount: 59,
    expectedUnpackedBytes: 999_525,
    version: "0.7.10",
  },
  {
    commit: "de73508b155f39052d78736880bae40333d6a9f7",
    expectedFileCount: 59,
    expectedUnpackedBytes: 1_001_925,
    version: "0.7.11",
  },
  {
    commit: "bca2491b1feb7bc9ea3a61529bc1e57e8b0a5a58",
    expectedFileCount: 59,
    expectedUnpackedBytes: 1_002_484,
    version: "0.7.12",
  },
  {
    commit: "80255649c017654ed378e26567df772fbab098ac",
    expectedFileCount: 59,
    expectedUnpackedBytes: 1_020_604,
    version: "0.7.13",
  },
] as const;

function workflowStepScript(workflow: string, name: string): string {
  const stepMarker = `      - name: ${name}\n`;
  const stepStart = workflow.indexOf(stepMarker);
  if (stepStart < 0) throw new Error(`Workflow step not found: ${name}`);
  const runMarker = "        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  if (runStart < 0) throw new Error(`Workflow step has no run script: ${name}`);
  const lines = workflow.slice(runStart + runMarker.length).split("\n");
  const script: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  return script.join("\n");
}

async function runWorkflowScript(
  script: string,
  environment: Readonly<Record<string, string>>,
): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> {
  const child = Bun.spawn(["/bin/bash", "-c", script], {
    cwd: repository,
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return Object.freeze({ exitCode, stderr, stdout });
}

async function run(command: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn([...command], { cwd, stderr: "inherit", stdout: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
}

function sha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function packJson(
  bytes: Uint8Array,
  inventory: PackageArtifactInventory,
  name: string,
  version: string,
  reverseFiles = false,
): string {
  const files = reverseFiles ? [...inventory.files].reverse() : inventory.files;
  return `${JSON.stringify([{
    bundled: [],
    entryCount: inventory.fileCount,
    filename: `hraness-direct-${version}.tgz`,
    files: files.map((file) => ({
      mode: file.mode,
      path: file.path,
      size: file.size,
    })),
    id: `${name}@${version}`,
    integrity: integrity(bytes),
    name,
    shasum: sha1(bytes),
    size: bytes.byteLength,
    unpackedSize: inventory.unpackedBytes,
    version,
  }], null, 2)}\n`;
}

function registryView(
  bytes: Uint8Array,
  inventory: PackageArtifactInventory,
  name: string,
  version: string,
): string {
  return `${JSON.stringify({
    dist: {
      fileCount: inventory.fileCount,
      integrity: integrity(bytes),
      shasum: sha1(bytes),
      tarball: `${npmRegistry}/${name}/-/direct-${version}.tgz`,
      unpackedSize: inventory.unpackedBytes,
    },
    name,
    version,
  }, null, 2)}\n`;
}

function readTarOctal(tar: Buffer, offset: number): number {
  const value = tar.subarray(offset, offset + 12).toString("ascii").replace(/\0.*$/u, "").trim();
  return Number.parseInt(value, 8);
}

function firstRegularHeader(tar: Buffer): Readonly<{ offset: number; size: number }> {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = readTarOctal(tar, offset + 124);
    const type = tar[offset + 156] ?? 0;
    if ((type === 0 || type === 48) && size > 0) return Object.freeze({ offset, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("Test package contains no non-empty regular file");
}

function writeHeaderChecksum(tar: Buffer, offset: number): void {
  tar.fill(32, offset + 148, offset + 156);
  let checksum = 0;
  for (let index = offset; index < offset + 512; index += 1) checksum += tar[index] ?? 0;
  const field = `${checksum.toString(8).padStart(6, "0")}\0 `;
  tar.write(field, offset + 148, 8, "ascii");
}

describe("npm release workflows", () => {
  test("binds the packaged Boa specification to the driver-neutral snapshot source", async () => {
    const [campaign, manifestSource, namedSnapshot, smoke] = await Promise.all([
      readFile(bombadilCampaignUrl, "utf8"),
      readFile(manifestUrl, "utf8"),
      readFile(bombadilNamedSnapshotUrl, "utf8"),
      readFile(packageSmokeUrl, "utf8"),
    ]);
    const manifest = JSON.parse(manifestSource) as {
      readonly exports?: Readonly<Record<string, unknown>>;
      readonly files?: readonly unknown[];
      readonly imports?: Readonly<Record<string, unknown>>;
      readonly sideEffects?: readonly unknown[];
    };
    const boaSourceStart = smoke.indexOf(
      "function bombadilBoaNamedSnapshotLoadSmokeSource(): string {",
    );
    const boaSourceEnd = smoke.indexOf("\n\nconst repository = process.cwd();", boaSourceStart);
    expect(boaSourceStart).toBeGreaterThanOrEqual(0);
    expect(boaSourceEnd).toBeGreaterThan(boaSourceStart);
    const boaSource = smoke.slice(boaSourceStart, boaSourceEnd);
    const namedSnapshotImportPrelude = `import { extract } from "@antithesishq/bombadil";
import type {
  Cell,
  JSON as BombadilJson,
} from "@antithesishq/bombadil";
import type {
  State as BombadilBrowserState,
} from "@antithesishq/bombadil/browser";

import { isUtf8ByteLengthAtMost } from "./utf8-byte-boundary.js";
`;
    const expectedNamedSnapshotImports = [
      ...namedSnapshotImportPrelude.matchAll(/^import[\s\S]*?;\n/gmu),
    ].map((match) => match[0]);
    const namedSnapshotImports = [
      ...namedSnapshot.matchAll(/^import[\s\S]*?;\n/gmu),
    ].map((match) => match[0]);
    const manifestExports = manifest.exports ?? {};

    expect(manifest.files).toContain("src/tooling/bombadil-named-snapshot.ts");
    expect(Object.hasOwn(
      manifestExports,
      "./tooling/bombadil-named-snapshot",
    )).toBe(false);
    expect(manifestExports["./tooling/bombadil-campaign"]).toBe(
      "./src/tooling/bombadil-campaign.ts",
    );
    expect(manifest.imports).toEqual({
      "#bombadil-named-snapshot": "./src/tooling/bombadil-named-snapshot.ts",
    });
    expect(manifest.sideEffects ?? []).not.toContain(
      "./src/tooling/bombadil-named-snapshot.ts",
    );
    expect(campaign).toContain(
      'import { createDirectBombadilNamedSnapshot } from "#bombadil-named-snapshot";',
    );
    expect(campaign).toContain("export { createDirectBombadilNamedSnapshot };");
    expect(campaign).not.toContain("export function createDirectBombadilNamedSnapshot");
    expect(namedSnapshot.startsWith(namedSnapshotImportPrelude)).toBe(true);
    expect(namedSnapshotImports).toEqual(expectedNamedSnapshotImports);
    expect(namedSnapshot.match(/@antithesishq\/bombadil\/browser/gu) ?? []).toHaveLength(1);
    expect(namedSnapshot.replace(namedSnapshotImportPrelude, "")).not.toContain(
      "@antithesishq/bombadil/browser",
    );
    expect(namedSnapshot).not.toContain("@antithesishq/bombadil/browser/defaults");
    expect(namedSnapshot).not.toMatch(/\brequire\s*\(|\bimport\s*\(/u);
    expect(boaSource).toContain(
      'from "./node_modules/@hraness/direct/src/tooling/bombadil-named-snapshot.ts";',
    );
    expect(boaSource).not.toContain(
      'from "@hraness/direct/tooling/bombadil-campaign";',
    );
    expect(boaSource).not.toContain("@antithesishq/bombadil/browser");
    expect(boaSource).not.toContain("@antithesishq/bombadil/terminal");
    expect(boaSource).not.toContain("pasteText");
    expect(boaSource).toContain(
      `export const loadSmokeActions = actions(() => [{
      TypeText: { CharSet: [{ Literal: "x" }] },
    }]);`,
    );
    expect(boaSource).toContain("export const loadSmokeFallbacks = always(() =>");
    expect(boaSource).toContain('asciiFallback.current.status === "unavailable"');
    expect(boaSource).toContain(
      'fallback: { status: "é 😀 \\\\ud800" },',
    );
    expect(boaSource).toContain(
      'unicodeFallback.current.status === "é 😀 \\\\\\\\uD800"',
    );
    expect([...boaSource.matchAll(/^\s*export\b[^\n]*/gmu)]
      .map((match) => match[0].trim())).toEqual([
      "export const loadSmokeActions = actions(() => [{",
      "export const loadSmokeFallbacks = always(() =>",
    ]);
    expect(smoke).toContain('"bombadil-named-snapshot.ts",');
    expect(smoke).toContain(
      "const [repositoryNamedSnapshotSource, installedNamedSnapshotSource] = await Promise.all([",
    );
    expect(smoke).toContain(
      "if (installedNamedSnapshotSource !== repositoryNamedSnapshotSource)",
    );
    expect(smoke).toContain(
      "Installed Bombadil named-snapshot source does not match the reviewed package source",
    );
    expect(smoke).toContain(`
      "terminal",
      "test",
      "--specification",
      "./boa-named-snapshot-load-smoke.ts",
      "--time-limit",
      "5s",
      "--output-path",
      join(work, "boa-named-snapshot-load-smoke"),
      "--",
      process.execPath,
      "-e",
      "process.exit(0)",
    `);
  });

  test("keeps npm discoverability metadata focused and aligned with the README", async () => {
    const [manifestSource, readme] = await Promise.all([
      readFile(manifestUrl, "utf8"),
      readFile(readmeUrl, "utf8"),
    ]);
    const manifest = JSON.parse(manifestSource) as {
      readonly description?: unknown;
      readonly keywords?: unknown;
      readonly version?: unknown;
    };
    expect(manifest).toEqual(expect.objectContaining({
      version: "0.7.14",
      description: "A TypeScript harness for deterministic frontend testing and development with repeatable scenarios, local fixtures, and browser verification for coding agents.",
      keywords: [
        "frontend-development",
        "frontend-testing",
        "deterministic-testing",
        "browser-testing",
        "scenario-testing",
        "fixtures",
        "coding-agents",
        "typescript",
      ],
    }));
    const opening = readme.slice(0, 1_500).replace(/\s+/gu, " ").toLowerCase();
    expect(opening).toContain(String(manifest.description).toLowerCase());
    for (const link of [
      "[Install @hraness/direct from npm](https://www.npmjs.com/package/@hraness/direct)",
      "[Direct source on GitHub](https://github.com/hraness/direct)",
      "[Direct overview](https://hraness.com/direct)",
    ]) expect(readme).toContain(link);
  });

  test("separates read-only verification from the exact terminal OIDC publish", async () => {
    const [workflow, releaseWorkflow] = await Promise.all([
      readFile(publishWorkflowUrl, "utf8"),
      readFile(releaseWorkflowUrl, "utf8"),
    ]);
    const verifyStart = workflow.indexOf("\n  verify:\n");
    const publishStart = workflow.indexOf("\n  publish:\n");

    expect(verifyStart).toBeGreaterThan(-1);
    expect(publishStart).toBeGreaterThan(verifyStart);
    const verifyJob = workflow.slice(verifyStart, publishStart);
    const publishJob = workflow.slice(publishStart);

    expect(workflow).toContain("workflow_call:");
    expect(workflow).toContain("permissions:\n  contents: read");
    for (const required of [
      "name: Verify exact package",
      "permissions:\n      contents: read",
      "runs-on: ubuntu-latest",
      "already_public: ${{ steps.availability.outputs.already_public }}",
      "source_sha: ${{ steps.identity.outputs.source_sha }}",
      "artifact_name: ${{ steps.artifact.outputs.artifact_name }}",
      "package_version: ${{ steps.artifact.outputs.package_version }}",
      "tarball_name: ${{ steps.artifact.outputs.tarball_name }}",
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "persist-credentials: false",
      'node-version: "24"',
      "package-manager-cache: false",
      'bun-version: "1.3.14"',
      "npm@11.19.0",
      "name: Verify release tag identity",
      "github.event.repository.default_branch",
      '"$GITHUB_EVENT_NAME" != push',
      '"$GITHUB_REF" != "refs/tags/$GITHUB_REF_NAME"',
      'git merge-base --is-ancestor "$GITHUB_SHA" "$default_head"',
      'release_ref="refs/direct-npm-publish-tags/$GITHUB_REF_NAME"',
      'remote_tag_sha="$(git rev-parse "$release_ref^{commit}")"',
      "name: Verify package publication state",
      'npm view "$package_name" name --json',
      'npm view "$package_name@$package_version" version --json',
      "already_public=true",
      "already_public=false",
      "bun install --frozen-lockfile --ignore-scripts",
      "bun run check",
      "git status --porcelain --untracked-files=all -- dist bun.lock",
      "scripts/prepare-npm-package.ts",
      "scripts/package-smoke.ts",
      '--archive "$archive"',
      '--pack-json "$metadata"',
      "npm-package.sha256",
      'sha256sum "$archive"',
      'sha256sum "$metadata"',
      "$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT",
      "Reviewed npm artifact must contain exactly three files",
      'if [[ ! -f "$required_file" || -L "$required_file" ]]',
      "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
      "path: ${{ runner.temp }}/direct-npm-${{ github.run_id }}-${{ github.run_attempt }}",
      "compression-level: 0",
    ] as const) {
      expect(verifyJob).toContain(required);
    }
    expect(verifyJob).not.toContain("id-token: write");
    expect(verifyJob).not.toMatch(/\bnpm publish\b/u);

    for (const required of [
      "name: Publish exact package",
      "needs: verify",
      "permissions:\n      id-token: write",
      "timeout-minutes: 10",
      'node-version: "24"',
      "package-manager-cache: false",
      "npm@11.19.0",
      "name: Bind artifact reference",
      "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT",
      "Verified artifact name is not bound to this run and attempt",
      "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
      "name: ${{ needs.verify.outputs.artifact_name }}",
      "Downloaded npm artifact must contain exactly the tarball, npm-pack.json, and npm-package.sha256",
      'if [[ ! -f "$required_file" || -L "$required_file" ]]',
      'expected_tarball_name="hraness-direct-$EXPECTED_VERSION.tgz"',
      'const expectedName = "@hraness/direct"',
      "const minimumFiles = 50",
      "const maximumFiles = 60",
      "const minimumPackedBytes = 140_000",
      "const maximumPackedBytes = 220_000",
      "const minimumUnpackedBytes = 650_000",
      "const maximumUnpackedBytes = 1_050_000",
      "record.files.length !== record.entryCount",
      "unpackedSize !== record.unpackedSize",
      'createHash("sha1")',
      'createHash("sha512")',
      'createHash("sha256")',
      "Downloaded files differ from the independent SHA-256 manifest",
      'git init --quiet --bare "$current_repository"',
      '"https://github.com/$GITHUB_REPOSITORY.git"',
      "EXPECTED_VERSION: ${{ needs.verify.outputs.package_version }}",
      "ALREADY_PUBLIC: ${{ needs.verify.outputs.already_public }}",
      "Verified package version is not stable semantic version",
      'release_tag="v$EXPECTED_VERSION"',
      '"refs/tags/v*:refs/tags/v*"',
      'current_tag_sha="$(git --git-dir="$current_repository" rev-parse',
      'merge-base --is-ancestor',
      "Tag $release_tag changed after artifact verification",
      "Tag $release_tag is no longer reachable from $DEFAULT_BRANCH",
      'git --git-dir="$current_repository" tag --list \'v*\'',
      "Tag $release_tag is not the newest stable tag $newest_stable_tag",
      'current_archive_sha256="$(sha256sum "$TARBALL"',
      'current_metadata_sha256="$(sha256sum "$METADATA"',
      'current_digest_sha256="$(sha256sum "$DIGEST"',
      "npm view @hraness/direct versions --json",
      "Published-version ordering proof is incomplete",
      "is not newer than published stable",
      'npm publish "$TARBALL"',
      "--access public",
      "--ignore-scripts",
      "--provenance",
      `--registry=${npmRegistry}`,
    ] as const) {
      expect(publishJob).toContain(required);
    }

    expect(workflow.match(/id-token: write/gu) ?? []).toHaveLength(1);
    expect(publishJob).not.toContain("contents: read");
    expect(publishJob).not.toContain("actions/checkout@");
    expect(publishJob).not.toContain("setup-bun@");
    expect(publishJob).not.toMatch(/\bbun\b/u);
    expect(publishJob).not.toContain("./scripts/");
    expect(publishJob.match(/git --git-dir="\$current_repository" fetch/gu) ?? []).toHaveLength(1);
    expect(publishJob.match(/npm publish/gu) ?? []).toHaveLength(1);

    const bindIndex = publishJob.indexOf("Bind artifact reference");
    const downloadIndex = publishJob.indexOf("Download reviewed package");
    const rebindIndex = publishJob.indexOf("Rebind downloaded package");
    const fetchIndex = publishJob.lastIndexOf('git --git-dir="$current_repository" fetch');
    const ancestryIndex = publishJob.lastIndexOf("merge-base --is-ancestor");
    const newestTagIndex = publishJob.lastIndexOf('newest_stable_tag="$(git --git-dir="$current_repository" tag');
    const rehashIndex = publishJob.lastIndexOf('current_archive_sha256="$(sha256sum "$TARBALL"');
    const versionOrderIndex = publishJob.lastIndexOf("published_versions_json=");
    const publishIndex = publishJob.indexOf('npm publish "$TARBALL"');
    expect(bindIndex).toBeLessThan(downloadIndex);
    expect(downloadIndex).toBeLessThan(rebindIndex);
    expect(rebindIndex).toBeLessThan(fetchIndex);
    expect(fetchIndex).toBeLessThan(ancestryIndex);
    expect(ancestryIndex).toBeLessThan(rehashIndex);
    expect(rehashIndex).toBeLessThan(versionOrderIndex);
    expect(versionOrderIndex).toBeLessThan(newestTagIndex);
    expect(newestTagIndex).toBeLessThan(publishIndex);

    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/npm stage publish/u);
    expect(workflow.match(/registry-url: "https:\/\/registry\.npmjs\.org"/gu) ?? [])
      .toHaveLength(2);
    expect(new Set(workflow.match(/--registry=[^\s"')]+/gu) ?? []))
      .toEqual(new Set([`--registry=${npmRegistry}`]));

    for (const required of [
      "if: github.event_name == 'push'",
      "contents: read\n      id-token: write",
      "uses: ./.github/workflows/npm-publish.yml",
      "needs: npm",
      "needs.npm.result == 'success'",
      "github.event_name == 'workflow_dispatch'",
    ] as const) {
      expect(releaseWorkflow).toContain(required);
    }
  });

  test("rechecks the immutable release tag at the terminal publishing boundary", async () => {
    const workflow = await readFile(publishWorkflowUrl, "utf8");
    const script = workflowStepScript(workflow, "Revalidate release tag and publish exact package");
    const directory = await mkdtemp(join(tmpdir(), "direct-publish-tag-"));
    const binaryDirectory = join(directory, "bin");
    const commandLog = join(directory, "commands.log");
    const publishMarker = join(directory, "published.txt");
    const tarball = join(directory, "hraness-direct-0.7.14.tgz");
    const metadata = join(directory, "npm-pack.json");
    const digest = join(directory, "npm-package.sha256");
    const sourceSha = "b".repeat(40);
    const archiveSha256 = "c".repeat(64);
    const metadataSha256 = "d".repeat(64);
    const digestSha256 = "e".repeat(64);
    const gitStub = join(binaryDirectory, "git");
    const npmStub = join(binaryDirectory, "npm");
    const sha256Stub = join(binaryDirectory, "sha256sum");

    try {
      await mkdir(binaryDirectory, { recursive: true });
      await Promise.all([
        writeFile(tarball, "reviewed tarball fixture\n", "utf8"),
        writeFile(metadata, "reviewed metadata fixture\n", "utf8"),
        writeFile(digest, "reviewed digest fixture\n", "utf8"),
      ]);
      await writeFile(gitStub, `#!/bin/bash\nset -euo pipefail\nprintf 'git %s\\n' "$*" >> "$COMMAND_LOG"\ncase "$*" in\n  *"rev-parse refs/heads/main"*) printf '%s\\n' "$DEFAULT_SHA" ;;\n  *"rev-parse refs/tags/v0.7.14^{commit}"*) printf '%s\\n' "$TAG_SHA" ;;\n  *"merge-base --is-ancestor"*) [[ "$ANCESTRY_STATE" == ancestor ]] ;;\n  *"tag --list v*"*) printf '%s\\n' "$REMOTE_TAGS" ;;\nesac\n`, "utf8");
      await writeFile(sha256Stub, `#!/bin/bash\nset -euo pipefail\nprintf 'sha256sum %s\\n' "$*" >> "$COMMAND_LOG"\ncase "$1" in\n  "$TARBALL") value="$EXPECTED_ARCHIVE_SHA256" ;;\n  "$METADATA") value="$EXPECTED_METADATA_SHA256" ;;\n  "$DIGEST") value="$EXPECTED_DIGEST_SHA256" ;;\n  *) echo "unexpected hash target: $1" >&2; exit 1 ;;\nesac\nprintf '%s  %s\\n' "$value" "$1"\n`, "utf8");
      await writeFile(npmStub, `#!/bin/bash\nset -euo pipefail\nprintf 'npm %s\\n' "$*" >> "$COMMAND_LOG"\nif [[ "\${1-}" == view ]]; then\n  printf '%s\\n' "$PUBLISHED_VERSIONS_JSON"\n  exit 0\nfi\nprintf 'published\\n' > "$PUBLISH_MARKER"\n`, "utf8");
      await Promise.all([chmod(gitStub, 0o755), chmod(npmStub, 0o755), chmod(sha256Stub, 0o755)]);

      const baseEnvironment = Object.freeze({
        ALREADY_PUBLIC: "false",
        ANCESTRY_STATE: "ancestor",
        COMMAND_LOG: commandLog,
        DEFAULT_BRANCH: "main",
        DEFAULT_SHA: "a".repeat(40),
        DIGEST: digest,
        EXPECTED_ARCHIVE_SHA256: archiveSha256,
        EXPECTED_DIGEST_SHA256: digestSha256,
        EXPECTED_METADATA_SHA256: metadataSha256,
        EXPECTED_SOURCE_SHA: sourceSha,
        EXPECTED_VERSION: "0.7.14",
        GITHUB_REF: "refs/tags/v0.7.14",
        GITHUB_REPOSITORY: "hraness/direct",
        GITHUB_SHA: sourceSha,
        METADATA: metadata,
        PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        PUBLISHED_VERSIONS_JSON: '["0.7.4","0.7.5","0.7.6","0.7.7","0.7.8","0.7.9","0.7.10","0.7.11","0.7.12","0.7.13"]',
        PUBLISH_MARKER: publishMarker,
        REMOTE_TAGS: "v0.7.4\nv0.7.5\nv0.7.6\nv0.7.7\nv0.7.8\nv0.7.9\nv0.7.10\nv0.7.11\nv0.7.12\nv0.7.13\nv0.7.14",
        RUNNER_TEMP: directory,
        TAG_SHA: sourceSha,
        TARBALL: tarball,
      });

      const published = await runWorkflowScript(script, baseEnvironment);
      expect(published.exitCode).toBe(0);
      expect(await readFile(publishMarker, "utf8")).toBe("published\n");
      const commands = await readFile(commandLog, "utf8");
      const fetchIndex = commands.indexOf("fetch --quiet --no-tags");
      const ancestryIndex = commands.indexOf("merge-base --is-ancestor");
      const newestTagIndex = commands.indexOf("tag --list v*");
      const hashIndex = commands.indexOf("sha256sum");
      const versionOrderIndex = commands.indexOf("npm view");
      const publishIndex = commands.indexOf("npm publish");
      expect(fetchIndex).toBeGreaterThan(-1);
      expect(ancestryIndex).toBeGreaterThan(fetchIndex);
      expect(hashIndex).toBeGreaterThan(ancestryIndex);
      expect(versionOrderIndex).toBeGreaterThan(hashIndex);
      expect(newestTagIndex).toBeGreaterThan(versionOrderIndex);
      expect(publishIndex).toBeGreaterThan(newestTagIndex);

      await rm(commandLog, { force: true });
      await rm(publishMarker, { force: true });
      const moved = await runWorkflowScript(script, {
        ...baseEnvironment,
        TAG_SHA: "f".repeat(40),
      });
      expect(moved.exitCode).not.toBe(0);
      expect(`${moved.stdout}${moved.stderr}`).toContain(
        "Tag v0.7.14 changed after artifact verification",
      );
      expect(await Bun.file(publishMarker).exists()).toBe(false);

      await rm(commandLog, { force: true });
      const detached = await runWorkflowScript(script, {
        ...baseEnvironment,
        ANCESTRY_STATE: "detached",
      });
      expect(detached.exitCode).not.toBe(0);
      expect(`${detached.stdout}${detached.stderr}`).toContain(
        "Tag v0.7.14 is no longer reachable from main",
      );
      expect(await Bun.file(publishMarker).exists()).toBe(false);

      await rm(commandLog, { force: true });
      const superseded = await runWorkflowScript(script, {
        ...baseEnvironment,
        REMOTE_TAGS: "v0.7.4\nv0.7.5\nv0.7.6\nv0.7.7\nv0.7.8\nv0.7.9\nv0.7.10\nv0.7.11\nv0.7.12\nv0.7.13\nv0.7.14\nv0.7.15",
      });
      expect(superseded.exitCode).not.toBe(0);
      expect(`${superseded.stdout}${superseded.stderr}`).toContain(
        "Tag v0.7.14 is not the newest stable tag v0.7.15",
      );
      expect(await readFile(commandLog, "utf8")).not.toContain("npm publish");
      expect(await Bun.file(publishMarker).exists()).toBe(false);

      await rm(commandLog, { force: true });
      const staleVersion = await runWorkflowScript(script, {
        ...baseEnvironment,
        PUBLISHED_VERSIONS_JSON: '["0.7.4","0.7.15"]',
      });
      expect(staleVersion.exitCode).not.toBe(0);
      expect(`${staleVersion.stdout}${staleVersion.stderr}`).toContain(
        "@hraness/direct@0.7.14 is not newer than published stable 0.7.15",
      );
      expect(await Bun.file(publishMarker).exists()).toBe(false);

      await rm(commandLog, { force: true });
      const idempotent = await runWorkflowScript(script, {
        ...baseEnvironment,
        ALREADY_PUBLIC: "true",
      });
      expect(idempotent.exitCode).toBe(0);
      expect(await Bun.file(publishMarker).exists()).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("gates immutable releases on canonical package content and supports bounded recovery", async () => {
    const [workflow, artifact, identity] = await Promise.all([
      readFile(releaseWorkflowUrl, "utf8"),
      readFile(packageArtifactUrl, "utf8"),
      readFile(packageIdentityUrl, "utf8"),
    ]);

    for (const required of [
      "workflow_dispatch:",
      "Existing stable tag to recover after npm delivery succeeded",
      "RECOVERY_TAG: ${{ inputs.tag }}",
      "Recovery must run from current $DEFAULT_BRANCH head",
      'release_ref="refs/direct-release-tags/$release_tag"',
      'git merge-base --is-ancestor "$tag_commit" "$default_head"',
      "Tag $release_tag is not the newest stable tag",
      'git worktree add --detach "$source_tree" "$SOURCE_SHA"',
      "Verify canonical npm delivery",
      'current_prepare="$GITHUB_WORKSPACE/scripts/prepare-npm-package.ts"',
      'current_identity="$GITHUB_WORKSPACE/scripts/npm-package-identity.ts"',
      'current_smoke="$GITHUB_WORKSPACE/scripts/package-smoke.ts"',
      'git -C "$GITHUB_WORKSPACE" rev-parse "$WORKFLOW_SHA:$relative_tool"',
      'git hash-object "$current_tool"',
      "bun --no-env-file --config=/dev/null run",
      '"$current_prepare" "$source_directory"',
      'run "$current_identity"',
      'run "$current_smoke"',
      'npm pack "$package_spec"',
      'npm view "$package_spec" name version dist',
      "scripts/npm-package-identity.ts",
      '--source-archive "$source_archive"',
      '--source-pack-json "$source_pack_json"',
      '--registry-archive "$registry_archive"',
      '--registry-pack-json "$registry_pack_json"',
      '--registry-view-json "$registry_view_json"',
      "scripts/package-smoke.ts",
      'current_tag_sha="$(gh api',
      'compare/$VERIFIED_SOURCE_SHA...$current_default_sha',
      '"$EVENT_MODE" == recovery && "$current_default_sha" != "$WORKFLOW_SHA"',
      '"/repos/$GITHUB_REPOSITORY/tags?per_page=100"',
      '"/repos/$GITHUB_REPOSITORY/releases?per_page=100"',
      `--registry=${npmRegistry}`,
    ] as const) {
      expect(workflow).toContain(required);
    }
    expect(workflow).not.toContain('cmp "$source_archive" "$registry_archive"');
    expect(workflow).not.toContain("bun run ./scripts/prepare-npm-package.ts");
    expect(workflow).not.toContain("bun run ./scripts/package-smoke.ts");
    expect(workflow).not.toMatch(/\bnpm (?:publish|stage publish)\b/u);
    expect(workflow.match(/contents: write/gu) ?? []).toHaveLength(1);

    for (const required of [
      "contentSha256",
      "contentSha512",
      "Unsupported package tar entry type",
      "Package tar contains data after its zero trailer",
      "maxOutputLength",
      "actual.mode !== file.mode",
    ] as const) {
      expect(`${artifact}\n${identity}`).toContain(required);
    }
    for (const required of [
      "Source and registry package content differ at canonical entry",
      "Source and registry npm pack file metadata differ",
      "npm registry metadata differs from the downloaded canonical package",
      "canonicalRegistryTarball",
      'createHash("sha1")',
      'createHash("sha256")',
      'createHash("sha512")',
    ] as const) {
      expect(identity).toContain(required);
    }
  });

  test("provisions the exact recovery-history and npm toolchain in CI", async () => {
    const workflow = await readFile(ciWorkflowUrl, "utf8");
    for (const required of [
      "fetch-depth: 0",
      "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
      'node-version: "24"',
      "package-manager-cache: false",
      "npm@11.19.0",
      'test "$(npm --version)" = "11.19.0"',
      '[[ "$(node --version)" == v24.* ]]',
    ] as const) {
      expect(workflow).toContain(required);
    }
  });

  test("pins public publication to the canonical npm registry", async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as {
      readonly publishConfig?: unknown;
    };

    expect(manifest.publishConfig).toEqual({
      access: "public",
      registry: npmRegistry,
    });
  });

  test("preserves and validates exact npm pack metadata in clean consumers", async () => {
    const [smoke, preparation] = await Promise.all([
      readFile(packageSmokeUrl, "utf8"),
      readFile(packagePreparationUrl, "utf8"),
    ]);

    for (const required of [
      "--archive <package.tgz> --pack-json <npm-pack.json>",
      "verifyExactNpmPackMetadata",
      "entryCount",
      "unpackedSize",
      'createHash("sha512")',
      'createHash("sha1")',
      "npm pack file inventory",
      "--registry=${npmRegistry}",
      "NPM_CONFIG_REGISTRY: npmRegistry",
    ] as const) {
      expect(smoke).toContain(required);
    }
    for (const required of [
      "npm-pack.json",
      'flag: "wx"',
      'createHash("sha512")',
      'createHash("sha1")',
      "--registry=${npmRegistry}",
      "NPM_CONFIG_REGISTRY: npmRegistry",
      "npm pack file inventory",
    ] as const) {
      expect(preparation).toContain(required);
    }
  });

  test("documents the three-file artifact and terminal publishing authority", async () => {
    const [guide, agents] = await Promise.all([
      readFile(publishingGuideUrl, "utf8"),
      readFile(agentGuideUrl, "utf8"),
    ]);
    const normalizedGuide = guide.replace(/\s+/gu, " ");

    expect(normalizedGuide).toContain(
      "exactly the tarball, `npm-pack.json`, and `npm-package.sha256`",
    );
    for (const required of [
      "only job with OIDC authority",
      "checks out no source and runs no repository code",
      "rehashes all three files",
      npmRegistry,
    ] as const) {
      expect(normalizedGuide).toContain(required);
    }
    expect(normalizedGuide).toContain("new bare Git directory");
    expect(normalizedGuide).toContain("newest remote stable tag");
    for (const required of [
      "rebinds the release helpers to their reviewed Git blobs",
      "invokes those files by absolute path",
      "no tag-owned config",
      "`npm pack --ignore-scripts`",
    ] as const) {
      expect(normalizedGuide).toContain(required);
    }
    expect(normalizedGuide).toContain("do not import a script from the tagged tree");
    expect(normalizedGuide).toContain("workflow filename: `release.yml`");
    expect(normalizedGuide).toContain("allowed action: `npm publish`");
    expect(normalizedGuide).toContain("Restrict creation to organization administrators");
    expect(normalizedGuide).toContain("Block updates and deletion with no bypass actors");
    expect(agents).toContain("only its minimal dependent publication job may request OIDC");
    expect(agents).toContain("Restrict version-tag creation to organization administrators");
    expect(agents).toContain("rebind the downloaded exact artifact, every remote stable tag, and current `main`");
    expect(agents).toContain("bind current helpers to reviewed Git blobs");
    expect(agents).toContain("recovery never runs a historical `prepack`");
  });
});

describe("canonical npm package identity", () => {
  test("accepts transport drift and rejects content, mode, and link drift", async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as {
      readonly name: string;
      readonly version: string;
    };
    const filename = `hraness-direct-${manifest.version}.tgz`;
    const work = await mkdtemp(join(tmpdir(), "direct-package-identity-test-"));
    try {
      const sourceDirectory = join(work, "source");
      const registryDirectory = join(work, "registry");
      await mkdir(sourceDirectory);
      await mkdir(registryDirectory);
      const sourceArchive = join(sourceDirectory, filename);
      const registryArchive = join(registryDirectory, filename);
      await run([
        process.execPath,
        "pm",
        "pack",
        "--filename",
        sourceArchive,
        "--ignore-scripts",
        "--quiet",
      ], repository);

      const sourceBytes = await readFile(sourceArchive);
      const transportVariant = Buffer.from(sourceBytes);
      transportVariant[9] = transportVariant[9] === 3 ? 0 : 3;
      expect(transportVariant.equals(sourceBytes)).toBe(false);
      expect(gunzipSync(transportVariant).equals(gunzipSync(sourceBytes))).toBe(true);
      await writeFile(registryArchive, transportVariant);

      const [sourceInventory, registryInventory] = await Promise.all([
        inspectPackageArtifact(sourceArchive),
        inspectPackageArtifact(registryArchive),
      ]);
      const sourcePackJson = join(sourceDirectory, "npm-pack.json");
      const registryPackJson = join(registryDirectory, "npm-pack.json");
      const registryViewJson = join(registryDirectory, "npm-view.json");
      await Promise.all([
        writeFile(
          sourcePackJson,
          packJson(sourceBytes, sourceInventory, manifest.name, manifest.version),
        ),
        writeFile(
          registryPackJson,
          packJson(transportVariant, registryInventory, manifest.name, manifest.version, true),
        ),
        writeFile(
          registryViewJson,
          registryView(transportVariant, registryInventory, manifest.name, manifest.version),
        ),
      ]);
      const validInput = Object.freeze({
        expectedName: manifest.name,
        expectedVersion: manifest.version,
        registryArchive,
        registryPackJson,
        registryViewJson,
        sourceArchive,
        sourcePackJson,
      });
      const verified = await verifyNpmPackageIdentity(validInput);
      expect(verified.fileCount).toBe(sourceInventory.fileCount);
      expect(verified.sourceArchiveSha512).not.toBe(verified.registryArchiveSha512);

      const originalTar = gunzipSync(sourceBytes);
      const first = firstRegularHeader(originalTar);

      const modeDirectory = join(work, "mode");
      await mkdir(modeDirectory);
      const modeArchive = join(modeDirectory, filename);
      const modeTar = Buffer.from(originalTar);
      modeTar.write("0000755\0", first.offset + 100, 8, "ascii");
      writeHeaderChecksum(modeTar, first.offset);
      const modeBytes = gzipSync(modeTar, { level: 9 });
      await writeFile(modeArchive, modeBytes);
      const modeInventory = await inspectPackageArtifact(modeArchive);
      const modePackJson = join(modeDirectory, "npm-pack.json");
      const modeViewJson = join(modeDirectory, "npm-view.json");
      await Promise.all([
        writeFile(
          modePackJson,
          packJson(modeBytes, modeInventory, manifest.name, manifest.version),
        ),
        writeFile(
          modeViewJson,
          registryView(modeBytes, modeInventory, manifest.name, manifest.version),
        ),
      ]);
      await expect(verifyNpmPackageIdentity({
        ...validInput,
        registryArchive: modeArchive,
        registryPackJson: modePackJson,
        registryViewJson: modeViewJson,
      })).rejects.toThrow("Source and registry npm pack file metadata differ");

      const contentDirectory = join(work, "content");
      await mkdir(contentDirectory);
      const contentArchive = join(contentDirectory, filename);
      const contentTar = Buffer.from(originalTar);
      contentTar[first.offset + 512] = (contentTar[first.offset + 512] ?? 0) ^ 0xff;
      const contentBytes = gzipSync(contentTar, { level: 9 });
      await writeFile(contentArchive, contentBytes);
      const contentInventory = await inspectPackageArtifact(contentArchive);
      const contentPackJson = join(contentDirectory, "npm-pack.json");
      const contentViewJson = join(contentDirectory, "npm-view.json");
      await Promise.all([
        writeFile(
          contentPackJson,
          packJson(contentBytes, contentInventory, manifest.name, manifest.version),
        ),
        writeFile(
          contentViewJson,
          registryView(contentBytes, contentInventory, manifest.name, manifest.version),
        ),
      ]);
      await expect(verifyNpmPackageIdentity({
        ...validInput,
        registryArchive: contentArchive,
        registryPackJson: contentPackJson,
        registryViewJson: contentViewJson,
      })).rejects.toThrow("Source and registry package content differ at canonical entry");

      const linkDirectory = join(work, "link");
      await mkdir(linkDirectory);
      const linkArchive = join(linkDirectory, filename);
      const linkTar = Buffer.from(originalTar);
      linkTar[first.offset + 156] = 50;
      writeHeaderChecksum(linkTar, first.offset);
      await writeFile(linkArchive, gzipSync(linkTar, { level: 9 }));
      await expect(verifyNpmPackageIdentity({
        ...validInput,
        registryArchive: linkArchive,
      })).rejects.toThrow("Unsupported package tar entry type");
    } finally {
      await rm(work, { force: true, recursive: true });
    }
  });

  for (const release of historicalRecoverySources) test(
    `current tools prepare and smoke exact v${release.version} source without tagged helpers`,
    async () => {
      const work = await mkdtemp(join(tmpdir(), "direct-release-recovery-test-"));
      try {
        const sourceArchive = join(work, `v${release.version}-source.tar`);
        const sourceTree = join(work, "source");
        const packageOutput = join(work, "package");
        await mkdir(sourceTree);
        await run([
          "git",
          "cat-file",
          "-e",
          `${release.commit}^{commit}`,
        ], repository);
        await run([
          "git",
          "archive",
          "--format=tar",
          `--output=${sourceArchive}`,
          release.commit,
        ], repository);
        await run(["tar", "-xf", sourceArchive, "-C", sourceTree], repository);

        const manifest = JSON.parse(await readFile(join(sourceTree, "package.json"), "utf8")) as {
          readonly name?: unknown;
          readonly scripts?: Readonly<Record<string, unknown>>;
          readonly version?: unknown;
        };
        expect(manifest.name).toBe("@hraness/direct");
        expect(manifest.version).toBe(release.version);
        expect(manifest.scripts?.prepack).toBe("bun run check");

        await rm(join(sourceTree, "scripts"), { recursive: true });
        expect(await readdir(sourceTree)).not.toContain("node_modules");
        await run([
          process.execPath,
          "--no-env-file",
          "--config=/dev/null",
          "run",
          fileURLToPath(packagePreparationUrl),
          packageOutput,
        ], sourceTree);

        const filename = `hraness-direct-${release.version}.tgz`;
        expect(new Set(await readdir(packageOutput))).toEqual(new Set([
          filename,
          "npm-pack.json",
        ]));
        const inventory = await inspectPackageArtifact(join(packageOutput, filename));
        if ("expectedFileCount" in release) {
          expect(inventory.fileCount).toBe(release.expectedFileCount);
          expect(inventory.unpackedBytes).toBe(release.expectedUnpackedBytes);
        } else {
          expect(inventory.fileCount).toBeGreaterThan(0);
          expect(inventory.unpackedBytes).toBeGreaterThan(0);
        }

        await run([
          process.execPath,
          "--no-env-file",
          "--config=/dev/null",
          "run",
          fileURLToPath(packageSmokeUrl),
          "--archive",
          join(packageOutput, filename),
          "--pack-json",
          join(packageOutput, "npm-pack.json"),
        ], sourceTree);
        const finalSourceEntries = await readdir(sourceTree);
        expect(finalSourceEntries).not.toContain("scripts");
        expect(finalSourceEntries).not.toContain("node_modules");
      } finally {
        await rm(work, { force: true, recursive: true });
      }
    },
    180_000,
  );
});
