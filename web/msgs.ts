import { effect, signal } from "@preact/signals";
import type { CommentDto, ThreadDetail } from "../src/core/types.ts";
import { currentThreadId } from "./state.ts";

/** The message under the cursor. Null until you move it there (keys or a click on the message). */
export const msgCursor = signal<number | null>(null);
/** Folds changed by hand: message id → open. */
export const msgOpen = signal<Map<number, boolean>>(new Map());
export const replyTo = signal<{ id: number; seq: number } | null>(null);
/** Messages that were new when the thread was opened; kept after the thread is marked read. */
export const newMark = signal<{ thread: number; ids: Set<number> } | null>(null);

effect(() => {
  const id = currentThreadId.value;
  if (newMark.peek()?.thread !== id) newMark.value = null;
  msgCursor.value = null;
  msgOpen.value = new Map();
  replyTo.value = null;
});

const FOLD_LINES = 12;
const FOLD_CHARS = 900;

export function isLong(c: CommentDto): boolean {
  return c.body.split("\n").length > FOLD_LINES || c.body.length > FOLD_CHARS;
}

/** Messages in the order they are shown: each first message by time, its replies under it. */
export function readingOrder(d: ThreadDetail): CommentDto[] {
  const kids = new Map<number | null, CommentDto[]>();
  for (const c of d.comments) kids.set(c.parentId, [...(kids.get(c.parentId) ?? []), c]);
  const out: CommentDto[] = [];
  const walk = (c: CommentDto) => {
    out.push(c);
    for (const k of kids.get(c.id) ?? []) walk(k);
  };
  for (const c of [...(kids.get(null) ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) walk(c);
  return out;
}

export function latchNew(d: ThreadDetail): void {
  if (newMark.peek()?.thread === d.thread.id) return;
  newMark.value = { thread: d.thread.id, ids: new Set(d.comments.filter((c) => c.unread).map((c) => c.id)) };
}

export function firstNew(d: ThreadDetail): number | null {
  const m = newMark.value;
  if (!m || m.thread !== d.thread.id || m.ids.size === 0) return null;
  return readingOrder(d).find((c) => m.ids.has(c.id))?.id ?? null;
}

/** Long messages you have read fold to a few lines, except the last one. */
export function isFolded(c: CommentDto, d: ThreadDetail): boolean {
  const own = msgOpen.value.get(c.id);
  if (own !== undefined) return !own;
  const order = readingOrder(d);
  return isLong(c) && !c.draft && !c.unread && !newMark.value?.ids.has(c.id) && order[order.length - 1]?.id !== c.id;
}

const column = () => document.querySelector<HTMLElement>(".thread-msgs");
const nodes = () => [...document.querySelectorAll<HTMLElement>(".thread-msgs .msg[data-id]")];
const idOf = (el: HTMLElement) => Number(el.dataset.id);

/** On a wide screen the messages scroll in their own column; on a narrow one the page scrolls. */
function ownScroll(): HTMLElement | null {
  const col = column();
  return col && /auto|scroll/.test(getComputedStyle(col).overflowY) && col.scrollHeight > col.clientHeight + 1 ? col : null;
}

function viewport(): { top: number; bottom: number } {
  const col = ownScroll();
  const head = document.querySelector<HTMLElement>(".msgs-head")?.offsetHeight ?? 0;
  if (!col) return { top: 0, bottom: window.innerHeight };
  const r = col.getBoundingClientRect();
  return { top: r.top + head, bottom: r.bottom };
}

function reveal(el: HTMLElement): void {
  const v = viewport();
  const r = el.getBoundingClientRect();
  if (r.top >= v.top && r.bottom <= v.bottom) return;
  el.scrollIntoView({ block: r.height > v.bottom - v.top || r.top < v.top || r.bottom > v.bottom ? "start" : "nearest" });
}

function firstVisible(list: HTMLElement[]): number {
  const v = viewport();
  const i = list.findIndex((el) => el.getBoundingClientRect().bottom > v.top + 4);
  return i === -1 ? list.length - 1 : i;
}

function put(el: HTMLElement | undefined): boolean {
  if (!el) return true;
  msgCursor.value = idOf(el);
  reveal(el);
  return true;
}

export function stepMsg(dir: 1 | -1, n = 1): boolean {
  const list = nodes();
  if (!list.length) return true;
  const at = list.findIndex((el) => idOf(el) === msgCursor.value);
  if (at === -1) return put(list[Math.max(0, firstVisible(list) - (dir === -1 ? 1 : 0))]);
  return put(list[Math.min(list.length - 1, Math.max(0, at + dir * n))]);
}

export function edgeMsg(last: boolean): boolean {
  const list = nodes();
  const done = put(last ? list[list.length - 1] : list[0]);
  if (last) {
    const col = ownScroll();
    if (col) col.scrollTop = col.scrollHeight;
  }
  return done;
}

export function halfPage(dir: 1 | -1): boolean {
  const col = ownScroll();
  const h = (col?.clientHeight ?? window.innerHeight) / 2;
  if (col) col.scrollTop += dir * h;
  else window.scrollBy(0, dir * h);
  const list = nodes();
  const cur = list.find((el) => idOf(el) === msgCursor.value);
  const v = viewport();
  if (cur) {
    const r = cur.getBoundingClientRect();
    if (r.bottom <= v.top || r.top >= v.bottom) msgCursor.value = idOf(list[firstVisible(list)]!);
  }
  return true;
}

export function foldMsg(d: ThreadDetail | null, how: boolean | "toggle"): boolean {
  if (!d) return true;
  const list = nodes();
  const id = msgCursor.value ?? (list.length ? idOf(list[firstVisible(list)]!) : null);
  const c = d.comments.find((x) => x.id === id);
  if (!c || !isLong(c)) return true;
  const open = how === "toggle" ? isFolded(c, d) : how;
  msgOpen.value = new Map(msgOpen.value).set(c.id, open);
  return true;
}

export function foldAllMsgs(d: ThreadDetail | null, open: boolean): boolean {
  if (!d) return true;
  const next = new Map(msgOpen.value);
  for (const c of d.comments) if (isLong(c)) next.set(c.id, open);
  msgOpen.value = next;
  return true;
}

/** `r`: a reply to the message under the cursor, or to the thread when you have not moved the cursor. */
export function replyAtCursor(): boolean {
  const id = msgCursor.value;
  if (id === null) return false;
  replyTo.value = { id, seq: (replyTo.value?.seq ?? 0) + 1 };
  return true;
}

function scrollToNews(): void {
  const col = ownScroll();
  if (!col) return;
  const line = col.querySelector<HTMLElement>(".new-line");
  if (line) line.scrollIntoView({ block: "start" });
  else col.scrollTop = col.scrollHeight;
}

let settling: (() => void) | null = null;

/**
 * When a thread opens: the first new message under a "new" line, else the last one with the reply box.
 * The messages keep growing for a moment after the first paint, so the scroll is repeated on every resize
 * until you scroll, click or press a key, or for 1.5 s.
 */
export function openAtNews(): void {
  settling?.();
  const col = column();
  const conv = col?.querySelector(".conversation");
  if (!col || !conv) return;
  const ro = new ResizeObserver(() => scrollToNews());
  const stop = () => {
    ro.disconnect();
    clearTimeout(timer);
    for (const ev of ["wheel", "mousedown", "touchstart"]) col.removeEventListener(ev, stop);
    window.removeEventListener("keydown", stop, true);
    if (settling === stop) settling = null;
  };
  const timer = setTimeout(stop, 1500);
  for (const ev of ["wheel", "mousedown", "touchstart"]) col.addEventListener(ev, stop, { passive: true });
  window.addEventListener("keydown", stop, true);
  settling = stop;
  ro.observe(conv);
  scrollToNews();
}

export function jumpToNew(): void {
  const line = document.querySelector<HTMLElement>(".thread-msgs .new-line");
  line?.scrollIntoView({ block: "start" });
  const next = line?.nextElementSibling?.querySelector<HTMLElement>(".msg[data-id]");
  if (next) msgCursor.value = idOf(next);
}
