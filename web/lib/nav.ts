import type { ComparePlacement, ThreadSummary } from "../../src/core/types.ts";
import type { FileGroup } from "./tree.ts";

export function stepThread(list: ThreadSummary[], currentId: number | null, dir: 1 | -1): number | null {
  if (list.length === 0) return null;
  const idx = list.findIndex((t) => t.id === currentId);
  if (idx === -1) return (dir === 1 ? list[0] : list[list.length - 1])!.id;
  const next = idx + dir;
  if (next < 0 || next >= list.length) return currentId;
  return list[next]!.id;
}

export function stepUnread(list: ThreadSummary[], currentId: number | null, dir: 1 | -1): number | null {
  const n = list.length;
  if (n === 0) return null;
  const idx = list.findIndex((t) => t.id === currentId);
  for (let k = 1; k <= n; k++) {
    const i = (((idx === -1 ? (dir === 1 ? -1 : 0) : idx) + dir * k) % n + n) % n;
    const t = list[i]!;
    if (t.unread && t.id !== currentId) return t.id;
  }
  return null;
}

export function stepFile(groups: FileGroup[], currentId: number | null, dir: 1 | -1): number | null {
  if (groups.length === 0) return null;
  const gi = groups.findIndex((g) => g.threads.some((t) => t.id === currentId));
  const next = gi === -1 ? (dir === 1 ? 0 : groups.length - 1) : gi + dir;
  if (next < 0 || next >= groups.length) return currentId;
  return groups[next]!.threads[0]?.id ?? null;
}

export function compareOrder(placements: ComparePlacement[], fileOrder: string[]): ComparePlacement[] {
  const rank = new Map(fileOrder.map((name, i) => [name, i]));
  return placements
    .filter((p) => rank.has(p.path))
    .sort((a, b) => rank.get(a.path)! - rank.get(b.path)! || a.range.start - b.range.start || a.threadId - b.threadId);
}
