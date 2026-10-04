import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { gitTry } from "./git.ts";
import { Store, type ReviewRow, type Role } from "./store/db.ts";
import { listWorktrees } from "./worktrees.ts";

export class StetError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
    readonly code: string = "error",
  ) {
    super(message);
    this.name = "StetError";
  }
}

export const notFound = (what: string) => new StetError(`${what} not found`, 2, "not_found");
export const forbidden = (msg: string) => new StetError(msg, 3, "forbidden");
export const conflict = (msg: string) => new StetError(msg, 3, "conflict");
export const usage = (msg: string) => new StetError(msg, 1, "usage");

export interface Repo {
  cwd: string;
  toplevel: string | null;
  commonDir: string;
  gitDir: string;
}

export async function openRepo(cwd: string): Promise<Repo> {
  const out = await gitTry(
    ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel"],
    { cwd },
  );
  if (out === null) {
    const bare = await gitTry(["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"], { cwd });
    if (bare === null) throw new StetError(`not a git repository: ${cwd}`, 4, "no_repo");
    const [commonDir, gitDir] = bare.split("\n");
    return { cwd, toplevel: null, commonDir: commonDir!, gitDir: gitDir! };
  }
  const [commonDir, gitDir, toplevel] = out.split("\n");
  return { cwd, toplevel: toplevel ?? null, commonDir: commonDir!, gitDir: gitDir! };
}

export interface Ctx {
  repo: Repo;
  store: Store;
  role: Role;
  author: string;
}

export async function openContext(opts: { cwd: string; role?: Role; author?: string }): Promise<Ctx> {
  const repo = await openRepo(opts.cwd);
  const store = Store.openInCommonDir(repo.commonDir);
  const role: Role = opts.role ?? (process.env.STET_ROLE === "reviewer" ? "reviewer" : "agent");
  const author = opts.author ?? process.env.STET_AUTHOR ?? (role === "reviewer" ? "reviewer" : "agent");
  return { repo, store, role, author };
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const ref = await gitTry(["symbolic-ref", "-q", "HEAD"], { cwd });
  return ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
}

export async function defaultBaseRef(cwd: string, branch: string): Promise<string | null> {
  const originHead = (await gitTry(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { cwd }))?.replace(/^refs\/remotes\//, "") ?? null;
  const candidates = [originHead, "origin/main", "origin/master", "main", "master"].filter(
    (c): c is string => !!c && c !== branch,
  );
  for (const c of candidates) {
    if (await gitTry(["rev-parse", "-q", "--verify", `${c}^{commit}`], { cwd })) return c;
  }
  return null;
}

export function activeReviewForBranch(store: Store, branch: string): ReviewRow | null {
  return store.db
    .query<ReviewRow, [string]>("SELECT * FROM reviews WHERE branch = ? AND state = 'active'")
    .get(branch);
}

export function reviewById(store: Store, id: number): ReviewRow {
  const r = store.db.query<ReviewRow, [number]>("SELECT * FROM reviews WHERE id = ?").get(id);
  if (!r) throw notFound(`review ${id}`);
  return r;
}

export async function reviewBranchName(ctx: Ctx, branchOpt?: string): Promise<string | null> {
  if (branchOpt) return branchOpt;
  if (process.env.STET_BRANCH) return process.env.STET_BRANCH;
  return currentBranch(ctx.repo.cwd);
}

export async function findReview(ctx: Ctx, branchOpt?: string): Promise<ReviewRow | null> {
  const branch = await reviewBranchName(ctx, branchOpt);
  if (branch) return activeReviewForBranch(ctx.store, branch);
  if (ctx.repo.toplevel) {
    return ctx.store.db
      .query<ReviewRow, [string]>("SELECT * FROM reviews WHERE state = 'active' AND worktree_hint = ?")
      .get(ctx.repo.toplevel);
  }
  return null;
}

export async function requireReview(ctx: Ctx, branchOpt?: string): Promise<ReviewRow> {
  const review = await findReview(ctx, branchOpt);
  if (review) return review;
  const branch = await reviewBranchName(ctx, branchOpt);
  if (!branch) {
    throw usage("HEAD is detached: pass --branch <name> or set STET_BRANCH (and run `stet init --branch <name>` once)");
  }
  throw new StetError(`no active review for branch '${branch}': run \`stet init\``, 2, "no_review");
}

export async function initReview(
  ctx: Ctx,
  opts: { branch?: string; base?: string; worktree?: string; staged?: boolean },
): Promise<{ review: ReviewRow; created: boolean }> {
  const branch = await reviewBranchName(ctx, opts.branch);
  if (!branch) throw usage("HEAD is detached: pass --branch <name>");
  const existing = activeReviewForBranch(ctx.store, branch);
  if (existing) return { review: existing, created: false };
  const baseRef =
    opts.base ??
    (opts.staged ? "HEAD" : ((await defaultBaseRef(ctx.repo.cwd, branch)) ?? (await gitTry(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: ctx.repo.cwd }))));
  if (opts.base && !(await gitTry(["rev-parse", "-q", "--verify", "--end-of-options", `${opts.base}^{commit}`], { cwd: ctx.repo.cwd }))) {
    throw usage(`base ref '${opts.base}' does not resolve to a commit`);
  }
  let hint: string | null = null;
  if (opts.worktree) {
    hint = await gitTry(["rev-parse", "--show-toplevel"], { cwd: resolve(ctx.repo.cwd, opts.worktree) });
    if (!hint) throw usage(`--worktree '${opts.worktree}' is not inside a git worktree`);
  } else if ((await currentBranch(ctx.repo.cwd)) === null) {
    hint = ctx.repo.toplevel;
  }
  const review = ctx.store.tx(() => {
    const again = activeReviewForBranch(ctx.store, branch);
    if (again) return again;
    const r = ctx.store.db.run(
      "INSERT INTO reviews(branch, base_ref, worktree_hint, source, created_at) VALUES (?, ?, ?, ?, ?)",
      [branch, baseRef, hint, opts.staged ? "index" : "worktree", new Date().toISOString()],
    );
    return reviewById(ctx.store, Number(r.lastInsertRowid));
  });
  return { review, created: true };
}

export async function ensureReview(ctx: Ctx, branchOpt?: string): Promise<ReviewRow> {
  const found = await findReview(ctx, branchOpt);
  if (found) return found;
  return (await initReview(ctx, { branch: branchOpt })).review;
}

export type NowSource = { kind: "worktree"; path: string } | { kind: "commit"; sha: string };

export async function nowSource(ctx: Ctx, review: ReviewRow): Promise<NowSource> {
  const worktrees = await listWorktrees(ctx.repo.cwd);
  const holder = worktrees.find((w) => w.branch === review.branch && !w.bare);
  if (holder && existsSync(holder.path)) return { kind: "worktree", path: holder.path };
  if (review.worktree_hint && existsSync(review.worktree_hint)) return { kind: "worktree", path: review.worktree_hint };
  const tip = await gitTry(["rev-parse", "-q", "--verify", "--end-of-options", `refs/heads/${review.branch}^{commit}`], { cwd: ctx.repo.cwd });
  if (tip) return { kind: "commit", sha: tip };
  throw new StetError(`cannot find code for branch '${review.branch}': no worktree has it checked out and the branch does not exist`, 4, "no_source");
}

export async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
  return gitTry(["rev-parse", "-q", "--verify", "--end-of-options", `${rev}^{commit}`], { cwd });
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | null> {
  return gitTry(["merge-base", "--end-of-options", a, b], { cwd });
}
