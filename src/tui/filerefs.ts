/**
 * Files a message names (`RetryQueue.kt:14-15`), found and resolved as the web does (src/ui/filerefs.ts, web/filerefs.ts):
 * a name that is one file of the review links to its lines at the code the message was written against; one several
 * files have opens the file finder with the name typed in.
 */
import type { CommentDto, VersionDto } from "../core/types.ts";
import { fileRefs, resolveFile, type FileIndex, type FileRef } from "../ui/filerefs.ts";

/** The references in a message's text, its inline code and its code blocks (a block's language line left out), as the web's Body looks for them. */
export function messageRefs(text: string): FileRef[] {
  const out: FileRef[] = [];
  const add = (seg: string, at: number) => {
    for (const r of fileRefs(seg)) out.push({ ...r, index: r.index + at });
  };
  let pos = 0;
  text.split("```").forEach((block, i) => {
    if (i % 2 === 1) {
      const lang = /^\w*\n/.exec(block)?.[0].length ?? 0;
      add(block.slice(lang), pos + lang);
    } else {
      let at = pos;
      for (const seg of block.split(/(`[^`\n]+`)/)) {
        if (seg.startsWith("`") && seg.endsWith("`") && seg.length > 1) add(seg.slice(1, -1), at + 1);
        else add(seg, at);
        at += seg.length;
      }
    }
    pos += block.length + 3;
  });
  return out;
}

/** The files a reference names: the branch diff's, else the repository's at the tip; null while one of them is not known yet. */
export function targetsOf(ref: FileRef, branch: FileIndex | null, tree: FileIndex | null): string[] | null {
  if (!branch) return null;
  const inDiff = resolveFile(ref, [branch]);
  return inDiff?.length ? inDiff : resolveFile(ref, [tree]);
}

/** A reference of a message that names files of the review: where it is in the text, and the files. */
export interface RefLink {
  ref: FileRef;
  paths: string[];
  /** What a click on it does: `fref:<comment>:<n>`. */
  hit: string;
}

/** The references of a message that link, with their files; none while the files are not known yet. */
export function linksOf(c: CommentDto, branch: FileIndex | null, tree: FileIndex | null): RefLink[] {
  const out: RefLink[] = [];
  messageRefs(c.body).forEach((ref, n) => {
    const paths = targetsOf(ref, branch, tree);
    if (paths?.length) out.push({ ref, paths, hit: `fref:${c.id}:${n}` });
  });
  return out;
}

/** The code a message was written against. */
export interface MessageCode {
  thread: number;
  agent: boolean;
  /** The worktree when it was written, and the latest version then. */
  snapshot: string | null;
  version: number | null;
}

export function messageCode(threadId: number, c: CommentDto): MessageCode {
  return { thread: threadId, agent: c.role === "agent", snapshot: c.snapshot, version: c.version };
}

export interface CodeState {
  sha: string;
  label: string;
  note?: string;
}

/**
 * Where a reference's lines are, best first: the code the message was written against, the worktree then (an agent
 * replies before it hands its fix over as a version) or its version then; the branch's tip last.
 */
export function statesOf(from: MessageCode, versions: readonly VersionDto[], tip: { sha: string; label: string } | null): CodeState[] {
  const whose = `as in the ${from.agent ? "agent's reply" : "message"} on #${from.thread}`;
  const out: CodeState[] = [];
  if (from.snapshot) {
    const same = versions.find((v) => v.snapshot === from.snapshot);
    const label = same ? `v${same.number}` : from.snapshot.slice(0, 7);
    out.push({ sha: from.snapshot, label, note: `${whose} (${same ? label : from.version ? `the code after v${from.version}` : "the code before v1"})` });
  }
  const then = versions.find((v) => v.number === from.version);
  if (then) out.push({ sha: then.snapshot, label: `v${then.number}`, note: `${whose} (v${then.number})` });
  if (tip) out.push({ sha: tip.sha, label: tip.label });
  return out;
}
