import { effect } from "@preact/signals";
import { baseFiles, compareData, guideShown } from "./compare.ts";
import { crossfade, pageSheet } from "./lib/fade.ts";
import { sameView } from "./lib/route.ts";
import { detail, jumpHooks, route } from "./state.ts";

/** The boxes that scroll on the pages: a view is in place once they keep their place and size. */
const SCROLLERS = ".codeview-host, .guide, .peek .code-host, .thread-code, .thread-msgs";

// the pages say "loading…" (or "loading thread #12…") where their data is not there yet
const loadingIn = (pane: Element) => [...pane.querySelectorAll(".note, .empty")].some((e) => e.textContent?.startsWith("loading"));

/** Whether the page the address names has its data: the compare of its range with its files, the thread. */
function arrived(pane: Element): boolean {
  const r = route.peek();
  if (r.name === "thread" && detail.peek()?.thread.id !== r.id) return false;
  if (r.name === "compare") {
    const d = compareData.peek();
    const files = baseFiles.peek() as { key?: string } | null;
    if (!d || d.from.ref !== r.from || d.to.ref !== r.to || files?.key !== `${d.from.sha}-${d.to.sha}`) return false;
  }
  return !loadingIn(pane);
}

/**
 * The page's view is about to change in one jump (another page, the guide, a far place in the code): a copy of what
 * it shows covers it and fades out once the view it changes to is in place. Called before the change.
 */
export function transition(): void {
  const pane = document.querySelector("main > .pane");
  // a page still loading has nothing to keep on screen
  if (!pane || pane.querySelector(":scope > .empty")) return;
  crossfade(pane, SCROLLERS, () => arrived(pane));
}

pageSheet();
jumpHooks.push(transition);

let shown = route.peek();
effect(() => {
  const r = route.value;
  const was = shown;
  shown = r;
  if (!sameView(was, r)) transition();
});

let guide = guideShown.peek();
effect(() => {
  const g = guideShown.value;
  if (g === guide) return;
  guide = g;
  transition();
});
