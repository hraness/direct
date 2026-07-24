import type { Metadata } from "next";

import { loadDirectArticle } from "../../article";
import { renderTrustedMarkdown } from "../../markdown";
import { SiteFooter, SiteHeader } from "../../site-shell";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Overview — Direct",
  description:
    "How Direct pairs deterministic app states with browser agents, where its proof stops, and when a smaller tool is enough.",
  alternates: { canonical: "/docs/overview" },
  openGraph: {
    type: "article",
    url: "/docs/overview",
    title: "Overview — Direct",
    description:
      "How Direct pairs deterministic app states with browser agents, where its proof stops, and when a smaller tool is enough.",
  },
};

export default async function OverviewPage() {
  const article = await loadDirectArticle();
  const articleHtml = renderTrustedMarkdown(article.markdown);

  return (
    <>
      <a className="direct-skip-link" href="#overview">
        Skip to overview
      </a>
      <SiteHeader activeRoute="overview" />

      <main>
        <article id="overview">
          <header className="direct-shell direct-article-header">
            <p className="direct-kicker">Overview</p>
            <h1>{article.title}</h1>
            <p className="direct-dek">{article.dek}</p>
            <div className="direct-article-meta">
              <span>Direct 0.4.0</span>
              <span aria-hidden="true">·</span>
              <a href={article.canonicalUrl}>Read on Hraness</a>
            </div>
          </header>

          <div
            className="direct-shell direct-article-body"
            // This trusted Markdown comes from the repository-controlled README
            // section parsed above; no network or user input reaches this path.
            dangerouslySetInnerHTML={{ __html: articleHtml }}
          />
        </article>
      </main>

      <SiteFooter />
    </>
  );
}
