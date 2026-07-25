import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DIRECT_PACKAGE_VERSION } from "../../version";
import OverviewPage from "./page";

describe("Direct Overview page", () => {
  test("renders the synchronized publication as a readable product overview", async () => {
    const html = renderToStaticMarkup(await OverviewPage());

    expect(html).toContain("<h1>Direct gives browser agents deterministic app states</h1>");
    expect(html).toContain(`Direct ${DIRECT_PACKAGE_VERSION}`);
    expect(html).toContain("Browser control and app state are different jobs");
    expect(html).toContain('href="https://agent-browser.dev/"');
    expect(html).toContain("Use browser automation alone");
    expect(html).toContain("Direct exposes a quiescence snapshot");
    expect(html).toContain("product-owned verifier code");
    expect(html).not.toContain("The browser helper waits");
    expect(html).not.toContain("live-system tests remain responsible");
  });

  test("server-renders highlighted fenced examples", async () => {
    const html = renderToStaticMarkup(await OverviewPage());

    expect(html).toContain("syntax-code language-typescript");
    expect(html).toContain("--sh-keyword");
    expect(html).toContain("syntax-code language-text");
    expect(html).toContain('tabindex="0"');
  });
});
