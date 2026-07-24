import {
  DIRECT_ARTICLE_URL,
  DIRECT_GITHUB_URL,
  SiteFooter,
} from "./site-shell";

export const dynamic = "force-static";

const installCommand = "bun add --dev github:hraness/direct#v0.4.0";

export default function HomePage() {
  return (
    <>
      <main className="plain-page direct-page" id="main">
        <h1>direct</h1>
        <p>deterministic app states for browser agents.</p>

        <section aria-labelledby="install">
          <h2 id="install">install</h2>
          <pre className="plain-code"><code>{installCommand}</code></pre>
          <p className="plain-muted">development only.</p>
        </section>

        <section aria-labelledby="about">
          <h2 id="about">about</h2>
          <p>
            direct gives a real frontend named, repeatable states without
            rebuilding accounts, cloud data, devices, permissions, or failures
            by hand.
          </p>
          <p>
            your browser tool still drives the page. live tests still prove the
            systems that direct replaces.
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
