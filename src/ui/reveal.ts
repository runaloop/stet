import { hydratePartialDiff, type FileDiffMetadata } from "@pierre/diffs";
import type { Span } from "./cursor.ts";

/**
 * The lines of a file shown beyond the hunks of its diff, the same for its code and for it rendered: spans of lines of
 * the new version (the unchanged lines between hunks are the same on both sides), or the whole file.
 */
export interface Reveal {
  spans: readonly Span[];
  full: boolean;
}

export const NOTHING: Reveal = { spans: [], full: false };

/** How many lines a "show more" reveals, in the code and rendered alike (rendered rounds it out to whole blocks). */
export const CHUNK = 20;

export interface HunkShape {
  deletionStart: number;
  deletionCount: number;
  additionStart: number;
  additionCount: number;
  hunkContent: readonly ({ type: "context"; lines: number } | { type: "change"; deletions: number; additions: number })[];
}

export function mergeSpans(spans: readonly Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].filter((x) => x.end >= x.start).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + 1) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export function withSpan(r: Reveal, s: Span): Reveal {
  return { ...r, spans: mergeSpans([...r.spans, s]) };
}

/** A line of the whole file in diff order: unchanged on both sides, or removed, or added; `hunk` when the diff shows it. */
export interface FileLine {
  kind: "same" | "del" | "add";
  old: number | null;
  new: number | null;
  hunk: boolean;
}

// a hunk with no lines on a side names the line before them
const firstLine = (start: number, count: number) => (count ? start : start + 1);

export function fileLines(hunks: readonly HunkShape[], oldCount: number, newCount: number): FileLine[] {
  const out: FileLine[] = [];
  let o = 1;
  let n = 1;
  const same = (hunk: boolean) => out.push({ kind: "same", old: o++, new: n++, hunk });
  for (const h of hunks) {
    const first = firstLine(h.deletionStart, h.deletionCount);
    while (o < first && o <= oldCount) same(false);
    for (const g of h.hunkContent) {
      if (g.type === "context") {
        for (let i = 0; i < g.lines; i++) same(true);
        continue;
      }
      for (let i = 0; i < g.deletions; i++) out.push({ kind: "del", old: o++, new: null, hunk: true });
      for (let i = 0; i < g.additions; i++) out.push({ kind: "add", old: null, new: n++, hunk: true });
    }
  }
  while (o <= oldCount && n <= newCount) same(false);
  return out;
}

/** The unchanged lines the diff leaves out, before each hunk and after the last one, as lines of the new version. */
export function gapsOf(hunks: readonly HunkShape[], newCount: number): Span[] {
  const gaps: Span[] = [];
  let next = 1;
  for (const h of hunks) {
    const first = firstLine(h.additionStart, h.additionCount);
    gaps.push({ start: next, end: first - 1 });
    next = first + h.additionCount;
  }
  gaps.push({ start: next, end: newCount });
  return gaps;
}

/** The lines a "show more" of the code reveals in the gap before hunk `index` (after the last one for the count of hunks). */
export function expansionOf(hunks: readonly HunkShape[], newCount: number, index: number, direction: "up" | "down" | "both", count: number): Span | null {
  const gap = gapsOf(hunks, newCount)[index];
  if (!gap || gap.end < gap.start) return null;
  if (direction === "both" || !Number.isFinite(count)) return gap;
  return direction === "up" ? { start: gap.start, end: Math.min(gap.end, gap.start + count - 1) } : { start: Math.max(gap.start, gap.end - count + 1), end: gap.end };
}

/** A line of the old version that did not change, as a line of the new version. */
export function newLineOf(hunks: readonly HunkShape[], old: number): number {
  let shift = 0;
  for (const h of hunks) {
    const oldNext = firstLine(h.deletionStart, h.deletionCount) + h.deletionCount;
    if (old < oldNext) break;
    shift = firstLine(h.additionStart, h.additionCount) + h.additionCount - oldNext;
  }
  return old + shift;
}

export function textLines(text: string): { lines: string[]; eol: boolean } {
  if (text === "") return { lines: [], eol: true };
  const lines = text.split("\n");
  const eol = text.endsWith("\n");
  if (eol) lines.pop();
  return { lines, eol };
}

/**
 * A diff of some of a file's changes (a guide step's lines, a thread's region) with both versions' lines, ready to
 * draw. The diff viewer reads the unchanged lines before each hunk as equally long on both sides, highlights every
 * line of a side in one pass and takes a drawn line by its place in that pass; past the last hunk it wants both sides
 * equally long. A change the patch leaves out breaks all of that: it read the old version before its start or past
 * its end, every old line after came out shifted (a word diff on another line), or it refused the diff ("trailing
 * context mismatch"). Then both sides get lines of their own: before each hunk as many unchanged lines as both
 * versions have there, the hunk's own lines, after the last one the new version's rest, and the hunks point at them.
 * Their numbers stay those of each version: they are what is shown and what comments anchor by. The bars between
 * hunks count those lines; the lines they open come through `onExpand`, which counts the new version's.
 */
export function hydrateSubset(fd: FileDiffMetadata, oldFile: { name: string; contents: string }, newFile: { name: string; contents: string }): FileDiffMetadata {
  let full: FileDiffMetadata;
  try {
    full = hydratePartialDiff("clone", fd, { oldFile, newFile } as never);
  } catch {
    return fd;
  }
  const starts = full.hunks.map((h) => ({ old: firstLine(h.deletionStart, h.deletionCount) - 1, now: firstLine(h.additionStart, h.additionCount) - 1 }));
  const ends = full.hunks.map((h, i) => ({ old: starts[i]!.old + h.deletionCount, now: starts[i]!.now + h.additionCount }));
  const gaps = starts.map((s, i) => ({ old: s.old - (ends[i - 1]?.old ?? 0), now: s.now - (ends[i - 1]?.now ?? 0) }));
  const end = ends.at(-1) ?? { old: 0, now: 0 };
  const tail = full.additionLines.length - end.now;
  if (gaps.every((g) => g.old === g.now) && full.deletionLines.length - end.old === tail) return full;
  const old: string[] = [];
  const now: string[] = [];
  let split = 0;
  let unified = 0;
  const hunks = full.hunks.map((h, i) => {
    const s = starts[i]!;
    const gap = Math.min(gaps[i]!.old, gaps[i]!.now);
    old.push(...full.deletionLines.slice(s.old - gap, s.old));
    now.push(...full.additionLines.slice(s.now - gap, s.now));
    const at = { old: old.length, now: now.length };
    old.push(...full.deletionLines.slice(s.old, s.old + h.deletionCount));
    now.push(...full.additionLines.slice(s.now, s.now + h.additionCount));
    const hunk = {
      ...h,
      collapsedBefore: gap,
      deletionLineIndex: at.old,
      additionLineIndex: at.now,
      splitLineStart: split + gap,
      unifiedLineStart: unified + gap,
      hunkContent: h.hunkContent.map((c) => ({ ...c, deletionLineIndex: c.deletionLineIndex - h.deletionLineIndex + at.old, additionLineIndex: c.additionLineIndex - h.additionLineIndex + at.now })),
    };
    split += gap + h.splitLineCount;
    unified += gap + h.unifiedLineCount;
    return hunk;
  });
  // the rest of the new version after the last hunk on both sides, then lines nobody reads, so that each side is as
  // long as its version says past the last hunk
  const rest = full.additionLines.slice(end.now);
  return {
    ...full,
    hunks,
    deletionLines: [...old, ...rest, ...Array<string>(end.old - old.length).fill("\n")],
    additionLines: [...now, ...rest, ...Array<string>(end.now - now.length).fill("\n")],
    splitLineCount: split + tail,
    unifiedLineCount: unified + tail,
  };
}

const holds = (spans: readonly Span[], n: number | null) => n !== null && spans.some((s) => s.start <= n && n <= s.end);

/**
 * The diff with the revealed lines as context: hunks grow to them, and an island of revealed lines between hunks is a
 * hunk of its own. `hunks` are all the changes of the file; `base`, when given, the lines shown before anything is
 * revealed (some of the changes, as around a thread), else the hunks. Null when that shows nothing more than the hunks.
 */
export function revealedPatch(
  oldFile: { path: string; text: string },
  newFile: { path: string; text: string },
  hunks: readonly HunkShape[],
  reveal: Reveal,
  base?: { old: readonly Span[]; new: readonly Span[] },
): string | null {
  if (!base && !reveal.full && !reveal.spans.length) return null;
  const a = textLines(oldFile.text);
  const b = textLines(newFile.text);
  const rows = fileLines(hunks, a.lines.length, b.lines.length);
  const spans = mergeSpans(reveal.spans);
  // a removed line is revealed with the line of the new version it stands before
  const at: number[] = [];
  for (let i = rows.length - 1, next = b.lines.length + 1; i >= 0; i--) {
    next = rows[i]!.new ?? next;
    at[i] = next;
  }
  const shown = rows.map((r, i) => reveal.full || (base ? holds(base.old, r.old) || holds(base.new, r.new) : r.hunk) || holds(spans, at[i]!));
  if (!base && shown.every((s, i) => s === rows[i]!.hunk)) return null;
  if (!shown.some(Boolean)) return null;
  const body: string[] = [];
  let lastOld = 0;
  let lastNew = 0;
  for (let i = 0; i < rows.length; ) {
    if (!shown[i]) {
      lastOld = rows[i]!.old ?? lastOld;
      lastNew = rows[i]!.new ?? lastNew;
      i++;
      continue;
    }
    const group: FileLine[] = [];
    for (; i < rows.length && shown[i]; i++) group.push(rows[i]!);
    const olds = group.flatMap((r) => (r.old === null ? [] : [r.old]));
    const news = group.flatMap((r) => (r.new === null ? [] : [r.new]));
    body.push(`@@ -${olds.length ? olds[0] : lastOld},${olds.length} +${news.length ? news[0] : lastNew},${news.length} @@`);
    for (const r of group) {
      const text = r.kind === "del" ? a.lines[r.old! - 1] : b.lines[r.new! - 1];
      body.push(`${r.kind === "same" ? " " : r.kind === "del" ? "-" : "+"}${text}`);
      const endsOld = r.old === a.lines.length && !a.eol;
      const endsNew = r.new === b.lines.length && !b.eol;
      if ((r.kind !== "add" && endsOld) || (r.kind !== "del" && endsNew)) body.push("\\ No newline at end of file");
      lastOld = r.old ?? lastOld;
      lastNew = r.new ?? lastNew;
    }
  }
  const rename = oldFile.path !== newFile.path ? `rename from ${oldFile.path}\nrename to ${newFile.path}\n` : "";
  return `diff --git a/${oldFile.path} b/${newFile.path}\n${rename}--- a/${oldFile.path}\n+++ b/${newFile.path}\n${body.join("\n")}\n`;
}
