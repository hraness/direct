import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import HomePage from "./page";

describe("Direct home page", () => {
  test("puts installation and the browser-tool decision on the concise landing page", () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toContain(
      "bun add --dev github:hraness/direct#v0.4.0",
    );
    expect(html.indexOf(">Install<")).toBeLessThan(
      html.indexOf(">The problem<"),
    );
    expect(html).toContain("Use agent-browser by itself");
    expect(html).toContain("Use Direct with agent-browser");
    expect(html).toContain('href="/docs/overview"');
  });

  test("keeps the canonical publication and repository in navigation", () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toContain(
      '<a href="https://hraness.pub/articles/direct-a-harness-for-your-frontend">Article</a>',
    );
    expect(html).toContain(
      '<a href="https://github.com/hraness/direct">GitHub</a>',
    );
    expect(html).not.toContain("Originally published by");
  });
});
