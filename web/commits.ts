import { effect, signal } from "@preact/signals";
import type { CommitDto, CommitsDto } from "../src/core/types.ts";
import { api } from "./api.ts";
import { notify, reviewId, versions } from "./state.ts";

export const commits = signal<CommitsDto | null>(null);
export const commitPicker = signal(false);

let seq = 0;
export async function loadCommits(): Promise<void> {
  const id = reviewId.peek();
  if (id === null) return;
  const mine = ++seq;
  try {
    const r = await api.commits(id);
    if (mine === seq) commits.value = r;
  } catch (e) {
    if (mine === seq) notify(`commits: ${(e as Error).message}`, "error");
  }
}

export const isSha = (ref: string) => /^[0-9a-f]{7,64}$/.test(ref);

export function commitOf(ref: string): CommitDto | null {
  if (!isSha(ref)) return null;
  return commits.value?.commits.find((c) => c.sha.startsWith(ref)) ?? null;
}

/** The ref to put in a compare link: the version number when the commit is one, else a short sha. */
export function commitRef(sha: string): string {
  const v = versions.value.find((x) => x.snapshot === sha);
  return v ? String(v.number) : sha.slice(0, 12);
}

/** The listed commit a compare end points at: a sha, or a version taken at a commit. */
export function commitAt(ref: string): CommitDto | null {
  if (/^\d+$/.test(ref)) {
    const sha = versions.value.find((v) => v.number === Number(ref))?.snapshot;
    return sha ? (commits.value?.commits.find((c) => c.sha === sha) ?? null) : null;
  }
  return commitOf(ref);
}

export function commitSubject(c: CommitDto, max = 90): string {
  return c.subject.length > max ? c.subject.slice(0, max - 1) + "…" : c.subject;
}

effect(() => {
  reviewId.value;
  commits.value = null;
  commitPicker.value = false;
});
