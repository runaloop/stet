import type { FileDiffMetadata } from "@pierre/diffs";

/**
 * A "viewed" tick is on a change of a file: `path@old..new`, the blob ids of its two sides in the diff where it was
 * ticked (`0000000` for a side the file is missing from, empty for a change without ids, such as a pure rename). A
 * diff of the file counts as viewed when ticked changes lead from its old side to its new side: the same change, or
 * changes ticked one after another (v1 → v2 and v2 → v3 make v1 → v3 viewed). A change you never saw (a deletion, a
 * revert to content you ticked before) does not.
 *
 * Keys stored before were `path@blob`: the new side only (the old side for a deleted file). They keep meaning
 * "viewed wherever the new side has this content", except for deleted files, where such a key cannot tell a ticked
 * deletion from a ticked content.
 */
export interface ViewedChange {
  path: string;
  old: string;
  new: string;
}

export function viewedChange(fd: FileDiffMetadata): ViewedChange {
  return { path: fd.name, old: fd.prevObjectId ?? "", new: fd.newObjectId ?? "" };
}

export function viewedKey(fd: FileDiffMetadata): string {
  const c = viewedChange(fd);
  return `${c.path}@${c.old}..${c.new}`;
}

interface Tick {
  key: string;
  old: string;
  new: string;
}

export interface ViewedIndex {
  ticks: Map<string, Tick[]>;
  /** Keys of the old form, by path: the blob of the new side. */
  legacy: Map<string, { key: string; blob: string }[]>;
}

export function viewedIndex(keys: Iterable<string>): ViewedIndex {
  const ticks = new Map<string, Tick[]>();
  const legacy = new Map<string, { key: string; blob: string }[]>();
  for (const key of keys) {
    const at = key.lastIndexOf("@");
    if (at <= 0) continue;
    const path = key.slice(0, at);
    const ids = key.slice(at + 1);
    const dots = ids.indexOf("..");
    if (dots === -1) {
      const list = legacy.get(path) ?? [];
      list.push({ key, blob: ids === "undefined" ? "" : ids });
      legacy.set(path, list);
      continue;
    }
    const list = ticks.get(path) ?? [];
    list.push({ key, old: ids.slice(0, dots), new: ids.slice(dots + 2) });
    ticks.set(path, list);
  }
  return { ticks, legacy };
}

// git abbreviates blob ids to a length that grows with the repository, so one blob can show up longer later
function same(a: string, b: string): boolean {
  return a === b || (a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a)));
}

/** The ticks that lead from the change's old side to its new side, or null when none do. */
function chain(ticks: readonly Tick[], c: ViewedChange): Tick[] | null {
  const from = new Map<Tick, Tick | null>();
  let level: (Tick | null)[] = [null];
  while (level.length) {
    const next: Tick[] = [];
    for (const via of level) {
      const at = via ? via.new : c.old;
      for (const t of ticks) {
        if (from.has(t) || !same(t.old, at)) continue;
        from.set(t, via);
        if (same(t.new, c.new)) {
          const out: Tick[] = [];
          for (let s: Tick | null = t; s; s = from.get(s) ?? null) out.unshift(s);
          return out;
        }
        next.push(t);
      }
    }
    level = next;
  }
  return null;
}

function legacyHits(index: ViewedIndex, fd: FileDiffMetadata): string[] {
  if (fd.type === "deleted") return [];
  const c = viewedChange(fd);
  return (index.legacy.get(c.path) ?? []).filter((l) => same(l.blob, c.new)).map((l) => l.key);
}

export function isViewedIn(index: ViewedIndex, fd: FileDiffMetadata): boolean {
  if (legacyHits(index, fd).length) return true;
  const ticks = index.ticks.get(fd.name);
  return !!ticks && chain(ticks, viewedChange(fd)) !== null;
}

/** The keys to drop so that the file is not viewed any more: every chain of ticks that leads across its change. */
export function unviewKeys(index: ViewedIndex, fd: FileDiffMetadata): string[] {
  const out = legacyHits(index, fd);
  let left = [...(index.ticks.get(fd.name) ?? [])];
  const c = viewedChange(fd);
  for (let found = chain(left, c); found; found = chain(left, c)) {
    out.push(...found.map((t) => t.key));
    left = left.filter((t) => !found!.includes(t));
  }
  return out;
}
