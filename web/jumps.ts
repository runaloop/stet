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

function sameSpot(a: Spot | undefined, b: Spot): boolean {
  return !!a && a.hash === b.hash && a.compareTop === b.compareTop && a.cursor?.path === b.cursor?.path && a.cursor?.row === b.cursor?.row && a.peek === b.peek;
}

function remember(list: Spot[], s: Spot): void {
  if (sameSpot(list[list.length - 1], s)) return;
  list.push(s);
  if (list.length > LIMIT) list.shift();
}

jumpHooks.push(() => {
  const s = capture();
  positions.set(s.hash, s);
  remember(back, s);
  forward.length = 0;
  if (chainId && location.hash === entryHash) savePreview(s);
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
  if (depth > 0 && back[back.length - 1] === (previews.before[depth - 1] ?? previews.floor)) {
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
  if (previews.after[depth] && forward[forward.length - 1] === previews.after[depth]) {
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
  stetPeekChain: number;
  peek: Peek;
}

const depthOf = (state: unknown) => (state as PeekEntry | null)?.stetPeek ?? 0;
let depth = 0;
let entryHash = "";
interface PreviewChain {
  // before[d]: where preview d + 1 opened; after[d]: where Back left preview d + 1
  before: Spot[];
  after: Spot[];
  spots: Map<number, Spot>;
  jumps: Map<number, { back: Spot[]; forward: Spot[] }>;
  // A restored browser entry may predate this page load and have no in-memory origin.
  floor?: Spot;
}
const newChain = (): PreviewChain => ({ before: [], after: [], spots: new Map(), jumps: new Map() });
const previewChains = new Map<number, PreviewChain>();
let chainId = 0;
let nextChainId = 0;
let previews = newChain();

function savePreview(s: Spot, at = depth): void {
  previews.spots.set(at, s);
  // noteJump() may already have recorded the current entry as a departure.
  const end = sameSpot(back[back.length - 1], s) ? back.length - 1 : back.length;
  previews.jumps.set(at, { back: back.slice(0, end), forward: [...forward] });
}

function restorePreview(chain: PreviewChain, at: number): void {
  const jumps = chain.jumps.get(at);
  if (!jumps) return;
  back.splice(0, back.length, ...jumps.back);
  forward.splice(0, forward.length, ...jumps.forward);
}

function chainFor(id: number): PreviewChain {
  let chain = previewChains.get(id);
  if (!chain) {
    chain = { ...newChain(), floor: back[back.length - 1] };
    if (id) previewChains.set(id, chain);
  }
  return chain;
}

function selectChain(): void {
  depth = depthOf(history.state);
  chainId = (history.state as PeekEntry | null)?.stetPeekChain ?? 0;
  nextChainId = Math.max(nextChainId, chainId);
  previews = chainFor(chainId);
}

export function openPeek(p: Peek): void {
  noteJump();
  if (depth === 0) {
    previews = newChain();
    chainId = ++nextChainId;
    previewChains.set(chainId, previews);
    savePreview(back[back.length - 1]!, 0);
    history.replaceState({ ...history.state, stetPeekChain: chainId }, "", location.href);
  }
  const { before, after } = previews;
  before.length = after.length = depth;
  before.push(back[back.length - 1]!);
  history.pushState({ stetPeek: ++depth, stetPeekChain: chainId, peek: p } satisfies PeekEntry, "", location.href);
  peek.value = p;
  savePreview(capture());
}

function otherPage(e?: Event): boolean {
  if (location.hash === entryHash) return false;
  // popstate precedes the page's hashchange listener, while its old view is still present.
  if (!e && chainId) savePreview(capture(entryHash));
  entryHash = location.hash;
  selectChain();
  return true;
}

function stepped(e: PopStateEvent): void {
  const to = depthOf(e.state);
  if (otherPage()) return;
  const id = (e.state as PeekEntry | null)?.stetPeekChain;
  const changedChain = (to > 0 || id !== undefined) && (id ?? 0) !== chainId;
  if (changedChain) {
    if (chainId) savePreview(capture());
    chainId = id ?? 0;
    nextChainId = Math.max(nextChainId, chainId);
    previews = chainFor(chainId);
    restorePreview(previews, to);
    depth = to;
    transition();
    apply(previews.spots.get(to) ?? { ...capture(), peek: (e.state as PeekEntry | null)?.peek ?? null });
    return;
  }
  if (to === depth) return;
  const { before, after } = previews;
  const here = capture();
  if (chainId) savePreview(here);
  const spot = (to < depth ? before[to] : to === depth + 1 ? after[depth] : undefined) ?? previews.spots.get(to);
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
}

/** Follows the browser's Back and Forward between a page and the previews its links opened. */
export function installHistory(): () => void {
  selectChain();
  entryHash = location.hash;
  window.addEventListener("hashchange", otherPage);
  window.addEventListener("popstate", stepped);
  return () => {
    window.removeEventListener("hashchange", otherPage);
    window.removeEventListener("popstate", stepped);
  };
}

export function leftPage(oldHash: string, own: boolean): void {
  if (own) return;
  const here = capture(oldHash);
  positions.set(oldHash, here);
  if (oldHash === entryHash && chainId) savePreview(here);
  const targetDepth = depthOf(history.state);
  const target = previewChains.get((history.state as PeekEntry | null)?.stetPeekChain ?? 0);
  const saved = target?.spots.get(targetDepth) ?? positions.get(location.hash);
  if (saved) {
    if (target) restorePreview(target, targetDepth);
    pendingSpot.value = targetDepth > 0 || !saved.peek?.jumped ? saved : { ...saved, peek: null };
  }
}
