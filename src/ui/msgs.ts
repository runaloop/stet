import type { CommentDto, ThreadDetail } from "../core/types.ts";

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

/** Long messages you have read fold to a few lines, except the last one; `fresh` are the ones new when the thread opened. */
export function foldedByDefault(c: CommentDto, d: ThreadDetail, fresh: ReadonlySet<number> | undefined): boolean {
  const order = readingOrder(d);
  return isLong(c) && !c.draft && !c.unread && !fresh?.has(c.id) && order[order.length - 1]?.id !== c.id;
}
