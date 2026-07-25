import {
  DIRECT_ARTICLE_URL,
  DIRECT_GITHUB_URL,
  SiteFooter,
} from "./site-shell";
import { DIRECT_INSTALL_COMMAND } from "./version";

export const dynamic = "force-static";

const structuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  applicationCategory: "DeveloperApplication",
  codeRepository: DIRECT_GITHUB_URL,
  description: "Named, repeatable app states for browser agents.",
  isAccessibleForFree: true,
  name: "Direct",
  operatingSystem: "Any",
  url: "https://hraness.direct/",
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
        <p>named, repeatable app states for browser agents.</p>

        <section aria-labelledby="install">
          <h2 id="install">install</h2>
          <pre className="plain-code"><code>{DIRECT_INSTALL_COMMAND}</code></pre>
          <p className="plain-muted">development only.</p>
        </section>

        <section aria-labelledby="about">
          <h2 id="about">about</h2>
          <p>
            define signed-in, empty, error, and other hard-to-reach states once,
            then open them by url in a development build.
          </p>
          <p>
            your interface and feature code stay on their normal paths. the
            development composition replaces selected external systems with
            deterministic adapters. direct does not drive the browser or test
            those systems.
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
