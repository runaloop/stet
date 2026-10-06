import type { Span } from "./cursor.ts";
import { CHUNK } from "./reveal.ts";

/** The source lines of a rendered block (`data-start`, `data-end`), or null for what is not a block of the source. */
export function linesOf(el: Element): Span | null {
  const s = el.getAttribute("data-start");
  const e = el.getAttribute("data-end");
  return s === null || e === null ? null : { start: Number(s), end: Number(e) };
}

export const meets = (r: Span, spans: readonly Span[]) => spans.some((x) => r.start <= x.end && x.start <= r.end);
const within = (r: Span, spans: readonly Span[]) => spans.some((x) => x.start <= r.start && r.end <= x.end);

const IDS = ["data-b", "data-start", "data-end", "data-pair", "data-stop"];
function strip<T extends Element>(el: T): T {
  for (const x of [el, ...el.querySelectorAll("*")]) for (const a of IDS) x.removeAttribute(a);
  return el;
}

const isList = (el: Element) => el.tagName === "UL" || el.tagName === "OL";
const isContainer = (el: Element) => isList(el) || el.tagName === "TABLE" || el.tagName === "BLOCKQUOTE";

function unitsOf(container: ParentNode & Element): Element[] {
  if (container.tagName === "TABLE") return [...container.querySelectorAll(":scope > tbody > tr")];
  if (isList(container)) return [...container.children].filter((c) => c.tagName === "LI");
  return [...container.children];
}

/** The lists, tables and quotes right inside an element, not inside another one of them. */
function innerContainers(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (n: Element) => {
    for (const c of n.children) {
      if (isContainer(c)) out.push(c);
      else walk(c);
    }
  };
  walk(el);
  return out;
}

export type MakeBar = (hidden: Span[]) => Element;

/**
 * Folds what `root` shows to the blocks on lines of `spans`: each run of blocks off them becomes a bar. A list or a
 * table partly on them is folded inside, item by item or row by row: the list goes on below the bar with its next
 * number, the table with its header again. `root` is a container itself (the top of a rendered cell).
 */
export function foldInside(root: ParentNode, spans: readonly Span[], bar: MakeBar): void {
  foldUnits(root, rootUnits(root), spans, bar);
}

function rootUnits(root: ParentNode): Element[] {
  return root instanceof Element && isContainer(root) ? unitsOf(root) : [...root.children];
}

function foldUnits(container: ParentNode, units: Element[], spans: readonly Span[], bar: MakeBar): void {
  const hide = units.map((u) => {
    const r = linesOf(u);
    return !!r && !meets(r, spans);
  });
  units.forEach((u, i) => {
    if (hide[i]) return;
    const r = linesOf(u);
    if (r && within(r, spans)) return;
    for (const c of isContainer(u) ? [u] : innerContainers(u)) foldUnits(c, unitsOf(c), spans, bar);
  });
  if (!hide.some(Boolean)) return;
  const runs: { hidden: boolean; units: Element[] }[] = [];
  units.forEach((u, i) => {
    const last = runs[runs.length - 1];
    if (last && last.hidden === hide[i]) last.units.push(u);
    else runs.push({ hidden: hide[i]!, units: [u] });
  });
  const spansOf = (us: Element[]) => us.flatMap((u) => linesOf(u) ?? []);
  if (!(container instanceof Element) || !(isList(container) || container.tagName === "TABLE")) {
    for (const run of runs) {
      if (!run.hidden) continue;
      run.units[0]!.before(bar(spansOf(run.units)));
      for (const u of run.units) u.remove();
    }
    return;
  }
  // a list or a table: one part for each run shown, a bar between them
  const doc = container.ownerDocument;
  const parts: Node[] = [];
  let first = true;
  let counted = 0;
  const start = Number(container.getAttribute("start") ?? 1);
  for (const run of runs) {
    if (run.hidden) {
      parts.push(bar(spansOf(run.units)));
      for (const u of run.units) u.remove();
    } else if (first) {
      if (container.tagName === "OL" && counted) container.setAttribute("start", String(start + counted));
      parts.push(container);
      first = false;
    } else {
      const part = strip(container.cloneNode(false) as Element);
      part.classList.add("md-more");
      if (container.tagName === "TABLE") {
        const head = container.querySelector(":scope > thead");
        if (head) {
          const again = strip(head.cloneNode(true) as Element);
          again.classList.add("md-again");
          part.append(again);
        }
        const body = doc.createElement("tbody");
        body.append(...run.units);
        part.append(body);
      } else {
        part.append(...run.units);
        if (container.tagName === "OL") part.setAttribute("start", String(start + counted));
      }
      parts.push(part);
    }
    if (isList(container)) counted += run.units.filter((u) => !u.matches(".md-gap, .md-removed")).length;
  }
  const anchor = doc.createComment("");
  container.before(anchor);
  anchor.replaceWith(...parts);
  if (first) container.remove();
}

/**
 * The lines shown with the gaps between them no longer than `small` filled in, as the code shows a gap of one line
 * rather than a bar for it; `count` is the number of lines of the file.
 */
export function closeGaps(spans: readonly Span[], count: number, small = 1): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].filter((x) => x.end >= x.start).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    const from = last ? last.end + 1 : 1;
    if (s.start - from <= small) {
      if (last) last.end = Math.max(last.end, s.end);
      else out.push({ start: 1, end: s.end });
    } else out.push({ ...s });
  }
  const last = out[out.length - 1];
  if (last && count - last.end <= small) last.end = Math.max(last.end, count);
  return out;
}

/**
 * The lines a bar stands for: the lines of its blocks and the blank lines around them that are not shown either, so
 * it counts what the code's bar over the same lines counts. `lines` is the text line by line.
 */
export function withBlanks(hidden: readonly Span[], lines: readonly string[], shown: readonly Span[]): Span[] {
  if (!hidden.length) return [];
  const out = hidden.map((s) => ({ ...s }));
  const count = lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const free = (n: number) => n >= 1 && n <= count && !lines[n - 1]!.trim() && !shown.some((s) => s.start <= n && n <= s.end);
  const first = out[0]!;
  const last = out[out.length - 1]!;
  while (free(first.start - 1)) first.start--;
  while (free(last.end + 1)) last.end++;
  return out;
}

/** The lines a bar opens: from its top or its bottom about `CHUNK` lines, in whole blocks; or all of them. */
export function opening(hidden: readonly Span[], how: "above" | "below" | "all"): Span | null {
  if (!hidden.length) return null;
  const all = { start: hidden[0]!.start, end: hidden[hidden.length - 1]!.end };
  if (how === "all") return all;
  const list = how === "above" ? hidden : [...hidden].reverse();
  const size = (k: number) => (how === "above" ? list[k]!.end - list[0]!.start : list[0]!.end - list[k]!.start) + 1;
  let k = 0;
  while (k < list.length - 1 && size(k) < CHUNK) k++;
  const a = list[0]!;
  const b = list[k]!;
  return how === "above" ? { start: a.start, end: b.end } : { start: b.start, end: a.end };
}
