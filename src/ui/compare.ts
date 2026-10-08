import type { FileDiffMetadata } from "@pierre/diffs";
import type { CompareDto, ComparePlacement, GrepResultDto } from "../core/types.ts";
import type { LineRange } from "./cursor.ts";
import { isTestPath, type FoldDecision, type FoldGroup } from "./fold.ts";
import { threadMarks, type LineMark, type Spot } from "./marks.ts";
import { fileComparator, groupTitle, type FileOrder } from "./order.ts";
import { routeHash, type Route } from "./route.ts";
import type { Hit, SearchResult } from "./search.ts";
import { isViewedIn, type ViewedIndex } from "./viewed.ts";

export interface FileRow {
  fd: FileDiffMetadata;
  group: FoldGroup | null;
  keptBecause: string | null;
  hidden: boolean;
  threads: number;
  /** The compare.order group of a file that is not folded. */
  kind: string;
  /** Title of the section this file starts, when the diff has more than one section. */
  section: string | null;
}

export function sectionTitle(r: FileRow): string {
  return r.group === "tests" ? "Tests with only new code" : r.group === "generated" ? "Generated and lock files" : groupTitle(r.kind);
}

export interface FileRowsInput {
  folds: ReadonlyMap<string, FoldDecision>;
  /** The fold groups the reader opened. */
  open: { tests: boolean; generated: boolean };
  /** The threads shown on the diff: a file with one is never folded. */
  placements: readonly ComparePlacement[];
  order: FileOrder;
  tests: string[];
}

/** The files of the diff in the order the Changes page lists them, in sections by compare.order and fold group. */
export function fileRows(files: readonly FileDiffMetadata[], o: FileRowsInput): FileRow[] {
  const count = new Map<string, number>();
  for (const p of o.placements) count.set(p.path, (count.get(p.path) ?? 0) + 1);
  const n = o.order.groups.length;
  const byOrder = fileComparator(o.order, o.tests);
  const rows = files.map((fd) => {
    const d = o.folds.get(fd.name) ?? { group: null, keptBecause: null };
    const threadsHere = count.get(fd.name) ?? 0;
    const group = threadsHere ? null : d.group;
    const kind = o.order.rank(fd.name, isTestPath(fd.name, o.tests, fd.prevName));
    const rank = group === null ? kind : group === "tests" ? n : n + 1;
    const file = { path: fd.name, prevPath: fd.prevName };
    return { row: { fd, group, keptBecause: d.keptBecause, hidden: group !== null && !o.open[group], threads: threadsHere, kind: o.order.name(kind), section: null } as FileRow, rank, file };
  });
  // the folded groups come last, each in the order of the diff
  const foldRank = (r: (typeof rows)[number]) => (r.row.group === null ? 0 : r.rank);
  const sorted = rows
    .map((r, i) => [r, i] as const)
    .sort(([a, i], [b, j]) => foldRank(a) - foldRank(b) || (foldRank(a) ? 0 : byOrder(a.file, b.file)) || i - j)
    .map(([r]) => r);
  const several = sorted.length > 0 && sorted[0]!.rank !== sorted[sorted.length - 1]!.rank;
  return sorted.map(({ row, rank }, i) => (several && (i === 0 || sorted[i - 1]!.rank !== rank) ? { ...row, section: sectionTitle(row) } : row));
}

/** The files the diff shows, and how many of them are viewed; files folded into a hidden group do not count. */
export function viewedCount(rows: readonly FileRow[], viewed: ViewedIndex): { shown: number; seen: number; hidden: number } {
  const shown = rows.filter((r) => !r.hidden).map((r) => r.fd);
  return { shown: shown.length, seen: shown.filter((fd) => isViewedIn(viewed, fd)).length, hidden: rows.length - shown.length };
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
  ranges: [number, number][];
  inDiff: boolean;
}

/** Grep results in the order of the Changes page: code first, docs last. */
export function grepSorted(r: GrepResultDto, order: FileOrder, tests: string[]): GrepResultDto {
  return { ...r, files: [...r.files].sort(fileComparator(order, tests)) };
}

export interface MarkSources {
  /** The lines a link opened. */
  linked: LineRange | null;
  placements: readonly ComparePlacement[];
  /** The thread whose marks are stronger. */
  focus: number | null;
  spot: Spot | null;
  grepHits: readonly GrepHit[];
  grepCurrent: GrepHit | null;
  search: SearchResult;
  current: Hit | null;
}

/** The marks on the lines of each file of the diff: linked lines, threads, and the hits of both searches. */
export function marksByPath(s: MarkSources): Map<string, LineMark[]> {
  const m = new Map<string, LineMark[]>();
  const push = (path: string, mark: LineMark) => {
    const list = m.get(path);
    if (list) list.push(mark);
    else m.set(path, [mark]);
  };
  const linked = s.linked;
  if (linked) push(linked.path, { side: linked.side, start: linked.start, end: linked.end, tag: "linked" });
  const byFile = new Map<string, ComparePlacement[]>();
  for (const p of s.placements) byFile.set(p.path, [...(byFile.get(p.path) ?? []), p]);
  for (const [path, placed] of byFile) for (const mark of threadMarks(placed, s.focus, s.spot)) push(path, mark);
  for (const h of s.grepHits) if (h.inDiff) push(h.path, { side: "additions", start: h.line, end: h.line, tag: "hit", ranges: h.ranges, current: h === s.grepCurrent });
  for (const f of s.search.files) {
    const rows = f.rows;
    for (const h of f.hits) {
      const r = rows[h.row]!;
      const current = h === s.current;
      push(f.path, { side: h.side, start: h.line, end: h.line, tag: "hit", ranges: h.ranges, current });
      if (r.kind === "context") push(f.path, { side: "deletions", start: r.old!, end: r.old!, tag: "hit", ranges: h.ranges, current });
    }
  }
  return m;
}

/** Where lines are shown: the route, the compare it shows, and a thread's code with the refs of its two sides. */
export interface LinesAt {
  route: Route;
  compare: Pick<CompareDto, "from" | "to"> | null;
  thread: { old: { ref: string }; now: { ref: string } } | null;
}

/** The address of lines on the Changes page, on the page at `page` (its URL without the hash). */
export function linesUrl(page: string, lines: LineRange, at: LinesAt, review: number | null): string | null {
  const r = at.route;
  const d = at.compare;
  const t = r.name === "thread" ? at.thread : null;
  const ends = t ? { from: t.old.ref, to: t.now.ref } : r.name === "compare" ? { from: d?.from.ref ?? r.from, to: d?.to.ref ?? r.to } : null;
  if (!ends) return null;
  const hash = routeHash(
    { name: "compare", ...ends, file: lines.path, line: lines.start, end: lines.end, ...(lines.side === "deletions" ? { side: "old" as const } : {}) },
    review,
  );
  return `${page}${hash}`;
}
