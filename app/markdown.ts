import {
  highlightCode,
  resolveSyntaxLanguage,
} from "./syntax-highlighting";
import { marked, Renderer } from "marked";

export function renderTrustedMarkdown(markdown: string): string {
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
    throw new TypeError("Direct Markdown rendering must complete synchronously");
  }
  return rendered;
}
