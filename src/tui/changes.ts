/**
 * The Changes tab's state and what it shows: the range between two versions, its files in reading order with their
 * folds and viewed marks, the threads on its lines, and the items of the diff widget made of them. The web's Changes
 * page decides the same from the same shared logic in src/ui.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import type { CompareDto, ComparePlacement, ReviewedDto, ThreadSummary } from "../core/types.ts";
import { fileRows, type FileRow } from "../ui/compare.ts";
import { DEFAULT_COLLAPSE_GLOBS, DEFAULT_SKIP_MARKERS, DEFAULT_TEST_GLOBS, foldOf, parseList, type FoldDecision } from "../ui/fold.ts";
import { CORE_PRESETS, orderOf } from "../ui/order.ts";
import { CHUNK, type Reveal } from "../ui/reveal.ts";
import { flatHits, searchDiff, type Hit } from "../ui/search.ts";
import { nowDirty, presets, reviewedRef, tipRef, type Preset, type Refs } from "../ui/state.ts";
import { isViewedIn, unviewKeys, viewedIndex, viewedKey, type ViewedIndex } from "../ui/viewed.ts";
import type { FileItem, Item, Placed } from "./diff/model.ts";
import type { Found, LineMarks } from "./diff/paint.ts";
import type { Ranges } from "./diff/words.ts";
import type { DiffView, LayoutPref } from "./diff/view.ts";
import type { Data } from "./model.ts";
import type { Side } from "./views/list.ts";



export interface ChangesState {
  /** The range asked for, as refs: `base`, a version's number, `now`, a commit. */
  from: string | null;
  to: string | null;
  data: CompareDto | null;
  /** The files of the range as the server's patch has them, for `key`. */
  base: FileDiffMetadata[] | null;
  key: string;
  /** Files whose both texts came, to show lines beyond the hunks. */
  whole: Map<string, FileDiffMetadata>;
  reveals: Map<string, Reveal>;
  /** Files opened or folded by hand; the rest are folded once viewed. */
  open: Map<string, boolean>;
  groups: { tests: boolean; generated: boolean };
  /** The review's viewed marks and last pass, from the server's cursors. */
  viewed: ReadonlySet<string>;
  reviewed: ReviewedDto | null;
  rows: FileRow[];
  focus: "list" | "diff";
  side: Side;
  /** The file the list's cursor is on. */
  sel: string | null;
  /** The range may have changed while the tab was not shown. */
  stale: boolean;
  /** The thread last stepped to or opened: its lines are marked stronger. */
  thread: number | null;
  loading: string | null;
  error: string | null;
  layout: LayoutPref;
  wrap: boolean;
  diff: DiffView;
  search: DiffSearch;
  /** A file to go to once the range loaded: picked in the file finder on another tab. */
  goto: string | null;
}

/** The diff's search (`/`): what is typed, the matches in reading order, the one gone to last. */
export interface DiffSearch {
  query: string;
  /** The box at the bottom takes the keys. */
  typing: boolean;
  hits: Hit[];
  /** The match `n` went to; -1 before the first. */
  at: number;
  error: string | null;
  truncated: boolean;
  /** The files and query the matches are of, so a fold or a viewed mark does not search again. */
  of: { files: FileDiffMetadata[] | null; query: string };
}

export function initialChanges(diff: DiffView): ChangesState {
  return {
    from: null,
    to: null,
    data: null,
    base: null,
    key: "",
    whole: new Map(),
    reveals: new Map(),
    open: new Map(),
    groups: { tests: false, generated: false },
    viewed: new Set(),
    reviewed: null,
    rows: [],
    focus: "diff",
    side: "files",
    sel: null,
    thread: null,
    stale: false,
    loading: null,
    error: null,
    layout: "auto",
    wrap: true,
    diff,
    search: { query: "", typing: false, hits: [], at: -1, error: null, truncated: false, of: { files: null, query: "" } },
    goto: null,
  };
}

const setting = (d: Data, key: string) => d.status?.ui?.config[key] ?? null;

export function refsOf(d: Data): Refs {
  return { versions: d.status?.versionsList ?? [], now: d.status?.now ?? undefined };
}

/** The whole branch: from the base to the latest version, or to "now" when it moved on. */
export function wholeBranch(d: Data): { from: string; to: string } {
  return { from: "base", to: tipRef(refsOf(d)) };
}

export function presetsOf(d: Data, c: ChangesState): Preset[] {
  return presets(refsOf(d), c.reviewed);
}

/** A ref as the strip and the title name it. */
export function refLabel(d: Data, c: ChangesState, ref: string): string {
  if (ref === "base") return d.status?.review.baseRef ?? "base";
  if (ref === "now") return "now";
  if (/^\d+$/.test(ref)) return `v${ref}`;
  return c.reviewed?.sha === ref ? "your last pass" : ref.slice(0, 8);
}

/** What the range is, in words: "The whole branch main → v2", "What changed in v2 v1 → v2". */
export function rangeTitle(d: Data, c: ChangesState): string {
  const from = c.from ?? "base";
  const to = c.to ?? "now";
  const refs = refsOf(d);
  const n = refs.versions.length;
  const ends = `${refLabel(d, c, from)} → ${refLabel(d, c, to)}`;
  if (from === reviewedRef(refs, c.reviewed) && to === tipRef(refs)) return `Since you last looked ${ends}`;
  if (to === "now" && from === String(n) && nowDirty(refs)) return `After v${n}, not saved as a version yet ${ends}`;
  if (from === "base") return to === tipRef(refs) ? `The whole branch ${ends}` : `The branch up to ${refLabel(d, c, to)} ${ends}`;
  if (/^\d+$/.test(to) && from === (Number(to) === 1 ? "base" : String(Number(to) - 1))) return `What changed in v${to} ${ends}`;
  return `Changes ${ends}`;
}

export function viewedIdx(c: ChangesState): ViewedIndex {
  return viewedIndex(c.viewed);
}

export function isCollapsed(c: ChangesState, fd: FileDiffMetadata, idx = viewedIdx(c)): boolean {
  return !(c.open.get(fd.name) ?? !isViewedIn(idx, fd));
}

/** The keys a viewed tick on a file adds, or the ones it drops to untick it. */
export function viewedChange(c: ChangesState, fd: FileDiffMetadata): { keys: string[]; on: boolean } {
  const idx = viewedIdx(c);
  const on = !isViewedIn(idx, fd);
  return { keys: on ? [viewedKey(fd)] : unviewKeys(idx, fd), on };
}

/** Threads shown on the diff: resolved ones only while the list shows them too. */
export function shownPlacements(d: Data, c: ChangesState, all: boolean): ComparePlacement[] {
  const resolved = new Set(d.threads.filter((t) => t.status === "resolved").map((t) => t.id));
  return (c.data?.placements ?? []).filter((p) => all || !resolved.has(p.threadId));
}

/** The lines a "show" on a bar opens: all of a short bar, else a chunk from each of its ends. */
export function barSpans(start: number, n: number): { start: number; end: number }[] {
  if (n <= CHUNK * 2) return [{ start, end: start + n - 1 }];
  return [
    { start, end: start + CHUNK - 1 },
    { start: start + n - CHUNK, end: start + n - 1 },
  ];
}

const counts = (fd: FileDiffMetadata) => {
  let add = 0;
  let del = 0;
  for (const h of fd.hunks) {
    add += h.additionLines;
    del += h.deletionLines;
  }
  return { add, del };
};

export function fileCounts(fd: FileDiffMetadata): { add: number; del: number } {
  return counts(fd);
}

export interface Built {
  items: Item[];
  marks: Map<string, LineMarks>;
}

/**
 * The files in reading order (src/ui/compare.ts) as the widget's items: fold groups before their files, folded files
 * as their header, threads' cards and marks on their lines.
 */
export function buildChanges(d: Data, c: ChangesState, showResolved: boolean): Built {
  const base = c.base ?? [];
  const tests = parseList(setting(d, "compare.tests"), DEFAULT_TEST_GLOBS);
  const cfg = { tests, skipMarkers: parseList(setting(d, "compare.skip_markers"), DEFAULT_SKIP_MARKERS), collapse: parseList(setting(d, "compare.collapse"), DEFAULT_COLLAPSE_GLOBS) };
  const folds = new Map<string, FoldDecision>();
  for (const fd of base) folds.set(fd.name, foldOf(fd, cfg));
  const placements = shownPlacements(d, c, showResolved);
  c.rows = fileRows(base, { folds, open: c.groups, placements, order: orderOf(setting(d, "compare.order"), CORE_PRESETS), tests });
  const idx = viewedIdx(c);
  const byPath = new Map<string, ComparePlacement[]>();
  for (const p of placements) byPath.set(p.path, [...(byPath.get(p.path) ?? []), p]);
  const files = new Map((c.data?.files ?? []).map((f) => [f.path, f]));
  const items: Item[] = [];
  const marks = new Map<string, LineMarks>();
  let group: string | null = null;
  for (const r of c.rows) {
    if (r.group && r.group !== group) items.push({ kind: "group", key: `group:${r.group}`, open: c.groups[r.group] });
    group = r.group;
    if (r.hidden) continue;
    const name = r.fd.name;
    const fd = c.whole.get(name) ?? r.fd;
    const placed: Placed[] = (byPath.get(name) ?? []).map((p) => ({ threadId: p.threadId, side: p.side, range: p.range }));
    const f = files.get(name);
    const note = r.fd.hunks.length
      ? undefined
      : f?.image
        ? "a picture:  g x  shows it in the browser"
        : f?.binary || r.fd.type === "change"
          ? "a binary file"
          : r.fd.type === "rename-pure"
            ? `renamed from ${r.fd.prevName}, no changes`
            : "no lines to show";
    const item: FileItem = { kind: "file", key: name, fd, collapsed: isCollapsed(c, r.fd, idx), placed, ...(c.reveals.has(name) ? { reveal: c.reveals.get(name)! } : {}), ...(note ? { note } : {}) };
    items.push(item);
    const m: LineMarks = { old: [], new: [] };
    for (const p of placed) (p.side === "deletions" ? m.old : m.new).push({ ...p.range, strong: p.threadId === c.thread });
    if (placed.length) marks.set(name, m);
  }
  return { items, marks };
}

/** The thread a card names, for its text. */
export function threadOf(d: Data, id: number): ThreadSummary | undefined {
  return d.threads.find((t) => t.id === id);
}

/** The widget shows the files anew: after the range, a fold, a viewed mark, a revealed line or a filter changed. */
export function syncChanges(d: Data, c: ChangesState, showResolved: boolean): void {
  const b = buildChanges(d, c, showResolved);
  c.diff.marks = b.marks;
  c.diff.setItems(b.items);
  if (!c.sel || !c.rows.some((r) => r.fd.name === c.sel)) c.sel = c.rows.find((r) => !r.hidden)?.fd.name ?? null;
  searchChanges(c);
}

/**
 * The search's matches in the range's files, as the web finds them (src/ui/search.ts): in every file of the diff,
 * folded ones too, in reading order. Searched again only when the files or the query changed; the widget marks them.
 */
export function searchChanges(c: ChangesState): void {
  const q = c.search;
  if (q.of.files !== c.base || q.of.query !== q.query) {
    const r = searchDiff(c.rows.map((x) => x.fd), q.query);
    q.hits = flatHits(r);
    q.error = r.error;
    q.truncated = r.truncated;
    q.at = -1;
    q.of = { files: c.base, query: q.query };
  }
  c.diff.setFound(foundOf(q.hits), currentHit(q));
}

function foundOf(hits: readonly Hit[]): Map<string, Found> {
  const out = new Map<string, { old: Map<number, Ranges>; new: Map<number, Ranges> }>();
  for (const h of hits) {
    let f = out.get(h.path);
    if (!f) out.set(h.path, (f = { old: new Map(), new: new Map() }));
    (h.side === "deletions" ? f.old : f.new).set(h.line, h.ranges);
  }
  return out;
}

export function currentHit(q: DiffSearch): { key: string; side: 0 | 1; line: number } | null {
  const h = q.hits[q.at];
  return h ? { key: h.path, side: h.side === "deletions" ? 0 : 1, line: h.line } : null;
}
