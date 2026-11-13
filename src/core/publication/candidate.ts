import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { nowSource, usage, type Ctx } from "../context.ts";
import { git, gitLine, gitRun, gitTry } from "../git.ts";
import type { ReviewRow } from "../store/db.ts";
import type { CandidateEvidence } from "./types.ts";

/** Fresh, complete trees using a disposable index. No snapshot exclusions, UI pins or cache. */
export async function captureCandidate(ctx: Ctx, review: ReviewRow, snapshot: string): Promise<CandidateEvidence> {
  const source = await nowSource(ctx, review);
  if (source.kind !== "worktree") throw usage("publication requires the review's checked-out worktree");
  const cwd = realpathSync(source.path);
  const opts = { cwd, env: { GIT_NO_REPLACE_OBJECTS: "1", GIT_NAMESPACE: undefined } };
  const gitDir = realpathSync(await gitLine(["rev-parse", "--absolute-git-dir"], opts));
  const head = await gitTry(["rev-parse", "--verify", "HEAD^{commit}"], opts);
  const ref = await gitLine(["symbolic-ref", "HEAD"], opts);
  if (ref !== `refs/heads/${review.branch}`) throw usage("the review's worktree is on another branch or detached");
  const objectFormat = await gitLine(["rev-parse", "--show-object-format"], opts);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw usage("unsupported Git object format");
  const reviewedTree = await gitLine(["rev-parse", "--verify", `${snapshot}^{tree}`], opts);
  const entries = await git(["ls-tree", "-r", "-z", reviewedTree], opts);
  if (review.source === "worktree") {
    const reviewedPaths = new Set(entries.split("\0").filter(Boolean).map((e) => e.slice(e.indexOf("\t") + 1)));
    const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], opts);
    if (untracked.split("\0").some((p) => p && !reviewedPaths.has(p))) {
      // Do not write omitted untracked secrets or large files into Git just to discover a mismatch.
      throw usage("untracked files outside the reviewed tree need a new version or an ignore rule");
    }
  }
  if ((await gitLine(["for-each-ref", "--format=%(refname)", "refs/replace/"], opts)) ||
      existsSync(join(ctx.repo.commonDir, "info", "grafts")) ||
      await gitLine(["rev-parse", "--is-shallow-repository"], opts) !== "false") {
    throw usage("publication does not support replacements, grafts or shallow history");
  }
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    if (existsSync(join(gitDir, name))) throw usage("finish the current merge, rebase or cherry-pick before publication");
  }
  const flags = await git(["ls-files", "-v", "-z"], opts);
  if (flags.split("\0").some((f) => f && (f[0] === "S" || f[0] !== f[0]!.toUpperCase()))) {
    throw usage("publication does not support sparse or assume-unchanged index entries");
  }
  const dir = join(ctx.repo.commonDir, "stet", "tmp");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `publication-index.${process.pid}.${crypto.randomUUID()}`);
  const indexPath = await gitLine(["rev-parse", "--path-format=absolute", "--git-path", "index"], opts);
  const env = { ...opts.env, GIT_INDEX_FILE: temp };
  let indexTree: string;
  let worktreeTree: string | null = null;
  try {
    if (existsSync(indexPath)) {
      const st = statSync(indexPath);
      copyFileSync(indexPath, temp);
      utimesSync(temp, st.atime, st.mtime);
      await git(["update-index", "--no-split-index"], { cwd, env });
    } else await git(["read-tree", ...(head ? [head] : ["--empty"])], { cwd, env });
    indexTree = await gitLine(["write-tree"], { cwd, env });
    if (review.source === "worktree") {
      await git(["add", "-A", "--", "."], { cwd, env });
      worktreeTree = await gitLine(["write-tree"], { cwd, env });
    }
  } finally {
    rmSync(temp, { force: true });
    rmSync(`${temp}.lock`, { force: true });
  }
  // Pointer approval cannot vouch for bytes stored in another repository or on an LFS server.
  if (entries.split("\0").some((e) => e.startsWith("160000 "))) throw usage("submodule publication is not supported");
  const lfs = await gitRun(["grep", "-I", "-l", "-e", "^version https://git-lfs.github.com/spec/v1$", reviewedTree, "--"], opts);
  if (lfs.code !== 1) throw usage(lfs.code === 0 ? "LFS publication is not supported" : "cannot inspect LFS pointers");
  if (head !== await gitTry(["rev-parse", "--verify", "HEAD^{commit}"], opts) || ref !== await gitLine(["symbolic-ref", "HEAD"], opts)) {
    throw usage("the source branch changed during candidate capture");
  }
  return { worktree: cwd, gitDir, ref, head, objectFormat, indexTree, worktreeTree, reviewedTree };
}
