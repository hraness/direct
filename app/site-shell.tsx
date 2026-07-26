export const DIRECT_ARTICLE_URL =
  "https://hraness.pub/articles/direct-a-harness-for-your-frontend";
export const DIRECT_DESCRIPTION = "Repeatable app screens for coding agents.";
export const DIRECT_GITHUB_URL = "https://github.com/hraness/direct";
export const DIRECT_SITE_URL = "https://hraness.direct";
export const DIRECT_TAGLINE = "repeatable app screens for coding agents";
export const DIRECT_TITLE = `direct — ${DIRECT_TAGLINE}`;

type DirectRoute = "home" | "overview";

function current(route: DirectRoute, activeRoute: DirectRoute) {
  return route === activeRoute ? "page" as const : undefined;
}

export function SiteHeader(
  { activeRoute }: Readonly<{ activeRoute: DirectRoute }>,
) {
  return (
    <header className="direct-site-header">
      <nav aria-label="project">
        <a href="/" aria-current={current("home", activeRoute)}>direct</a>
        <span aria-hidden="true"> · </span>
        <a href="/docs/overview" aria-current={current("overview", activeRoute)}>
          overview
        </a>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="plain-footer direct-site-footer">
      <p>MIT</p>
      <a href={DIRECT_GITHUB_URL}>github</a>
    </footer>
  );
}
