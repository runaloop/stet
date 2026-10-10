/**
 * A thread's code as plain rows: the server's diff of its lines from when it was written to now, or its lines at one
 * step, with a few lines around. A stand-in for the diff widget of phase 3, which takes over behind `codeLines`.
 */
import type { Excerpt, ThreadDetail, TimelineStepDto } from "../core/types.ts";
import { clean, clip, line, rangeText, s, type Line, type Span } from "./text.ts";

export interface CodeRow {
  kind: "ctx" | "add" | "del" | "gap";
  old: number | null;
  new: number | null;
  text: string;
  /** One of the thread's lines, on the side the row belongs to. */
  marked: boolean;
}

export interface Code {
  title: string;
  rows: CodeRow[];
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
    else if (mark === " ") rows.push({ kind: "ctx", old: o++, new: n++, text, marked: inRange(n - 1, now) || inRange(o - 1, then) });
  }
  return rows;
}

function excerptRows(e: Excerpt): CodeRow[] {
  return e.lines.map((text, i) => {
    const at = e.firstLine + i;
    return { kind: "ctx", old: null, new: at, text, marked: at >= e.start && at <= e.end };
  });
}

/** What the thread's page shows of its code. */
export function threadCode(d: ThreadDetail): Code {
  const t = d.thread;
  const first = d.timeline[0]!;
  const last = d.timeline[d.timeline.length - 1]!;
  if (t.region) return { title: `an area of the image ${t.path}: \`stet open ${t.id} --browser\` shows it`, rows: [] };
  if (d.code.interdiff) {
    const rows = patchRows(d.code.interdiff, first.range, last.range);
    if (rows.length) return { title: `lines ${rangeText(last.range)} · how they changed from ${first.label} to ${last.label}`, rows };
  }
  if (d.code.now && last.range) {
    const title = last.index === 0 ? `lines ${rangeText(last.range)} at ${last.label}, when the thread started` : `lines ${rangeText(last.range)} at ${last.label} · unchanged since ${first.label}`;
    return { title, rows: excerptRows(d.code.now) };
  }
  if (d.code.then) {
    return { title: `the commented code is gone at ${last.label} (${last.reason ?? "outdated"}) · as it was at ${first.label}`, rows: excerptRows(d.code.then) };
  }
  return { title: "the thread's code could not be read", rows: [] };
}

/** The rows as screen lines: line numbers, a bar on the thread's lines, + and − in their colours. Long lines are cut. */
export function codeLines(code: Code, w: number): Line[] {
  const numbers = code.rows.flatMap((r) => [r.old ?? 0, r.new ?? 0]);
  const digits = Math.max(2, String(Math.max(0, ...numbers)).length);
  const twoColumns = code.rows.some((r) => r.kind !== "ctx" || r.old !== null);
  const num = (v: number | null) => (v === null ? " ".repeat(digits) : String(v).padStart(digits));
  return code.rows.map((r) => {
    if (r.kind === "gap") return line(s(`${" ".repeat(digits * (twoColumns ? 2 : 1) + (twoColumns ? 1 : 0) + 1)}⋯`, { tone: "muted" }));
    const tone = r.kind === "add" ? "add" : r.kind === "del" ? "del" : undefined;
    const gutter = twoColumns ? `${num(r.old)} ${num(r.new)}` : num(r.new);
    const spans: Span[] = [
      s(r.marked ? "▌" : " ", { tone: "warn" }),
      s(gutter, { tone: r.marked ? "warn" : "muted", bold: r.marked }),
      s(r.kind === "add" ? " + " : r.kind === "del" ? " - " : "   ", { tone }),
      s(clean(r.text), { tone, bold: r.marked && !tone }),
    ];
    return { spans: clip(spans, w) };
  });
}
