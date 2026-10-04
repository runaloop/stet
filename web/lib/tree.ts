import type { ThreadSummary } from "../../src/core/types.ts";

export interface FileGroup {
  path: string;
  threads: ThreadSummary[];
}

export function fileOf(t: ThreadSummary): string {
  return t.anchor.path ?? t.path;
}

export function lineOf(t: ThreadSummary): number {
  return t.anchor.range?.start ?? t.range.start;
}

export function groupByFile(threads: ThreadSummary[], rank: (path: string) => number = () => 0): FileGroup[] {
  const map = new Map<string, ThreadSummary[]>();
  for (const t of threads) {
    const key = fileOf(t);
    const list = map.get(key);
    if (list) list.push(t);
    else map.set(key, [t]);
  }
  return [...map.entries()]
    .map(([path, list]) => [path, list, rank(path)] as const)
    .sort(([a, , ra], [b, , rb]) => ra - rb || a.localeCompare(b, undefined, { numeric: true }))
    .map(([path, list]) => ({ path, threads: list.sort((a, b) => lineOf(a) - lineOf(b) || a.id - b.id) }));
}

export function flatten(groups: FileGroup[]): ThreadSummary[] {
  return groups.flatMap((g) => g.threads);
}
