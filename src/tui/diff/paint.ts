/**
 * One row of the diff as screen lines: the gutter (thread mark, line numbers, sign), the code with its syntax colours
 * and changed words, wrapped or cut sideways; in split the old line left of the new one. File headers, group rows
 * and thread cards come from the page that shows the diff.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import { line, s, type Cls, type Line, type Span } from "../text.ts";
import { clipRuns, expandRuns, wrapRuns } from "./cells.ts";
import { ADD, CTX, DEL, FILE, GAP, GROUP, NOTE, PAIR, lineText, type FileItem, type GroupItem, type Placed, type Rows } from "./model.ts";
import { markRuns, wordMarks, type Ranges } from "./words.ts";

/** Syntax colours of a line: per token its end in the line's text and its style. */
export interface TokenSource {
  line(fd: FileDiffMetadata, side: 0 | 1, i: number): Uint32Array | undefined;
  style(id: number): { fg: string; fs: number } | undefined;
}

/** What the page draws itself, in the rows the diff gives it. */
export interface Hooks {
  header(item: FileItem, w: number, at: boolean): Line;
  group(item: GroupItem, w: number, at: boolean): Line;
  /** A thread's card, open or as one line, under the gutter's width `indent`. */
  card(item: FileItem, p: Placed, w: number, open: boolean, indent: number, at: boolean): Line[];
  note(item: FileItem, w: number, at: boolean): Line;
}

export interface PaintOpts {
  width: number;
  split: boolean;
  wrap: boolean;
  /** Cells scrolled sideways, without wrap. */
  hoff: number;
  /** Width of each line-number field. */
  num: number;
  /** Lines a wrapped row may take at most. */
  cap: number;
}

/** A thread's lines on a side, for the ▌ in the gutter; `strong` for the thread in focus. */
export interface LineMarks {
  old: { start: number; end: number; strong: boolean }[];
  new: { start: number; end: number; strong: boolean }[];
}

type Run = Span;

function tokenRuns(text: string, tk: Uint32Array | undefined, src: TokenSource): Run[] {
  if (!tk || !tk[0]) return [{ text }];
  const out: Run[] = [];
  let off = 0;
  for (let k = 0; k < tk[0]; k++) {
    const end = Math.min(text.length, tk[1 + 2 * k]!);
    if (end > off) {
      const st = src.style(tk[2 + 2 * k]!);
      out.push(st ? { text: text.slice(off, end), fg: st.fg, ...(st.fs ? { fs: st.fs } : {}) } : { text: text.slice(off, end) });
    }
    off = end;
  }
  if (off < text.length) out.push({ text: text.slice(off) });
  return out;
}

const withClass = (c: Cls) => (r: Run): Run => ({ ...r, c: [...(r.c ?? []), c] });

/** A side's code as display lines of `w` cells: its runs in the row's colour, wrapped or cut. */
function codeLines(runs: Run[], w: number, o: PaintOpts, fill: Cls | null, rowsHigh: number): Span[][] {
  const coloured = fill ? runs.map((r) => ({ ...r, c: [fill, ...(r.c ?? [])] })) : runs;
  const expanded = expandRuns(coloured);
  let lines: Span[][];
  if (o.wrap) lines = wrapRuns(expanded, w, o.cap);
  else {
    const cut = clipRuns(expanded, o.hoff, w);
    lines = [cut.more ? [...clipRuns(cut.runs, 0, w - 1).runs, s("›", ...((fill ? [fill, "ln"] : ["ln"]) as Cls[]))] : cut.runs];
  }
  while (lines.length < rowsHigh) lines.push([]);
  return lines.map((l) => pad(l, w, fill));
}

function pad(spans: Span[], w: number, fill: Cls | null): Span[] {
  let used = 0;
  for (const x of spans) used += Bun.stringWidth(x.text);
  return used < w ? [...spans, fill ? s(" ".repeat(w - used), fill) : s(" ".repeat(w - used))] : spans;
}

const num = (n: number, w: number) => (n > 0 ? String(n).padStart(w) : " ".repeat(w));

function marked(m: LineMarks["old"], n: number): "strong" | "mark" | null {
  let hit: "strong" | "mark" | null = null;
  for (const x of m) if (n >= x.start && n <= x.end) hit = x.strong ? "strong" : (hit ?? "mark");
  return hit;
}

export class Painter {
  private readonly words = new Map<string, { old: Ranges; new: Ranges } | null>();

  constructor(private readonly tokens: TokenSource) {}

  private runs(fd: FileDiffMetadata, side: 0 | 1, i: number, words: Ranges | null): Run[] {
    const text = lineText(fd, side, i);
    const runs = tokenRuns(text, this.tokens.line(fd, side, i), this.tokens);
    return words?.length ? markRuns(runs, words, withClass(side === 0 ? "delw" : "addw")) : runs;
  }

  /** The changed words of a removed line and the added line it is paired with. */
  wordsOf(fd: FileDiffMetadata, o: number, n: number): { old: Ranges; new: Ranges } | null {
    const key = `${fd.cacheKey ?? fd.name}:${o}:${n}`;
    let hit = this.words.get(key);
    if (hit === undefined) {
      hit = wordMarks(lineText(fd, 0, o), lineText(fd, 1, n));
      if (this.words.size > 5000) this.words.clear();
      this.words.set(key, hit);
    }
    return hit;
  }

  /**
   * Row `r` as `height` screen lines. `pair` is the line a removed or added row's words are compared with in unified
   * (-1 for none); `at` marks the cursor's row; `focus` whether the diff has the focus.
   */
  row(rows: Rows, r: number, item: FileItem | GroupItem, o: PaintOpts, h: { hooks: Hooks; marks: LineMarks; pair: number; at: boolean; focus: boolean; open: boolean; height: number }): Line[] {
    const k = rows.kind[r]!;
    const w = o.width;
    const cur: Cls = h.focus ? "sel" : "seli";
    if (k === GROUP) return [h.hooks.group(item as GroupItem, w, h.at)];
    const f = item as FileItem;
    if (k === FILE) return [h.hooks.header(f, w, h.at)];
    if (k === NOTE) return [h.hooks.note(f, w, h.at)];
    const gutter = o.split ? o.num + 1 : o.num * 2 + 1;
    if (k === GAP) {
      const n = rows.n[r]!;
      const text = `${" ".repeat(Math.max(0, o.split ? o.num - 1 : o.num * 2 - 1))}⋯ ${n} unchanged line${n === 1 ? "" : "s"}`;
      const more = h.at ? "  Enter shows them" : "";
      return [{ spans: [s(text, "ln"), ...(more ? [s(more, "dim")] : [])], fill: h.at ? [cur] : ["hunk" as Cls] }];
    }
    if (k !== CTX && k !== DEL && k !== ADD && k !== PAIR) {
      const p = f.placed?.[rows.x[r]!];
      return p ? h.hooks.card(f, p, w, h.open, gutter + 2, h.at) : [line()];
    }
    const fd = f.fd;
    if (!o.split) {
      const side: 0 | 1 = k === DEL ? 0 : 1;
      const idx = k === DEL ? rows.a[r]! : rows.b[r]!;
      const fill: Cls | null = k === DEL ? "del" : k === ADD ? "add" : null;
      let words: Ranges | null = null;
      if (h.pair >= 0) {
        const wm = k === DEL ? this.wordsOf(fd, idx, h.pair) : this.wordsOf(fd, h.pair, idx);
        words = wm ? (k === DEL ? wm.old : wm.new) : null;
      }
      const cw = Math.max(1, w - gutter - 2);
      const code = codeLines(this.runs(fd, side, idx, words), cw, o, fill, h.height);
      const sign = k === DEL ? "-" : k === ADD ? "+" : " ";
      const markOld = k !== ADD ? marked(h.marks.old, rows.oldNo[r]!) : null;
      const markNew = k !== DEL ? marked(h.marks.new, rows.newNo[r]!) : null;
      const mark = markNew ?? markOld;
      const field = `${num(rows.oldNo[r]!, o.num)}${num(rows.newNo[r]!, o.num)}`;
      const g: Cls[] = h.at ? [cur, "ln"] : ["ln"];
      return code.map((c, y) => {
        const head: Span[] =
          y === 0
            ? mark
              ? [s("▌", ...(h.at ? [cur] : []), mark === "strong" ? "acc" : "mk"), s(field.slice(1), ...g)]
              : [s(field, ...g)]
            : [s(" ".repeat(field.length), ...g)];
        const signSpan = s(y === 0 ? ` ${sign} ` : "   ", ...(fill ? [fill] : []), ...(k === DEL ? (["delc"] as Cls[]) : k === ADD ? (["addc"] as Cls[]) : []));
        return { spans: [...head, signSpan, ...c] };
      });
    }
    // split: the old line on the left, the new one on the right
    const left = Math.floor((w - 1) / 2);
    const right = w - 1 - left;
    const ctx = rows.n[r]! === 0;
    const a = rows.a[r]!;
    const b = rows.b[r]!;
    const wm = !ctx && a >= 0 && b >= 0 ? this.wordsOf(fd, a, b) : null;
    const half = (side: 0 | 1, idx: number, no: number, width: number): Span[][] => {
      const cw = Math.max(1, width - o.num - 3);
      const g: Cls[] = h.at ? [cur, "ln"] : ["ln"];
      if (idx < 0) return Array.from({ length: h.height }, () => [s(" ".repeat(width), "void")]);
      const fill: Cls | null = ctx ? null : side === 0 ? "del" : "add";
      const code = codeLines(this.runs(fd, side, idx, wm ? (side === 0 ? wm.old : wm.new) : null), cw, o, fill, h.height);
      const mark = marked(side === 0 ? h.marks.old : h.marks.new, no);
      const sign = ctx ? " " : side === 0 ? "-" : "+";
      return code.map((c, y) => {
        const field = y === 0 ? num(no, o.num) : " ".repeat(o.num);
        const head = y === 0 && mark ? [s("▌", ...(h.at ? [cur] : []), mark === "strong" ? "acc" : "mk"), s(field.slice(1), ...g)] : [s(field, ...g)];
        return [...head, s(y === 0 ? ` ${sign} ` : "   ", ...(fill ? [fill] : []), ...(fill === "del" ? (["delc"] as Cls[]) : fill === "add" ? (["addc"] as Cls[]) : [])), ...c];
      });
    };
    const l = half(0, a, rows.oldNo[r]!, left);
    const rt = half(1, b, rows.newNo[r]!, right);
    return l.map((x, y) => ({ spans: [...x, s("│", "bd"), ...rt[y]!] }));
  }
}
