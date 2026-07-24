import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import OverviewPage from "./page";

describe("Direct Overview page", () => {
  test("renders the synchronized publication as a readable product overview", async () => {
    const html = renderToStaticMarkup(await OverviewPage());

    expect(html).toContain("<h1>Direct gives browser agents deterministic app states</h1>");
    expect(html).toContain("Browser control and app state are different jobs");
    expect(html).toContain('href="https://agent-browser.dev/"');
    expect(html).toContain("Use browser automation alone");
  });

  test("server-renders highlighted fenced examples", async () => {
    const html = renderToStaticMarkup(await OverviewPage());

    expect(html).toContain("syntax-code language-typescript");
    expect(html).toContain("--sh-keyword");
    expect(html).toContain("syntax-code language-text");
    expect(html).toContain('tabindex="0"');
  });
});
