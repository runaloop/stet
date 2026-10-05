import { signal } from "@preact/signals";
import { setWidth } from "./components/Splitter.tsx";
import { route } from "./state.ts";

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
