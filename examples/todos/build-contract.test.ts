import { expect, test } from "bun:test";
import { STYLEX_TEMPLATE_CSS_PLACEHOLDER } from "@hraness/ui/stylex-build";
import { parseTodoBuildTarget, renderTodoBuildHtml } from "./build-contract.js";

test("compiler targets are finite, never an implicit output or arbitrary entry", () => {
  expect(parseTodoBuildTarget("production")).toBe("production");
  expect(parseTodoBuildTarget("direct")).toBe("direct");
  for (const value of [undefined, "", "latest", "../direct", "Production"]) {
    expect(() => parseTodoBuildTarget(value)).toThrow("Expected production or direct");
  }
});

for (const target of ["production", "direct"] as const) {
  const script = `<script type="module" src="/${target === "production" ? "src" : "direct"}/main.tsx"></script>`;
  const source = `<html><head><title>Retain document</title></head><body><div id="root"></div>${script}</body></html>`;
  test(`${target} HTML keeps authored body and orders foundation before finalized union`, () => {
    const html = renderTodoBuildHtml(source, target, "assets/main-123.js", "assets/main-456.css");
    expect(html).toContain('<title>Retain document</title>');
    expect(html).toContain('<body><div id="root"></div><script type="module" src="/graphs/client/assets/main-123.js"></script></body>');
    expect(html).toContain(`href="/graphs/client/assets/main-456.css">\n    <link rel="stylesheet" href="${STYLEX_TEMPLATE_CSS_PLACEHOLDER}">`);
    expect(html.split(STYLEX_TEMPLATE_CSS_PLACEHOLDER)).toHaveLength(2);
  });
  test(`${target} HTML rejects ambiguous producer input and unsafe graph filenames`, () => {
    for (const invalid of [source.replace(script, ""), `${source}${script}`, source.replace("</head>", ""), `${source}</head>`, `${source}${STYLEX_TEMPLATE_CSS_PLACEHOLDER}`]) {
      expect(() => renderTodoBuildHtml(invalid, target, "assets/main.js", "assets/main.css")).toThrow();
    }
    for (const path of ["../outside.js", "assets/../outside.js", "/absolute.js", "assets//main.js", "assets/./main.js", "assets/main.js?x", "assets/main\".js"]) {
      expect(() => renderTodoBuildHtml(source, target, path, "assets/main.css")).toThrow();
      expect(() => renderTodoBuildHtml(source, target, "assets/main.js", path)).toThrow();
    }
  });
}
