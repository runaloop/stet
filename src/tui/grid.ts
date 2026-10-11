/** Screen rows built from bordered panes put side by side, with boxes laid over them. A row is exactly as wide as the screen. */
import { clip, fit, s, spansWidth, width, type Cls, type Line, type Span } from "./text.ts";

export type Row = Span[];

export interface Pane {
  w: number;
  title?: Span[];
  /** On the right of the top border: "1 of 5", "preview", the keys of a box. */
  right?: Span[];
  /** In the bottom border, after its corner. */
  bottom?: Span[];
  /** The lines in sight, from the top of the pane's inside. */
  lines: Line[];
  focus?: boolean;
  /** Border colour in place of the focus one. */
  border?: Cls;
  /** What a click inside the pane does where its rows say nothing else. */
  hit?: string;
}

const plainOf = (spans: Span[], c: Cls): Span[] => spans.map((x) => (x.c?.length ? x : { text: x.text, c: [c] }));

/** The pane `h` rows high, its border included. */
export function pane(p: Pane, h: number): Row[] {
  const b: Cls = p.border ?? (p.focus ? "bf" : "bd");
  const inner = Math.max(0, p.w - 2);
  const right = p.right?.length ? [s(" "), ...p.right, s(" ")] : [];
  const rw = spansWidth(right);
  const title = p.title?.length ? clip([s(" "), ...plainOf(p.title, p.focus ? "bft" : "bdt"), s(" ")], Math.max(0, p.w - 4 - rw - 1)) : [];
  const fill = Math.max(0, p.w - 4 - spansWidth(title) - rw);
  const top = fit({ spans: [s("╭─", b), ...title, s("─".repeat(fill), b), ...right, s("─╮", b)] }, p.w);
  const rows: Row[] = [top];
  for (let i = 0; i < h - 2; i++) rows.push([s("│", b), ...fit(p.lines[i] ?? { spans: [] }, inner), s("│", b)]);
  if (h >= 2) {
    const bottom = p.bottom?.length ? clip([s(" "), ...p.bottom, s(" ")], Math.max(0, p.w - 4)) : [];
    rows.push(fit({ spans: [s("╰─", b), ...bottom, s("─".repeat(Math.max(0, p.w - 3 - spansWidth(bottom))), b), s("╯", b)] }, p.w));
  }
  const out = rows.slice(0, h);
  return p.hit ? out.map((r) => r.map((x) => (x.hit ? x : { ...x, hit: p.hit }))) : out;
}

export function hcat(cols: Row[][]): Row[] {
  const h = Math.max(0, ...cols.map((c) => c.length));
  const out: Row[] = [];
  for (let i = 0; i < h; i++) out.push(cols.flatMap((c) => c[i] ?? []));
  return out;
}

interface Cell {
  ch: string;
  c?: Cls[];
  hit?: string;
  /** 0 for the right half of a wide character. */
  w: number;
}

function cells(row: Row): Cell[] {
  const out: Cell[] = [];
  for (const x of row) {
    for (const ch of x.text) {
      const cw = width(ch);
      if (cw === 0) continue;
      out.push({ ch, c: x.c, hit: x.hit, w: cw });
      if (cw === 2) out.push({ ch: "", c: x.c, hit: x.hit, w: 0 });
    }
  }
  return out;
}

function spansOf(list: Cell[]): Row {
  const out: Row = [];
  for (const cell of list) {
    const last = out[out.length - 1];
    const key = cell.c?.join(" ") ?? "";
    if (last && (last.c?.join(" ") ?? "") === key && last.hit === cell.hit) last.text += cell.ch;
    else out.push({ text: cell.ch, ...(cell.c ? { c: cell.c } : {}), ...(cell.hit ? { hit: cell.hit } : {}) });
  }
  return out;
}

/** `box` drawn over `base` from row `top`, column `left`; a wide character cut in two becomes a space. */
export function overlay(base: Row[], box: Row[], top: number, left: number): Row[] {
  const out = [...base];
  box.forEach((row, i) => {
    const y = top + i;
    if (y < 0 || y >= out.length) return;
    const under = cells(out[y]!);
    const over = cells(row);
    const end = Math.min(under.length, left + over.length);
    if (left > 0 && under[left]?.w === 0) under[left - 1] = { ...under[left - 1]!, ch: " ", w: 1 };
    if (under[end]?.w === 0) under[end] = { ...under[end]!, ch: " ", w: 1 };
    under.splice(left, end - left, ...over.slice(0, end - left));
    out[y] = spansOf(under);
  });
  return out;
}

export function rowText(row: Row): string {
  return row.map((x) => x.text).join("");
}

/** A line of the screen outside the panes: the header, the banner, the footer. */
export function bar(l: Line, w: number): Row {
  return fit(l, w);
}

export interface Hit {
  y: number;
  x0: number;
  x1: number;
  hit: string;
}

/** Where on the screen each clickable span is. */
export function hitsOf(rows: Row[]): Hit[] {
  const out: Hit[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    for (const span of row) {
      const w = width(span.text);
      if (span.hit) out.push({ y, x0: x, x1: x + w, hit: span.hit });
      x += w;
    }
  });
  return out;
}

export function hitAt(hits: Hit[], x: number, y: number): string | null {
  for (const h of hits) if (h.y === y && x >= h.x0 && x < h.x1) return h.hit;
  return null;
}
