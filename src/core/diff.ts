import { git } from "./git.ts";

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface RawChange {
  status: string;
  score: number | null;
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
  oldPath: string;
  newPath: string;
}

export const NULL_BLOB = /^0+$/;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of patch.split("\n")) {
    const m = HUNK_RE.exec(line);
    if (!m) continue;
    hunks.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

export function parseRawZ(out: string): RawChange[] {
  const parts = out.split("\0");
  const result: RawChange[] = [];
  let i = 0;
  while (i < parts.length) {
    const head = parts[i++];
    if (!head) continue;
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(head);
    if (!m) continue;
    const status = m[5]!;
    const src = parts[i++] ?? "";
    const dst = status === "R" || status === "C" ? (parts[i++] ?? "") : src;
    result.push({
      status,
      score: m[6] ? Number(m[6]) : null,
      oldMode: m[1]!,
      newMode: m[2]!,
      oldBlob: m[3]!,
      newBlob: m[4]!,
      oldPath: src,
      newPath: dst,
    });
  }
  return result;
}

const rawCache = new Map<string, RawChange[]>();
const hunkCache = new Map<string, Hunk[]>();

function remember<V>(map: Map<string, V>, key: string, value: V, max = 256): V {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as string);
  return value;
}

export async function diffTreeRaw(cwd: string, from: string, to: string): Promise<RawChange[]> {
  const key = `${from}..${to}`;
  const hit = rawCache.get(key);
  if (hit) return hit;
  const out = await git(["diff-tree", "-r", "-M", "--no-abbrev", "-z", "--raw", from, to], { cwd });
  return remember(rawCache, key, parseRawZ(out));
}

export async function blobHunks(cwd: string, oldBlob: string, newBlob: string): Promise<Hunk[]> {
  const key = `${oldBlob}..${newBlob}`;
  const hit = hunkCache.get(key);
  if (hit) return hit;
  if (oldBlob === newBlob) return remember(hunkCache, key, []);
  const out = await git(
    ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--histogram", "-U0", oldBlob, newBlob],
    { cwd },
  );
  return remember(hunkCache, key, parseHunks(out), 2048);
}

export async function unifiedPatch(cwd: string, from: string, to: string, paths: string[], context = 3): Promise<string> {
  return git(
    ["diff-tree", "-p", "-M", "--no-ext-diff", "--no-textconv", "--histogram", `-U${context}`, from, to, "--", ...paths],
    { cwd },
  );
}

export interface NumstatEntry {
  additions: number | null;
  deletions: number | null;
  oldPath: string;
  newPath: string;
}

export async function numstat(cwd: string, from: string, to: string): Promise<NumstatEntry[]> {
  const out = await git(["diff-tree", "-r", "-M", "--numstat", "-z", from, to], { cwd });
  const parts = out.split("\0");
  const result: NumstatEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const head = parts[i++];
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(head);
    if (!m) continue;
    const additions = m[1] === "-" ? null : Number(m[1]);
    const deletions = m[2] === "-" ? null : Number(m[2]);
    if (m[3] === "") {
      const oldPath = parts[i++] ?? "";
      const newPath = parts[i++] ?? "";
      result.push({ additions, deletions, oldPath, newPath });
    } else {
      result.push({ additions, deletions, oldPath: m[3]!, newPath: m[3]! });
    }
  }
  return result;
}
