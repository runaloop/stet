import type { Verdict } from "../../src/core/types.ts";

export interface Round {
  /** 0: the versions before the first review; k: the agent's answer to review k. */
  index: number;
  /** When review `index` was submitted; null for round 0. */
  at: string | null;
  /** What review `index` said: changes requested, or approved (its versions then fix the nits). */
  verdict: Verdict | null;
  first: number;
  last: number;
}

/** Versions grouped by the review they answer. Rounds without versions are left out. */
export function rounds(versions: readonly { number: number; createdAt: string }[], submissions: readonly { at: string; verdict: Verdict }[]): Round[] {
  const out: Round[] = [];
  let k = 0;
  for (const v of versions) {
    while (k < submissions.length && submissions[k]!.at <= v.createdAt) k++;
    const last = out[out.length - 1];
    const review = k ? submissions[k - 1]! : null;
    if (last && last.index === k) last.last = v.number;
    else out.push({ index: k, at: review?.at ?? null, verdict: review?.verdict ?? null, first: v.number, last: v.number });
  }
  return out;
}

export type Folded = { kind: "one"; i: number } | { kind: "fold"; from: number; to: number };

/** Indices 0…n-1, with every run of at least `minRun` indices that are not kept folded into one item. */
export function foldRuns(n: number, keep: (i: number) => boolean, minRun = 3): Folded[] {
  const out: Folded[] = [];
  let i = 0;
  while (i < n) {
    if (keep(i)) {
      out.push({ kind: "one", i: i++ });
      continue;
    }
    let j = i;
    while (j < n && !keep(j)) j++;
    if (j - i >= minRun) out.push({ kind: "fold", from: i, to: j - 1 });
    else for (let k = i; k < j; k++) out.push({ kind: "one", i: k });
    i = j;
  }
  return out;
}

/**
 * Strip steps that stay whole: every step that is not a version (base, a pass, now), the newest versions, and
 * each marked step (the two ends, your last pass) with a neighbour on each side, so ]v and [v stay visible.
 */
export function keptSteps(steps: readonly { kind: string }[], marks: readonly number[], newest = 3): Set<number> {
  const keep = new Set<number>();
  const versions: number[] = [];
  steps.forEach((s, i) => (s.kind === "version" ? versions.push(i) : keep.add(i)));
  for (const i of versions.slice(-newest)) keep.add(i);
  for (const m of marks) if (m >= 0) for (const d of [-1, 0, 1]) keep.add(m + d);
  return keep;
}

interface TimelineLike {
  state: string;
  path: string | null;
  range: { start: number; end: number } | null;
  commentIds: readonly number[];
}

/** Timeline steps that stay whole: the first and the last, the one shown with its neighbours, every step with messages, every step where the code moved or changed. */
export function keptTimeline(steps: readonly TimelineLike[], selected: number): Set<number> {
  const keep = new Set<number>([0, steps.length - 1, selected - 1, selected, selected + 1]);
  steps.forEach((s, i) => {
    const p = steps[i - 1];
    const moved = !p || p.state !== s.state || p.path !== s.path || p.range?.start !== s.range?.start || p.range?.end !== s.range?.end;
    if (moved || s.commentIds.length) keep.add(i);
  });
  return keep;
}

function place(ref: string, latest: number): number | null {
  if (ref === "base") return 0;
  if (ref === "now") return latest + 1;
  return /^\d+$/.test(ref) ? Number(ref) : null;
}

const refAt = (p: number, latest: number): string => (p <= 0 ? "base" : p > latest ? "now" : String(p));

/** The range after setting one end; an end that would cross the other moves the other along. A commit or a pass sha has no place, so it never moves. */
export function withEnd(end: "from" | "to", ref: string, from: string, to: string, latest: number): [string, string] {
  const p = place(ref, latest);
  if (end === "from") {
    const t = place(to, latest);
    return [ref, p !== null && t !== null && t <= p ? refAt(p + 1, latest) : to];
  }
  const f = place(from, latest);
  return [p !== null && f !== null && f >= p ? refAt(p - 1, latest) : from, ref];
}

/** The range that shows only what changed in version `n`. */
export function onlyVersion(n: number): [string, string] {
  return [n > 1 ? String(n - 1) : "base", String(n)];
}
