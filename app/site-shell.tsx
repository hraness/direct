import type { ReactNode } from "react";

export const DIRECT_ARTICLE_URL =
  "https://hraness.pub/articles/direct-a-harness-for-your-frontend";
export const DIRECT_GITHUB_URL = "https://github.com/hraness/direct";

type DirectRoute = "home" | "overview";

function current(route: DirectRoute, activeRoute: DirectRoute) {
  return route === activeRoute ? "page" as const : undefined;
}

export function SiteHeader(
  { activeRoute }: Readonly<{ activeRoute: DirectRoute }>,
) {
  return (
    <header className="direct-site-header">
      <div className="direct-shell direct-site-header__inner">
        <a
          className="direct-wordmark"
          href="/"
          aria-current={current("home", activeRoute)}
          aria-label="Direct home"
        >
          <span aria-hidden="true">D/</span>
          <span>Direct</span>
        </a>
        <nav aria-label="Primary navigation">
          <a
            href="/docs/overview"
            aria-current={current("overview", activeRoute)}
          >
            Overview
          </a>
          <a href={DIRECT_ARTICLE_URL}>Article</a>
          <a href={DIRECT_GITHUB_URL}>GitHub</a>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter(
  { children }: Readonly<{ children?: ReactNode }>,
) {
  return (
    <footer className="direct-site-footer">
      <div className="direct-shell direct-site-footer__inner">
        <p>{children ?? "Direct is an MIT-licensed TypeScript package."}</p>
        <a href={`${DIRECT_GITHUB_URL}#install`}>Install from GitHub</a>
      </div>
    </footer>
  );
}
