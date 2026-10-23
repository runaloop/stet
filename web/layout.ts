import { signal } from "@preact/signals";
import { setWidth } from "./components/Splitter.tsx";
import { sideWidth } from "../src/ui/side.ts";
import { diffStyle, route } from "./state.ts";

/** The pages whose columns can trade places: the side panel and the diff, the code and the conversation. */
export type SwapPage = "compare" | "thread";

export function layoutPage(): SwapPage | "other" {
  const r = route.value.name;
  return r === "thread" ? "thread" : r === "compare" ? "compare" : "other";
}

function stored(page: SwapPage): boolean {
  try {
    return localStorage.getItem(`stet.swap.${page}`) === "1";
  } catch {
    return false;
  }
}

const swaps = signal<Record<SwapPage, boolean>>({ compare: stored("compare"), thread: stored("thread") });

export function swapped(page: SwapPage): boolean {
  return swaps.value[page];
}

function setSwapped(page: SwapPage, on: boolean): void {
  swaps.value = { ...swaps.value, [page]: on };
  try {
    if (on) localStorage.setItem(`stet.swap.${page}`, "1");
    else localStorage.removeItem(`stet.swap.${page}`);
  } catch {
    return;
  }
}

export function toggleSwap(page: SwapPage): void {
  setSwapped(page, !swaps.value[page]);
}

/** Column order and widths of the page on screen back to the defaults. */
export function resetLayout(): void {
  const page = layoutPage();
  setWidth(`side.${page}`, null);
  if (page === "thread") setWidth("msgs", null);
  if (page !== "other") setSwapped(page, false);
}

/** What the side panel's rows need, measured when a review loads or the page or tab changes, not on live updates. */
const sideNeed = signal<number | null>(null);
const viewport = signal(typeof window === "undefined" ? 0 : window.innerWidth);
if (typeof window !== "undefined") {
  let frame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => (viewport.value = window.innerWidth));
  });
}

/**
 * The width the rows of the panel take unclipped: a file's name (its folder only shows on hover), a thread's place
 * line, a thread group's file name; thread titles are sentences and would always take the ceiling. A copy of the panel
 * is laid out out of sight, so the panel on screen keeps its scroll. Null when the tab shows none of these rows.
 */
function measureSide(side: HTMLElement): number | null {
  if (!side.querySelector(".file-row, .thread-row")) return null;
  const probe = document.createElement("aside");
  probe.className = "side-measure";
  probe.append(side.cloneNode(true));
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  const list = side.querySelector<HTMLElement>(".tree, .file-list");
  return width > 0 ? Math.ceil(width) + (list ? list.offsetWidth - list.clientWidth : 0) : null;
}

export function remeasureSide(side: HTMLElement | null): void {
  const need = side ? measureSide(side) : null;
  if (need !== null) sideNeed.value = need;
}

/** The panel's width when the reader has not dragged it: as its rows need, up to the ceiling of the page. */
export function autoSideWidth(page: SwapPage | "other"): number {
  return sideWidth(sideNeed.value, { window: viewport.value, page, split: diffStyle.value === "split" });
}
