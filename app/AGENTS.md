# Contents

- `article.ts` – strict extraction of the synchronized article from the public README.
- `article.test.ts` and `article.property.test.ts` – named regressions and arbitrary-input laws for that extraction boundary.
- `page.tsx` and `page.test.tsx` – the static Direct article page at `hraness.direct` and its server-markup regressions.
- `syntax-highlighting.ts` and `syntax-highlighting.css` – the vendored typed server highlighter and semantic syntax-color recipe used by fenced code.
- `layout.tsx` and `globals.css` – site metadata plus the neutral reading surface.
- `robots.ts`, `sitemap.ts`, `manifest.ts`, `icon.png`, `apple-icon.png`, and `opengraph-image.tsx` – crawl, install, icon, and social metadata.
- `../tsconfig.site.json` and `../tsconfig.site-test.json` – separate browser/Next and Bun-test type boundaries.

# Guidelines

- Keep the site statically generated, dependency-light, and readable without client JavaScript.
- Treat the synchronized README article as the local public source of truth. Parse its exact markers and structure instead of maintaining a second prose copy.
- Parse foreign text through the fallible article boundary, keep one visible `h1`, and shift README body headings only outside fenced code.
- Render only repository-controlled Markdown. Do not generalize the trusted HTML path to user or network input.
- Parse fenced-code language labels into the highlighter's closed union, preserve exact accessible source text, and keep code horizontally scrollable.
- Keep canonical metadata on `https://hraness.direct`, point the `Article` navigation item directly at the canonical `hraness.pub` article, omit a duplicate publication-attribution link, and retain the public GitHub repository link.
- Keep site files out of the packed runtime allowlist; a package install may carry only the documented runtime, types, examples, and skills.
- Run `bun run site:test`, `bun run site:typecheck`, and `bun run site:build` after changing this boundary.
