import type { FileDiffMetadata } from "@pierre/diffs";
import { computed, effect, signal } from "@preact/signals";
import type { CompareDto, GrepResultDto, Region } from "../src/core/types.ts";
import { DEFAULT_COLLAPSE_GLOBS, DEFAULT_SKIP_MARKERS, foldOf, isTestPath, parseList, viewedKey, type FoldDecision, type FoldGroup } from "./lib/fold.ts";
import { groupTitle } from "./lib/order.ts";
import type { LineMark } from "./lib/marks.ts";
import { CursorSpace, type Cursor, type LineRange } from "./lib/cursor.ts";
import { api } from "./api.ts";
import { compileQuery, diffRows, flatHits, matchRanges, searchDiff, type Hit, type Side } from "./lib/search.ts";
import { clampStep } from "./lib/timeline.ts";
import { compareFocus, detail, fileOrder, guard, loading, markReviewed, noteJump, reviewedCursor, reviewId, route, selectedStep, showResolved, status, testGlobs, threads, viewedKeys } from "./state.ts";

export type SideTab = "threads" | "files" | "search";

function load(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`stet.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(`stet.${key}`, value);
  } catch {
    return;
  }
}

export const compareData = signal<CompareDto | null>(null);
export const compareFiles = signal<FileDiffMetadata[] | null>(null);
export const activeFile = signal<string | null>(null);
const sideTabs = signal<{ compare: SideTab; thread: SideTab }>({ compare: load("sideTab", "threads") as SideTab, thread: "threads" });
const tabPage = () => (route.value.name === "thread" ? "thread" : "compare");
export const sideTab = {
  get value(): SideTab {
    return sideTabs.value[tabPage()];
  },
  set value(t: SideTab) {
    autoTab = false;
    sideTabs.value = { ...sideTabs.value, [tabPage()]: t };
  },
};

let autoTab = false;

/**
 * A review with no threads (no drafts either) would open on an empty Threads tab: show its files instead.
 * Not remembered, so a review with threads opens on the reader's tab again.
 */
export function landTab(): void {
  if (threads.peek().length > 0 || sideTabs.peek().compare !== "threads") return;
  autoTab = true;
  sideTabs.value = { ...sideTabs.peek(), compare: "files" };
}

let landed = false;
effect(() => {
  if (loading.value || landed) return;
  landed = true;
  landTab();
});
export const hoverThread = signal<number | null>(null);
export const groupsOpen = signal<{ tests: boolean; generated: boolean }>({ tests: false, generated: false });
export const fileOpen = signal<Map<string, boolean>>(new Map());

export type ImageMode = "2-up" | "swipe" | "onion" | "diff";
export const imageMode = signal<ImageMode>(load("imageMode", "2-up") as ImageMode);
effect(() => save("imageMode", imageMode.value));

/** An area drawn on an image of the diff, waiting for its first message. `file` is the diff item it was drawn in. */
export interface ImagePending {
  file: string;
  path: string;
  side: "new" | "old";
  sha: string;
  label: string;
  region: Region;
}
export const imagePending = signal<ImagePending | null>(null);

export type FileView = "picture" | "rendered" | "code";

/**
 * Files the reader switched between their code and a picture (SVG) or the rendered text (Markdown). Without an entry
 * an SVG is a picture unless lines of it have threads, and Markdown is code.
 */
export const fileView = signal<Map<string, FileView>>(new Map());

export function setFileView(path: string, view: FileView): void {
  fileView.value = new Map(fileView.value).set(path, view);
}

export const searchInput = signal("");
export const searchQuery = signal("");
export const searchRegex = signal(false);
export const searchIndex = signal(-1);
export const searchFocus = signal(0);

export type SearchScope = "diff" | "files";
export const searchScope = signal<SearchScope>(load("searchScope", "diff") as SearchScope);
effect(() => save("searchScope", searchScope.value));
export const onThreadPage = computed(() => route.value.name === "thread");
export const scope = computed<SearchScope>(() => (onThreadPage.value ? "files" : searchScope.value));

export const searchAt = computed<{ sha: string; label: string } | null>(() => {
  if (onThreadPage.value) {
    const d = detail.value;
    const step = d ? d.timeline[clampStep(d, selectedStep.value)] : null;
    return step ? { sha: step.sha, label: step.label } : null;
  }
  const to = compareData.value?.to;
  return to ? { sha: to.sha, label: to.label } : null;
});

let debounce: ReturnType<typeof setTimeout> | undefined;
effect(() => {
  const q = searchInput.value;
  clearTimeout(debounce);
  debounce = setTimeout(() => (searchQuery.value = q), q.length > 2 ? 120 : 250);
});
effect(() => {
  const t = sideTabs.value.compare;
  if (!autoTab) save("sideTab", t);
});

export const foldConfig = computed(() => {
  const ui = status.value?.ui;
  return {
    tests: testGlobs.value,
    skipMarkers: parseList(ui?.skipMarkers, DEFAULT_SKIP_MARKERS),
    collapse: parseList(ui?.collapse, DEFAULT_COLLAPSE_GLOBS),
  };
});

export const folds = computed(() => {
  const cfg = foldConfig.value;
  const m = new Map<string, FoldDecision>();
  for (const fd of compareFiles.value ?? []) m.set(fd.name, foldOf(fd, cfg));
  return m;
});

export const viewed = viewedKeys;

export function isViewed(fd: FileDiffMetadata): boolean {
  return viewed.value.has(viewedKey(fd));
}

export function setViewed(fd: FileDiffMetadata, on: boolean): void {
  const next = new Set(viewed.value);
  if (on) next.add(viewedKey(fd));
  else next.delete(viewedKey(fd));
  viewed.value = next;
  const rid = reviewId.peek();
  if (rid !== null) void guard(api.setViewed(rid, [viewedKey(fd)], on));
  if (on) rememberIfAllViewed();
  const open = new Map(fileOpen.value);
  open.delete(fd.name);
  fileOpen.value = open;
}

function rememberIfAllViewed(): void {
  const rows = fileRows.peek();
  const r = route.peek();
  if (r.name !== "compare" || rows.length === 0 || !rows.every((x) => isViewed(x.fd))) return;
  const rv = reviewedCursor.peek();
  if (!rv || r.to === "now" || (/^\d+$/.test(r.to) && (rv.version === null || Number(r.to) > rv.version))) void markReviewed(r.to);
}

export function isCollapsed(fd: FileDiffMetadata): boolean {
  return !(fileOpen.value.get(fd.name) ?? !isViewed(fd));
}

export function toggleFile(fd: FileDiffMetadata): void {
  const open = new Map(fileOpen.value);
  open.set(fd.name, isCollapsed(fd));
  fileOpen.value = open;
}

export interface CompareHandle {
  scrollToFile(path: string): void;
  scrollToLine(path: string, side: Side, line: number): void;
  /** The line in the diff with the cursor on it, or the file's preview at that line when the diff does not show it. */
  openLine(path: string, side: Side, line: number): void;
  revealCursor(c: Cursor, align?: "nearest" | "center"): void;
  startComment(range: LineRange): void;
  pageRows(): number;
  getScrollTop(): number;
  setScrollTop(top: number): void;
}

export const compareNav: { current: CompareHandle | null } = { current: null };

export function stepHit(dir: 1 | -1): boolean {
  if (scope.value === "files") {
    const n = grepHits.value.length;
    if (n === 0) return false;
    const i = grepIndex.value;
    goToGrepHit(i === -1 ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n);
    return true;
  }
  const hits = searchHits.value;
  if (hits.length === 0) return false;
  const i = searchIndex.value;
  const next = i === -1 ? (dir === 1 ? 0 : hits.length - 1) : (i + dir + hits.length) % hits.length;
  goToHit(next);
  return true;
}

export function goToHit(i: number): void {
  const h = searchHits.value[i];
  if (!h) return;
  noteJump();
  searchIndex.value = i;
  compareNav.current?.scrollToLine(h.path, h.side, h.line);
}

export function openSearch(): void {
  sideTab.value = "search";
  searchFocus.value++;
}

export const resolvedIds = computed(() => new Set(threads.value.filter((t) => t.status === "resolved").map((t) => t.id)));
export const shownPlacements = computed(() => (compareData.value?.placements ?? []).filter((p) => showResolved.value || !resolvedIds.value.has(p.threadId)));

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

export const fileRows = computed<FileRow[]>(() => {
  const files = compareFiles.value ?? [];
  const f = folds.value;
  const open = groupsOpen.value;
  const count = new Map<string, number>();
  for (const p of shownPlacements.value) count.set(p.path, (count.get(p.path) ?? 0) + 1);
  const order = fileOrder.value;
  const tests = foldConfig.value.tests;
  const n = order.groups.length;
  const rows = files.map((fd) => {
    const d = f.get(fd.name) ?? { group: null, keptBecause: null };
    const threadsHere = count.get(fd.name) ?? 0;
    const group = threadsHere ? null : d.group;
    const kind = order.rank(fd.name, isTestPath(fd.name, tests, fd.prevName));
    const rank = group === null ? kind : group === "tests" ? n : n + 1;
    return { row: { fd, group, keptBecause: d.keptBecause, hidden: group !== null && !open[group], threads: threadsHere, kind: order.name(kind), section: null } as FileRow, rank };
  });
  const sorted = rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => a.rank - b.rank || i - j).map(([r]) => r);
  const several = sorted.length > 0 && sorted[0]!.rank !== sorted[sorted.length - 1]!.rank;
  return sorted.map(({ row, rank }, i) => (several && (i === 0 || sorted[i - 1]!.rank !== rank) ? { ...row, section: sectionTitle(row) } : row));
});

export const visibleFiles = computed(() => fileRows.value.filter((r) => !r.hidden).map((r) => r.fd));

export const marksByPath = computed(() => {
  const m = new Map<string, LineMark[]>();
  const push = (path: string, mark: LineMark) => {
    const list = m.get(path);
    if (list) list.push(mark);
    else m.set(path, [mark]);
  };
  const focus = hoverThread.value ?? compareFocus.value;
  for (const p of shownPlacements.value) push(p.path, { side: p.side, start: p.range.start, end: p.range.end, tag: p.threadId === focus ? "focus" : "thread" });
  const grepCur = currentGrepHit.value;
  for (const h of grepHits.value) if (h.inDiff) push(h.path, { side: "additions", start: h.line, end: h.line, tag: "hit", ranges: h.ranges, current: h === grepCur });
  const cur = currentHit.value;
  for (const f of searchResult.value.files) {
    const rows = f.rows;
    for (const h of f.hits) {
      const r = rows[h.row]!;
      const current = h === cur;
      push(f.path, { side: h.side, start: h.line, end: h.line, tag: "hit", ranges: h.ranges, current });
      if (r.kind === "context") push(f.path, { side: "deletions", start: r.old!, end: r.old!, tag: "hit", ranges: h.ranges, current });
    }
  }
  return m;
});

export const searchResult = computed(() =>
  scope.value === "files" ? searchDiff([], "") : searchDiff(fileRows.value.map((r) => r.fd), searchQuery.value, { regex: searchRegex.value }),
);
export const searchHits = computed(() => flatHits(searchResult.value));
export const currentHit = computed<Hit | null>(() => searchHits.value[searchIndex.value] ?? null);
effect(() => {
  searchQuery.value;
  searchRegex.value;
  compareFiles.value;
  searchIndex.value = -1;
});

export interface Peek {
  path: string;
  sha: string;
  label: string;
  line: number;
}
export const peek = signal<Peek | null>(null);

export const grepResult = signal<GrepResultDto | null>(null);
/** Grep results in the order of the Changes page: code first, docs last. */
export const grepSorted = computed<GrepResultDto | null>(() => {
  const r = grepResult.value;
  if (!r) return null;
  const order = fileOrder.value;
  const tests = testGlobs.value;
  const rank = new Map(r.files.map((f) => [f.path, order.rank(f.path, isTestPath(f.path, tests))]));
  return { ...r, files: [...r.files].sort((a, b) => rank.get(a.path)! - rank.get(b.path)!) };
});
export const grepLoading = signal(false);
export const grepIndex = signal(-1);

let grepSeq = 0;
effect(() => {
  const where = scope.value;
  const q = searchQuery.value;
  const regex = searchRegex.value;
  const sha = searchAt.value?.sha;
  grepIndex.value = -1;
  if (where !== "files" || !sha || q.length < 2) {
    grepResult.value = null;
    grepLoading.value = false;
    return;
  }
  const seq = ++grepSeq;
  grepLoading.value = true;
  api.grep(sha, q, regex).then(
    (r) => {
      if (seq !== grepSeq) return;
      grepResult.value = r;
      grepLoading.value = false;
    },
    (e) => {
      if (seq !== grepSeq) return;
      grepResult.value = { files: [], total: 0, truncated: false, error: (e as Error).message };
      grepLoading.value = false;
    },
  );
});

export interface GrepHit {
  path: string;
  line: number;
  text: string;
  ranges: [number, number][];
  inDiff: boolean;
}

export const grepHits = computed<GrepHit[]>(() => {
  const r = grepSorted.value;
  if (!r) return [];
  const re = compileQuery(searchQuery.value, searchRegex.value);
  const byName = new Map((onThreadPage.value ? [] : (compareFiles.value ?? [])).map((fd) => [fd.name, fd]));
  const out: GrepHit[] = [];
  for (const f of r.files) {
    const fd = byName.get(f.path);
    const lines = fd ? new Set(diffRows(fd).map((row) => row.new).filter((n): n is number => n !== null)) : null;
    for (const g of f.groups)
      for (const l of g)
        if (l.match) out.push({ path: f.path, line: l.line, text: l.text, ranges: re instanceof RegExp ? matchRanges(re, l.text) : [], inDiff: !!lines?.has(l.line) });
  }
  return out;
});

export const currentGrepHit = computed<GrepHit | null>(() => grepHits.value[grepIndex.value] ?? null);

export function goToGrepHit(i: number): void {
  const h = grepHits.value[i];
  const at = searchAt.value;
  if (!h || !at) return;
  noteJump();
  grepIndex.value = i;
  if (h.inDiff) {
    peek.value = null;
    compareNav.current?.scrollToLine(h.path, "additions", h.line);
  } else peek.value = { path: h.path, sha: at.sha, label: at.label, line: h.line };
}
effect(() => {
  compareData.value?.to.sha;
  route.value.name === "thread" ? route.value.id : null;
  peek.value = null;
});

export const cursor = signal<Cursor | null>(null);
export const visualAnchor = signal<Cursor | null>(null);
export const cursorSpace = computed(() => new CursorSpace(visibleFiles.value.map((fd) => ({ fd, collapsed: isCollapsed(fd) }))));
effect(() => {
  const c = cursor.value;
  if (c && c.path !== activeFile.peek()) activeFile.value = c.path;
});

export function cursorMarks(space: CursorSpace, c: Cursor | null, anchor: Cursor | null): Map<string, LineMark[]> {
  const out = new Map<string, LineMark[]>();
  const add = (path: string, m: LineMark) => out.set(path, [...(out.get(path) ?? []), m]);
  const mark = (at: Cursor, tag: string) => {
    const r = space.row(at);
    if (!r) return;
    if (r.new !== null) add(at.path, { side: "additions", start: r.new, end: r.new, tag });
    if (r.old !== null) add(at.path, { side: "deletions", start: r.old, end: r.old, tag });
  };
  if (anchor && c && anchor.path === c.path) {
    for (let r = Math.min(anchor.row, c.row); r <= Math.max(anchor.row, c.row); r++) mark({ path: c.path, row: r }, "visual");
  }
  if (c) mark(c, "cursor");
  return out;
}

export function setCursor(c: Cursor | null, reveal = true): void {
  cursor.value = c;
  if (c && reveal) compareNav.current?.revealCursor(c);
}

export const cursorLayer = computed(() => cursorMarks(cursorSpace.value, cursor.value, visualAnchor.value));

export function marksFor(path: string): LineMark[] {
  const a = marksByPath.peek().get(path);
  const b = cursorLayer.peek().get(path);
  return a && b ? [...a, ...b] : (a ?? b ?? []);
}
