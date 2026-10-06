import type { Side } from "./search.ts";

export interface LineMark {
  side: Side;
  start: number;
  end: number;
  tag: string;
  ranges?: [number, number][];
  current?: boolean;
  /** Shown over the line number of the mark's first line. */
  label?: string;
}

/** Where a thread is on the lines of a file. */
export interface ThreadLines {
  threadId: number;
  side: Side;
  range: { start: number; end: number };
}

/** The thread marked so that it cannot be mistaken for another at the same place; it flashes at first. */
export interface Spot {
  id: number;
  flash: boolean;
}

/**
 * The marks of the threads on one file's lines, the focused one's stronger. A thread in the spotlight is framed, with its
 * number on its first line, and the other threads of the file are dimmed.
 */
export function threadMarks(placed: readonly ThreadLines[], focus: number | null, spot: Spot | null): LineMark[] {
  const lit = !!spot && placed.some((p) => p.threadId === spot.id);
  return placed.flatMap((p): LineMark[] => {
    const at = { side: p.side, start: p.range.start, end: p.range.end };
    if (spot && p.threadId === spot.id) {
      return [
        { ...at, tag: "spot", label: `#${p.threadId}` },
        { ...at, end: at.start, tag: "spot-first" },
        { ...at, start: at.end, tag: "spot-last" },
        ...(spot.flash ? [{ ...at, tag: "flash" }] : []),
      ];
    }
    return [{ ...at, tag: lit ? "dim" : p.threadId === focus ? "focus" : "thread" }];
  });
}

const ATTR = "data-stet-mark";
const LABEL = "data-stet-label";
const HIT = "stet-hit";
const HIT_CURRENT = "stet-hit-current";

export const MARK_CSS = `
/* pierre's 1fr grows a column to its widest annotation, and a wrapped line lets the other column shrink to 1ch */
[data-diff][data-overflow="wrap"], [data-file][data-overflow="wrap"] { --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr); }
/* an image or rendered Markdown of the diff is a file item whose one empty line only carries the viewer */
:host([data-stet-viewer]) [data-line], :host([data-stet-viewer]) [data-column-number] { visibility: hidden; }
[data-content] > [${ATTR}~="thread"] { box-shadow: inset 0 0 0 100vmax light-dark(rgb(255 190 0 / 0.13), rgb(255 190 0 / 0.09)); }
[data-gutter] > [${ATTR}~="thread"] { box-shadow: inset 3px 0 0 light-dark(#e0a800, #b8900a), inset 0 0 0 100vmax light-dark(rgb(255 190 0 / 0.13), rgb(255 190 0 / 0.09)); }
[data-content] > [${ATTR}~="focus"] { box-shadow: inset 0 0 0 100vmax light-dark(rgb(255 170 0 / 0.26), rgb(255 170 0 / 0.2)); }
[data-gutter] > [${ATTR}~="focus"] { box-shadow: inset 4px 0 0 light-dark(#d08000, #e0a000), inset 0 0 0 100vmax light-dark(rgb(255 170 0 / 0.26), rgb(255 170 0 / 0.2)); }
[data-content] > [${ATTR}~="dim"] { box-shadow: inset 0 0 0 100vmax light-dark(rgb(140 140 140 / 0.07), rgb(160 160 160 / 0.06)); }
[data-gutter] > [${ATTR}~="dim"] { box-shadow: inset 3px 0 0 light-dark(rgb(140 140 140 / 0.45), rgb(160 160 160 / 0.35)); }
:is([data-content], [data-gutter]) > [${ATTR}~="spot"] { --spot-top: 0 0 0 transparent; --spot-bottom: 0 0 0 transparent; --spot-side: inset -2px 0 0 light-dark(#c8287a, #ff6eb4); box-shadow: var(--spot-top), var(--spot-bottom), var(--spot-side), inset 0 0 0 100vmax light-dark(rgb(200 40 122 / 0.12), rgb(255 110 180 / 0.14)); }
[data-gutter] > [${ATTR}~="spot"] { --spot-side: inset 4px 0 0 light-dark(#c8287a, #ff6eb4); }
:is([data-content], [data-gutter]) > [${ATTR}~="spot"][${ATTR}~="spot-first"] { --spot-top: inset 0 2px 0 light-dark(#c8287a, #ff6eb4); }
:is([data-content], [data-gutter]) > [${ATTR}~="spot"][${ATTR}~="spot-last"] { --spot-bottom: inset 0 -2px 0 light-dark(#c8287a, #ff6eb4); }
[data-gutter] > [${LABEL}]::after { content: attr(${LABEL}); position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: flex-end; padding-right: 1ch; border-radius: 4px 0 0 4px; background: light-dark(#c8287a, #ff6eb4); color: light-dark(#fff, #1a0d14); font-weight: 700; }
:is([data-content], [data-gutter]) > [${ATTR}~="flash"] { animation: stet-flash 0.45s ease-in-out 2 alternate; }
@keyframes stet-flash { to { background-color: light-dark(rgb(200 40 122 / 0.4), rgb(255 110 180 / 0.35)); } }
@media (prefers-reduced-motion: reduce) { :is([data-content], [data-gutter]) > [${ATTR}~="flash"] { animation: none; } }
[data-content] > [${ATTR}~="hit"] { background-image: linear-gradient(light-dark(rgb(60 140 255 / 0.1), rgb(90 160 255 / 0.12)), light-dark(rgb(60 140 255 / 0.1), rgb(90 160 255 / 0.12))); }
[data-content] > [${ATTR}~="hit-current"] { outline: 2px solid light-dark(#e07b00, #ffae40); outline-offset: -2px; }
[data-content] > [${ATTR}~="visual"] { background-image: linear-gradient(light-dark(rgb(47 111 221 / 0.16), rgb(110 162 255 / 0.2)), light-dark(rgb(47 111 221 / 0.16), rgb(110 162 255 / 0.2))); }
[data-content] > [${ATTR}~="linked"] { background-image: linear-gradient(light-dark(rgb(130 80 220 / 0.17), rgb(170 130 255 / 0.2)), light-dark(rgb(130 80 220 / 0.17), rgb(170 130 255 / 0.2))); }
[data-gutter] > [${ATTR}~="linked"] { box-shadow: inset 3px 0 0 light-dark(#8250df, #a78bfa), inset 0 0 0 100vmax light-dark(rgb(130 80 220 / 0.17), rgb(170 130 255 / 0.2)); }
[data-content] > [${ATTR}~="cursor"] { outline: 1px solid light-dark(#2f6fdd, #6ea2ff); outline-offset: -1px; }
[data-gutter] > [${ATTR}~="cursor"] { box-shadow: inset 3px 0 0 light-dark(#2f6fdd, #6ea2ff); }
::highlight(${HIT}) { background-color: light-dark(rgb(255 214 0 / 0.6), rgb(255 200 0 / 0.4)); }
::highlight(${HIT_CURRENT}) { background-color: #ffb000; color: #000; }
`;

type Column = Side | "unified";

function sidesOf(col: Column, row: Element): [Side, number][] {
  const n = Number(row.getAttribute("data-line"));
  if (col !== "unified") return [[col, n]];
  const type = row.getAttribute("data-line-type");
  if (type === "change-deletion") return [["deletions", n]];
  if (type === "change-addition") return [["additions", n]];
  const alt = row.getAttribute("data-alt-line");
  return alt ? [["additions", n], ["deletions", Number(alt)]] : [["additions", n]];
}

interface HighlightLike {
  add(r: Range): void;
  delete(r: Range): boolean;
}

function highlight(name: string): HighlightLike | null {
  const g = globalThis as unknown as { CSS?: { highlights?: Map<string, HighlightLike> }; Highlight?: new () => HighlightLike };
  const registry = g.CSS?.highlights;
  if (!registry || !g.Highlight) return null;
  let h = registry.get(name);
  if (!h) {
    h = new g.Highlight();
    registry.set(name, h);
  }
  return h;
}

const painted = new WeakMap<Element, { range: Range; current: boolean }[]>();

function textRange(row: Element, from: number, to: number): Range | null {
  const walker = row.ownerDocument.createTreeWalker(row, 4);
  let pos = 0;
  let start: [Node, number] | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.nodeValue?.length ?? 0;
    if (!start && from < pos + len) start = [node, from - pos];
    if (start && to <= pos + len) {
      const r = row.ownerDocument.createRange();
      r.setStart(start[0], start[1]);
      r.setEnd(node, to - pos);
      return r;
    }
    pos += len;
  }
  return null;
}

export function paintMarks(container: Element, marks: readonly LineMark[]): void {
  const root: ParentNode = (container as HTMLElement).shadowRoot ?? container;
  for (const el of root.querySelectorAll(`[${ATTR}], [${LABEL}]`)) {
    el.removeAttribute(ATTR);
    el.removeAttribute(LABEL);
  }
  const old = painted.get(container);
  if (old) {
    for (const p of old) highlight(p.current ? HIT_CURRENT : HIT)?.delete(p.range);
    painted.delete(container);
  }
  if (marks.length === 0) return;

  const byLine = new Map<string, LineMark[]>();
  for (const m of marks) {
    for (let n = m.start; n <= Math.min(m.end, m.start + 5000); n++) {
      const key = `${m.side}:${n}`;
      const list = byLine.get(key);
      if (list) list.push(m);
      else byLine.set(key, [m]);
    }
  }

  const ranges: { range: Range; current: boolean }[] = [];
  for (const code of root.querySelectorAll("code[data-code]")) {
    const col: Column = code.hasAttribute("data-deletions") ? "deletions" : code.hasAttribute("data-additions") ? "additions" : "unified";
    const gutter = code.querySelector(":scope > [data-gutter]");
    const content = code.querySelector(":scope > [data-content]");
    if (!gutter || !content) continue;
    const rows = content.children;
    const nums = gutter.children;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (!row.hasAttribute("data-line")) continue;
      const tags = new Set<string>();
      let textMarked = false;
      for (const [side, n] of sidesOf(col, row)) {
        for (const m of byLine.get(`${side}:${n}`) ?? []) {
          tags.add(m.tag);
          if (m.label && n === m.start) nums[i]?.setAttribute(LABEL, m.label);
          if (m.current) tags.add(`${m.tag}-current`);
          if (m.ranges && !textMarked) {
            textMarked = true;
            for (const [from, to] of m.ranges) {
              const r = textRange(row, from, to);
              if (r) ranges.push({ range: r, current: !!m.current });
            }
          }
        }
      }
      if (tags.size === 0) continue;
      const value = [...tags].join(" ");
      row.setAttribute(ATTR, value);
      nums[i]?.setAttribute(ATTR, value);
    }
  }
  for (const p of ranges) highlight(p.current ? HIT_CURRENT : HIT)?.add(p.range);
  if (ranges.length) painted.set(container, ranges);
}

/** Paints search hits in text outside the code (rendered Markdown), in place of what was painted for `owner` before. */
export function paintTextHits(owner: Element, ranges: { range: Range; current: boolean }[]): void {
  for (const p of painted.get(owner) ?? []) highlight(p.current ? HIT_CURRENT : HIT)?.delete(p.range);
  painted.delete(owner);
  for (const p of ranges) highlight(p.current ? HIT_CURRENT : HIT)?.add(p.range);
  if (ranges.length) painted.set(owner, ranges);
}

/** The drawn lines of a file of the diff, each with the side and number it shows (a context line in unified view, both). */
export function drawnLines(container: Element): { el: Element; at: [Side, number][] }[] {
  const root: ParentNode = (container as HTMLElement).shadowRoot ?? container;
  const out: { el: Element; at: [Side, number][] }[] = [];
  for (const code of root.querySelectorAll("code[data-code]")) {
    const col: Column = code.hasAttribute("data-deletions") ? "deletions" : code.hasAttribute("data-additions") ? "additions" : "unified";
    for (const row of code.querySelector(":scope > [data-content]")?.children ?? []) if (row.hasAttribute("data-line")) out.push({ el: row, at: sidesOf(col, row) });
  }
  return out;
}
