import { describe, expect, test } from "bun:test";

import {
  ARTICLE_END_MARKER,
  ARTICLE_START_MARKER,
  loadDirectArticle,
  parseDirectArticleSource,
} from "./article";

const validArticle = [
  ARTICLE_START_MARKER,
  "## [Direct title](<https://prmte.com/articles/direct-title>)",
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
        canonicalUrl: "https://prmte.com/articles/direct-title",
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
      title: "Hraness Direct makes frontend loops faster",
    });
    expect(article.markdown).toContain("## Change the composition below the behavior");
    expect(article.markdown).toContain("defineDirect");
    expect(article.markdown).toContain("direct-setup");
  });
});
