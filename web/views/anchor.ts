import type { CodeView } from "@pierre/diffs";
import { drawnLines } from "../lib/marks.ts";
import type { Side } from "../lib/search.ts";

/** The sticky file header covers this much of the top of the code view. */
const HEADER = 48;

let release: (() => void) | null = null;

/**
 * Keeps an element at `y` px below the top of the scroller while it is laid out (pictures load, code is highlighted,
 * pierre measures rows), until the reader scrolls, clicks or types. The element may appear later.
 */
export function holdAt(scroller: HTMLElement, find: () => Element | null, y: number, ms = 1500): void {
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
  const tick = () => {
    if (done) return;
    if (performance.now() > end) return stop();
    const el = find();
    if (el) {
      const off = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - y;
      if (Math.abs(off) >= 1) scroller.scrollTop += off;
    }
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
