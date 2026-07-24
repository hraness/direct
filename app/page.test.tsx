import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import HomePage from "./page";

describe("Direct home page", () => {
  test("is a compact project page with the exact install command", () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toContain("<h1>direct</h1>");
    expect(html).toContain("deterministic app states for browser agents.");
    expect(html).toContain("bun add --dev github:hraness/direct#v0.4.0");
    expect(html).toContain("development only.");
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
