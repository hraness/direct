import {
  DIRECT_ARTICLE_URL,
  DIRECT_GITHUB_URL,
  SiteFooter,
} from "./site-shell";

export const dynamic = "force-static";

const installCommand = "bun add --dev github:hraness/direct#v0.5.0";

export default function HomePage() {
  return (
    <>
      <main className="plain-page direct-page" id="main">
        <h1>direct</h1>
        <p>named, repeatable app states for browser agents.</p>

        <section aria-labelledby="install">
          <h2 id="install">install</h2>
          <pre className="plain-code"><code>{installCommand}</code></pre>
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
