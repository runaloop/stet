import { hydratePartialDiff, parsePatchFiles, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs";
import { computed, effect, signal } from "@preact/signals";
import type { CompareDto, GrepResultDto, Region } from "../src/core/types.ts";
import { DEFAULT_COLLAPSE_GLOBS, DEFAULT_SKIP_MARKERS, foldOf, isTestPath, parseList, viewedKey, type FoldDecision, type FoldGroup } from "./lib/fold.ts";
import { groupTitle } from "./lib/order.ts";
import type { LineMark } from "./lib/marks.ts";
import { CursorSpace, rowPosition, type Cursor, type LineRange, type NavBlock } from "./lib/cursor.ts";
import { isMarkdown } from "./lib/markdown.ts";
import { NOTHING, revealedPatch, type Reveal } from "./lib/reveal.ts";
import { api } from "./api.ts";
import { compileQuery, diffRows, flatHits, matchRanges, searchDiff, type Hit, type Side } from "./lib/search.ts";
import { clampStep } from "./lib/timeline.ts";
import { routeHash } from "./lib/route.ts";
import { compareFocus, detail, fileOrder, guard, loading, markReviewed, noteJump, notify, reviewedCursor, reviewId, route, selectedStep, showResolved, status, testGlobs, threads, viewedKeys } from "./state.ts";

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
/** The files of the diff as the server sent them. */
export const baseFiles = signal<FileDiffMetadata[] | null>(null);

/**
 * Lines of Markdown files shown beyond their hunks, in the code and rendered alike: what the reader opened, and the
 * files shown whole. Opened lines last for the range shown; a file shown whole stays so while the page is open.
 */
export const reveals = signal<ReadonlyMap<string, Reveal>>(new Map());

const derived = new WeakMap<FileDiffMetadata, { reveal: Reveal; fd: FileDiffMetadata }>();

/** The diff of a file with its revealed lines as context; the file itself while its texts are not loaded. */
function withRevealed(fd: FileDiffMetadata, reveal: Reveal, d: CompareDto): FileDiffMetadata {
  const hit = derived.get(fd);
  if (hit?.reveal === reveal) return hit.fd;
  const oldPath = fd.prevName ?? fd.name;
  const oldText = fd.type === "new" ? "" : api.loadedBlob(d.from.sha, oldPath)?.contents;
  const newText = fd.type === "deleted" ? "" : api.loadedBlob(d.to.sha, fd.name)?.contents;
  if (typeof oldText !== "string" || typeof newText !== "string") return fd;
  const patch = revealedPatch({ path: oldPath, text: oldText }, { path: fd.name, text: newText }, fd.hunks, reveal);
  const parsed = patch ? parsePatchFiles(patch, `${fd.cacheKey ?? fd.name}:${reveal.full ? "whole" : JSON.stringify(reveal.spans)}`)[0]?.files[0] : null;
  let out = fd;
  if (parsed) {
    try {
      out = hydratePartialDiff("clone", parsed, { oldFile: { name: oldPath, contents: oldText }, newFile: { name: fd.name, contents: newText } } as never);
    } catch {
      out = parsed;
    }
    Object.assign(out, { name: fd.name, prevName: fd.prevName, type: fd.type, newObjectId: fd.newObjectId, prevObjectId: fd.prevObjectId, mode: fd.mode, prevMode: fd.prevMode });
  }
  derived.set(fd, { reveal, fd: out });
  return out;
}

/** The files of the diff as the page shows them: a Markdown file with lines the reader opened has them as context. */
export const compareFiles = computed<FileDiffMetadata[] | null>(() => {
  const base = baseFiles.value;
  const d = compareData.value;
  const r = reveals.value;
  if (!base || !d || !r.size) return base;
  return base.map((fd) => {
    const reveal = r.get(fd.name);
    return reveal && isMarkdown(fd.name) ? withRevealed(fd, reveal, d) : fd;
  });
});

let revealRange = "";
effect(() => {
  const d = compareData.value;
  const range = d ? `${d.from.sha}..${d.to.sha}` : "";
  if (range === revealRange) return;
  revealRange = range;
  reveals.value = new Map([...reveals.peek()].flatMap(([path, r]) => (r.full ? [[path, { spans: [], full: true }] as const] : [])));
});

export const isWhole = (path: string): boolean => reveals.value.get(path)?.full ?? false;

/**
 * Changes what a Markdown file shows beyond its hunks, once both its texts are loaded. A cursor on its lines stays on
 * the same line; one on its rendered blocks follows its block when the blocks are laid out again.
 */
export async function changeReveal(path: string, next: (r: Reveal) => Reveal): Promise<void> {
  const d = compareData.peek();
  const fd = baseFiles.peek()?.find((f) => f.name === path);
  if (!d || !fd || !isMarkdown(path)) return;
  if (!revealNow(path, next)) {
    await Promise.all([fd.type === "new" ? null : api.blob(d.from.sha, fd.prevName ?? path), fd.type === "deleted" ? null : api.blob(d.to.sha, path)]).catch(() => null);
    if (compareData.peek() === d) revealNow(path, next);
  }
}

/** The same at once, when both texts are loaded; false when they are not. */
export function revealNow(path: string, next: (r: Reveal) => Reveal): boolean {
  const d = compareData.peek();
  const fd = baseFiles.peek()?.find((f) => f.name === path);
  if (!d || !fd) return false;
  if ((fd.type !== "new" && !api.loadedBlob(d.from.sha, fd.prevName ?? path)) || (fd.type !== "deleted" && !api.loadedBlob(d.to.sha, path))) return false;
  const lines = !drawnFiles.peek().has(path);
  const at = (c: Cursor | null) => {
    const r = lines && c?.path === path && c.row >= 0 ? cursorSpace.peek().row(c) : null;
    return r ? rowPosition(r) : null;
  };
  const c = at(cursor.peek());
  const a = at(visualAnchor.peek());
  const was = reveals.peek().get(path) ?? NOTHING;
  const now = next(was);
  if (now.full === was.full && JSON.stringify(now.spans) === JSON.stringify(was.spans)) return true;
  reveals.value = new Map(reveals.peek()).set(path, now);
  if (c) cursor.value = cursorSpace.peek().locate(path, c.side, c.line) ?? cursor.peek();
  if (a) visualAnchor.value = cursorSpace.peek().locate(path, a.side, a.line) ?? visualAnchor.peek();
  return true;
}
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
 * an SVG is a picture unless lines of it have threads, and Markdown is as `compare.markdown` says.
 */
export const fileView = signal<Map<string, FileView>>(new Map());

/** How a Markdown file opens: rendered unless `stet config set compare.markdown code`. */
export const markdownView = computed<FileView>(() => (status.value?.ui?.markdown === "code" ? "code" : "rendered"));

export function setFileView(path: string, view: FileView): void {
  fileView.value = new Map(fileView.value).set(path, view);
}

/** Files of the diff drawn as a picture or as rendered Markdown right now, not as lines. */
export const drawnFiles = signal<ReadonlySet<string>>(new Set());

/** The blocks of rendered Markdown files, for the cursor; kept with the file diff they were laid out for. */
export const fileBlocks = signal<ReadonlyMap<string, { fd: FileDiffMetadata; blocks: readonly NavBlock[] }>>(new Map());

export function setFileBlocks(fd: FileDiffMetadata, blocks: readonly NavBlock[]): void {
  const had = fileBlocks.peek().get(fd.name);
  if (had?.fd === fd && JSON.stringify(had.blocks) === JSON.stringify(blocks)) return;
  fileBlocks.value = new Map(fileBlocks.peek()).set(fd.name, { fd, blocks });
  // blocks opened or folded above the cursor: it stays on its block (a file shown as code has the cursor on its lines)
  const follow = (c: Cursor | null) => {
    const was = had && drawnFiles.peek().has(fd.name) && c?.path === fd.name && c.row >= 0 ? had.blocks[c.row] : null;
    if (!was) return c;
    const same = (b: NavBlock) => JSON.stringify([b.old, b.new]) === JSON.stringify([was.old, was.new]);
    const k = blocks.findIndex(same);
    return k === -1 || k === c!.row ? c : { path: fd.name, row: k };
  };
  const c = follow(cursor.peek());
  if (c !== cursor.peek()) cursor.value = c;
  const a = follow(visualAnchor.peek());
  if (a !== visualAnchor.peek()) visualAnchor.value = a;
}

/** Lines picked for a new thread on the Changes page, waiting for its first message: in the code or on a rendered block. */
export interface PendingLines {
  path: string;
  oldPath: string;
  range: SelectedLineRange;
}
export const pendingLines = signal<PendingLines | null>(null);

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
  /** A search hit: on its block in a rendered file when the rendered text has the match, else in the code. */
  showHit(path: string, side: Side, line: number): void;
  /** The line in the diff with the cursor on it, or the file's preview at that line when the diff does not show it. */
  openLine(path: string, side: Side, line: number): void;
  /** A rendered Markdown file as code, the block `stop` becoming its lines at the same height, with the cursor on them. */
  showCode(path: string, stop: number, side: "old" | "new"): void;
  revealCursor(c: Cursor, align?: "nearest" | "center"): void;
  startComment(range: LineRange): void;
  submitComment(body: string, mode: "draft" | "now"): Promise<boolean | void>;
  cancelComment(): void;
  pageRows(): number;
  /** Half a screen from the cursor in a rendered file, or null to move by rows. */
  pageFrom(c: Cursor, dir: 1 | -1): Cursor | null;
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
  compareNav.current?.showHit(h.path, h.side, h.line);
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
  const linked = linkedLines.value;
  if (linked) push(linked.path, { side: linked.side, start: linked.start, end: linked.end, tag: "linked" });
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
  baseFiles.value;
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
    compareNav.current?.showHit(h.path, "additions", h.line);
  } else peek.value = { path: h.path, sha: at.sha, label: at.label, line: h.line };
}
effect(() => {
  compareData.value?.to.sha;
  route.value.name === "thread" ? route.value.id : null;
  peek.value = null;
});

export const cursor = signal<Cursor | null>(null);
export const visualAnchor = signal<Cursor | null>(null);
export const cursorSpace = computed(() => {
  const drawn = drawnFiles.value;
  const blocks = fileBlocks.value;
  return new CursorSpace(
    visibleFiles.value.map((fd) => {
      if (!drawn.has(fd.name)) return { fd, collapsed: isCollapsed(fd) };
      const laid = blocks.get(fd.name);
      return { fd, collapsed: isCollapsed(fd), blocks: laid?.fd === fd ? laid.blocks : [] };
    }),
  );
});
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

/** The lines a link opened, highlighted until the cursor leaves them. */
export const linkedLines = signal<LineRange | null>(null);

effect(() => {
  const c = cursor.value;
  const lines = linkedLines.peek();
  if (c && lines && !cursorSpace.peek().holds(c, lines)) linkedLines.value = null;
});

/** The address of lines on this Changes page, for another tab or another reader of the same browser. */
export function linesUrl(lines: LineRange): string | null {
  const r = route.peek();
  const d = compareData.peek();
  if (r.name !== "compare") return null;
  const hash = routeHash(
    { name: "compare", from: d?.from.ref ?? r.from, to: d?.to.ref ?? r.to, file: lines.path, line: lines.start, end: lines.end, ...(lines.side === "deletions" ? { side: "old" as const } : {}) },
    reviewId.peek(),
  );
  return `${location.origin}${location.pathname}${hash}`;
}

export async function copyLinesUrl(lines: LineRange): Promise<void> {
  const url = linesUrl(lines);
  if (!url) return;
  const what = `${lines.path}:${lines.start === lines.end ? lines.start : `${lines.start}–${lines.end}`}`;
  try {
    await navigator.clipboard.writeText(url);
    notify(`copied a link to ${what}${lines.side === "deletions" ? " (removed lines)" : ""}`);
  } catch {
    notify(url);
  }
}

export const cursorLayer = computed(() => cursorMarks(cursorSpace.value, cursor.value, visualAnchor.value));

export function marksFor(path: string): LineMark[] {
  const a = marksByPath.peek().get(path);
  const b = cursorLayer.peek().get(path);
  return a && b ? [...a, ...b] : (a ?? b ?? []);
}
