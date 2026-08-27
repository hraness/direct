import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const stageWorkflowUrl = new URL("../.github/workflows/npm-stage.yml", import.meta.url);
const releaseWorkflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const manifestUrl = new URL("../package.json", import.meta.url);

describe("npm release workflows", () => {
  test("keeps staging manual, current-head bound, generated-tree clean, tokenless, and stage-only", async () => {
    const workflow = await readFile(stageWorkflowUrl, "utf8");

    for (const required of [
      "workflow_dispatch:",
      "contents: read",
      "id-token: write",
      "runs-on: ubuntu-latest",
      "node-version: \"24\"",
      "package-manager-cache: false",
      "npm@11.19.0",
      "bun-version: \"1.3.14\"",
      "github.event.repository.default_branch",
      "origin/$DEFAULT_BRANCH",
      "bun install --frozen-lockfile --ignore-scripts",
      "bun run check",
      "git status --porcelain --untracked-files=all -- dist bun.lock",
      "scripts/prepare-npm-package.ts",
      "scripts/package-smoke.ts",
      "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
      "npm stage publish \"$ARCHIVE\"",
      "--registry=https://registry.npmjs.org",
    ] as const) {
      expect(workflow).toContain(required);
    }

    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toMatch(/\n\s+push:/u);
    expect(workflow).not.toMatch(/\bnpm publish\b/u);
  });

  test("gates immutable GitHub releases on the exact public npm artifact", async () => {
    const workflow = await readFile(releaseWorkflowUrl, "utf8");

    expect(workflow).toContain("Verify exact npm delivery");
    expect(workflow).toContain("scripts/prepare-npm-package.ts");
    expect(workflow).toContain("npm pack \"$package_spec\"");
    expect(workflow).toContain("--registry=https://registry.npmjs.org");
    expect(workflow).toContain("cmp \"$source_archive\" \"$registry_archive\"");
  });

  test("pins public publication to the canonical npm registry", async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as {
      readonly publishConfig?: unknown;
    };

    expect(manifest.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org",
    });
  });
});
