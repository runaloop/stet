import type { CodeView } from "@pierre/diffs";
import { drawnLines } from "../lib/marks.ts";
import type { Side } from "../lib/search.ts";

/** The sticky file header covers this much of the top of the code view. */
const HEADER = 48;

let release: (() => void) | null = null;

/**
 * Puts a rendered block `y` px below the top of the scroller: once as soon as it is drawn, and once more when the
 * pictures above it have loaded (they push it down), within `ms` and unless the reader scrolls, clicks or types first.
 * Between the two pierre keeps the place itself; a correction on every frame would fight its own and shake the page.
 */
export function placeAt(scroller: HTMLElement, find: () => Element | null, y: number, ms = 1500): void {
  release?.();
  let done = false;
  const events = ["wheel", "pointerdown", "keydown"] as const;
  const stop = () => {
    done = true;
    for (const ev of events) window.removeEventListener(ev, stop, { capture: true });
    if (release === stop) release = null;
  };
  release = stop;
  for (const ev of events) window.addEventListener(ev, stop, { capture: true, passive: true });
  const end = performance.now() + ms;
  const fix = (el: Element) => {
    const off = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - y;
    if (Math.abs(off) >= 1) scroller.scrollTop += off;
  };
  const above = (el: Element) => [...(el.closest(".md-view")?.querySelectorAll("img") ?? [])].filter((img) => img.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  let placed = false;
  let last = NaN;
  let still = 0;
  const tick = () => {
    if (done) return;
    const el = find();
    const late = performance.now() > end;
    if (el && !placed) {
      fix(el);
      placed = true;
    } else if (el) {
      const top = el.getBoundingClientRect().top;
      still = top === last ? still + 1 : 0;
      last = top;
      // the second time only once the layout around it is quiet: pictures loaded, nothing moved for a few frames
      if (late || (still >= 4 && above(el).every((img) => img.complete))) {
        fix(el);
        return stop();
      }
    }
    if (late) return stop();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Puts a line of the code `y` px below the top: pierre's own line target keeps it there while it lays the rows out,
 * and once the line has stood still for a few frames one last nudge takes up what pierre's sum leaves over.
 */
export function lineAt(scroller: HTMLElement, view: CodeView<never>, path: string, side: Side, line: number, y: number, ms = 1500): void {
  release?.();
  const sticky = (view as unknown as { getStickyHeaderOffset?: () => number }).getStickyHeaderOffset?.() ?? 0;
  view.scrollTo({ type: "line", id: path, lineNumber: line, side, align: "start", offset: y - sticky });
  let done = false;
  const events = ["wheel", "pointerdown", "keydown"] as const;
  const stop = () => {
    done = true;
    for (const ev of events) window.removeEventListener(ev, stop, { capture: true });
    if (release === stop) release = null;
  };
  release = stop;
  for (const ev of events) window.addEventListener(ev, stop, { capture: true, passive: true });
  const end = performance.now() + ms;
  let last = NaN;
  let still = 0;
  const tick = () => {
    if (done) return;
    const el = rowElement(view, path, side, line);
    const top = el ? el.getBoundingClientRect().top - scroller.getBoundingClientRect().top : NaN;
    still = top === last ? still + 1 : 0;
    last = top;
    if (el && still >= 6) {
      if (Math.abs(top - y) >= 1) scroller.scrollTop += top - y;
      return stop();
    }
    if (performance.now() > end) return stop();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const mdView = (path: string) => document.querySelector<HTMLElement>(`.md-view[data-file="${CSS.escape(path)}"]`);

/** The element of a rendered block, by its place among the file's blocks: the old twin of an unchanged block for the old side. */
export function stopElement(path: string, stop: number, side: Side = "additions"): HTMLElement | null {
  const all = [...(mdView(path)?.querySelectorAll<HTMLElement>(`[data-stop="${stop}"]`) ?? [])];
  const old = all.find((el) => el.closest<HTMLElement>(".md-cell")?.dataset.side === "old");
  return (side === "deletions" ? old : all.find((el) => el !== old)) ?? all[0] ?? null;
}

function visibleBand(scroller: HTMLElement): { top: number; bottom: number } {
  const r = scroller.getBoundingClientRect();
  return { top: r.top + HEADER, bottom: r.bottom };
}

/** The topmost of `els` in view: the first whose bottom is below the file header, if its top is above the bottom. */
function topmost<T extends Element>(scroller: HTMLElement, els: Iterable<T>): T | null {
  const band = visibleBand(scroller);
  let best: T | null = null;
  let bestTop = Infinity;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.bottom <= band.top || r.top >= band.bottom) continue;
    if (r.top < bestTop) {
      best = el;
      bestTop = r.top;
    }
  }
  return best;
}

const inView = (scroller: HTMLElement, el: Element) => {
  const band = visibleBand(scroller);
  const r = el.getBoundingClientRect();
  return r.bottom > band.top && r.top < band.bottom;
};

const offsetOf = (scroller: HTMLElement, el: Element) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

/** Where a rendered file is on screen: the given block if it is in view, else the topmost block in view. */
export function renderedAnchor(scroller: HTMLElement, path: string, prefer: number | null): { stop: number; side: "old" | "new"; y: number } | null {
  const view = mdView(path);
  if (!view) return null;
  const preferred = prefer === null ? [] : [...view.querySelectorAll<HTMLElement>(`[data-stop="${prefer}"]`)].filter((el) => inView(scroller, el));
  const el = preferred[0] ?? topmost(scroller, view.querySelectorAll<HTMLElement>("[data-stop]"));
  if (!el) return null;
  return { stop: Number(el.dataset.stop), side: el.closest<HTMLElement>(".md-cell")?.dataset.side === "old" ? "old" : "new", y: offsetOf(scroller, el) };
}

function itemElement(view: CodeView<never>, path: string): HTMLElement | null {
  return view.getRenderedItems().find((r) => r.id === path)?.element ?? null;
}

/** The drawn row of a line of the diff, on its side. */
export function rowElement(view: CodeView<never>, path: string, side: Side, line: number): Element | null {
  const item = itemElement(view, path);
  if (!item) return null;
  return drawnLines(item).find((r) => r.at.some(([s, n]) => s === side && n === line))?.el ?? null;
}

/** Where a file drawn as code is on screen: the given line if it is in view, else the topmost line in view. */
export function codeAnchor(scroller: HTMLElement, view: CodeView<never>, path: string, prefer: { side: Side; line: number } | null): { side: Side; line: number; y: number } | null {
  const item = itemElement(view, path);
  if (!item) return null;
  const rows = drawnLines(item);
  const wanted = prefer ? rows.find((r) => r.at.some(([s, n]) => s === prefer.side && n === prefer.line)) : undefined;
  const top = wanted && inView(scroller, wanted.el) ? wanted.el : topmost(scroller, rows.map((x) => x.el));
  const row = rows.find((r) => r.el === top);
  if (!row) return null;
  const [side, line] = (wanted === row && prefer ? [prefer.side, prefer.line] : (row.at.find(([s]) => s === "additions") ?? row.at[0]!)) as [Side, number];
  return { side, line, y: offsetOf(scroller, row.el) };
}
