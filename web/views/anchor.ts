import type { CodeView } from "@pierre/diffs";
import type { CursorSpace, Seen } from "../lib/cursor.ts";
import { holdFade } from "../lib/fade.ts";
import { drawnLines } from "../lib/marks.ts";
import type { Side } from "../lib/search.ts";

/** The sticky file header covers this much of the top of the code view. */
const HEADER = 48;

let release: (() => void) | null = null;

const once = (fn?: () => void) => {
  let done = !fn;
  return () => {
    if (done) return;
    done = true;
    fn!();
  };
};

/** `placed`, after letting go of a copy of the old view that waits for this placement. */
const heldUntil = (placed?: () => void) => {
  const free = holdFade();
  return () => {
    free();
    placed?.();
  };
};

/**
 * Puts a rendered block where `want` says (px from the top of the scroller, given the block, as its height may count):
 * once as soon as it is drawn, and once more when the pictures above it have loaded (they push it down), within `ms`
 * and unless the reader scrolls, clicks or types first. Between the two pierre keeps the place itself; a correction on
 * every frame would fight its own and shake the page.
 */
export function placeAt(scroller: HTMLElement, find: () => Element | null, want: number | ((el: Element) => number), ms = 1500, placed?: () => void): void {
  const tell = once(heldUntil(placed));
  release?.();
  let done = false;
  const events = ["wheel", "pointerdown", "keydown"] as const;
  const stop = () => {
    tell();
    done = true;
    for (const ev of events) window.removeEventListener(ev, stop, { capture: true });
    if (release === stop) release = null;
  };
  release = stop;
  for (const ev of events) window.addEventListener(ev, stop, { capture: true, passive: true });
  const end = performance.now() + ms;
  const fix = (el: Element) => {
    const y = typeof want === "number" ? want : want(el);
    const off = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - y;
    if (Math.abs(off) >= 1) scroller.scrollTop += off;
  };
  const above = (el: Element) => [...(el.closest(".md-view")?.querySelectorAll("img") ?? [])].filter((img) => img.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  let first = false;
  let last = NaN;
  let still = 0;
  const tick = () => {
    if (done) return;
    const el = find();
    const late = performance.now() > end;
    if (el && !first) {
      fix(el);
      first = true;
      tell();
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
export function lineAt(scroller: HTMLElement, view: CodeView<never>, path: string, side: Side, line: number, y: number, ms = 1500, placed?: () => void): void {
  const tell = once(heldUntil(placed));
  release?.();
  const sticky = (view as unknown as { getStickyHeaderOffset?: () => number }).getStickyHeaderOffset?.() ?? 0;
  view.scrollTo({ type: "line", id: path, lineNumber: line, side, align: "start", offset: y - sticky });
  let done = false;
  const events = ["wheel", "pointerdown", "keydown"] as const;
  const stop = () => {
    tell();
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
    if (el && Math.abs(top - y) <= 2) tell();
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

/** The topmost of `els` in view: the one whose top is highest among those reaching below the file header; on a tie the first that `prefer` likes. */
function topmost<T extends Element>(scroller: HTMLElement, els: Iterable<T>, prefer: (el: T) => boolean = () => false): T | null {
  const band = visibleBand(scroller);
  let best: T | null = null;
  let bestTop = Infinity;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.bottom <= band.top || r.top >= band.bottom) continue;
    if (r.top < bestTop - 0.5 || (Math.abs(r.top - bestTop) <= 0.5 && best && !prefer(best) && prefer(el))) {
      best = el;
      bestTop = r.top;
    }
  }
  return best;
}

/** Whether an element is in the part of the view the reader sees, under the file header. */
export const onScreen = (scroller: HTMLElement, el: Element | null): boolean => {
  if (!el) return false;
  const band = visibleBand(scroller);
  const r = el.getBoundingClientRect();
  return r.height > 0 && r.bottom > band.top && r.top < band.bottom;
};

const offsetOf = (scroller: HTMLElement, el: Element) => el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

/**
 * The first text the reader sees in a rendered file: the topmost block under the file header, where it is (px from
 * the top of the scroller), how tall, and how much of it is scrolled past the header (0 to 1).
 */
export function renderedTop(scroller: HTMLElement, path: string): { stop: number; side: "old" | "new"; y: number; height: number; past: number } | null {
  const view = mdView(path);
  if (!view) return null;
  const isNew = (el: HTMLElement) => el.closest<HTMLElement>(".md-cell")?.dataset.side !== "old";
  const el = topmost(scroller, view.querySelectorAll<HTMLElement>("[data-stop]"), isNew);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const past = Math.min(1, Math.max(0, (visibleBand(scroller).top - r.top) / r.height));
  return { stop: Number(el.dataset.stop), side: isNew(el) ? "new" : "old", y: offsetOf(scroller, el), height: r.height, past };
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

/** The first line the reader sees in a file drawn as code: the topmost row under the file header, on the new side when both have one. */
export function codeTop(scroller: HTMLElement, view: CodeView<never>, path: string): { side: Side; line: number; y: number } | null {
  const item = itemElement(view, path);
  if (!item) return null;
  const rows = drawnLines(item);
  const added = (el: Element) => rows.some((r) => r.el === el && r.at.some(([s]) => s === "additions"));
  const top = topmost(scroller, rows.map((x) => x.el), added);
  const row = rows.find((r) => r.el === top);
  if (!row) return null;
  const [side, line] = row.at.find(([s]) => s === "additions") ?? row.at[0]!;
  return { side, line, y: offsetOf(scroller, row.el) };
}

/**
 * How much of an element the reader sees, 0 to 1: of the element, or of the view when the element is taller. The view
 * is the scroller below `inset` px (a sticky header), inside the window.
 */
export function seenShare(scroller: Element, el: Element, inset = HEADER): number {
  const s = scroller.getBoundingClientRect();
  const top = Math.max(s.top + inset, 0);
  const bottom = Math.min(s.bottom, innerHeight);
  const r = el.getBoundingClientRect();
  const seen = Math.min(r.bottom, bottom) - Math.max(r.top, top);
  return r.height > 0 && seen > 0 ? Math.min(1, seen / Math.min(r.height, bottom - top)) : 0;
}

/** The drawn lines of a file of code (`id` for the cursor) on screen, as places of the cursor. */
export function linesInSight(scroller: Element, container: Element, id: string, space: CursorSpace, inset = HEADER): Seen[] {
  return drawnLines(container).flatMap(({ el, at }) => {
    const share = at[0] ? seenShare(scroller, el, inset) : 0;
    const place = share > 0 ? space.locate(id, at[0]![0], at[0]![1]) : null;
    return place ? [{ at: place, share }] : [];
  });
}

/** The blocks of a rendered file on screen, as places of the cursor. */
export function blocksInSight(scroller: Element, view: ParentNode, id: string, inset = HEADER): Seen[] {
  return [...view.querySelectorAll<HTMLElement>("[data-stop]")].flatMap((el) => {
    const share = seenShare(scroller, el, inset);
    return share > 0 ? [{ at: { path: id, row: Number(el.dataset.stop) }, share }] : [];
  });
}
