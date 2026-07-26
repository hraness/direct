import {
  DIRECT_ARTICLE_URL,
  DIRECT_DESCRIPTION,
  DIRECT_GITHUB_URL,
  DIRECT_SITE_URL,
  DIRECT_TAGLINE,
  SiteFooter,
} from "./site-shell";
import { DIRECT_INSTALL_COMMAND } from "./version";

export const dynamic = "force-static";

const structuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  applicationCategory: "DeveloperApplication",
  codeRepository: DIRECT_GITHUB_URL,
  description: DIRECT_DESCRIPTION,
  isAccessibleForFree: true,
  name: "Direct",
  operatingSystem: "Any",
  url: `${DIRECT_SITE_URL}/`,
} as const;

export default function HomePage() {
  return (
    <>
      <main className="plain-page direct-page" id="main">
        <script
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structuredData).replaceAll("<", "\\u003c"),
          }}
          id="direct-structured-data"
          type="application/ld+json"
        />
        <h1>direct</h1>
        <p>{DIRECT_TAGLINE}.</p>

        <section aria-labelledby="install">
          <h2 id="install">install</h2>
          <pre className="plain-code"><code>{DIRECT_INSTALL_COMMAND}</code></pre>
          <p className="plain-muted">development only.</p>
        </section>

        <section aria-labelledby="about">
          <h2 id="about">about</h2>
          <p>
            set up signed-in, empty, error, and other hard-to-reach screens once,
            then open them by URL during development.
          </p>
          <p>
            your interface and feature code run normally. in development,
            direct replaces only the outside systems needed for that screen
            with predictable local stand-ins. direct does not click through the
            browser or test the systems it replaces.
          </p>
        </section>

        <section aria-labelledby="links">
          <h2 id="links">links</h2>
          <ul className="plain-links">
            <li><a href="/docs/overview">overview</a></li>
            <li><a href={DIRECT_GITHUB_URL}>github</a></li>
            <li><a href={DIRECT_ARTICLE_URL}>article</a></li>
          </ul>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
