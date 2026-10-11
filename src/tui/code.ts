/**
 * A thread's code on the diff widget: around the thread (the server's diff of its lines from when it was written to
 * now, or its lines at one end, with a few lines around), every change of its file, or the whole file. The two wider
 * scopes come from the server: the file's patch between the two steps, and both files for the whole one.
 */
import { hydratePartialDiff, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { Api } from "../client/api.ts";
import type { Excerpt, ThreadDetail, TimelineStepDto } from "../core/types.ts";
import { outdatedText } from "../ui/timeline.ts";
import type { FileItem, Placed } from "./diff/model.ts";
import type { LineMarks } from "./diff/paint.ts";
import { rangeText, s, spread, type Line, type Span } from "./text.ts";

export interface CodeRow {
  kind: "ctx" | "add" | "del" | "gap";
  old: number | null;
  new: number | null;
  text: string;
  /** One of the thread's lines, on the side the row belongs to. */
  marked: boolean;
}

/** Diff: how the lines changed from when the thread was written; Then: as written; At: as they are at the last step. */
export type CodeView = "diff" | "then" | "at";

/** How much of the file: around the thread, every change of the file, or the whole file. */
export type Scope = "around" | "changes" | "file";

export interface Code {
  view: CodeView;
  /** What the rows show, after the file's name. */
  title: string;
  rows: CodeRow[];
  /** Two columns of line numbers: the rows are a diff. */
  diff: boolean;
}

const inRange = (n: number | null, r: { start: number; end: number } | null) => n !== null && !!r && n >= r.start && n <= r.end;

/** A unified diff's rows; `then` and `now` mark the thread's lines on the old and the new side. */
export function patchRows(patch: string, then: TimelineStepDto["range"], now: TimelineStepDto["range"]): CodeRow[] {
  const rows: CodeRow[] = [];
  let o = 0;
  let n = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      if (rows.length) rows.push({ kind: "gap", old: null, new: null, text: "", marked: false });
      o = Number(h[1]);
      n = Number(h[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    const mark = raw[0];
    const text = raw.slice(1);
    if (mark === "+") rows.push({ kind: "add", old: null, new: n, text, marked: inRange(n++, now) });
    else if (mark === "-") rows.push({ kind: "del", old: o, new: null, text, marked: inRange(o++, then) });
    else if (mark === " ") rows.push({ kind: "ctx", old: o++, new: n++, text, marked: inRange(n - 1, now) });
  }
  return rows;
}

function excerptRows(e: Excerpt): CodeRow[] {
  return e.lines.map((text, i) => {
    const at = e.firstLine + i;
    return { kind: "ctx", old: at, new: at, text, marked: at >= e.start && at <= e.end };
  });
}

/** The views the thread's data can show, the default first. */
export function codeViews(d: ThreadDetail): CodeView[] {
  const first = d.timeline[0]!;
  const last = d.timeline[d.timeline.length - 1]!;
  const out: CodeView[] = [];
  if (d.code.interdiff && patchRows(d.code.interdiff, first.range, last.range).length) out.push("diff");
  if (d.code.now && last.range) out.push("at");
  if (d.code.then) out.push("then");
  return out;
}

const lines = (r: { start: number; end: number } | null) => (r && r.start !== r.end ? `lines ${rangeText(r)}` : `line ${rangeText(r)}`);

/** What the thread shows of its code in `view`, or in its default view when that one has nothing. */
export function threadCode(d: ThreadDetail, view: CodeView | null): Code {
  const t = d.thread;
  const first = d.timeline[0]!;
  const last = d.timeline[d.timeline.length - 1]!;
  const views = codeViews(d);
  const v = view && views.includes(view) ? view : views[0];
  if (t.region) return { view: "at", title: `an area of the image: \`stet open ${t.id} --browser\` shows it`, rows: [], diff: false };
  if (v === "diff") {
    return { view: v, title: `${lines(last.range)} · how they changed from ${first.label} to ${last.label}`, rows: patchRows(d.code.interdiff!, first.range, last.range), diff: true };
  }
  if (v === "at") {
    const since = last.index === 0 ? "" : views.includes("diff") ? "" : ` · unchanged since ${first.label}`;
    return { view: v, title: `${lines(last.range)} at ${last.label}${since}`, rows: excerptRows(d.code.now!), diff: false };
  }
  if (v === "then") {
    const gone = !d.code.now || !last.range ? `${outdatedText(last.reason, last.label)} · ` : "";
    return { view: v, title: `${gone}${lines(first.range)} as written on ${first.label}`, rows: excerptRows(d.code.then!), diff: false };
  }
  return { view: "at", title: "the thread's code could not be read", rows: [], diff: false };
}

/** Only the rows of the thread's lines and `around` rows on each side, for a column with little room. */
export function nearThread(code: Code, around: number): Code {
  const marked = code.rows.flatMap((r, i) => (r.marked ? [i] : []));
  if (!marked.length) return code;
  return { ...code, rows: code.rows.slice(Math.max(0, marked[0]! - around), marked[marked.length - 1]! + around + 1) };
}

/**
 * The ends of the thread's code: the step its old side is at and the one its new side is at. Every change of the file
 * runs from when the thread was written to its last step, whichever view is on.
 */
export function codeEnds(d: ThreadDetail, view: CodeView, scope: Scope = "around"): { from: TimelineStepDto; to: TimelineStepDto } {
  const first = d.timeline[0]!;
  const last = d.timeline[d.timeline.length - 1]!;
  return view === "diff" || scope === "changes" ? { from: first, to: last } : view === "then" ? { from: first, to: first } : { from: last, to: last };
}

/** The scopes `z` goes through in a view: every change of the file once the thread has more than one step. */
export function scopesOf(d: ThreadDetail, view: CodeView): Scope[] {
  if (d.thread.region) return ["around"];
  const first = d.timeline[0]!;
  const last = d.timeline[d.timeline.length - 1]!;
  const { to } = codeEnds(d, view);
  const changes = first.path && last.path && first.sha !== last.sha ? ["changes" as const] : [];
  return ["around", ...changes, ...(to.path ? ["file" as const] : [])];
}

/** What a wider scope needs from the server, and the key its answer is kept under. */
export function wideKey(d: ThreadDetail, view: CodeView, scope: Scope): string | null {
  if (scope === "around" || !scopesOf(d, view).includes(scope)) return null;
  const { from, to } = codeEnds(d, view, scope);
  return `${d.thread.id}:${view}:${scope}:${from.sha}:${from.path}:${to.sha}:${to.path}`;
}

/** A wider scope's code as the app fetched it: a file diff, whole files for `file`. */
export interface Wide {
  key: string;
  fd: FileDiffMetadata | null;
  error?: string;
}

/** The rows as a patch of one file that pierre parses: hunks split where the rows have a gap. */
function rowsPatch(path: string, rows: CodeRow[]): string {
  const out: string[] = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  let hunk: CodeRow[] = [];
  const flush = () => {
    if (!hunk.length) return;
    const olds = hunk.filter((r) => r.kind !== "add");
    const news = hunk.filter((r) => r.kind !== "del");
    const o = olds[0]?.old ?? 1;
    const n = news[0]?.new ?? 1;
    out.push(`@@ -${olds.length ? o : Math.max(0, o - 1)},${olds.length} +${news.length ? n : Math.max(0, n - 1)},${news.length} @@`);
    for (const r of hunk) out.push(`${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`);
    hunk = [];
  };
  for (const r of rows) {
    if (r.kind === "gap") flush();
    else hunk.push(r);
  }
  flush();
  return `${out.join("\n")}\n`;
}

const parsed = new Map<string, FileDiffMetadata | null>();

/** A patch of one file as pierre's file diff, the same object for the same key so its colours stay. */
export function fileDiff(key: string, patch: string): FileDiffMetadata | null {
  let fd = parsed.get(key);
  if (fd === undefined) {
    fd = parsePatchFiles(patch, key)[0]?.files[0] ?? null;
    if (parsed.size > 64) parsed.delete(parsed.keys().next().value!);
    parsed.set(key, fd);
  }
  return fd;
}

export interface ThreadBlock {
  item: FileItem;
  marks: LineMarks;
  /** The line over the code: the file, what the code shows, −N +M. */
  title: string;
  view: CodeView;
  scope: Scope;
}

function counts(fd: FileDiffMetadata | null): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of fd?.hunks ?? []) {
    add += h.additionLines;
    del += h.deletionLines;
  }
  return { add, del };
}

/** The file's header over its code: the path, what the rows show, −N +M. */
export function fileHeader(path: string, title: string, fd: FileDiffMetadata | null, w: number): Line {
  const c = counts(fd);
  const right: Span[] = [];
  if (c.del) right.push(s(`−${c.del}`, "delc"));
  if (c.add) right.push(...(c.del ? [s(" ")] : []), s(`+${c.add}`, "addc"));
  return { spans: spread([s(" "), s(path, "fh"), s(` · ${title}`, "dim")], right, w) };
}

const SCOPE_TITLES: Record<Exclude<Scope, "around">, (view: CodeView, from: TimelineStepDto, to: TimelineStepDto) => string> = {
  changes: (_v, from, to) => `every change of the file from ${from.label} to ${to.label}`,
  file: (v, from, to) => (v === "diff" ? `the whole file at ${to.label}, changes from ${from.label}` : `the whole file at ${to.label}`),
};

/**
 * The thread's code to draw: around the thread from the thread's own data (`around` rows each side of its lines when
 * given), or the wider scope `wide` holds once it came. Null while the wider scope is on its way.
 */
export function threadBlock(d: ThreadDetail, view: CodeView | null, scope: Scope, wide: Wide | null, around: number | null = null): ThreadBlock | null {
  const t = d.thread;
  const base = threadCode(d, view);
  const v = base.view;
  const { from, to } = codeEnds(d, v, scope);
  const single = scope === "changes" ? false : scope === "file" ? v !== "diff" : !base.diff;
  const path = t.anchor.path ?? t.path;
  const key = wideKey(d, v, scope);
  const marks: LineMarks = single ? { old: [], new: [] } : { old: from.range ? [{ ...from.range, strong: false }] : [], new: [] };
  const mine = v === "then" && scope !== "changes" ? from.range : to.range;
  if (mine) marks.new.push({ ...mine, strong: false });
  const placed: Placed[] = mine
    ? [{ threadId: t.id, side: "additions", range: mine }]
    : from.range
      ? [{ threadId: t.id, side: "deletions", range: from.range }]
      : [];
  if (!key) {
    const code = around === null ? base : nearThread(base, around);
    const fd = code.rows.length ? fileDiff(`around:${t.id}:${v}:${to.sha}:${around ?? ""}:${code.rows.length}`, rowsPatch(path, code.rows)) : null;
    const item: FileItem = { kind: "file", key: path, fd: fd ?? EMPTY, collapsed: false, placed, single, excerpt: true, ...(fd ? {} : { note: "" }) };
    return { item, marks, title: code.title, view: v, scope: "around" };
  }
  if (!wide || wide.key !== key) return null;
  const title = SCOPE_TITLES[scope as Exclude<Scope, "around">](v, from, to);
  const fd = wide.fd ?? EMPTY;
  const item: FileItem = { kind: "file", key: path, fd, collapsed: false, placed, single, ...(scope === "file" ? { reveal: { spans: [], full: true } } : {}), ...(wide.fd ? {} : { note: wide.error ?? "no changes in this file" }) };
  return { item, marks, title, view: v, scope };
}

const EMPTY = { name: "", type: "change", hunks: [], splitLineCount: 0, unifiedLineCount: 0, isPartial: true, deletionLines: [], additionLines: [] } as unknown as FileDiffMetadata;

/** A whole file of one version as a diff of context lines, for the whole-file scope of Then and At. */
export function wholeFile(key: string, path: string, text: string): FileDiffMetadata | null {
  const all = text.split("\n");
  if (all[all.length - 1] === "") all.pop();
  if (!all.length) return null;
  return fileDiff(key, rowsPatch(path, all.map((t, i) => ({ kind: "ctx", old: i + 1, new: i + 1, text: t, marked: false }))));
}

/** Fetches a wider scope's code: the file's patch between the ends, with both files for the whole of it. */
export async function fetchWide(api: Pick<Api, "patch" | "blob">, d: ThreadDetail, view: CodeView, scope: Scope, key: string): Promise<Wide> {
  const { from, to } = codeEnds(d, view, scope);
  try {
    let fd: FileDiffMetadata | null = null;
    if (scope === "changes" || view === "diff") {
      const text = await api.patch(from.sha, to.sha, [...new Set([from.path!, to.path!])]);
      const part = text ? fileDiff(`${key}:patch`, text) : null;
      if (scope === "changes") fd = part;
      else {
        const [a, b] = await Promise.all([api.blob(from.sha, from.path!), api.blob(to.sha, to.path!)]);
        if (part && a.contents !== null && b.contents !== null) {
          fd = hydratePartialDiff("clone", part, { oldFile: { name: from.path!, contents: a.contents }, newFile: { name: to.path!, contents: b.contents } } as never);
        } else if (b.contents !== null) fd = wholeFile(key, to.path!, b.contents);
      }
    } else {
      const b = await api.blob(to.sha, to.path!);
      fd = b.contents !== null ? wholeFile(key, to.path!, b.contents) : null;
    }
    return fd ? { key, fd } : { key, fd: null, error: scope === "changes" ? "no changes in this file" : "the file is not text" };
  } catch (e) {
    return { key, fd: null, error: (e as Error).message };
  }
}
