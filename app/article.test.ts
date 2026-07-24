import { describe, expect, test } from "bun:test";

import {
  ARTICLE_END_MARKER,
  ARTICLE_START_MARKER,
  loadDirectArticle,
  parseDirectArticleSource,
} from "./article";

const validArticle = [
  ARTICLE_START_MARKER,
  "## [Direct title](<https://hraness.pub/articles/direct-title>)",
  "",
  "> A precise dek.",
  "",
  "### First section",
  "",
  "```text",
  "### Code stays code",
  "```",
  ARTICLE_END_MARKER,
].join("\n");

describe("Direct site article source", () => {
  test("extracts one linked article and downshifts only prose headings", () => {
    expect(parseDirectArticleSource(validArticle)).toEqual({
      ok: true,
      value: {
        canonicalUrl: "https://hraness.pub/articles/direct-title",
        dek: "A precise dek.",
        markdown: [
          "## First section",
          "",
          "```text",
          "### Code stays code",
          "```",
        ].join("\n"),
        title: "Direct title",
      },
    });
  });

  test("rejects missing, duplicate, inline, reversed, and malformed boundaries", () => {
    expect(parseDirectArticleSource("ordinary README")).toMatchObject({
      ok: false,
      error: { code: "missing-marker" },
    });
    expect(parseDirectArticleSource(`${validArticle}\n${ARTICLE_START_MARKER}`)).toMatchObject({
      ok: false,
      error: { code: "duplicate-marker" },
    });
    expect(parseDirectArticleSource(`prefix ${validArticle}`)).toMatchObject({
      ok: false,
      error: { code: "invalid-structure" },
    });
    expect(parseDirectArticleSource(
      `${ARTICLE_END_MARKER}\n${validArticle}`,
    )).toMatchObject({
      ok: false,
      error: { code: "duplicate-marker" },
    });
    expect(parseDirectArticleSource(
      validArticle.replace("## [Direct title]", "# Direct title"),
    )).toMatchObject({
      ok: false,
      error: { code: "invalid-heading" },
    });
  });

  test("loads the current synchronized public article", async () => {
    const article = await loadDirectArticle();
    expect(article).toMatchObject({
      canonicalUrl: "https://hraness.pub/articles/direct-a-harness-for-your-frontend",
      title: "Direct gives browser agents deterministic app states",
    });
    expect(article.markdown).toContain("## Browser control and app state are different jobs");
    expect(article.markdown).toContain("agent-browser");
    expect(article.markdown).toContain("direct-setup");
    expect(article.dek).toContain(
      "without claiming to test the external systems it replaces",
    );
    expect(article.markdown).toContain("Direct exposes a quiescence snapshot");
    expect(article.markdown).toContain(
      "`waitForQuiescence` is product-owned verifier code",
    );
    expect(article.markdown).not.toContain("The browser helper waits");
    expect(article.markdown).not.toContain(
      "live-system tests remain responsible",
    );
  });
});
