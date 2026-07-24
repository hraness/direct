import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import HomePage from "./page";

describe("Direct article page", () => {
  test("uses the Article navigation as the sole visible publication link", async () => {
    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain(
      '<a href="https://hraness.pub/articles/direct-a-harness-for-your-frontend">Article</a>',
    );
    expect(html).not.toContain("Originally published by");
  });

  test("server-renders highlighted fenced examples", async () => {
    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("syntax-code language-typescript");
    expect(html).toContain("--sh-keyword");
    expect(html).toContain("syntax-code language-text");
    expect(html).toContain("tabindex=\"0\"");
  });
});
