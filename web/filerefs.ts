import { signal, untracked } from "@preact/signals";
import { fileIndex, linesText, movedLines, resolveFile, type FileIndex, type FileRef } from "../src/ui/filerefs.ts";
import type { Route } from "../src/ui/route.ts";
import { api } from "./api.ts";
import { compareData, fileChoice, peek, type Peek } from "./compare.ts";
import { picker } from "./keys.ts";
import { lastCompare, navigate, noteJump, notify, reviewId, status, tipRef, versions } from "./state.ts";

/** A message whose text names files: the code it was written against. */
export interface MessageCode {
  thread: number;
  agent: boolean;
  /** The worktree when it was written, and the latest version then. */
  snapshot: string | null;
  version: number | null;
}

/** The files of the whole branch's diff, base to the latest version or "now": references name these first. */
export interface BranchFiles {
  review: number;
  key: string;
  ref: string;
  sha: string;
  label: string;
  paths: string[];
  index: FileIndex;
}

const branchFiles = signal<BranchFiles | null>(null);
const trees = signal<ReadonlyMap<string, FileIndex>>(new Map());
const asked = new Set<string>();
let wanted = "";

/** The branch's files, asked for the first time a page needs them and again once a version or "now" moves the tip. */
export function branch(): BranchFiles | null {
  const rid = reviewId.value;
  const s = status.value;
  if (rid === null || !s) return null;
  const tip = tipRef();
  const key = `${rid}:${tip}:${versions.value.length}:${s.pinnedNow ?? ""}`;
  const b = branchFiles.value;
  if (b?.key !== key && wanted !== key) {
    wanted = key;
    api
      .compare(rid, "base", tip)
      .then((d) => {
        if (wanted !== key) return;
        const paths = d.files.filter((f) => f.status !== "D").map((f) => f.path);
        branchFiles.value = { review: rid, key, ref: tip, sha: d.to.sha, label: d.to.label, paths, index: fileIndex(paths) };
      })
      .catch(() => null);
  }
  // the older tip's files serve until the new ones come
  return b?.review === rid ? b : null;
}

function treeAt(sha: string): FileIndex | null {
  const have = trees.value.get(sha);
  if (have || asked.has(sha)) return have ?? null;
  asked.add(sha);
  const keep = (paths: string[]) => (trees.value = new Map(trees.peek()).set(sha, fileIndex(paths)));
  api.files(sha).then(
    (r) => keep(r.paths ?? []),
    () => keep([]),
  );
  return null;
}

/** The files a reference names: the branch diff's, else the repository's at the latest version; null while loading. */
export function targetsOf(ref: FileRef): string[] | null {
  const b = branch();
  if (!b) return null;
  const inDiff = resolveFile(ref, [b.index]);
  return inDiff?.length ? inDiff : resolveFile(ref, [treeAt(b.sha)]);
}

/** The Changes page at a file's lines in the whole branch: where the link goes in a new tab. */
export function branchRoute(path: string, ref: FileRef): Route | null {
  const b = branch();
  if (!b) return null;
  return { name: "compare", from: "base", to: b.ref, file: path, ...(ref.start !== null ? { line: ref.start, ...(ref.end !== ref.start ? { end: ref.end! } : {}) } : {}) };
}

interface CodeState {
  sha: string;
  label: string;
  note?: string;
}

/**
 * Where a reference's lines are, best first: the code the message was written against, the worktree then (an agent
 * replies before it hands its fix over as a version) or its version then; the latest version last.
 */
function statesOf(from: MessageCode): CodeState[] {
  const vs = versions.peek();
  const whose = `as in the ${from.agent ? "agent's reply" : "message"} on #${from.thread}`;
  const out: CodeState[] = [];
  if (from.snapshot) {
    const same = vs.find((v) => v.snapshot === from.snapshot);
    const label = same ? `v${same.number}` : from.snapshot.slice(0, 7);
    out.push({ sha: from.snapshot, label, note: `${whose} (${same ? label : from.version ? `the code after v${from.version}` : "the code before v1"})` });
  }
  const then = vs.find((v) => v.number === from.version);
  if (then) out.push({ sha: then.snapshot, label: `v${then.number}`, note: `${whose} (v${then.number})` });
  const b = untracked(branch);
  if (b) out.push({ sha: b.sha, label: b.label });
  return out;
}

/** Opens a file a message names over the thread's code, as the code was for the message, its lines marked in the middle. */
export async function openFileRef(path: string, ref: FileRef, from: MessageCode): Promise<void> {
  const states = statesOf(from);
  let at = states[0];
  for (const s of states) {
    const blob = await api.blob(s.sha, path).catch(() => null);
    if (blob?.exists) {
      at = s;
      break;
    }
  }
  if (!at) return;
  const b = untracked(branch);
  noteJump();
  peek.value = {
    path,
    jumped: true,
    sha: at.sha,
    label: at.label,
    line: ref.start ?? 1,
    ...(ref.start !== null ? { end: ref.end ?? ref.start } : {}),
    ...(at.note ? { note: at.note } : {}),
    ...(b && b.sha !== at.sha ? { latest: { sha: b.sha, label: b.label } } : {}),
  };
}

/** The preview's file and lines in the latest version: where its marked lines went since. */
export async function peekLatest(p: Peek): Promise<void> {
  if (!p.latest) return;
  const [was, now] = await Promise.all([api.blob(p.sha, p.path), api.blob(p.latest.sha, p.path)]).catch(() => [null, null]);
  if (!now?.exists || now.contents === null) {
    notify(`${p.path} is not in ${p.latest.label}`);
    return;
  }
  const lines = p.end !== undefined && was?.contents ? movedLines(was.contents, now.contents, { start: p.line, end: p.end }) : null;
  noteJump();
  peek.value = {
    path: p.path,
    jumped: true,
    sha: p.latest.sha,
    label: p.latest.label,
    line: lines?.start ?? p.line,
    ...(lines ? { end: lines.end } : {}),
    ...(lines ? { note: `the same lines in ${p.latest.label}${lines.changed ? ", edited since" : ""}` } : {}),
  };
}

/** Several files have the name a message wrote: the file finder lists them, with the name typed in. */
export function chooseFile(paths: string[], ref: FileRef, from: MessageCode): void {
  fileChoice.value = { query: ref.path, paths, open: (path) => void openFileRef(path, ref, from), lines: linesText(ref) };
  picker.value = "files";
}

/** A file picked in the finder on a thread's page: in the diff the reader came from when it has the file, else in the whole branch. */
export function openInChanges(path: string): void {
  const last = lastCompare.peek();
  const d = compareData.peek();
  const inLast = !!last && !!d && d.from.ref === last.from && d.to.ref === last.to && d.files.some((f) => f.path === path);
  const range = inLast ? last : { from: "base", to: untracked(branch)?.ref ?? tipRef() };
  navigate({ name: "compare", ...range, file: path });
}

/** The files the finder offers on a thread's page: the whole branch's, and those of the diff the reader came from. */
export function finderFiles(): string[] {
  const own = branch()?.paths ?? [];
  const seen = new Set(own);
  return [...own, ...(compareData.value?.files ?? []).map((f) => f.path).filter((p) => !seen.has(p))];
}
