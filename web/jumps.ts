import { signal } from "@preact/signals";
import { compareNav, cursor, peek, type Peek } from "./compare.ts";
import type { Cursor } from "./lib/cursor.ts";
import { expectNavigation, jumpHooks, notify, selectedStep } from "./state.ts";

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
  if (last && last.hash === s.hash && last.compareTop === s.compareTop && last.cursor?.path === s.cursor?.path && last.cursor?.row === s.cursor?.row) return;
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
  if (location.hash === s.hash) {
    apply(s);
    return;
  }
  pendingSpot.value = s;
  expectNavigation(s.hash);
  location.hash = s.hash;
}

export function jumpBack(): boolean {
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
  const s = forward.pop();
  if (!s) {
    notify("no later position");
    return true;
  }
  remember(back, capture());
  go(s);
  return true;
}

export function leftPage(oldHash: string, own: boolean): void {
  if (own) return;
  positions.set(oldHash, capture(oldHash));
  const saved = positions.get(location.hash);
  if (saved) pendingSpot.value = saved;
}
