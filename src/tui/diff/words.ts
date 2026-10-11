import { diffWordsWithSpace } from "diff";

/** Character ranges `[start, end)` of a line. */
export type Ranges = [number, number][];

const MAX = 1000;

/**
 * The words that changed between a removed line and the added line that took its place, as the web marks them: the
 * removed words on the old line, the added ones on the new. Null when nothing is alike (the whole line changed) or a
 * line is too long to compare.
 */
export function wordMarks(old: string, now: string): { old: Ranges; new: Ranges } | null {
  if (old.length > MAX || now.length > MAX || old === now) return null;
  const out = { old: [] as Ranges, new: [] as Ranges };
  let o = 0;
  let n = 0;
  let same = 0;
  for (const part of diffWordsWithSpace(old, now)) {
    const len = part.value.length;
    if (part.added) {
      out.new.push([n, n + len]);
      n += len;
    } else if (part.removed) {
      out.old.push([o, o + len]);
      o += len;
    } else {
      if (part.value.trim()) same += len;
      o += len;
      n += len;
    }
  }
  if (same === 0) return null;
  return out;
}

/** Runs cut where `ranges` start and end, those inside given `mark`. */
export function markRuns<T extends { text: string }>(runs: readonly T[], ranges: Ranges, mark: (r: T) => T): T[] {
  if (!ranges.length) return runs as T[];
  const out: T[] = [];
  let pos = 0;
  let k = 0;
  for (const r of runs) {
    let at = 0;
    const end = pos + r.text.length;
    while (at < r.text.length) {
      while (k < ranges.length && ranges[k]![1] <= pos + at) k++;
      const range = ranges[k];
      if (!range || range[0] >= end) {
        out.push(at === 0 ? r : { ...r, text: r.text.slice(at) });
        break;
      }
      const start = Math.max(range[0] - pos, at);
      if (start > at) out.push({ ...r, text: r.text.slice(at, start) });
      const stop = Math.min(range[1] - pos, r.text.length);
      out.push(mark({ ...r, text: r.text.slice(start, stop) }));
      at = stop;
    }
    pos = end;
  }
  return out;
}
