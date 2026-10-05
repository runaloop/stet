import type { Side } from "./search.ts";

export interface LineMark {
  side: Side;
  start: number;
  end: number;
  tag: string;
  ranges?: [number, number][];
  current?: boolean;
}

const ATTR = "data-stet-mark";
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
[data-content] > [${ATTR}~="hit"] { background-image: linear-gradient(light-dark(rgb(60 140 255 / 0.1), rgb(90 160 255 / 0.12)), light-dark(rgb(60 140 255 / 0.1), rgb(90 160 255 / 0.12))); }
[data-content] > [${ATTR}~="hit-current"] { outline: 2px solid light-dark(#e07b00, #ffae40); outline-offset: -2px; }
[data-content] > [${ATTR}~="visual"] { background-image: linear-gradient(light-dark(rgb(47 111 221 / 0.16), rgb(110 162 255 / 0.2)), light-dark(rgb(47 111 221 / 0.16), rgb(110 162 255 / 0.2))); }
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
  for (const el of root.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);
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
