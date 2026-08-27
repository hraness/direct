import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const stageWorkflowUrl = new URL("../.github/workflows/npm-stage.yml", import.meta.url);
const releaseWorkflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const manifestUrl = new URL("../package.json", import.meta.url);
const packageSmokeUrl = new URL("./package-smoke.ts", import.meta.url);
const packagePreparationUrl = new URL("./prepare-npm-package.ts", import.meta.url);
const publishingGuideUrl = new URL("../docs/publishing.md", import.meta.url);
const agentGuideUrl = new URL("../AGENTS.md", import.meta.url);
const npmRegistry = "https://registry.npmjs.org";

describe("npm release workflows", () => {
  test("separates read-only verification from the exact terminal OIDC stage", async () => {
    const workflow = await readFile(stageWorkflowUrl, "utf8");
    const verifyStart = workflow.indexOf("\n  verify:\n");
    const stageStart = workflow.indexOf("\n  stage:\n");

    expect(verifyStart).toBeGreaterThan(-1);
    expect(stageStart).toBeGreaterThan(verifyStart);
    const verifyJob = workflow.slice(verifyStart, stageStart);
    const stageJob = workflow.slice(stageStart);

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions:\n  contents: read");
    for (const required of [
      "name: Verify exact package",
      "permissions:\n      contents: read",
      "runs-on: ubuntu-latest",
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
      "github.event.repository.default_branch",
      '"$GITHUB_SHA" != "$default_head" || "$checked_out_head" != "$default_head"',
      'npm view "$package_name" name --json',
      'npm view "$package_name@$package_version" version --json',
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
    expect(verifyJob).not.toContain("npm stage publish");

    for (const required of [
      "name: Stage exact package",
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
      "const maximumPackedBytes = 180_000",
      "const minimumUnpackedBytes = 650_000",
      "const maximumUnpackedBytes = 750_000",
      "record.files.length !== record.entryCount",
      "unpackedSize !== record.unpackedSize",
      'createHash("sha1")',
      'createHash("sha512")',
      'createHash("sha256")',
      "Downloaded files differ from the independent SHA-256 manifest",
      'git init --quiet --bare "$current_main"',
      '"https://github.com/$GITHUB_REPOSITORY.git"',
      'current_archive_sha256="$(sha256sum "$TARBALL"',
      'current_metadata_sha256="$(sha256sum "$METADATA"',
      'current_digest_sha256="$(sha256sum "$DIGEST"',
      'npm stage publish "$TARBALL"',
      "--access public",
      "--ignore-scripts",
      "--provenance",
      `--registry=${npmRegistry}`,
    ] as const) {
      expect(stageJob).toContain(required);
    }

    expect(workflow.match(/id-token: write/gu) ?? []).toHaveLength(1);
    expect(stageJob).not.toContain("contents: read");
    expect(stageJob).not.toContain("actions/checkout@");
    expect(stageJob).not.toContain("setup-bun@");
    expect(stageJob).not.toMatch(/\bbun\b/u);
    expect(stageJob).not.toContain("./scripts/");
    expect(stageJob.match(/git --git-dir="\$current_main" fetch/gu) ?? []).toHaveLength(1);
    expect(stageJob.match(/npm stage publish/gu) ?? []).toHaveLength(1);

    const bindIndex = stageJob.indexOf("Bind artifact reference");
    const downloadIndex = stageJob.indexOf("Download reviewed package");
    const rebindIndex = stageJob.indexOf("Rebind downloaded package");
    const fetchIndex = stageJob.lastIndexOf('git --git-dir="$current_main" fetch');
    const rehashIndex = stageJob.lastIndexOf('current_archive_sha256="$(sha256sum "$TARBALL"');
    const stageIndex = stageJob.indexOf('npm stage publish "$TARBALL"');
    expect(bindIndex).toBeLessThan(downloadIndex);
    expect(downloadIndex).toBeLessThan(rebindIndex);
    expect(rebindIndex).toBeLessThan(fetchIndex);
    expect(fetchIndex).toBeLessThan(rehashIndex);
    expect(rehashIndex).toBeLessThan(stageIndex);

    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toMatch(/\n\s+push:/u);
    expect(workflow).not.toMatch(/\bnpm publish\b/u);
    expect(workflow.match(/registry-url: "https:\/\/registry\.npmjs\.org"/gu) ?? [])
      .toHaveLength(2);
    expect(new Set(workflow.match(/--registry=[^\s"']+/gu) ?? []))
      .toEqual(new Set([`--registry=${npmRegistry}`]));
  });

  test("gates immutable GitHub releases on the exact public npm artifact", async () => {
    const workflow = await readFile(releaseWorkflowUrl, "utf8");

    expect(workflow).toContain("Verify exact npm delivery");
    expect(workflow).toContain("scripts/prepare-npm-package.ts");
    expect(workflow).toContain('npm pack "$package_spec"');
    expect(workflow).toContain(`--registry=${npmRegistry}`);
    expect(workflow).toContain('cmp "$source_archive" "$registry_archive"');
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

  test("documents the three-file artifact and terminal staging authority", async () => {
    const [guide, agents] = await Promise.all([
      readFile(publishingGuideUrl, "utf8"),
      readFile(agentGuideUrl, "utf8"),
    ]);

    for (const required of [
      "exactly the tarball, `npm-pack.json`, and `npm-package.sha256`",
      "only job with OIDC authority",
      "checks out no source and runs no repository code",
      "rehashes all three files",
      npmRegistry,
    ] as const) {
      expect(guide).toContain(required);
    }
    expect(guide).toMatch(/new bare\s+Git directory/u);
    expect(agents).toContain("only its minimal dependent staging job may request OIDC");
    expect(agents).toContain("rebind the downloaded exact artifact and current `main`");
  });
});
