import type { Hunk } from "./diff.ts";

export const REANCHOR_ALGO = 2;
export const CONTEXT_LINES = 3;

export interface AnchorSpec {
  path: string;
  start: number;
  end: number;
  lines: string[];
  before: string[];
  after: string[];
  /** An area of an image: `lines` holds the image's blob id. */
  image?: boolean;
}

export type FileChange =
  | { kind: "same"; newPath: string; newLines: string[] }
  | { kind: "modified"; newPath: string; oldLines: string[]; newLines: string[]; hunks: Hunk[] }
  | { kind: "deleted" }
  | { kind: "binary"; newPath: string };

export type AnchorState = "ok" | "moved" | "changed" | "outdated";
export type Method = "identity" | "offset" | "exact" | "whitespace" | "boundary" | "image";
export type OutdatedReason = "file-deleted" | "lines-deleted" | "text-not-found" | "ambiguous" | "binary" | "rewritten";

export interface Placement {
  state: AnchorState;
  path: string | null;
  start: number | null;
  end: number | null;
  method: Method | null;
  reason?: OutdatedReason;
}

export function outdated(reason: OutdatedReason): Placement {
  return { state: "outdated", path: null, start: null, end: null, method: null, reason };
}

export function sliceLines(lines: string[], start: number, end: number): string[] {
  return lines.slice(start - 1, end);
}

export function contextAround(lines: string[], start: number, end: number, n = CONTEXT_LINES) {
  return {
    before: lines.slice(Math.max(0, start - 1 - n), start - 1),
    after: lines.slice(end, end + n),
  };
}

function equalLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function normalizeWs(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function isChangedOld(line: number, hunks: Hunk[]): boolean {
  for (const h of hunks) if (h.oldCount > 0 && line >= h.oldStart && line < h.oldStart + h.oldCount) return true;
  return false;
}

export function mapLine(line: number, hunks: Hunk[]): number | null {
  if (isChangedOld(line, hunks)) return null;
  let delta = 0;
  for (const h of hunks) {
    if (h.oldCount > 0) {
      if (h.oldStart + h.oldCount - 1 < line) delta += h.newCount - h.oldCount;
    } else if (h.oldStart < line) {
      delta += h.newCount;
    }
  }
  return line + delta;
}

export function isTouched(start: number, end: number, hunks: Hunk[]): boolean {
  for (const h of hunks) {
    if (h.oldCount > 0) {
      if (h.oldStart <= end && h.oldStart + h.oldCount - 1 >= start) return true;
    } else if (h.oldStart >= start && h.oldStart <= end - 1) {
      return true;
    }
  }
  return false;
}

function countOccurrences(hay: string[], needle: string[], eq: (a: string, b: string) => boolean): number[] {
  const found: number[] = [];
  if (needle.length === 0) return found;
  outer: for (let p = 0; p + needle.length <= hay.length; p++) {
    for (let i = 0; i < needle.length; i++) if (!eq(hay[p + i]!, needle[i]!)) continue outer;
    found.push(p + 1);
  }
  return found;
}

function contextScore(a: AnchorSpec, lines: string[], p: number): number {
  let score = 0;
  for (let i = 0; i < a.before.length; i++) {
    const idx = p - 1 - a.before.length + i;
    if (idx >= 0 && lines[idx] === a.before[i]) score++;
  }
  for (let i = 0; i < a.after.length; i++) {
    const idx = p - 1 + a.lines.length + i;
    if (idx < lines.length && lines[idx] === a.after[i]) score++;
  }
  return score;
}

function pickCandidate(a: AnchorSpec, lines: string[], candidates: number[], expected: number): number | "ambiguous" | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  let best: number[] = [];
  let bestScore = -1;
  for (const p of candidates) {
    const s = contextScore(a, lines, p);
    if (s > bestScore) {
      bestScore = s;
      best = [p];
    } else if (s === bestScore) best.push(p);
  }
  if (best.length === 1) return best[0]!;
  let closest: number[] = [];
  let bestDist = Infinity;
  for (const p of best) {
    const d = Math.abs(p - expected);
    if (d < bestDist) {
      bestDist = d;
      closest = [p];
    } else if (d === bestDist) closest.push(p);
  }
  return closest.length === 1 ? closest[0]! : "ambiguous";
}

const exactEq = (x: string, y: string) => x === y;
const wsEq = (x: string, y: string) => normalizeWs(x) === normalizeWs(y);

function isSignificant(lines: string[]): boolean {
  return lines.join("").replace(/\s/g, "").length >= 12;
}

function unchangedPlacement(a: AnchorSpec, newPath: string, start: number, method: Method): Placement {
  const moved = newPath !== a.path || start !== a.start;
  return {
    state: moved ? "moved" : "ok",
    path: newPath,
    start,
    end: start + a.lines.length - 1,
    method,
  };
}

export function reanchor(a: AnchorSpec, c: FileChange): Placement {
  if (c.kind === "deleted") return outdated("file-deleted");
  if (c.kind === "binary") return outdated("binary");
  const len = a.end - a.start + 1;
  if (c.kind === "same") {
    if (equalLines(sliceLines(c.newLines, a.start, a.end), a.lines)) {
      return unchangedPlacement(a, c.newPath, a.start, "identity");
    }
    return reanchor(a, { kind: "modified", newPath: c.newPath, oldLines: a.lines, newLines: c.newLines, hunks: [] });
  }

  const { hunks, newLines, oldLines, newPath } = c;

  if (!isTouched(a.start, a.end, hunks)) {
    const ns = mapLine(a.start, hunks);
    if (ns !== null && equalLines(sliceLines(newLines, ns, ns + len - 1), a.lines)) {
      return unchangedPlacement(a, newPath, ns, hunks.length ? "offset" : "identity");
    }
  }

  let lo = a.start - 1;
  while (lo >= 1 && isChangedOld(lo, hunks)) lo--;
  let hi = a.end + 1;
  while (hi <= oldLines.length && isChangedOld(hi, hunks)) hi++;
  const wStart = (mapLine(lo, hunks) ?? 0) + 1;
  const wEnd = (mapLine(hi, hunks) ?? newLines.length + 1) - 1;
  const expected = wStart + (a.start - lo - 1);
  const windowLines = newLines.slice(wStart - 1, Math.max(wStart - 1, wEnd));

  let ambiguous = false;

  const exactInWindow = countOccurrences(windowLines, a.lines, exactEq).map((p) => p + wStart - 1);
  const exactPick = pickCandidate(a, newLines, exactInWindow, expected);
  if (typeof exactPick === "number") return unchangedPlacement(a, newPath, exactPick, "exact");
  if (exactPick === "ambiguous") ambiguous = true;

  const wsInWindow = countOccurrences(windowLines, a.lines, wsEq).map((p) => p + wStart - 1);
  const wsPick = pickCandidate(a, newLines, wsInWindow, expected);
  if (typeof wsPick === "number") {
    return { state: "changed", path: newPath, start: wsPick, end: wsPick + len - 1, method: "whitespace" };
  }
  if (wsPick === "ambiguous") ambiguous = true;

  let pending: OutdatedReason | null = null;
  const spill = a.start - 1 - lo + (hi - 1 - a.end);
  if (spill <= Math.max(3, len)) {
    const nlen = wEnd - wStart + 1;
    if (nlen <= 0) pending = "lines-deleted";
    else if (nlen > 3 * (len + spill) + 10) pending = "rewritten";
    else return { state: "changed", path: newPath, start: wStart, end: wEnd, method: "boundary" };
  } else {
    pending = "rewritten";
  }

  if (isSignificant(a.lines)) {
    const inNew = countOccurrences(newLines, a.lines, exactEq);
    const inOld = countOccurrences(oldLines, a.lines, exactEq);
    if (inNew.length === 1 && inOld.length <= 1) return unchangedPlacement(a, newPath, inNew[0]!, "exact");
    if (inNew.length > 1) ambiguous = true;
  }

  if (ambiguous) return outdated("ambiguous");
  return outdated(pending ?? "text-not-found");
}

export function specAt(path: string, lines: string[], start: number, end: number): AnchorSpec {
  const { before, after } = contextAround(lines, start, end);
  return { path, start, end, lines: sliceLines(lines, start, end), before, after };
}
