import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import HomePage from "./page";
import { DIRECT_PACKAGE_VERSION } from "./version";

describe("Direct home page", () => {
  test("is a compact project page with the package-versioned install command", async () => {
    const html = renderToStaticMarkup(<HomePage />);
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly version?: unknown };

    expect(html).toContain("<h1>direct</h1>");
    expect(html).toContain("named, repeatable app states for browser agents.");
    expect(typeof manifest.version).toBe("string");
    if (typeof manifest.version !== "string") {
      throw new Error("Direct package manifest has no string version");
    }
    expect(manifest.version).toBe(DIRECT_PACKAGE_VERSION);
    expect(html).toContain(
      `bun add --dev github:hraness/direct#v${manifest.version}`,
    );
    expect(html).toContain("development only.");
    expect(html).toContain(
      "define signed-in, empty, error, and other hard-to-reach states once",
    );
    expect(html).toContain(
      "direct does not drive the browser or test those systems.",
    );
    expect(html).not.toContain("direct gives a real frontend");
    expect(html).not.toContain("live tests still prove");
    expect(html).not.toContain("direct-capability-grid");
    expect(html).toContain('href="/docs/overview"');
  });

  test("keeps the canonical publication and repository in navigation", () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toContain(
      '<a href="https://hraness.pub/articles/direct-a-harness-for-your-frontend">article</a>',
    );
    expect(html).toContain(
      '<a href="https://github.com/hraness/direct">github</a>',
    );
    expect(html).not.toContain("Originally published by");
  });
});
