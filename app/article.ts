import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const ARTICLE_START_MARKER =
  "<!-- article:direct-a-harness-for-your-frontend:start -->";
export const ARTICLE_END_MARKER =
  "<!-- article:direct-a-harness-for-your-frontend:end -->";

export type DirectArticleParseErrorCode =
  | "duplicate-marker"
  | "invalid-heading"
  | "invalid-source"
  | "invalid-structure"
  | "missing-marker";

export interface DirectArticleParseError {
  readonly code: DirectArticleParseErrorCode;
  readonly message: string;
}

export interface DirectArticleSource {
  readonly canonicalUrl: `https://${string}`;
  readonly dek: string;
  readonly markdown: string;
  readonly title: string;
}

export type DirectArticleParseResult =
  | { readonly ok: true; readonly value: DirectArticleSource }
  | { readonly ok: false; readonly error: DirectArticleParseError };

function failure(
  code: DirectArticleParseErrorCode,
  message: string,
): DirectArticleParseResult {
  return { ok: false, error: Object.freeze({ code, message }) };
}

function markerOffset(
  source: string,
  marker: string,
): number | DirectArticleParseResult {
  const first = source.indexOf(marker);
  if (first === -1) {
    return failure("missing-marker", `Direct article is missing ${marker}`);
  }
  if (source.indexOf(marker, first + marker.length) !== -1) {
    return failure("duplicate-marker", `Direct article repeats ${marker}`);
  }
  const before = source[first - 1];
  const after = source[first + marker.length];
  if ((first > 0 && before !== "\n") || (after !== undefined && after !== "\n")) {
    return failure("invalid-structure", `Direct article marker must occupy its own line: ${marker}`);
  }
  return first;
}

function downshiftBodyHeadings(markdown: string): string {
  let fence: { readonly character: "`" | "~"; readonly length: number } | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const fenceMatch = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line);
      if (fenceMatch !== null) {
        const delimiter = fenceMatch[1];
        if (delimiter === undefined) return line;
        const character = delimiter[0];
        if (character !== "`" && character !== "~") return line;
        if (fence === null) {
          fence = { character, length: delimiter.length };
        } else if (fence.character === character && delimiter.length >= fence.length) {
          fence = null;
        }
        return line;
      }
      if (fence !== null) return line;
      return line.replace(/^(#{3,6})(?=\s)/u, (heading) => heading.slice(1));
    })
    .join("\n");
}

function isHttpsUrl(value: string): value is `https://${string}` {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function parseDirectArticleSource(input: unknown): DirectArticleParseResult {
  if (typeof input !== "string") {
    return failure("invalid-source", "Direct article source must be a string");
  }

  const start = markerOffset(input, ARTICLE_START_MARKER);
  if (typeof start !== "number") return start;
  const end = markerOffset(input, ARTICLE_END_MARKER);
  if (typeof end !== "number") return end;
  if (start >= end) {
    return failure("invalid-structure", "Direct article start marker must precede its end marker");
  }

  const section = input
    .slice(start + ARTICLE_START_MARKER.length, end)
    .trim();
  const lines = section.split("\n");
  const heading = /^## \[([^\]]+)\]\(<([^>]+)>\)$/u.exec(lines[0] ?? "");
  if (heading === null) {
    return failure("invalid-heading", "Direct article must begin with one linked level-two heading");
  }
  const title = heading[1];
  const canonicalUrl = heading[2];
  if (
    title === undefined
    || title.length === 0
    || canonicalUrl === undefined
    || !isHttpsUrl(canonicalUrl)
  ) {
    return failure("invalid-heading", "Direct article heading must contain a title and HTTPS URL");
  }
  if (lines[1] !== "") {
    return failure("invalid-structure", "Direct article heading and dek must be separated by one blank line");
  }
  const dekMatch = /^> (.+)$/u.exec(lines[2] ?? "");
  if (dekMatch?.[1] === undefined || dekMatch[1].length === 0) {
    return failure("invalid-structure", "Direct article must contain one single-line dek");
  }
  if (lines[3] !== "") {
    return failure("invalid-structure", "Direct article dek and body must be separated by one blank line");
  }
  const body = lines.slice(4).join("\n").trim();
  if (body.length === 0) {
    return failure("invalid-structure", "Direct article body must not be empty");
  }

  return {
    ok: true,
    value: Object.freeze({
      canonicalUrl,
      dek: dekMatch[1],
      markdown: downshiftBodyHeadings(body),
      title,
    }),
  };
}

export async function loadDirectArticle(
  readmePath = resolve(process.cwd(), "README.md"),
): Promise<DirectArticleSource> {
  const source = await readFile(readmePath, "utf8");
  const parsed = parseDirectArticleSource(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}
