import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { metadata } from "./layout";
import directManifest from "./manifest";
import HomePage from "./page";
import {
  DIRECT_DESCRIPTION,
  DIRECT_TAGLINE,
  DIRECT_TITLE,
} from "./site-shell";
import { DIRECT_PACKAGE_VERSION } from "./version";

describe("Direct home page", () => {
  test("is a compact project page with the package-versioned install command", async () => {
    const html = renderToStaticMarkup(<HomePage />);
    const [manifestSource, readme] = await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../README.md", import.meta.url), "utf8"),
    ]);
    const manifest = JSON.parse(manifestSource) as {
      readonly description?: unknown;
      readonly version?: unknown;
    };

    expect(html).toContain("<h1>direct</h1>");
    expect(html).toContain(`${DIRECT_TAGLINE}.`);
    expect(html).toContain(`"description":"${DIRECT_DESCRIPTION}"`);
    expect(manifest.description).toBe(DIRECT_DESCRIPTION);
    expect(readme).toStartWith(`# direct\n\n${DIRECT_TAGLINE}.\n`);
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
      "set up signed-in, empty, error, and other hard-to-reach screens once",
    );
    expect(html).toContain(
      "direct does not click through the browser or test the systems it replaces.",
    );
    expect(html).toContain("predictable local stand-ins");
    expect(html).not.toContain("development composition");
    expect(html).not.toContain("deterministic adapters");
    expect(html).not.toContain("direct gives a real frontend");
    expect(html).not.toContain("live tests still prove");
    expect(html).not.toContain("direct-capability-grid");
    expect(html).toContain('href="/docs/overview"');
  });

  test("keeps the public identity aligned across site metadata", () => {
    expect(metadata.title).toBe(DIRECT_TITLE);
    expect(metadata.description).toBe(DIRECT_DESCRIPTION);
    expect(metadata.openGraph?.title).toBe(DIRECT_TITLE);
    expect(metadata.openGraph?.description).toBe(DIRECT_DESCRIPTION);
    expect(metadata.twitter?.title).toBe(DIRECT_TITLE);
    expect(metadata.twitter?.description).toBe(DIRECT_DESCRIPTION);
    expect(directManifest().description).toBe(DIRECT_DESCRIPTION);
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
