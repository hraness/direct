import assert from "node:assert/strict";
import { STYLEX_TEMPLATE_CSS_PLACEHOLDER } from "@hraness/ui/stylex-build";

export type TodoBuildTarget = "production" | "direct";

export function parseTodoBuildTarget(value: string | undefined): TodoBuildTarget {
  assert.ok(value === "production" || value === "direct", "Expected production or direct example target");
  return value;
}

export function renderTodoBuildHtml(
  source: string,
  target: TodoBuildTarget,
  entryFile: string,
  foundationFile: string,
): string {
  for (const path of [entryFile, foundationFile]) {
    assert.match(path, /^[a-zA-Z0-9_-][a-zA-Z0-9._/-]*$/u);
    assert.ok(path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
  }
  const originalScript = target === "production"
    ? '<script type="module" src="/src/main.tsx"></script>'
    : '<script type="module" src="/direct/main.tsx"></script>';
  assert.equal(source.split(originalScript).length, 2, "The example template must contain its exact entry once");
  assert.equal(source.split("</head>").length, 2, "The example template must contain one head");
  assert.ok(!source.includes(STYLEX_TEMPLATE_CSS_PLACEHOLDER), "Authored HTML must not contain a produced-template placeholder");
  return source.replace(originalScript, `<script type="module" src="/graphs/client/${entryFile}"></script>`)
    .replace("</head>", `<link rel="stylesheet" href="/graphs/client/${foundationFile}">\n    <link rel="stylesheet" href="${STYLEX_TEMPLATE_CSS_PLACEHOLDER}">\n  </head>`);
}
