import { statSync } from "node:fs";
import { join } from "node:path";
import { nowSource, type Ctx, type NowSource } from "./context.ts";
import { git, gitRun, gitTry, Lru } from "./git.ts";
import type { ReviewRow } from "./store/db.ts";
import type { GitFileDto, GitStateDto } from "./types.ts";

const MAX_FILES = 1000;
const MAX_UNPUSHED = 50;

export interface WorktreeStatus {
  head: string | null;
  branch: string | null;
  files: GitFileDto[];
  /** Changes whenever the status or the content of a changed file does: a cheap "did anything move". */
  fingerprint: string;
}

/** `git status --porcelain=v2 -z` of a worktree. */
export function parseStatus(out: string): Omit<WorktreeStatus, "fingerprint"> {
  const records = out.split("\0");
  let head: string | null = null;
  let branch: string | null = null;
  const files: GitFileDto[] = [];
  const file = (path: string, xy: string, extra: Partial<GitFileDto> = {}) =>
    files.push({ path, staged: xy[0] !== ".", unstaged: xy[1] !== ".", untracked: false, conflict: false, unpushed: false, ...extra });
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (!rec) continue;
    if (rec.startsWith("# branch.oid ")) head = /^[0-9a-f]{7,64}$/.test(rec.slice(13)) ? rec.slice(13) : null;
    else if (rec.startsWith("# branch.head ")) branch = rec.slice(14) === "(detached)" ? null : rec.slice(14);
    else if (rec.startsWith("1 ")) file(fields(rec, 8), rec.slice(2, 4));
    else if (rec.startsWith("2 ")) {
      file(fields(rec, 9), rec.slice(2, 4));
      i++;
    } else if (rec.startsWith("u ")) file(fields(rec, 10), rec.slice(2, 4), { staged: false, unstaged: true, conflict: true });
    else if (rec.startsWith("? ")) file(rec.slice(2), "..", { untracked: true });
  }
  return { head, branch, files };
}

function fields(rec: string, n: number): string {
  let at = 0;
  for (let k = 0; k < n; k++) at = rec.indexOf(" ", at) + 1;
  return rec.slice(at);
}

export async function worktreeStatus(path: string): Promise<WorktreeStatus> {
  const r = await gitRun(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--no-renames"], { cwd: path });
  if (r.code !== 0) throw new Error(`git status failed in ${path}: ${r.stderr.trim()}`);
  const out = new TextDecoder().decode(r.stdout);
  const parsed = parseStatus(out);
  const hash = new Bun.CryptoHasher("sha1");
  hash.update(out);
  for (const f of parsed.files) {
    try {
      const st = statSync(join(path, f.path));
      hash.update(`\0${st.mtimeMs}:${st.size}`);
    } catch {
      hash.update("\0-");
    }
  }
  return { ...parsed, fingerprint: hash.digest("hex") };
}

interface Remote {
  upstream: string | null;
  upstreamSha: string | null;
  tracking: boolean;
  gone: boolean;
}

async function remoteOf(cwd: string, branch: string): Promise<Remote> {
  const set = await gitTry(["for-each-ref", "--format=%(upstream)", "--end-of-options", `refs/heads/${branch}`], { cwd });
  if (set) {
    const sha = await gitTry(["rev-parse", "-q", "--verify", "--end-of-options", `${set}^{commit}`], { cwd });
    return { upstream: short(set), upstreamSha: sha, tracking: true, gone: !sha };
  }
  const remotes = ((await gitTry(["remote"], { cwd })) ?? "").split("\n").filter(Boolean);
  for (const remote of remotes) {
    const ref = `refs/remotes/${remote}/${branch}`;
    const sha = await gitTry(["rev-parse", "-q", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd });
    if (sha) return { upstream: short(ref), upstreamSha: sha, tracking: false, gone: false };
  }
  return { upstream: null, upstreamSha: null, tracking: false, gone: false };
}

const short = (ref: string) => ref.replace(/^refs\/(remotes|heads)\//, "");

interface Ahead {
  ahead: number;
  behind: number;
  unpushed: { sha: string; subject: string }[];
  paths: string[];
}

const aheadCache = new Lru<Ahead>(64);

async function aheadOf(cwd: string, tip: string, upstream: string): Promise<Ahead> {
  const key = `${tip}..${upstream}`;
  const hit = aheadCache.get(key);
  if (hit) return hit;
  const counts = (await git(["rev-list", "--left-right", "--count", `${tip}...${upstream}`, "--"], { cwd })).trim().split(/\s+/).map(Number);
  const ahead = counts[0] ?? 0;
  const behind = counts[1] ?? 0;
  let unpushed: Ahead["unpushed"] = [];
  let paths: string[] = [];
  if (ahead > 0) {
    const log = await git(["log", `--max-count=${MAX_UNPUSHED}`, "-z", "--format=%H%x1f%s", `${upstream}..${tip}`, "--"], { cwd });
    unpushed = log.split("\0").filter(Boolean).map((rec) => {
      const [sha, subject] = rec.split("\x1f");
      return { sha: sha!, subject: subject ?? "" };
    });
    const base = await gitTry(["merge-base", tip, upstream], { cwd });
    if (base) paths = (await git(["diff-tree", "-r", "--name-only", "-z", "--no-renames", base, tip], { cwd })).split("\0").filter(Boolean);
  }
  const result = { ahead, behind, unpushed, paths };
  aheadCache.set(key, result);
  return result;
}

/** Where the review's branch stands in git: pushed or not, and what in the worktree is staged, unstaged or new. */
export async function gitState(ctx: Ctx, review: ReviewRow, src?: NowSource, status?: WorktreeStatus): Promise<GitStateDto> {
  const from = src ?? (await nowSource(ctx, review));
  const st = status ?? (from.kind === "worktree" ? await worktreeStatus(from.path) : null);
  const cwd = from.kind === "worktree" ? from.path : ctx.repo.cwd;
  const tip = await gitTry(["rev-parse", "-q", "--verify", "--end-of-options", `refs/heads/${review.branch}^{commit}`], { cwd });
  const remote = await remoteOf(cwd, review.branch);
  // With no remote branch, every commit since the base is a commit no remote has.
  const against = remote.upstreamSha ?? (review.base_ref ? await gitTry(["rev-parse", "-q", "--verify", "--end-of-options", `${review.base_ref}^{commit}`], { cwd }) : null);
  const ahead = tip && against ? { ...(await aheadOf(cwd, tip, against)), ...(remote.upstreamSha ? {} : { behind: 0 }) } : { ahead: 0, behind: 0, unpushed: [], paths: [] };
  const byPath = new Map<string, GitFileDto>();
  for (const f of st?.files ?? []) byPath.set(f.path, f);
  for (const p of ahead.paths) {
    const f = byPath.get(p);
    if (f) f.unpushed = true;
    else byPath.set(p, { path: p, staged: false, unstaged: false, untracked: false, conflict: false, unpushed: true });
  }
  const files = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    branch: review.branch,
    worktree: from.kind === "worktree" ? from.path : null,
    detached: !!st && st.branch !== review.branch,
    tip,
    upstream: remote.upstream,
    tracking: remote.tracking,
    gone: remote.gone,
    ahead: ahead.ahead,
    behind: ahead.behind,
    unpushed: ahead.unpushed,
    files: files.slice(0, MAX_FILES),
    truncated: files.length > MAX_FILES,
  };
}
