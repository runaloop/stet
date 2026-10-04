import type { FileDiffMetadata } from "@pierre/diffs";
import { diffRows, type DiffRow, type Side } from "./search.ts";

export interface Cursor {
  path: string;
  row: number;
}

export interface CursorFile {
  fd: FileDiffMetadata;
  collapsed: boolean;
}

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
      this.byPath.set(f.fd.name, i);
      this.starts.push(n);
      n += this.stops(i);
    });
    this.total = n;
  }

  rows(i: number): DiffRow[] {
    const f = this.files[i]!;
    return f.collapsed ? [] : diffRows(f.fd);
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
    return { path: this.files[lo]!.fd.name, row: rows ? n - this.starts[lo]! : -1 };
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
    return { path: this.files[i]!.fd.name, row: this.rows(i).length ? 0 : -1 };
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
    const rows = this.rows(i);
    const r = rows.findIndex((x) => (side === "deletions" ? x.kind !== "add" && x.old === line : x.kind !== "del" && x.new === line));
    return r === -1 ? null : { path, row: r };
  }

  range(anchor: Cursor, head: Cursor): LineRange | null {
    const i = this.fileIndex(anchor.path);
    const a = this.row(anchor);
    if (i === -1 || !a) return null;
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
