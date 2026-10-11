/**
 * A thread's code as plain rows: the server's diff of its lines from when it was written to now, or its lines at one
 * end, with a few lines around. A stand-in for the diff widget of phase 3, which takes over behind `codeLines`.
 */
import type { Excerpt, ThreadDetail, TimelineStepDto } from "../core/types.ts";
import { outdatedText } from "../ui/timeline.ts";
import { chop, clean, filled, line, rangeText, s, spread, type Line, type Span } from "./text.ts";

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
    return { kind: "ctx", old: null, new: at, text, marked: at >= e.start && at <= e.end };
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

export function counts(code: Code): { add: number; del: number } {
  return { add: code.rows.filter((r) => r.kind === "add").length, del: code.rows.filter((r) => r.kind === "del").length };
}

/** The file's header over its code: the path, what the rows show, −N +M. */
export function fileHeader(path: string, code: Code, w: number): Line {
  const c = counts(code);
  const right: Span[] = [];
  if (c.del) right.push(s(`−${c.del}`, "delc"));
  if (c.add) right.push(...(c.del ? [s(" ")] : []), s(`+${c.add}`, "addc"));
  return { spans: spread([s(" "), s(path, "fh"), s(` · ${code.title}`, "dim")], right, w) };
}

/**
 * The rows as screen lines: line numbers, ▌ on the thread's lines, diff rows painted across the width, long lines
 * wrapped. `mark` is the row put under the thread's last line: "▲ thread #1 · v2".
 */
export function codeLines(code: Code, w: number, mark: Span[] | null): Line[] {
  const numbers = code.rows.flatMap((r) => [r.old ?? 0, r.new ?? 0]);
  const side = Math.max(3, String(Math.max(0, ...numbers)).length + 1);
  const num = (v: number | null) => (v === null ? " ".repeat(side) : String(v).padStart(side));
  const lastMarked = code.rows.reduce((at, r, i) => (r.marked ? i : at), -1);
  const room = Math.max(1, w - side * 2 - 3);
  const out: Line[] = [];
  code.rows.forEach((r, i) => {
    if (r.kind === "gap") {
      out.push(line(s(`${" ".repeat(side * 2 - 1)}⋯`, "ln")));
      return;
    }
    const field = code.diff ? `${num(r.old)}${num(r.new)}` : `${" ".repeat(side)}${num(r.new)}`;
    const head: Span[] = r.marked ? [s("▌", "mk"), s(field.slice(1), "ln")] : [s(field, "ln")];
    const sign = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
    const fill = r.kind === "add" ? (["add"] as const) : r.kind === "del" ? (["del"] as const) : null;
    chop(clean(r.text), room).forEach((part, k) => {
      const spans = [...(k === 0 ? head : [s(" ".repeat(side * 2), "ln")]), s(` ${k === 0 ? sign : " "} ${part}`)];
      out.push(fill ? filled([...fill], ...spans) : { spans });
    });
    if (i === lastMarked && mark) out.push(line(s(" ".repeat(side * 2), "ln"), s("   "), ...mark));
  });
  return out;
}
