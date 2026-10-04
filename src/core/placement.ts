import { blobHunks, diffTreeRaw, NULL_BLOB } from "./diff.ts";
import { blobIdAt, readBlobById, splitLines } from "./git.ts";
import {
  outdated,
  REANCHOR_ALGO,
  reanchor,
  specAt,
  type AnchorSpec,
  type AnchorState,
  type FileChange,
  type Placement,
} from "./reanchor.ts";
import type { Store } from "./store/db.ts";

export async function fileChange(cwd: string, from: string, to: string, path: string): Promise<FileChange> {
  if (from === to) {
    const lines = await linesAt(cwd, to, path);
    return lines === null ? { kind: "deleted" } : { kind: "same", newPath: path, newLines: lines };
  }
  const changes = await diffTreeRaw(cwd, from, to);
  const entry = changes.find((c) => c.oldPath === path && c.status !== "A");
  if (!entry) {
    const lines = await linesAt(cwd, to, path);
    return lines === null ? { kind: "deleted" } : { kind: "same", newPath: path, newLines: lines };
  }
  if (entry.status === "D" || NULL_BLOB.test(entry.newBlob)) return { kind: "deleted" };
  if (entry.newMode === "160000") return { kind: "binary", newPath: entry.newPath };
  const newBlob = await readBlobById(cwd, entry.newBlob);
  if (newBlob.binary) return { kind: "binary", newPath: entry.newPath };
  const newLines = splitLines(newBlob.text);
  if (entry.oldBlob === entry.newBlob) return { kind: "same", newPath: entry.newPath, newLines };
  const oldBlob = await readBlobById(cwd, entry.oldBlob);
  if (oldBlob.binary) return { kind: "binary", newPath: entry.newPath };
  const hunks = await blobHunks(cwd, entry.oldBlob, entry.newBlob);
  return { kind: "modified", newPath: entry.newPath, oldLines: splitLines(oldBlob.text), newLines, hunks };
}

export async function linesAt(cwd: string, commit: string, path: string): Promise<string[] | null> {
  const id = await blobIdAt(cwd, commit, path);
  if (!id) return null;
  const blob = await readBlobById(cwd, id);
  if (blob.binary) return null;
  return splitLines(blob.text);
}

export interface StepResult {
  placement: Placement;
  spec: AnchorSpec | null;
}

function cacheKey(from: string, to: string, spec: AnchorSpec): string {
  const h = Bun.hash(JSON.stringify([spec.lines, spec.before, spec.after])).toString(36);
  return `${REANCHOR_ALGO}${spec.image ? "i" : ""}:${from}:${to}:${spec.path}:${spec.start}-${spec.end}:${h}`;
}

/** An image area stays where it is: the image is the same, renamed, changed or gone. */
async function imageStep(cwd: string, from: string, to: string, spec: AnchorSpec): Promise<StepResult> {
  let path = spec.path;
  let blob: string | null = null;
  const entry = from === to ? undefined : (await diffTreeRaw(cwd, from, to)).find((c) => c.oldPath === spec.path && c.status !== "A");
  if (!entry) blob = await blobIdAt(cwd, to, path);
  else if (entry.status !== "D" && !NULL_BLOB.test(entry.newBlob)) {
    path = entry.newPath;
    blob = entry.newBlob;
  }
  if (!blob) return { placement: outdated("file-deleted"), spec: null };
  const same = blob === spec.lines[0];
  return {
    placement: { state: same ? (path === spec.path ? "ok" : "moved") : "changed", path, start: spec.start, end: spec.end, method: same ? "identity" : "image" },
    spec: { ...spec, path, lines: [blob] },
  };
}

export async function step(
  cwd: string,
  store: Store | null,
  from: string,
  to: string,
  spec: AnchorSpec,
  persist: boolean,
): Promise<StepResult> {
  const key = cacheKey(from, to, spec);
  if (store) {
    const row = store.db.query<{ result: string }, [string]>("SELECT result FROM anchor_cache WHERE key = ?").get(key);
    if (row) return JSON.parse(row.result) as StepResult;
  }
  const result = spec.image ? await imageStep(cwd, from, to, spec) : await lineStep(cwd, from, to, spec);
  if (store && persist) {
    store.db.run("INSERT OR REPLACE INTO anchor_cache(key, result) VALUES (?, ?)", [key, JSON.stringify(result)]);
  }
  return result;
}

async function lineStep(cwd: string, from: string, to: string, spec: AnchorSpec): Promise<StepResult> {
  const change = await fileChange(cwd, from, to, spec.path);
  const placement = reanchor(spec, change);
  let next: AnchorSpec | null = null;
  if (placement.state !== "outdated" && placement.path && placement.start !== null && placement.end !== null) {
    const newLines = change.kind === "same" || change.kind === "modified" ? change.newLines : [];
    next = specAt(placement.path, newLines, placement.start, placement.end);
  }
  return { placement, spec: next };
}

export function cumulativeState(original: AnchorSpec, current: AnchorSpec | null, outdatedSeen: boolean): AnchorState {
  if (outdatedSeen || !current) return "outdated";
  const same = current.lines.length === original.lines.length && current.lines.every((l, i) => l === original.lines[i]);
  if (!same) return "changed";
  return current.path === original.path && current.start === original.start ? "ok" : "moved";
}

export interface TimelineInput {
  sha: string;
  persist: boolean;
}

export interface TimelinePoint {
  sha: string;
  step: Placement;
  state: AnchorState;
  spec: AnchorSpec | null;
}

export async function trace(
  cwd: string,
  store: Store | null,
  original: AnchorSpec,
  anchorSha: string,
  targets: TimelineInput[],
): Promise<TimelinePoint[]> {
  const points: TimelinePoint[] = [];
  let prevSha = anchorSha;
  let spec: AnchorSpec | null = original;
  let lost = false;
  for (const t of targets) {
    if (!spec || lost) {
      points.push({ sha: t.sha, step: { state: "outdated", path: null, start: null, end: null, method: null, reason: "text-not-found" }, state: "outdated", spec: null });
      continue;
    }
    const r = await step(cwd, store, prevSha, t.sha, spec, t.persist);
    if (r.placement.state === "outdated") {
      lost = true;
      points.push({ sha: t.sha, step: r.placement, state: "outdated", spec: null });
      continue;
    }
    spec = r.spec;
    prevSha = t.sha;
    points.push({ sha: t.sha, step: r.placement, state: cumulativeState(original, spec, false), spec });
  }
  return points;
}

export async function direct(cwd: string, store: Store | null, original: AnchorSpec, anchorSha: string, target: string, persist: boolean): Promise<TimelinePoint> {
  const r = await step(cwd, store, anchorSha, target, original, persist);
  if (r.placement.state === "outdated") return { sha: target, step: r.placement, state: "outdated", spec: null };
  return { sha: target, step: r.placement, state: cumulativeState(original, r.spec, false), spec: r.spec };
}
