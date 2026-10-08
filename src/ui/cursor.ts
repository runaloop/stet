import type { FileDiffMetadata } from "@pierre/diffs";
import { diffRows, type DiffRow, type Side } from "./search.ts";

export interface Cursor {
  path: string;
  row: number;
}

export interface Span {
  start: number;
  end: number;
}

/** A block of a file drawn as rendered Markdown: its lines on the old side, the new side, or both when it did not change. */
export interface NavBlock {
  old: Span | null;
  new: Span | null;
  changed: boolean;
  /** Blocks of one group face each other; `]c` stops once per group. */
  group: number;
}

export interface CursorFile {
  fd: FileDiffMetadata;
  collapsed: boolean;
  /** A file drawn instead of its lines: the cursor stops at these blocks (none for a picture) rather than at the lines. */
  blocks?: readonly NavBlock[];
  /** What the cursor calls the file when it is not its path: lines of one file drawn in several places (a guide's steps). */
  id?: string;
}

const idOf = (f: CursorFile) => f.id ?? f.fd.name;

export interface LineRange {
  path: string;
  side: Side;
  start: number;
  end: number;
}

export function rowPosition(r: DiffRow): { side: Side; line: number } {
  return r.kind === "del" ? { side: "deletions", line: r.old! } : { side: "additions", line: r.new! };
}

export class CursorSpace {
  private readonly starts: number[] = [];
  private readonly byPath = new Map<string, number>();
  readonly total: number;

  constructor(readonly files: CursorFile[]) {
    let n = 0;
    files.forEach((f, i) => {
      this.byPath.set(idOf(f), i);
      this.starts.push(n);
      n += this.stops(i);
    });
    this.total = n;
  }

  rows(i: number): DiffRow[] {
    const f = this.files[i]!;
    if (f.collapsed) return [];
    return f.blocks ? blockRows(f.blocks) : diffRows(f.fd);
  }

  /** The rendered block under the cursor, in a file drawn as blocks. */
  block(c: Cursor): NavBlock | null {
    const i = this.fileIndex(c.path);
    const f = this.files[i];
    return f && !f.collapsed && f.blocks ? (f.blocks[c.row] ?? null) : null;
  }

  private stops(i: number): number {
    return Math.max(1, this.rows(i).length);
  }

  fileIndex(path: string): number {
    return this.byPath.get(path) ?? -1;
  }

  flat(c: Cursor): number {
    const i = this.fileIndex(c.path);
    if (i === -1) return -1;
    return this.starts[i]! + Math.max(0, Math.min(c.row, this.stops(i) - 1));
  }

  at(flat: number): Cursor | null {
    if (this.total === 0) return null;
    const n = Math.max(0, Math.min(flat, this.total - 1));
    let lo = 0;
    let hi = this.files.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= n) lo = mid;
      else hi = mid - 1;
    }
    const rows = this.rows(lo).length;
    return { path: idOf(this.files[lo]!), row: rows ? n - this.starts[lo]! : -1 };
  }

  normalize(c: Cursor | null): Cursor | null {
    if (!c) return this.at(0);
    const f = this.flat(c);
    return f === -1 ? this.at(0) : this.at(f);
  }

  move(c: Cursor | null, delta: number): Cursor | null {
    const f = c ? this.flat(c) : -1;
    return this.at(f === -1 ? 0 : f + delta);
  }

  row(c: Cursor): DiffRow | null {
    const i = this.fileIndex(c.path);
    if (i === -1 || c.row < 0) return null;
    return this.rows(i)[c.row] ?? null;
  }

  fileStart(i: number): Cursor | null {
    if (i < 0 || i >= this.files.length) return null;
    return { path: idOf(this.files[i]!), row: this.rows(i).length ? 0 : -1 };
  }

  nextFile(c: Cursor | null, dir: 1 | -1): Cursor | null {
    const i = c ? this.fileIndex(c.path) : -1;
    return this.fileStart(i === -1 ? 0 : i + dir);
  }

  private find(c: Cursor | null, dir: 1 | -1, test: (rows: DiffRow[], r: number) => boolean): Cursor | null {
    let f = c ? this.flat(c) : -1;
    for (let k = 0; k < this.total; k++) {
      f += dir;
      if (f < 0 || f >= this.total) return null;
      const at = this.at(f)!;
      if (at.row < 0) continue;
      const rows = this.rows(this.fileIndex(at.path));
      if (test(rows, at.row)) return at;
    }
    return null;
  }

  nextChange(c: Cursor | null, dir: 1 | -1): Cursor | null {
    const changed = (rows: DiffRow[], r: number) => rows[r]!.kind !== "context";
    return this.find(c, dir, (rows, r) => changed(rows, r) && (r === 0 || !changed(rows, r - 1) || rows[r - 1]!.hunk !== rows[r]!.hunk));
  }

  nextHunk(c: Cursor | null, dir: 1 | -1): Cursor | null {
    return this.find(c, dir, (rows, r) => r === 0 || rows[r - 1]!.hunk !== rows[r]!.hunk);
  }

  locate(path: string, side: Side, line: number): Cursor | null {
    const i = this.fileIndex(path);
    if (i === -1) return null;
    const blocks = this.files[i]!.collapsed ? null : this.files[i]!.blocks;
    if (blocks) {
      const on = (b: NavBlock) => (side === "deletions" ? b.old : b.new);
      // the innermost block that holds the line, else the last one before it
      let best = -1;
      for (const [k, b] of blocks.entries()) {
        const r = on(b);
        if (!r || r.start > line) continue;
        const was = best === -1 ? null : on(blocks[best]!)!;
        if (!was || (r.end >= line ? was.end < line || r.start >= was.start : was.end < line && r.start >= was.start)) best = k;
      }
      return best === -1 ? null : { path, row: best };
    }
    const rows = this.rows(i);
    const r = rows.findIndex((x) => (side === "deletions" ? x.kind !== "add" && x.old === line : x.kind !== "del" && x.new === line));
    return r === -1 ? null : { path, row: r };
  }

  /** The line under the cursor, or the first line of its rendered block (its new side when it has one). */
  position(c: Cursor): { side: Side; line: number } | null {
    const block = this.block(c);
    if (block) return block.new ? { side: "additions", line: block.new.start } : block.old ? { side: "deletions", line: block.old.start } : null;
    const r = this.row(c);
    return r ? rowPosition(r) : null;
  }

  /** Whether the cursor is on one of `lines`: a line of the range, or a rendered block with lines in it. */
  holds(c: Cursor, lines: LineRange): boolean {
    if (c.path !== lines.path) return false;
    const block = this.block(c);
    if (block) {
      const span = lines.side === "deletions" ? block.old : block.new;
      return !!span && span.start <= lines.end && lines.start <= span.end;
    }
    const r = this.row(c);
    const n = !r ? null : lines.side === "deletions" ? (r.kind !== "add" ? r.old : null) : r.kind !== "del" ? r.new : null;
    return n !== null && n >= lines.start && n <= lines.end;
  }

  range(anchor: Cursor, head: Cursor): LineRange | null {
    const i = this.fileIndex(anchor.path);
    const a = this.row(anchor);
    if (i === -1 || !a) return null;
    const blocks = this.files[i]!.blocks;
    if (blocks) {
      const first = blocks[anchor.row]!;
      const side: Side = first.new ? "additions" : "deletions";
      const end = head.path === anchor.path && head.row >= 0 ? head.row : anchor.row;
      const spans = blocks.slice(Math.min(anchor.row, end), Math.max(anchor.row, end) + 1).flatMap((b) => {
        const r = side === "additions" ? b.new : b.old;
        return r ? [r] : [];
      });
      return { path: anchor.path, side, start: Math.min(...spans.map((r) => r.start)), end: Math.max(...spans.map((r) => r.end)) };
    }
    const rows = this.rows(i);
    const end = head.path === anchor.path && head.row >= 0 ? head.row : anchor.row;
    const side: Side = a.kind === "del" ? "deletions" : "additions";
    const lines: number[] = [];
    for (let r = Math.min(anchor.row, end); r <= Math.max(anchor.row, end); r++) {
      const x = rows[r]!;
      const n = side === "deletions" ? (x.kind !== "add" ? x.old : null) : x.kind !== "del" ? x.new : null;
      if (n !== null) lines.push(n);
    }
    if (lines.length === 0) return null;
    return { path: anchor.path, side, start: Math.min(...lines), end: Math.max(...lines) };
  }
}

/**
 * Where a place of the cursor goes when its file is drawn anew (other lines, rendered or as code), now as `path`: to
 * the same rendered block, else to the block or line that holds its line; where it was when neither is drawn.
 */
export function carry(c: Cursor, was: CursorSpace, now: CursorSpace, path = c.path): Cursor {
  const block = was.block(c);
  const blocks = now.files[now.fileIndex(path)]?.blocks;
  const same = block && blocks ? blocks.findIndex((b) => JSON.stringify([b.old, b.new]) === JSON.stringify([block.old, block.new])) : -1;
  if (same !== -1) return { path, row: same };
  const at = was.position(c);
  return (at && now.locate(path, at.side, at.line)) ?? c;
}

/** A place of the cursor drawn on screen, and how much of it shows: 0 to 1 of it, or of the view when it is taller. */
export interface Seen {
  at: Cursor;
  share: number;
}

/**
 * Where a move starts after the reader scrolled with the mouse: at the cursor while some of it is on screen; else, as
 * Vim drags the cursor along when it scrolls, at the first place at least half on screen going down (`dir` 1), the
 * last going up.
 */
export function moveStart(space: CursorSpace, c: Cursor, seen: readonly Seen[], dir: 1 | -1): Cursor {
  if (seen.some((s) => s.share > 0 && s.at.path === c.path && s.at.row === c.row)) return c;
  const flat = seen.filter((s) => s.share >= 0.5).map((s) => space.flat(s.at)).filter((f) => f !== -1);
  if (flat.length === 0) return c;
  return space.at(dir === 1 ? Math.min(...flat) : Math.max(...flat)) ?? c;
}

/** The lines a piece of the page has on each side: a line of code, a rendered block. */
export type SideLines = Partial<Record<Side, Span>>;

/**
 * The lines a text selection takes, from the pieces it takes some text of: on the new side when each of them has lines
 * there, else on the old side when each has; "both" when it takes removed lines and added ones. Null for no pieces.
 */
export function selectionLines(pieces: readonly SideLines[]): { side: Side; start: number; end: number } | "both" | null {
  if (pieces.length === 0) return null;
  const side = (["additions", "deletions"] as const).find((s) => pieces.every((p) => p[s]));
  if (!side) return "both";
  const spans = pieces.map((p) => p[side]!);
  return { side, start: Math.min(...spans.map((s) => s.start)), end: Math.max(...spans.map((s) => s.end)) };
}

const blockRowCache = new WeakMap<readonly NavBlock[], DiffRow[]>();

/** Rendered blocks as rows of the diff: a changed block is an added or removed row, so `]c` finds it. */
function blockRows(blocks: readonly NavBlock[]): DiffRow[] {
  let rows = blockRowCache.get(blocks);
  if (!rows) {
    rows = blocks.map((b) => ({ kind: !b.changed ? "context" : b.new ? "add" : "del", old: b.old?.start ?? null, new: b.new?.start ?? null, text: "", hunk: b.group }));
    blockRowCache.set(blocks, rows);
  }
  return rows;
}
