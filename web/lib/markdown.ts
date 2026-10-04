import type { FileDiffMetadata } from "@pierre/diffs";
import MarkdownIt, { type Env, type Token } from "markdown-it";
import { imageType } from "../../src/core/image.ts";

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** Where a link or an image of a Markdown file points: a file of the repository (with a `#L12` line), or somewhere else. */
export type Ref = { path: string; line: number | null } | { outside: string };

/** Resolves `ref` written in the Markdown file `from`: relative to its folder, or to the repository root with a leading slash. */
export function resolveRef(ref: string, from: string): Ref {
  if (!ref || ref.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) return { outside: ref };
  const hash = ref.indexOf("#");
  let target: string;
  try {
    target = decodeURIComponent((hash === -1 ? ref : ref.slice(0, hash)).replace(/\?.*$/, ""));
  } catch {
    return { outside: ref };
  }
  const parts = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const p of target.split("/")) {
    if (p === "" || p === ".") continue;
    if (p !== "..") parts.push(p);
    else if (parts.pop() === undefined) return { outside: ref };
  }
  if (parts.length === 0) return { outside: ref };
  const line = /^L(\d+)/.exec(hash === -1 ? "" : ref.slice(hash + 1))?.[1];
  return { path: parts.join("/"), line: line ? Number(line) : null };
}

/** What the diff changed in the new file: the lines it added, and where it only removed lines (after which new line, how many, from which old line). */
export interface Changes {
  added: ReadonlySet<number>;
  removed: { after: number; count: number; old: number }[];
}

export function changesOf(fd: FileDiffMetadata): Changes {
  const added = new Set<number>();
  const removed: Changes["removed"] = [];
  for (const h of fd.hunks) {
    let o = h.deletionStart;
    let n = h.additionStart;
    for (const g of h.hunkContent) {
      if (g.type === "context") {
        o += g.lines;
        n += g.lines;
        continue;
      }
      for (let i = 0; i < g.additions; i++) added.add(n + i);
      if (g.deletions && !g.additions) removed.push({ after: n - 1, count: g.deletions, old: o });
      o += g.deletions;
      n += g.additions;
    }
  }
  return { added, removed };
}

/** A rendered block and its source lines, 1-based and inclusive; `parent` is the index of the block around it, -1 at the top. */
export interface Block {
  start: number;
  end: number;
  parent: number;
}

export interface BlockMarks {
  /** The innermost blocks whose lines changed. */
  changed: Set<number>;
  /** Lines removed between top-level blocks, shown before the block at that index (`blocks.length`: at the end). */
  removedBefore: Map<number, { count: number; old: number }>;
}

export function markBlocks(blocks: readonly Block[], changes: Changes): BlockMarks {
  const inside = (b: Block, after: number) => b.start <= after && after < b.end;
  const hit = blocks.map((b) => {
    for (let n = b.start; n <= b.end; n++) if (changes.added.has(n)) return true;
    return changes.removed.some((r) => inside(b, r.after));
  });
  const around = new Set<number>();
  blocks.forEach((b, i) => {
    if (hit[i]) for (let p = b.parent; p !== -1; p = blocks[p]!.parent) around.add(p);
  });
  const changed = new Set(blocks.flatMap((_, i) => (hit[i] && !around.has(i) ? [i] : [])));
  const removedBefore: BlockMarks["removedBefore"] = new Map();
  for (const r of changes.removed) {
    if (blocks.some((b) => inside(b, r.after))) continue;
    const next = blocks.findIndex((b) => b.parent === -1 && b.start > r.after);
    const at = next === -1 ? blocks.length : next;
    const had = removedBefore.get(at);
    removedBefore.set(at, { count: (had?.count ?? 0) + r.count, old: had?.old ?? r.old });
  }
  return { changed, removedBefore };
}

export interface RenderOptions {
  /** The file's path in the repository: relative links and images resolve against its folder. */
  path: string;
  /** Where the page loads an image file of the repository from, at the snapshot of the text. */
  imageUrl: (path: string) => string;
  changes: Changes | null;
  /** HTML of a highlighted code block, or null to leave it plain. */
  highlight?: ((code: string, lang: string) => string | null) | null;
}

export interface Rendered {
  html: string;
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
    return `<img src="${attr(e.imageUrl(ref.path))}" alt="${attr(alt)}" data-path="${attr(ref.path)}"${title ? ` title="${attr(title)}"` : ""}>`;
  }
  const why = "path" in ref ? "not an image file" : "not loaded: the review loads no pictures from outside the repository";
  return `<span class="md-image-off" title="${attr(why)}">▧ ${alt ? `${escapeHtml(alt)} · ` : ""}<code>${escapeHtml(src)}</code></span>`;
};

md.renderer.rules.link_open = (tokens, idx, _options, env) => {
  const href = String(tokens[idx]!.attrGet("href") ?? "");
  const ref = resolveRef(href, (env as RenderEnv).path);
  if ("path" in ref) return `<a class="md-file" data-path="${attr(ref.path)}"${ref.line ? ` data-line="${ref.line}"` : ""} title="${attr(`${ref.path}: open it in the preview`)}">`;
  return `<a class="md-outside" title="${attr(href)}">`;
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

const removedNote = (r: { count: number; old: number } | undefined) =>
  r ? `<div class="md-removed" data-old="${r.old}">− ${r.count} line${r.count === 1 ? "" : "s"} removed here</div>\n` : "";

/**
 * The file as HTML: every block carries its source lines (`data-start`, `data-end`), the innermost blocks the diff
 * changed are marked `md-changed`, and lines removed between blocks are listed where they were.
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
    blocks.push({ start, end, parent: stack[stack.length - 1]?.i ?? -1 });
    owner.set(t, i);
    t.attrSet("data-start", start);
    t.attrSet("data-end", end);
    if (t.nesting === 1) stack.push({ i, level: t.level });
  }
  const marks = opts.changes ? markBlocks(blocks, opts.changes) : null;
  for (const [t, i] of owner) if (marks?.changed.has(i)) t.attrJoin("class", "md-changed");
  let html = "";
  let from = 0;
  tokens.forEach((t, i) => {
    if (t.level !== 0 || t.nesting === 1) return;
    html += removedNote(marks?.removedBefore.get(owner.get(tokens[from]!) ?? -1)) + md.renderer.render(tokens.slice(from, i + 1), md.options, env);
    from = i + 1;
  });
  html += removedNote(marks?.removedBefore.get(blocks.length));
  return { html, langs: [...env.langs] };
}
