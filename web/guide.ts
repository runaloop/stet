import { computed, effect, signal } from "@preact/signals";
import type { GuideDto } from "../src/core/types.ts";
import { api } from "./api.ts";
import { compareData, compareNav } from "./compare.ts";
import { navigate, notify, reviewId, route, routeHash, versions, type Route } from "./state.ts";

/**
 * The Guide tab of the Changes page (experimental): the agent's guide to the version on the right, over the diff. The
 * diff stays as it is under it, so switching back finds it as it was.
 */
export const guideOpen = signal(false);
/** The step `}` and `{` went to, from 1. */
export const guideStep = signal<number | null>(null);

/** The version on the right of the compare shown, when the agent wrote a guide to it. */
export const guideVersion = computed(() => {
  const r = route.value;
  const d = compareData.value;
  if (r.name !== "compare" || !d || d.from.ref !== r.from || d.to.ref !== r.to) return null;
  const n = Number(/^v(\d+)$/.exec(d.to.label)?.[1]);
  return versions.value.some((v) => v.number === n && v.guide) ? n : null;
});

export const guideShown = computed(() => guideOpen.value && guideVersion.value !== null);

// A version whose guide the reviewer asked for opens on the Guide tab the first time it is on the right; after that
// the tab stays as the reader left it.
effect(() => {
  const n = guideVersion.value;
  const rid = reviewId.peek();
  if (n === null || rid === null || !versions.peek().find((v) => v.number === n)?.guideRequested) return;
  const key = `stet.guideShown.${rid}.${n}`;
  try {
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
  } catch {
    return;
  }
  guideOpen.value = true;
});

export function toggleGuide(): boolean {
  if (guideVersion.value === null) notify("the version on the right has no guide: the agent writes one with stet version create --guide");
  else guideOpen.value = !guideOpen.value;
  return true;
}

// a guide does not change once its version is made
const loaded = new Map<string, Promise<GuideDto>>();

export function fetchGuide(review: number, version: number): Promise<GuideDto> {
  const key = `${review}:${version}`;
  let p = loaded.get(key);
  if (!p) {
    p = api.guide(review, version);
    p.catch(() => loaded.delete(key));
    loaded.set(key, p);
  }
  return p;
}

/** The diff at a step's lines: the Guide tab closes, and the diff goes there as for a link to them. */
export function openInDiff(r: Extract<Route, { name: "compare" }>): void {
  const again = location.hash === routeHash(r);
  guideOpen.value = false;
  if (!again) return navigate(r);
  // the address is already the one of these lines: the diff handled it once and would not move again
  const nav = compareNav.current;
  if (!nav || !r.file) return;
  if (r.line) nav.openLine(r.file, r.side === "old" ? "deletions" : "additions", r.line);
  else nav.scrollToFile(r.file);
}
