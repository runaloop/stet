import { computed, effect, signal } from "@preact/signals";
import type { GuideDto } from "../src/core/types.ts";
import { api } from "./api.ts";
import { compareData, compareNav, cursor, guideFiles, guideOpen, guideShown, guideVersion, type FileView } from "./compare.ts";
import { navigate, notify, reviewId, routeHash, versions, type Route } from "./state.ts";

export { guideOpen, guideShown, guideVersion } from "./compare.ts";

/** The step `}` and `{` went to, from 1. */
export const guideStep = signal<number | null>(null);

/** A step's file diff longer than this many lines starts folded. */
export const LONG = 80;

/** The key of a step's reference among the Guide tab's file diffs: step from 1, reference from 0. */
export const refKey = (step: number, ref: number) => `${step}.${ref}`;

/** File diffs of the guide the reader folded (true) or opened (false); the others are folded when they are long. */
export const guideFolds = signal<ReadonlyMap<string, boolean>>(new Map());

export const isFolded = (key: string, lines: number) => guideFolds.value.get(key) ?? lines > LONG;

export function foldRef(key: string, folded: boolean): void {
  guideFolds.value = new Map(guideFolds.value).set(key, folded);
}

/** Markdown file diffs of the guide the reader switched to rendered or to code; the others are as `compare.markdown` says. */
export const guideViews = signal<ReadonlyMap<string, FileView>>(new Map());

/** The guide's file diff the reader is at: under the cursor, gone to with a key or a click, else the top one in view. */
export const guideAt = signal<string | null>(null);

effect(() => {
  const c = cursor.value;
  if (c && guideShown.peek() && guideFiles.peek().has(c.path)) guideAt.value = c.path;
});

/** The file of the diff the reader is at in the guide, for the Files panel. */
export const guideFile = computed(() => {
  const k = guideAt.value;
  return k ? (guideFiles.value.get(k)?.path ?? null) : null;
});

let shownRange = "";
effect(() => {
  const d = compareData.value;
  const range = d ? `${d.from.sha}..${d.to.sha}` : "";
  if (range === shownRange) return;
  shownRange = range;
  guideFolds.value = new Map();
  guideViews.value = new Map();
  guideAt.value = null;
  guideStep.value = null;
});

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
