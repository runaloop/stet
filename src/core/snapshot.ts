import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Ctx } from "./context.ts";
import { nowSource } from "./context.ts";
import { git, gitLine, gitTry } from "./git.ts";
import { nowIso, type ReviewRow, type SnapshotRow } from "./store/db.ts";
import { listWorktrees } from "./worktrees.ts";

export const DEFAULT_MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

const SECRET_NAME = /^(\.env(\.(?!example$|sample$|template$)[^/]+)?|.+\.(pem|key|p12|pfx|jks|keystore|p8)|id_(rsa|ecdsa|ed25519)|\.netrc|\.npmrc|\.pypirc)$/i;

export function looksSecret(path: string): boolean {
  return SECRET_NAME.test(path.slice(path.lastIndexOf("/") + 1));
}

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "stet",
  GIT_AUTHOR_EMAIL: "stet@localhost",
  GIT_COMMITTER_NAME: "stet",
  GIT_COMMITTER_EMAIL: "stet@localhost",
};

export interface SnapshotResult {
  sha: string;
  tree: string;
  parent: string | null;
  worktree: string | null;
  excluded: string[];
  reused: boolean;
}

export function snapshotRef(sha: string): string {
  return `refs/stet/snap/${sha}`;
}

function excludeGlobs(ctx: Ctx): string[] {
  const raw = ctx.store.meta("snapshot.exclude");
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function maxUntrackedBytes(ctx: Ctx): number {
  const raw = ctx.store.meta("snapshot.max_untracked_bytes");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UNTRACKED_BYTES;
}

async function collectExclusions(ctx: Ctx, worktree: string): Promise<string[]> {
  const excluded = new Set<string>();
  const cap = maxUntrackedBytes(ctx);
  const others = await git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: worktree });
  for (const rel of others.split("\0")) {
    if (!rel || rel.endsWith("/")) continue;
    if (looksSecret(rel)) {
      excluded.add(rel);
      continue;
    }
    try {
      const st = lstatSync(join(worktree, rel));
      if (st.isFile() && st.size > cap) excluded.add(rel);
    } catch {
      continue;
    }
  }
  for (const w of await listWorktrees(worktree)) {
    if (w.path === worktree) continue;
    const rel = relative(worktree, w.path);
    if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) excluded.add(rel.split(sep).join("/"));
  }
  return [...excluded].sort();
}

function findSnapshot(ctx: Ctx, tree: string, parent: string | null): SnapshotRow | null {
  return ctx.store.db
    .query<SnapshotRow, [string, string | null]>("SELECT * FROM snapshots WHERE tree = ? AND parent IS ? ORDER BY created_at LIMIT 1")
    .get(tree, parent);
}

export function getSnapshot(ctx: Ctx, sha: string): SnapshotRow | null {
  return ctx.store.db.query<SnapshotRow, [string]>("SELECT * FROM snapshots WHERE sha = ?").get(sha);
}

export async function promote(ctx: Ctx, sha: string): Promise<void> {
  const row = getSnapshot(ctx, sha);
  if (row && row.kept) return;
  await git(["update-ref", snapshotRef(sha), sha], { cwd: ctx.repo.cwd });
  ctx.store.db.run("UPDATE snapshots SET kept = 1 WHERE sha = ?", [sha]);
}

export async function takeWorktreeSnapshot(ctx: Ctx, worktree: string, opts: { keep: boolean; indexOnly?: boolean }): Promise<SnapshotResult> {
  const indexPath = await gitLine(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: worktree });
  const head = await gitTry(["rev-parse", "-q", "--verify", "HEAD^{commit}"], { cwd: worktree });
  const splitIndex = (await gitTry(["config", "--bool", "core.splitIndex"], { cwd: worktree })) === "true";
  const tmpDir = join(ctx.repo.commonDir, "stet", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpIndex = join(tmpDir, `index.${process.pid}.${crypto.randomUUID()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  let tree: string;
  let excluded: string[];
  try {
    if (!splitIndex && existsSync(indexPath)) {
      const st = statSync(indexPath);
      copyFileSync(indexPath, tmpIndex);
      utimesSync(tmpIndex, st.atime, st.mtime);
    } else if (head) {
      await git(["read-tree", head], { cwd: worktree, env });
    }
    excluded = opts.indexOnly ? [] : await collectExclusions(ctx, worktree);
    if (!opts.indexOnly) {
      const pathspecs = [
        ".",
        ...excluded.map((p) => `:(exclude,literal)${p}`),
        ...excludeGlobs(ctx).map((g) => `:(exclude,glob)${g}`),
      ];
      await git(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        cwd: worktree,
        env,
        input: pathspecs.join("\0") + "\0",
      });
    }
    tree = await gitLine(["write-tree"], { cwd: worktree, env });
  } finally {
    rmSync(tmpIndex, { force: true });
    rmSync(`${tmpIndex}.lock`, { force: true });
  }
  const existing = findSnapshot(ctx, tree, head);
  if (existing) {
    if (opts.keep && !existing.kept) await promote(ctx, existing.sha);
    return { sha: existing.sha, tree, parent: head, worktree, excluded, reused: true };
  }
  const args = ["commit-tree", "--no-gpg-sign", tree, "-m", "stet snapshot"];
  if (head) args.splice(3, 0, "-p", head);
  const sha = await gitLine(args, { cwd: worktree, env: SNAPSHOT_IDENTITY });
  ctx.store.db.run(
    "INSERT OR IGNORE INTO snapshots(sha, tree, parent, worktree, kept, excluded, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
    [sha, tree, head, worktree, excluded.length ? JSON.stringify(excluded) : null, nowIso()],
  );
  if (opts.keep) await promote(ctx, sha);
  return { sha, tree, parent: head, worktree, excluded, reused: false };
}

export async function registerCommitSnapshot(ctx: Ctx, commit: string, opts: { keep: boolean }): Promise<SnapshotResult> {
  const sha = await gitLine(["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`], { cwd: ctx.repo.cwd });
  const existing = getSnapshot(ctx, sha);
  if (existing) {
    if (opts.keep && !existing.kept) await promote(ctx, sha);
    return { sha, tree: existing.tree, parent: existing.parent, worktree: existing.worktree, excluded: [], reused: true };
  }
  const tree = await gitLine(["rev-parse", `${sha}^{tree}`], { cwd: ctx.repo.cwd });
  const parent = await gitTry(["rev-parse", "-q", "--verify", `${sha}^1`], { cwd: ctx.repo.cwd });
  ctx.store.db.run(
    "INSERT OR IGNORE INTO snapshots(sha, tree, parent, worktree, kept, excluded, created_at) VALUES (?, ?, ?, NULL, 0, NULL, ?)",
    [sha, tree, parent, nowIso()],
  );
  if (opts.keep) await promote(ctx, sha);
  return { sha, tree, parent, worktree: null, excluded: [], reused: false };
}

const nowCache = new Map<number, { at: number; result: SnapshotResult }>();
const NOW_TTL_MS = 2000;

export async function takeNow(ctx: Ctx, review: ReviewRow, opts: { keep: boolean; fresh?: boolean }): Promise<SnapshotResult> {
  const cached = nowCache.get(review.id);
  if (!opts.fresh && cached && Date.now() - cached.at < NOW_TTL_MS) {
    if (opts.keep) await promote(ctx, cached.result.sha);
    return cached.result;
  }
  const src = await nowSource(ctx, review);
  const result = src.kind === "worktree"
    ? await takeWorktreeSnapshot(ctx, src.path, { ...opts, indexOnly: review.source === "index" })
    : await registerCommitSnapshot(ctx, src.sha, opts);
  nowCache.set(review.id, { at: Date.now(), result });
  return result;
}

export function clearNowCache(): void {
  nowCache.clear();
}
