/**
 * The finders over the screen, as the web's pickers: the file finder (`Space f f`) over the diff's files, or on a
 * thread's page over the whole branch's (with a name a message wrote typed in, over the files it may be), and the
 * version finder (`Space f v`), newest first under the review each version answers.
 */
import type { VersionDto } from "../../core/types.ts";
import { fuzzyFilter, wordFilter } from "../../ui/fuzzy.ts";
import { rounds, type Round } from "../../ui/versions.ts";
import { pane, type Row } from "../grid.ts";
import type { Data } from "../model.ts";
import { ago, blank, key, line, s, truncate, type Line, type Span } from "../text.ts";

export interface PickerState {
  kind: "files" | "versions";
  query: string;
  /** The row the cursor is on, of the rows the query leaves. */
  at: number;
  /** The paths offered: the diff's files, the branch's, or the files a name in a message may be. */
  paths: string[];
  /** Threads per path, shown beside it. */
  threads?: ReadonlyMap<string, number>;
  /** A name a message wrote, typed in: its files, and the lines a pick opens. */
  name?: { lines: string };
  /** What a pick does, for the hint: "jump", "open it on the Changes page". */
  verb: string;
  /** The range shown, whose ends the version finder marks. */
  range: { from: string; to: string };
  /** The keys that make a version "from" and "to" in this terminal, for the hint. */
  ends?: { from: string; to: string };
}

export interface VersionItem {
  v: VersionDto;
  round: Round | null;
  /** The newest version of its round heads the round in the list. */
  head: boolean;
}

export function roundTitle(r: Round, now = Date.now()): string {
  return r.index === 0 ? "before your first review" : `after your review ${r.index} · ${r.verdict === "approved" ? "approved" : "changes requested"} · ${ago(r.at!, now)}`;
}

/** Every version, newest first, with its round. */
export function versionItems(d: Data): VersionItem[] {
  const vs = d.status?.versionsList ?? [];
  const rs = rounds(vs, d.status?.submissions ?? []);
  return [...vs].reverse().map((v) => {
    const round = rs.find((r) => v.number >= r.first && v.number <= r.last) ?? null;
    return { v, round, head: !!round && round.last === v.number };
  });
}

/** The versions a query finds, as the web's finder: `v3` or `3` first, a phrase next, then words of the label. */
export function findVersions(all: VersionItem[], q: string, now = Date.now()): VersionItem[] {
  const text = (x: VersionItem) => `v${x.v.number} ${x.v.label ?? ""} ${x.v.author} ${x.round ? roundTitle(x.round, now) : ""}`;
  const query = q.trim().toLowerCase();
  const m = /^v?(\d+)$/.exec(query);
  const exact = m ? all.filter((x) => x.v.number === Number(m[1])) : [];
  const phrase = query.includes(" ") ? all.filter((x) => text(x).toLowerCase().includes(query)) : [];
  const first = [...exact, ...phrase];
  return [...first, ...wordFilter(all, q, text).filter((x) => !first.includes(x))];
}

export const FILE_LIMIT = 80;

/** The rows the query leaves: paths, or versions. */
export function pickerRows(p: PickerState, d: Data, now = Date.now()): string[] | VersionItem[] {
  return p.kind === "files" ? fuzzyFilter(p.paths, p.query, (x) => x, FILE_LIMIT) : findVersions(versionItems(d), p.query, now);
}

function fileRow(path: string, threads: number, w: number, on: boolean): Line {
  const cut = path.lastIndexOf("/") + 1;
  const tail = threads ? `  ${threads} thread${threads === 1 ? "" : "s"}` : "";
  const dir = truncate(path.slice(0, cut), Math.max(0, w - Bun.stringWidth(path.slice(cut)) - tail.length - 3));
  return { spans: [s(" "), s(path.slice(cut), "b"), s(` ${dir}`, "dim"), ...(tail ? [s(tail, "dim")] : [])], ...(on ? { fill: ["sel"] } : {}) };
}

function versionLines(x: VersionItem, p: PickerState, pass: number | null, on: boolean, now: number): Line[] {
  const out: Line[] = [];
  if (x.head && x.round) out.push(line(s(` ${roundTitle(x.round, now)}`, "dim")));
  const ref = String(x.v.number);
  const end = ref === p.range.from ? "from" : ref === p.range.to ? "to" : "";
  const files = x.v.files !== null && x.v.files !== undefined ? ` · ${x.v.files} file${x.v.files === 1 ? "" : "s"}` : "";
  const spans: Span[] = [s("   "), s(`v${x.v.number}`, "b"), ...(pass === x.v.number ? [s(" ✓", "ok")] : []), s(`  ${ago(x.v.createdAt, now)}${files}`, "dim"), s(`  ${x.v.label ?? ""}`), ...(end ? [s("  "), s(` ${end} `, "chips")] : [])];
  out.push({ spans, ...(on ? { fill: ["sel"] } : {}) });
  return out;
}

/** The finder as a box `w` cells wide at most, the input on top, the rows under it, its keys in the bottom border. */
export function pickerBox(p: PickerState, d: Data, w: number, h: number, pass: number | null, now = Date.now()): Row[] {
  const bw = Math.min(w - 4, 84);
  const inner = bw - 2;
  const rows = pickerRows(p, d, now);
  p.at = Math.max(0, Math.min(p.at, rows.length - 1));
  const placeholder =
    p.kind === "versions" ? "its number or words of its label" : p.name ? `${p.paths.length} files have this name: pick one` : p.verb === "jump" ? "a file of this diff (fuzzy)" : "a file of the branch's diff (fuzzy)";
  const input = line(s(" > ", "acc"), ...(p.query ? [s(p.query), s("▏", "acc")] : [s("▏", "acc"), s(placeholder, "dim")]));
  const room = Math.max(3, Math.min(h - 6, 20));
  const body: Line[] = [];
  const marks: number[] = [];
  if (p.kind === "files") {
    (rows as string[]).forEach((path, i) => {
      marks.push(body.length);
      body.push({ ...fileRow(path, p.threads?.get(path) ?? 0, inner, i === p.at), hit: `pick:${i}` });
    });
  } else {
    (rows as VersionItem[]).forEach((x, i) => {
      const ls = versionLines(x, p, pass, i === p.at, now);
      marks.push(body.length + ls.length - 1);
      body.push(...ls.map((l) => ({ ...l, hit: `pick:${i}` })));
    });
  }
  if (!rows.length) body.push(line(s(p.kind === "files" ? " no file has these letters" : " no version has these words", "dim")));
  const sel = marks[p.at] ?? 0;
  const top = Math.max(0, Math.min(sel - Math.floor(room / 2), body.length - room));
  const shown = body.slice(top, top + room);
  const lines = [input, blank(), ...shown];
  const how: Span[] =
    p.kind === "versions"
      ? [key("Enter"), s(" what changed in it · "), key(p.ends?.from ?? "Shift+Enter"), s(" from · "), key(p.ends?.to ?? "Ctrl+Enter"), s(" to · "), key("Esc"), s(" close")]
      : [key("↑"), key("↓"), s(" · "), key("Enter"), s(` ${p.name ? (p.name.lines ? `open it at ${p.name.lines.includes("–") ? "lines" : "line"} ${p.name.lines}` : "open it") : p.verb} · `), key("Esc"), s(" close")];
  const title = p.kind === "versions" ? "Find a version" : "Find a file";
  return pane({ w: bw, title: [s(title, "b")], right: rows.length > room ? [s(`${rows.length}`, "dim")] : [], bottom: how, lines, focus: true, hit: "focus:picker" }, lines.length + 2);
}
