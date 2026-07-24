import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  ARTICLE_END_MARKER,
  ARTICLE_START_MARKER,
  parseDirectArticleSource,
} from "./article";

const arbitraryForeignValue = fc.anything({
  withBigInt: true,
  withBoxedValues: true,
  withMap: true,
  withNullPrototype: true,
  withObjectString: true,
  withSet: true,
});

test("property: arbitrary foreign article values never escape the fallible boundary", () => {
  fc.assert(fc.property(arbitraryForeignValue, (value) => {
    expect(() => parseDirectArticleSource(value)).not.toThrow();
  }), { numRuns: 300 });
});

test("property: unrelated README text cannot perturb one exact marked article", () => {
  const unrelated = fc.string({ maxLength: 256 }).filter(
    (value) =>
      !value.includes(ARTICLE_START_MARKER)
      && !value.includes(ARTICLE_END_MARKER),
  );
  fc.assert(fc.property(unrelated, unrelated, (prefix, suffix) => {
    const parsed = parseDirectArticleSource([
      prefix,
      ARTICLE_START_MARKER,
      "## [Direct title](<https://prmte.com/articles/direct-title>)",
      "",
      "> A precise dek.",
      "",
      "### Body",
      ARTICLE_END_MARKER,
      suffix,
    ].join("\n"));
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        canonicalUrl: "https://prmte.com/articles/direct-title",
        dek: "A precise dek.",
        markdown: "## Body",
        title: "Direct title",
      },
    });
  }), { numRuns: 300 });
});
