import type { CommitDto, CommitsDto, VersionDto } from "../core/types.ts";

export const isSha = (ref: string) => /^[0-9a-f]{7,64}$/.test(ref);

export function commitOf(list: CommitsDto | null, ref: string): CommitDto | null {
  if (!isSha(ref)) return null;
  return list?.commits.find((c) => c.sha.startsWith(ref)) ?? null;
}

/** The ref to put in a compare link: the version number when the commit is one, else a short sha. */
export function commitRef(versions: readonly VersionDto[], sha: string): string {
  const v = versions.find((x) => x.snapshot === sha);
  return v ? String(v.number) : sha.slice(0, 12);
}
