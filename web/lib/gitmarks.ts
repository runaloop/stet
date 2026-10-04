import type { GitFileDto, GitStateDto } from "../../src/core/types.ts";

export type Tone = "ok" | "warn" | "bad" | "soft" | "accent";

export interface Mark {
  text: string;
  tone: Tone;
  title: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What git says about one file now. `indexOnly`: the review reads the index (`init --staged`), so changes that
 * are not staged are not in it.
 */
export function fileMarks(f: GitFileDto | undefined, indexOnly: boolean): Mark[] {
  if (!f) return [];
  const out: Mark[] = [];
  const outside = indexOnly ? " They are not in this review: it reads only what is staged." : "";
  if (f.conflict) out.push({ text: "conflict", tone: "bad", title: "unmerged: the file has a merge conflict" });
  else if (f.untracked) out.push({ text: "new", tone: indexOnly ? "warn" : "soft", title: `untracked: not added to git yet.${outside}` });
  else if (f.staged && f.unstaged) out.push({ text: "partly staged", tone: indexOnly ? "warn" : "accent", title: `some changes are staged (git add), more are not.${outside}` });
  // In a review of the index everything it shows is staged; the mark would be on every file.
  else if (f.staged && !indexOnly) out.push({ text: "staged", tone: "accent", title: "the changes are staged (git add) and not committed" });
  else if (f.unstaged) out.push({ text: "not staged", tone: indexOnly ? "warn" : "soft", title: `changed in the working tree, not staged and not committed.${outside}` });
  if (f.unpushed) out.push({ text: "↑", tone: "soft", title: "changed by commits that are not pushed" });
  return out;
}

export interface GitCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
}

export function gitCounts(g: GitStateDto): GitCounts {
  const c: GitCounts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  for (const f of g.files) {
    if (f.conflict) c.conflicts++;
    else if (f.untracked) c.untracked++;
    else {
      if (f.staged) c.staged++;
      if (f.unstaged) c.unstaged++;
    }
  }
  return c;
}

/** The header's short line: pushed or not, then what the worktree holds that is not committed. */
export function gitSummary(g: GitStateDto, indexOnly: boolean): Mark[] {
  const out: Mark[] = [];
  const c = gitCounts(g);
  if (!g.upstream) {
    out.push({ text: g.ahead ? `not pushed · ${plural(g.ahead, "commit")}` : "not pushed", tone: "warn", title: `${g.branch} is on no remote${g.ahead ? `: ${plural(g.ahead, "commit")} since the base` : ""}` });
  } else if (g.gone) {
    out.push({ text: "remote branch gone", tone: "warn", title: `${g.upstream} was the upstream of ${g.branch}; it is not there any more (deleted on the remote, or pruned)` });
  } else {
    const where = `${g.upstream}${g.tracking ? "" : " (a remote branch of the same name; no upstream is set)"}`;
    if (g.ahead) out.push({ text: `↑${g.ahead} not pushed`, tone: "warn", title: `${plural(g.ahead, "commit")} of ${g.branch} not pushed to ${where}` });
    if (g.behind) out.push({ text: `↓${g.behind}`, tone: "soft", title: `${where} has ${plural(g.behind, "commit")} that ${g.branch} does not (as of the last fetch)` });
    if (!g.ahead && !g.behind) out.push({ text: "pushed", tone: "ok", title: `${g.branch} is the same as ${where} (as of the last fetch)` });
  }
  if (c.conflicts) out.push({ text: plural(c.conflicts, "conflict"), tone: "bad", title: "files with merge conflicts" });
  if (c.staged) out.push({ text: `${c.staged} staged`, tone: "accent", title: `${plural(c.staged, "file")} with changes staged (git add), not committed` });
  if (indexOnly && c.unstaged + c.untracked) {
    const n = c.unstaged + c.untracked;
    out.push({ text: `${n} not in review`, tone: "warn", title: `${plural(n, "file")} with changes that are not staged${c.untracked ? ` (${c.untracked} new)` : ""}: this review reads only the index, so it does not show them` });
  } else {
    if (c.unstaged) out.push({ text: `${c.unstaged} not staged`, tone: "soft", title: `${plural(c.unstaged, "file")} changed in the working tree, not staged` });
    if (c.untracked) out.push({ text: `${c.untracked} new`, tone: "soft", title: `${plural(c.untracked, "file")} not added to git` });
  }
  return out;
}
