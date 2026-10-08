import MarkdownIt, { type Env } from "markdown-it";

interface GuideEnv extends Env {
  thread: (id: number) => string | null;
}

// html: false as for Markdown files: raw HTML in a step comes out as text. Links and pictures do not leave the page.
const md = new MarkdownIt({ html: false });
const { escapeHtml } = md.utils;
const THREAD = /(?<![\w&#])#(\d+)\b/g;

md.renderer.rules.link_open = (tokens, idx) => `<a class="md-outside" title="${escapeHtml(String(tokens[idx]!.attrGet("href") ?? ""))}">`;
md.renderer.rules.image = (tokens, idx, options, env, self) => `<span class="md-image-off">▧ ${escapeHtml(self.renderInlineAsText(tokens[idx]!.children ?? [], options, env))}</span>`;
md.renderer.rules.text = (tokens, idx, _options, env) => {
  const text = tokens[idx]!.content;
  const href = (env as GuideEnv).thread;
  let out = "";
  let pos = 0;
  for (const m of text.matchAll(THREAD)) {
    const to = href(Number(m[1]));
    if (!to) continue;
    out += `${escapeHtml(text.slice(pos, m.index))}<a class="guide-thread" href="${escapeHtml(to)}" data-thread="${m[1]}">${escapeHtml(m[0])}</a>`;
    pos = m.index! + m[0].length;
  }
  return out + escapeHtml(text.slice(pos));
};

/** A step's text as HTML; `#12` links to the thread when `thread` gives it an address. */
export function guideHtml(text: string, thread: (id: number) => string | null): string {
  return md.render(text, { thread } satisfies GuideEnv);
}
