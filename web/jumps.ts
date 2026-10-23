import { signal } from "@preact/signals";
import { compareNav, cursor, peek, type Peek } from "./compare.ts";
import type { Cursor } from "../src/ui/cursor.ts";
import { expectNavigation, jumpHooks, noteJump, notify, selectedStep } from "./state.ts";
import { transition } from "./transition.ts";

export interface Spot {
  hash: string;
  cursor: Cursor | null;
  peek: Peek | null;
  step: number | null;
  compareTop: number | null;
  scroll: Record<string, number>;
}

const SCROLLERS = [".pane", ".thread-code", ".thread-msgs", ".side > .tree", ".side > .file-list", ".side > .search"];
const LIMIT = 100;

const back: Spot[] = [];
const forward: Spot[] = [];
const positions = new Map<string, Spot>();

export const pendingSpot = signal<Spot | null>(null);

export function capture(hash = location.hash): Spot {
  const scroll: Record<string, number> = {};
  for (const sel of SCROLLERS) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) scroll[sel] = el.scrollTop;
  }
  return {
    hash,
    cursor: cursor.peek(),
    peek: peek.peek(),
    step: selectedStep.peek(),
    compareTop: compareNav.current?.getScrollTop() ?? null,
    scroll,
  };
}

function remember(list: Spot[], s: Spot): void {
  const last = list[list.length - 1];
  if (last && last.hash === s.hash && last.compareTop === s.compareTop && last.cursor?.path === s.cursor?.path && last.cursor?.row === s.cursor?.row && last.peek === s.peek) return;
  list.push(s);
  if (list.length > LIMIT) list.shift();
}

jumpHooks.push(() => {
  const s = capture();
  positions.set(s.hash, s);
  remember(back, s);
  forward.length = 0;
});

export function apply(s: Spot): void {
  cursor.value = s.cursor;
  peek.value = s.peek;
  if (s.step !== null || selectedStep.peek() !== null) selectedStep.value = s.step;
  requestAnimationFrame(() => {
    for (const [sel, top] of Object.entries(s.scroll)) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) el.scrollTop = top;
    }
    if (s.compareTop !== null) compareNav.current?.setScrollTop(s.compareTop);
  });
}

export function takeSpot(hash: string): Spot | null {
  const s = pendingSpot.peek();
  if (!s || s.hash !== hash) return null;
  pendingSpot.value = null;
  return s;
}

function go(s: Spot): void {
  transition();
  if (location.hash === s.hash) {
    apply(s);
    return;
  }
  pendingSpot.value = s;
  expectNavigation(s.hash);
  location.hash = s.hash;
}

export function jumpBack(): boolean {
  if (depth > 0 && before[depth - 1] && back[back.length - 1] === before[depth - 1]) {
    history.back();
    return true;
  }
  const s = back.pop();
  if (!s) {
    notify("no earlier position (Ctrl+O goes back through pages, search hits and file jumps)");
    return true;
  }
  remember(forward, capture());
  go(s);
  return true;
}

export function jumpForward(): boolean {
  if (after[depth] && forward[forward.length - 1] === after[depth]) {
    history.forward();
    return true;
  }
  const s = forward.pop();
  if (!s) {
    notify("no later position");
    return true;
  }
  remember(back, capture());
  go(s);
  return true;
}

/** A preview a link opens is an entry in the browser's history of its own, on the same address: Back closes it, Forward opens it again. */
interface PeekEntry {
  stetPeek: number;
  peek: Peek;
}

const depthOf = (state: unknown) => (state as PeekEntry | null)?.stetPeek ?? 0;
let depth = depthOf(history.state);
let entryHash = location.hash;
// before[d]: the spot on the entry of depth d that the preview of d + 1 opened from; after[d]: the spot Back left on d + 1
const before: Spot[] = [];
const after: Spot[] = [];

export function openPeek(p: Peek): void {
  noteJump();
  before.length = after.length = depth;
  before.push(back[back.length - 1]!);
  history.pushState({ stetPeek: ++depth, peek: p } satisfies PeekEntry, "", location.href);
  peek.value = p;
}

function otherPage(): boolean {
  if (location.hash === entryHash) return false;
  entryHash = location.hash;
  depth = depthOf(history.state);
  before.length = after.length = 0;
  return true;
}

window.addEventListener("hashchange", otherPage);
window.addEventListener("popstate", (e) => {
  const to = depthOf(e.state);
  if (otherPage() || to === depth) return;
  const here = capture();
  const spot = to < depth ? before[to] : to === depth + 1 ? after[depth] : undefined;
  if (to < depth) {
    if (spot && back[back.length - 1] === spot) back.pop();
    remember(forward, here);
    after.length = to;
    if (to === depth - 1) after.push(forward[forward.length - 1]!);
  } else {
    if (spot && forward[forward.length - 1] === spot) forward.pop();
    remember(back, here);
    before.length = depth;
    before.push(back[back.length - 1]!);
  }
  depth = to;
  transition();
  apply(spot ?? { ...here, peek: (e.state as PeekEntry | null)?.peek ?? null });
});

export function leftPage(oldHash: string, own: boolean): void {
  if (own) return;
  positions.set(oldHash, capture(oldHash));
  const saved = positions.get(location.hash);
  if (saved) pendingSpot.value = saved;
}
