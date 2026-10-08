import type { NowStateDto, ReviewedDto, StatusDto, ThreadSummary, VersionDto } from "../core/types.ts";
import { isTestPath } from "./fold.ts";
import type { FileOrder } from "./order.ts";
import { groupByFile, type FileGroup } from "./tree.ts";

/** What the ends of a compare are picked from: the review's versions and its "now". */
export interface Refs {
  versions: readonly VersionDto[];
  now: StatusDto["now"] | undefined;
}

/** Threads by file, the files in the order of compare.order and compare.tests. */
export function groups(threads: ThreadSummary[], order: FileOrder, tests: string[]): FileGroup[] {
  return groupByFile(threads, (p) => order.rank(p, isTestPath(p, tests)));
}

/** The worktree moved away from the "now" `shown`: files that differ, or 0 when only the pin moved. */
export function nowMoved(n: NowStateDto | null, shown: string | null | undefined): number | null {
  return n && shown && n.sha !== shown ? (n.pinned === shown ? (n.files ?? 0) : 0) : null;
}

export function refOptions(r: Refs): { value: string; label: string }[] {
  return [
    { value: "base", label: "base" },
    ...r.versions.map((v) => ({ value: String(v.number), label: `v${v.number}${v.label ? ` · ${v.label}` : ""}` })),
    { value: "now", label: r.now?.changedSinceLatest === false ? "now (= latest)" : "now" },
  ];
}

export function nowDirty(r: Refs): boolean {
  return r.versions.length === 0 || !!r.now?.changedSinceLatest;
}

export function tipRef(r: Refs): string {
  const n = r.versions.length;
  return nowDirty(r) || n === 0 ? "now" : String(n);
}

export function reviewedRef(r: Refs, rv: ReviewedDto | null): string | null {
  if (!rv) return null;
  const n = r.versions.length;
  if (rv.version !== null) {
    if (rv.version > n || (rv.version === n && !nowDirty(r))) return null;
    return String(rv.version);
  }
  if (rv.sha === r.now?.sha) return null;
  return rv.sha;
}

export interface Preset {
  id: "since" | "after" | "round" | "branch";
  label: string;
  from: string;
  to: string;
}

export function presets(r: Refs, reviewed: ReviewedDto | null): Preset[] {
  const n = r.versions.length;
  const tip = tipRef(r);
  const out: Preset[] = [];
  const seen = new Set<string>();
  const add = (p: Preset) => {
    const key = `${p.from}..${p.to}`;
    if (p.from === p.to || seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  const rv = reviewedRef(r, reviewed);
  if (rv) add({ id: "since", label: "since I last looked", from: rv, to: tip });
  if (n >= 1 && nowDirty(r)) add({ id: "after", label: `after v${n} (no version yet)`, from: String(n), to: "now" });
  if (n >= 1) add({ id: "round", label: `what changed in v${n}`, from: n >= 2 ? String(n - 1) : "base", to: String(n) });
  add({ id: "branch", label: "whole branch", from: "base", to: tip });
  return out;
}

export function defaultCompare(r: Refs, reviewed: ReviewedDto | null): { from: string; to: string } {
  const p = presets(r, reviewed);
  const pick = p.find((x) => x.id === "since") ?? p.find((x) => x.id === "after") ?? p.find((x) => x.id === "round") ?? p[0];
  return pick ? { from: pick.from, to: pick.to } : { from: "base", to: "now" };
}

export function shiftRef(r: Refs, ref: string, dir: 1 | -1): string {
  const opts = refOptions(r).map((o) => o.value);
  const i = opts.indexOf(ref);
  const j = Math.max(0, Math.min(opts.length - 1, (i === -1 ? opts.length - 1 : i) + dir));
  return opts[j]!;
}
