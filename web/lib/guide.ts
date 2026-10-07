import MarkdownIt, { type Env } from "markdown-it";
import type { CompareFile, ComparePlacement, GuideDto, GuideRefDto } from "../../src/core/types.ts";
import type { Span } from "./cursor.ts";
import { revealedPatch, type HunkShape } from "./reveal.ts";

/** Lines shown around a step's lines at first. */
export const GUIDE_CONTEXT = 3;

export const refLabel = (r: GuideRefDto) => (r.range ? `${r.path}:${r.range.start === r.range.end ? r.range.start : `${r.range.start}-${r.range.end}`}` : r.path);

/**
 * A step's lines as a patch of the compare: lines `range` of the new file and `context` lines around them, with the
 * lines removed among them, and the lines of the new file in `more` (opened by the reader). A whole-file reference is
 * the file's own diff (`hunks`): null until the reader opens more of it.
 */
export function refPatch(
  ref: GuideRefDto,
  oldFile: { path: string; text: string },
  newFile: { path: string; text: string },
  hunks: readonly HunkShape[],
  more: readonly Span[] = [],
  context = GUIDE_CONTEXT,
): string | null {
  if (!ref.range) return more.length ? revealedPatch(oldFile, newFile, hunks, { spans: more, full: false }) : null;
  const { start, end } = ref.range;
  const around = { start: Math.max(1, start - context), end: end + context };
  return revealedPatch(oldFile, newFile, hunks, { spans: [around, ...more], full: false }, { old: [], new: [ref.range] });
}

/**
 * The lines of each side a step's reference shows rendered: its lines and those in `more`, without the lines around
 * them its code shows, as a rendered block shows whole; a whole-file reference, its file's diff.
 */
export function refShown(
  ref: GuideRefDto,
  oldFile: { path: string; text: string },
  newFile: { path: string; text: string },
  hunks: readonly HunkShape[],
  more: readonly Span[] = [],
): { old: Span[]; new: Span[] } | null {
  const patch = refPatch(ref, oldFile, newFile, hunks, more, 0);
  const heads = patch
    ? [...patch.matchAll(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/gm)].map((m) => ({ deletionStart: +m[1]!, deletionCount: +m[2]!, additionStart: +m[3]!, additionCount: +m[4]! }))
    : ref.range
      ? null
      : hunks;
  if (!heads) return null;
  return {
    old: heads.map((h) => ({ start: h.deletionStart, end: h.deletionStart + h.deletionCount - 1 })),
    new: heads.map((h) => ({ start: h.additionStart, end: h.additionStart + h.additionCount - 1 })),
  };
}

/** The changed files of the compare that no step names, in the compare's order. */
export function notInGuide(files: readonly CompareFile[], guide: GuideDto): CompareFile[] {
  const named = new Set(guide.steps.flatMap((s) => s.refs.map((r) => r.path)));
  return files.filter((f) => !named.has(f.path) && !(f.oldPath && named.has(f.oldPath)));
}

/**
 * The threads on a reference's lines, each at the last of its lines the reference shows: `shown` are the line numbers
 * on each side.
 */
export function threadsOn(placements: readonly ComparePlacement[], path: string, shown: { old: readonly number[]; new: readonly number[] }): { placement: ComparePlacement; line: number }[] {
  return placements.flatMap((p) => {
    if (p.path !== path) return [];
    const lines = (p.side === "additions" ? shown.new : shown.old).filter((n) => n >= p.range.start && n <= p.range.end);
    return lines.length ? [{ placement: p, line: Math.max(...lines) }] : [];
  });
}

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
