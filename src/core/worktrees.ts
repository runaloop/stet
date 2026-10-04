import { git } from "./git.ts";

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
}

export function parseWorktreeList(out: string): Worktree[] {
  const result: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const field of out.split("\0")) {
    if (field === "") {
      if (cur) result.push(cur);
      cur = null;
      continue;
    }
    const sp = field.indexOf(" ");
    const key = sp === -1 ? field : field.slice(0, sp);
    const value = sp === -1 ? "" : field.slice(sp + 1);
    if (key === "worktree") {
      if (cur) result.push(cur);
      cur = { path: value, head: null, branch: null, detached: false, bare: false };
    } else if (cur) {
      if (key === "HEAD") cur.head = value;
      else if (key === "branch") cur.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "detached") cur.detached = true;
      else if (key === "bare") cur.bare = true;
    }
  }
  if (cur) result.push(cur);
  return result;
}

export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  return parseWorktreeList(await git(["worktree", "list", "--porcelain", "-z"], { cwd }));
}
