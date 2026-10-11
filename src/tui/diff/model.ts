/**
 * A diff as one flat list of rows over all its files: file headers, fold-group rows, bars of unchanged lines, code
 * rows (one line in unified, a removed and an added line side by side in split) and thread cards after the line they
 * end on. Kept in typed arrays: a compare of 3,500 files has a quarter of a million rows.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import type { Reveal } from "../../ui/reveal.ts";

export const FILE = 1;
export const GROUP = 2;
export const GAP = 3;
export const NOTE = 4;
export const CTX = 5;
export const DEL = 6;
export const ADD = 7;
export const PAIR = 8;
export const CARD = 9;

export const isLine = (k: number) => k >= CTX && k <= PAIR;

/** Where a thread is on a file's lines: its card follows the row of its last line. */
export interface Placed {
  threadId: number;
  side: "additions" | "deletions";
  range: { start: number; end: number };
}

export interface FileItem {
  kind: "file";
  /** What the cursor and the caller call the file: its path, or a key of its own. */
  key: string;
  fd: FileDiffMetadata;
  /** Only the header shows (▸). */
  collapsed: boolean;
  /** Unchanged lines shown beyond the hunks, for a diff with both files' text (`fd.isPartial` false). */
  reveal?: Reveal;
  placed?: readonly Placed[];
  /** In place of the code: a binary file, an image, a rename with no change. */
  note?: string;
  /** Lines of one version, not a diff: only their numbers show. */
  single?: boolean;
  /** No bar for the lines before the first hunk: the code is an excerpt, not a file. */
  excerpt?: boolean;
}

export interface GroupItem {
  kind: "group";
  key: string;
  open: boolean;
}

export type Item = FileItem | GroupItem;

export interface Rows {
  len: number;
  kind: Uint8Array;
  /** The item the row belongs to. */
  item: Int32Array;
  /** The line's index in `fd.deletionLines` (old side) and `fd.additionLines` (new side), -1 where it has none. */
  a: Int32Array;
  b: Int32Array;
  /** Line numbers, 0 where none: of the line, or of a bar's first folded line. */
  oldNo: Int32Array;
  newNo: Int32Array;
  /** A code row's hunk; a bar's place: the hunk after it, or the count of hunks for the end; a card's index in `placed`. */
  x: Int32Array;
  /** How many lines a bar folds; for a split row, how many of the pair's lines changed (1 or 2). */
  n: Int32Array;
  /** The first row of each item. */
  first: Int32Array;
}

class Builder {
  len = 0;
  cap: number;
  kind: Uint8Array;
  item: Int32Array;
  a: Int32Array;
  b: Int32Array;
  oldNo: Int32Array;
  newNo: Int32Array;
  x: Int32Array;
  n: Int32Array;

  constructor(cap: number) {
    this.cap = Math.max(16, cap);
    this.kind = new Uint8Array(this.cap);
    this.item = new Int32Array(this.cap);
    this.a = new Int32Array(this.cap);
    this.b = new Int32Array(this.cap);
    this.oldNo = new Int32Array(this.cap);
    this.newNo = new Int32Array(this.cap);
    this.x = new Int32Array(this.cap);
    this.n = new Int32Array(this.cap);
  }

  private grow(): void {
    this.cap *= 2;
    const g = <T extends Uint8Array | Int32Array>(arr: T): T => {
      const next = new (arr.constructor as new (n: number) => T)(this.cap);
      next.set(arr);
      return next;
    };
    this.kind = g(this.kind);
    this.item = g(this.item);
    this.a = g(this.a);
    this.b = g(this.b);
    this.oldNo = g(this.oldNo);
    this.newNo = g(this.newNo);
    this.x = g(this.x);
    this.n = g(this.n);
  }

  push(kind: number, item: number, a: number, b: number, oldNo: number, newNo: number, x = 0, n = 0): number {
    if (this.len === this.cap) this.grow();
    const i = this.len++;
    this.kind[i] = kind;
    this.item[i] = item;
    this.a[i] = a;
    this.b[i] = b;
    this.oldNo[i] = oldNo;
    this.newNo[i] = newNo;
    this.x[i] = x;
    this.n[i] = n;
    return i;
  }
}

const shown = (r: Reveal | undefined, n: number) => !!r && (r.full || r.spans.some((s) => s.start <= n && n <= s.end));

/**
 * Unchanged lines between hunks in a diff with whole files: the revealed ones as context rows, the rest as bars.
 * `o` and `nw` are the 0-based indexes of the first line on each side.
 */
function between(out: Builder, item: number, o: number, nw: number, count: number, at: number, reveal: Reveal | undefined, split: boolean): void {
  let i = 0;
  while (i < count) {
    if (shown(reveal, nw + i + 1)) {
      out.push(split ? PAIR : CTX, item, o + i, nw + i, o + i + 1, nw + i + 1, at);
      i++;
      continue;
    }
    let j = i;
    while (j < count && !shown(reveal, nw + j + 1)) j++;
    out.push(GAP, item, o + i, nw + i, o + i + 1, nw + i + 1, at, j - i);
    i = j;
  }
}

function fileRows(out: Builder, item: number, f: FileItem, split: boolean): void {
  const fd = f.fd;
  const whole = !fd.isPartial;
  let oEnd = 0;
  let nEnd = 0;
  fd.hunks.forEach((h, hi) => {
    if (h.collapsedBefore > 0 && !(hi === 0 && f.excerpt && !whole)) {
      if (whole) between(out, item, oEnd, nEnd, h.collapsedBefore, hi, f.reveal, split);
      else out.push(GAP, item, -1, -1, h.deletionStart - h.collapsedBefore, h.additionStart - h.collapsedBefore, hi, h.collapsedBefore);
    }
    const oNo = (i: number) => h.deletionStart + (i - h.deletionLineIndex);
    const nNo = (i: number) => h.additionStart + (i - h.additionLineIndex);
    for (const c of h.hunkContent) {
      if (c.type === "context") {
        for (let i = 0; i < c.lines; i++) {
          const o = c.deletionLineIndex + i;
          const n = c.additionLineIndex + i;
          out.push(split ? PAIR : CTX, item, o, n, oNo(o), nNo(n), hi);
        }
        continue;
      }
      if (split) {
        for (let i = 0; i < Math.max(c.deletions, c.additions); i++) {
          const o = i < c.deletions ? c.deletionLineIndex + i : -1;
          const n = i < c.additions ? c.additionLineIndex + i : -1;
          out.push(PAIR, item, o, n, o >= 0 ? oNo(o) : 0, n >= 0 ? nNo(n) : 0, hi, (o >= 0 ? 1 : 0) + (n >= 0 ? 1 : 0));
        }
      } else {
        for (let i = 0; i < c.deletions; i++) out.push(DEL, item, c.deletionLineIndex + i, -1, oNo(c.deletionLineIndex + i), 0, hi);
        for (let i = 0; i < c.additions; i++) out.push(ADD, item, -1, c.additionLineIndex + i, 0, nNo(c.additionLineIndex + i), hi);
      }
    }
    oEnd = h.deletionLineIndex + h.deletionCount;
    nEnd = h.additionLineIndex + h.additionCount;
  });
  if (whole) {
    const rest = Math.min(fd.deletionLines.length - oEnd, fd.additionLines.length - nEnd);
    if (rest > 0) between(out, item, oEnd, nEnd, rest, fd.hunks.length, f.reveal, split);
  }
}

/** The row a thread's card goes after: the row of its last line on its side, else the bar that folds that line. */
function cardRow(rows: Builder, from: number, to: number, p: Placed): number {
  const del = p.side === "deletions";
  const line = p.range.end;
  let bar = -1;
  let before = -1;
  for (let r = from; r < to; r++) {
    const k = rows.kind[r]!;
    if (k === GAP) {
      const start = del ? rows.oldNo[r]! : rows.newNo[r]!;
      if (line >= start && line < start + rows.n[r]!) bar = r;
      continue;
    }
    if (!isLine(k)) continue;
    const no = del ? (k === ADD ? 0 : rows.oldNo[r]!) : k === DEL ? 0 : rows.newNo[r]!;
    if (no === line) return r;
    if (no && no < line) before = r;
  }
  return bar !== -1 ? bar : before;
}

/** The rows of the items, the files' code in split or unified. */
export function buildRows(items: readonly Item[], split: boolean): Rows {
  let estimate = items.length;
  for (const it of items) if (it.kind === "file" && !it.collapsed) estimate += it.fd.unifiedLineCount + it.fd.hunks.length * 2 + (it.placed?.length ?? 0) + 2;
  const out = new Builder(estimate);
  const first = new Int32Array(items.length);
  items.forEach((it, i) => {
    first[i] = out.len;
    if (it.kind === "group") {
      out.push(GROUP, i, -1, -1, 0, 0);
      return;
    }
    out.push(FILE, i, -1, -1, 0, 0);
    if (it.collapsed) return;
    if (it.note) {
      out.push(NOTE, i, -1, -1, 0, 0);
      return;
    }
    const start = out.len;
    fileRows(out, i, it, split);
    const placed = it.placed ?? [];
    if (!placed.length) return;
    // cards go in after the rows of their lines, so the file's rows are laid out again with them
    const after = placed.map((p) => cardRow(out, start, out.len, p));
    const order = placed.map((_, k) => k).sort((x, y) => after[x]! - after[y]! || placed[x]!.range.start - placed[y]!.range.start || placed[x]!.threadId - placed[y]!.threadId);
    const code = { kind: out.kind.slice(start, out.len), a: out.a.slice(start, out.len), b: out.b.slice(start, out.len), oldNo: out.oldNo.slice(start, out.len), newNo: out.newNo.slice(start, out.len), x: out.x.slice(start, out.len), n: out.n.slice(start, out.len) };
    const count = out.len - start;
    out.len = start;
    let k = 0;
    // a card whose line the diff does not show at all goes before the code
    for (; k < order.length && after[order[k]!]! < start; k++) out.push(CARD, i, -1, -1, 0, 0, order[k]!);
    for (let r = 0; r < count; r++) {
      out.push(code.kind[r]!, i, code.a[r]!, code.b[r]!, code.oldNo[r]!, code.newNo[r]!, code.x[r]!, code.n[r]!);
      for (; k < order.length && after[order[k]!]! === start + r; k++) out.push(CARD, i, -1, -1, 0, 0, order[k]!);
    }
  });
  return { len: out.len, kind: out.kind, item: out.item, a: out.a, b: out.b, oldNo: out.oldNo, newNo: out.newNo, x: out.x, n: out.n, first };
}

/** The last row of item `i`. */
export function lastRow(rows: Rows, i: number): number {
  return (i + 1 < rows.first.length ? rows.first[i + 1]! : rows.len) - 1;
}

/** A line's text without its line break. */
export function lineText(fd: FileDiffMetadata, side: 0 | 1, i: number): string {
  const s = (side === 0 ? fd.deletionLines : fd.additionLines)[i] ?? "";
  return s.endsWith("\n") ? s.slice(0, s.endsWith("\r\n") ? -2 : -1) : s;
}

/** The row that shows a line of a file, or -1. */
export function rowOfLine(rows: Rows, item: number, side: "additions" | "deletions", line: number): number {
  const end = lastRow(rows, item);
  for (let r = rows.first[item]!; r <= end; r++) {
    const k = rows.kind[r]!;
    if (!isLine(k)) continue;
    const no = side === "deletions" ? (k === ADD ? 0 : rows.oldNo[r]!) : k === DEL ? 0 : rows.newNo[r]!;
    if (no === line) return r;
  }
  return -1;
}
