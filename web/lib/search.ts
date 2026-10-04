import type { FileDiffMetadata } from "@pierre/diffs";

export type RowKind = "context" | "add" | "del";
export type Side = "additions" | "deletions";

export interface DiffRow {
  kind: RowKind;
  old: number | null;
  new: number | null;
  text: string;
  hunk: number;
}

export interface Hit {
  path: string;
  row: number;
  side: Side;
  line: number;
  ranges: [number, number][];
}

export interface FileHits {
  path: string;
  rows: DiffRow[];
  hits: Hit[];
}

export interface SearchResult {
  files: FileHits[];
  total: number;
  truncated: boolean;
  error: string | null;
}

const strip = (s: string | undefined) => (s ?? "").replace(/\r?\n$/, "");

const rowCache = new WeakMap<FileDiffMetadata, { partial: boolean; rows: DiffRow[] }>();

export function diffRows(fd: FileDiffMetadata): DiffRow[] {
  const hit = rowCache.get(fd);
  if (hit && hit.partial === fd.isPartial) return hit.rows;
  const rows: DiffRow[] = [];
  fd.hunks.forEach((h, hunk) => {
    let o = h.deletionStart;
    let n = h.additionStart;
    for (const g of h.hunkContent) {
      if (g.type === "context") {
        for (let i = 0; i < g.lines; i++) rows.push({ kind: "context", old: o + i, new: n + i, text: strip(fd.additionLines[g.additionLineIndex + i]), hunk });
        o += g.lines;
        n += g.lines;
      } else {
        for (let i = 0; i < g.deletions; i++) rows.push({ kind: "del", old: o + i, new: null, text: strip(fd.deletionLines[g.deletionLineIndex + i]), hunk });
        for (let i = 0; i < g.additions; i++) rows.push({ kind: "add", old: null, new: n + i, text: strip(fd.additionLines[g.additionLineIndex + i]), hunk });
        o += g.deletions;
        n += g.additions;
      }
    }
  });
  rowCache.set(fd, { partial: fd.isPartial, rows });
  return rows;
}

export function compileQuery(query: string, regex: boolean): RegExp | string | null {
  if (!query) return null;
  const flags = /[A-Z]/.test(query) ? "g" : "gi";
  try {
    return new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch (e) {
    return (e as Error).message;
  }
}

export function matchRanges(re: RegExp, text: string): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

export function searchDiff(files: FileDiffMetadata[], query: string, opts: { regex?: boolean; limit?: number } = {}): SearchResult {
  const re = compileQuery(query, opts.regex ?? false);
  if (re === null) return { files: [], total: 0, truncated: false, error: null };
  if (typeof re === "string") return { files: [], total: 0, truncated: false, error: re };
  const limit = opts.limit ?? 5000;
  const out: FileHits[] = [];
  let total = 0;
  for (const fd of files) {
    const rows = diffRows(fd);
    const hits: Hit[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const ranges = matchRanges(re, r.text);
      if (ranges.length === 0) continue;
      const side: Side = r.kind === "del" ? "deletions" : "additions";
      hits.push({ path: fd.name, row: i, side, line: (side === "deletions" ? r.old : r.new)!, ranges });
      if (++total >= limit) break;
    }
    if (hits.length) out.push({ path: fd.name, rows, hits });
    if (total >= limit) return { files: out, total, truncated: true, error: null };
  }
  return { files: out, total, truncated: false, error: null };
}

export function snippet(rows: DiffRow[], row: number, radius = 1): { row: DiffRow; index: number }[] {
  const hunk = rows[row]!.hunk;
  const out: { row: DiffRow; index: number }[] = [];
  for (let i = Math.max(0, row - radius); i <= Math.min(rows.length - 1, row + radius); i++) if (rows[i]!.hunk === hunk) out.push({ row: rows[i]!, index: i });
  return out;
}

export function flatHits(r: SearchResult): Hit[] {
  return r.files.flatMap((f) => f.hits);
}

export interface HitGroup {
  from: number;
  to: number;
  hits: { hit: Hit; index: number }[];
}

export function groupHits(rows: DiffRow[], hits: Hit[], firstIndex = 0, radius = 1): HitGroup[] {
  const groups: HitGroup[] = [];
  hits.forEach((hit, i) => {
    const around = snippet(rows, hit.row, radius);
    const from = around[0]!.index;
    const to = around[around.length - 1]!.index;
    const last = groups[groups.length - 1];
    if (last && rows[last.to]!.hunk === rows[hit.row]!.hunk && from <= last.to + 1) {
      last.to = Math.max(last.to, to);
      last.hits.push({ hit, index: firstIndex + i });
    } else groups.push({ from, to, hits: [{ hit, index: firstIndex + i }] });
  });
  return groups;
}
