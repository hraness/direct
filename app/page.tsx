import {
  highlightCode,
  resolveSyntaxLanguage,
} from "./syntax-highlighting";
import { marked, Renderer } from "marked";

import { loadDirectArticle } from "./article";

export const dynamic = "force-static";

function renderMarkdown(markdown: string): string {
  const renderer = new Renderer();
  renderer.code = ({ lang, text }) => {
    const language = resolveSyntaxLanguage(lang);
    const highlighted = highlightCode(text, language);
    return `<pre tabindex="0"><code class="${highlighted.className}" data-language="${highlighted.language}">${highlighted.html}</code></pre>\n`;
  };

  const rendered = marked.parse(markdown, {
    async: false,
    gfm: true,
    renderer,
  });
  if (typeof rendered !== "string") {
    throw new TypeError("Direct article rendering must complete synchronously");
  }
  return rendered;
}

export default async function HomePage() {
  const article = await loadDirectArticle();
  const articleHtml = renderMarkdown(article.markdown);

  return (
    <>
      <a className="direct-skip-link" href="#article">
        Skip to article
      </a>
      <header className="direct-site-header">
        <div className="direct-shell direct-site-header__inner">
          <a className="direct-wordmark" href="/" aria-label="Direct home">
            <span aria-hidden="true">D/</span>
            <span>Direct</span>
          </a>
          <nav aria-label="Primary navigation">
            <a href={article.canonicalUrl}>Article</a>
            <a href="https://github.com/hraness/direct">GitHub</a>
          </nav>
        </div>
      </header>

      <main>
        <article id="article">
          <header className="direct-shell direct-article-header">
            <p className="direct-kicker">Deterministic interface verification</p>
            <h1>{article.title}</h1>
            <p className="direct-dek">{article.dek}</p>
            <div className="direct-article-meta">
              <span>Direct 0.4.0</span>
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

      <footer className="direct-site-footer">
        <div className="direct-shell direct-site-footer__inner">
          <p>Direct is an MIT-licensed TypeScript package.</p>
          <a href="https://github.com/hraness/direct#install">
            Install from GitHub
          </a>
        </div>
      </footer>
    </>
  );
}
