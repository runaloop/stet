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
 * The old version to draw a patch of some of a file's changes with. Past the patch's last hunk a change it leaves out
 * makes the two versions differ in length, which the diff viewer refuses ("trailing context mismatch"); there the old
 * version takes the new one's lines, so the bar below counts lines of the new version, as `gapsOf` does. Unchanged when
 * the lengths agree.
 */
export function evenTail(oldText: string, newText: string, last: HunkShape | undefined): string {
  if (!last) return oldText;
  const a = textLines(oldText);
  const b = textLines(newText);
  const oldEnd = firstLine(last.deletionStart, last.deletionCount) + last.deletionCount - 1;
  const newEnd = firstLine(last.additionStart, last.additionCount) + last.additionCount - 1;
  if (a.lines.length - oldEnd === b.lines.length - newEnd) return oldText;
  const lines = [...a.lines.slice(0, oldEnd), ...b.lines.slice(newEnd)];
  return lines.length ? lines.join("\n") + (b.eol ? "\n" : "") : "";
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
