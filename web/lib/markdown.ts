import MarkdownIt, { type Env, type Token } from "markdown-it";
import { imageType } from "../../src/core/media.ts";
import { changedBlocks, hitBlocks, ownHits, resolveRef, type Block, type SideChanges } from "../../src/ui/markdown.ts";

export interface RenderOptions {
  /** The file's path in the repository: relative links and images resolve against its folder. */
  path: string;
  /** Where the page loads an image file of the repository from, at the snapshot of the text. */
  imageUrl: (path: string) => string;
  changes: SideChanges | null;
  /** HTML of a highlighted code block, or null to leave it plain. */
  highlight?: ((code: string, lang: string) => string | null) | null;
}

export interface Rendered {
  blocks: Block[];
  hit: boolean[];
  /** Blocks whose own lines changed (see `ownHits`). */
  own: boolean[];
  /** The source, line by line (line 1 at index 0). */
  lines: string[];
  /** HTML of each top-level block, by its index in `blocks`. */
  tops: { block: number; html: string }[];
  /** Languages of the fenced code blocks. */
  langs: string[];
}

interface RenderEnv extends Env, RenderOptions {
  langs: Set<string>;
}

// html: false: raw HTML in the file comes out as text.
const md = new MarkdownIt({ html: false });
const { escapeHtml, unescapeAll } = md.utils;
const attr = (v: string | number | null) => escapeHtml(String(v ?? ""));

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const t = tokens[idx]!;
  const e = env as RenderEnv;
  const src = String(t.attrGet("src") ?? "");
  const alt = self.renderInlineAsText(t.children ?? [], options, env);
  const ref = resolveRef(src, e.path);
  if ("path" in ref && imageType(ref.path)) {
    const title = t.attrGet("title");
    return `<img src="${attr(e.imageUrl(ref.path))}" alt="${attr(alt)}" data-path="${attr(ref.path)}" data-src="${attr(src)}"${title ? ` title="${attr(title)}"` : ""}>`;
  }
  const why = "path" in ref ? "not an image file" : "not loaded: the review loads no pictures from outside the repository";
  return `<span class="md-image-off" title="${attr(why)}">▧ ${alt ? `${escapeHtml(alt)} · ` : ""}<code>${escapeHtml(src)}</code></span>`;
};

md.renderer.rules.link_open = (tokens, idx, _options, env) => {
  const href = String(tokens[idx]!.attrGet("href") ?? "");
  const ref = resolveRef(href, (env as RenderEnv).path);
  if ("path" in ref) return `<a class="md-file" data-path="${attr(ref.path)}"${ref.line ? ` data-line="${ref.line}"` : ""} data-href="${attr(href)}" title="${attr(`${ref.path}: open it in the preview`)}">`;
  return `<a class="md-outside" data-href="${attr(href)}" title="${attr(href)}">`;
};

md.renderer.rules.fence = (tokens, idx, _options, env, self) => {
  const t = tokens[idx]!;
  const e = env as RenderEnv;
  const lang = unescapeAll(t.info).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (lang) e.langs.add(lang);
  t.attrJoin("class", "md-code");
  return `<div${self.renderAttrs(t)}>${(lang && e.highlight?.(t.content, lang)) || `<pre><code>${escapeHtml(t.content)}</code></pre>`}</div>\n`;
};

md.renderer.rules.code_block = (tokens, idx, _options, _env, self) => {
  const t = tokens[idx]!;
  t.attrJoin("class", "md-code");
  return `<div${self.renderAttrs(t)}><pre><code>${escapeHtml(t.content)}</code></pre></div>\n`;
};

/**
 * The file as HTML, one piece per top-level block: every block carries its index (`data-b`) and its source lines
 * (`data-start`, `data-end`), and the innermost blocks the diff changed are marked `md-changed`.
 */
export function renderMarkdown(text: string, opts: RenderOptions): Rendered {
  const env: RenderEnv = { ...opts, langs: new Set() };
  const tokens = md.parse(text, env);
  const lines = text.split("\n");
  const blocks: Block[] = [];
  const owner = new Map<Token, number>();
  const stack: { i: number; level: number }[] = [];
  for (const t of tokens) {
    while (stack.length && stack[stack.length - 1]!.level >= t.level) stack.pop();
    if (!t.block || !t.map || t.hidden || t.nesting === -1 || t.type === "inline") continue;
    const i = blocks.length;
    const start = t.map[0] + 1;
    // a list item's lines run on over the blank lines after it
    let end = t.map[1];
    while (end > start && !lines[end - 1]!.trim()) end--;
    blocks.push({ start, end, parent: stack[stack.length - 1]?.i ?? -1, tag: t.type === "fence" || t.type === "code_block" ? "code" : t.tag });
    owner.set(t, i);
    t.attrSet("data-b", i);
    t.attrSet("data-start", start);
    t.attrSet("data-end", end);
    if (t.nesting === 1) stack.push({ i, level: t.level });
  }
  const hit = opts.changes ? hitBlocks(blocks, opts.changes) : blocks.map(() => false);
  const own = opts.changes ? ownHits(blocks, opts.changes) : blocks.map(() => false);
  const changed = changedBlocks(blocks, hit);
  for (const [t, i] of owner) if (changed.has(i)) t.attrJoin("class", "md-changed");
  const tops: Rendered["tops"] = [];
  let from = 0;
  tokens.forEach((t, i) => {
    if (t.level !== 0 || t.nesting === 1) return;
    const block = owner.get(tokens[from]!);
    const html = md.renderer.render(tokens.slice(from, i + 1), md.options, env);
    from = i + 1;
    if (block !== undefined) tops.push({ block, html });
  });
  return { blocks, hit, own, lines, tops, langs: [...env.langs] };
}
