import { createHash } from "node:crypto";
import { emptyBase, notFound, resolveCommit, usage, type Ctx } from "./context.ts";
import { gist } from "./export.ts";
import { git, gitLine, Lru } from "./git.ts";
import { linesAt } from "./placement.ts";
import { firstLine, placementsAt, resolveRef, submissionTimes, threadSummaries, versionRows } from "./service.ts";
import { getSnapshot } from "./snapshot.ts";
import type { CommentRow, ReviewRow, VersionRow } from "./store/db.ts";
import type { BlameDto, BlameOriginDto, BlameRoundDto, BlameRunDto, BlameThreadDto, SubmissionDto } from "./types.ts";

/**
 * Snapshots sit on the branch HEAD of their time, not on each other, so `git blame` on one cannot tell the
 * versions apart. Blame runs on a private chain instead: base → v1 → … → vN (→ now), one commit per tree.
 * The commits have a fixed identity and date, so the same trees always give the same chain.
 */
const CHAIN_IDENTITY = {
  GIT_AUTHOR_NAME: "stet",
  GIT_AUTHOR_EMAIL: "stet@localhost",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_NAME: "stet",
  GIT_COMMITTER_EMAIL: "stet@localhost",
  GIT_COMMITTER_DATE: "@0 +0000",
};

export const blameRefPrefix = (reviewId: number) => `refs/stet/blame/${reviewId}/`;

interface Base {
  sha: string;
  tree: string;
}

interface Chain {
  links: Map<number, string>;
  tip: string | null;
  base: Base | null;
}

const chains = new Lru<Chain>(32);

async function commitTree(cwd: string, tree: string, parents: string[], message: string): Promise<string> {
  return gitLine(["commit-tree", "--no-gpg-sign", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message], { cwd, env: CHAIN_IDENTITY });
}

/**
 * The next commit of the chain. When the branch was rebased onto a newer base, that base is a second parent:
 * `git blame` passes it the lines the previous link does not have, so upstream lines stay `base`.
 */
async function link(cwd: string, prev: { sha: string; base: Base } | null, tree: string, base: Base, message: string): Promise<string> {
  if (!prev) return commitTree(cwd, tree, [await commitTree(cwd, base.tree, [], "base")], message);
  const parents = [prev.sha];
  if (base.tree !== prev.base.tree) parents.push(await commitTree(cwd, base.tree, [], "base"));
  return commitTree(cwd, tree, parents, message);
}

async function treesOf(cwd: string, shas: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(shas)];
  if (!unique.length) return new Map();
  const out = (await git(["rev-parse", ...unique.map((s) => `${s}^{tree}`)], { cwd })).trim().split("\n");
  return new Map(unique.map((s, i) => [s, out[i]!]));
}

async function baseSha(ctx: Ctx, review: ReviewRow, tip: string, fallback: string | null): Promise<string> {
  try {
    return (await resolveRef(ctx, review, "base", { baseFor: tip })).sha;
  } catch {
    return fallback ?? (await emptyBase(ctx.repo.cwd));
  }
}

/** The chain of the review's versions, kept under refs/stet/blame/<review>/<key>: a new version or a moved base makes a new key. */
async function versionChain(ctx: Ctx, review: ReviewRow, versions: VersionRow[]): Promise<Chain> {
  const cwd = ctx.repo.cwd;
  if (!versions.length) return { links: new Map(), tip: null, base: null };
  const bases: string[] = [];
  for (const v of versions) bases.push(await baseSha(ctx, review, v.snapshot, bases[bases.length - 1] ?? null));
  const trees = await treesOf(cwd, [...versions.map((v) => v.snapshot), ...bases]);
  const spec = versions.map((v, i) => `v${v.number} ${trees.get(v.snapshot)} ${trees.get(bases[i]!)}`).join("\n");
  const prefix = blameRefPrefix(review.id);
  const ref = prefix + createHash("sha256").update(spec).digest("hex").slice(0, 20);
  const memoKey = `${ctx.repo.commonDir}\0${ref}`;
  const memo = chains.get(memoKey);
  if (memo) return memo;
  const lastBase = bases[bases.length - 1]!;
  const base = { sha: lastBase, tree: trees.get(lastBase)! };
  const links = new Map<number, string>();
  let tip = await resolveCommit(cwd, ref);
  if (tip) {
    const log = await git(["log", "--first-parent", "--format=%H %s", "--end-of-options", tip], { cwd });
    for (const line of log.split("\n")) {
      const m = /^([0-9a-f]+) v(\d+)$/.exec(line);
      if (m) links.set(Number(m[2]), m[1]!);
    }
  } else {
    let prev: { sha: string; base: Base } | null = null;
    for (const [i, v] of versions.entries()) {
      const b = { sha: bases[i]!, tree: trees.get(bases[i]!)! };
      const sha = await link(cwd, prev, trees.get(v.snapshot)!, b, `v${v.number}`);
      links.set(v.number, sha);
      prev = { sha, base: b };
    }
    tip = prev!.sha;
    const stale = (await git(["for-each-ref", "--format=%(refname)", prefix], { cwd })).split("\n").filter((r) => r && r !== ref);
    await git(["update-ref", "--stdin"], { cwd, input: [`update ${ref} ${tip}`, ...stale.map((r) => `delete ${r}`)].join("\n") + "\n" });
  }
  const chain = { links, tip, base };
  chains.set(memoKey, chain);
  return chain;
}

interface Blamed {
  line: number;
  origLine: number;
  origPath: string;
  summary: string;
}

function parsePorcelain(text: string): Blamed[] {
  const summary = new Map<string, string>();
  const file = new Map<string, string>();
  const out: Blamed[] = [];
  let cur: { sha: string; orig: number; final: number } | null = null;
  for (const l of text.split("\n")) {
    if (l.startsWith("\t")) {
      if (cur) out.push({ line: cur.final, origLine: cur.orig, origPath: file.get(cur.sha) ?? "", summary: summary.get(cur.sha) ?? "" });
      continue;
    }
    const head = /^([0-9a-f]{40,64}) (\d+) (\d+)/.exec(l);
    if (head) cur = { sha: head[1]!, orig: Number(head[2]), final: Number(head[3]) };
    else if (cur && l.startsWith("summary ")) summary.set(cur.sha, l.slice("summary ".length));
    else if (cur && l.startsWith("filename ")) file.set(cur.sha, l.slice("filename ".length));
  }
  return out;
}

/**
 * The versions an agent's `fixed` reply may have brought: the next one, as on the thread's timeline ("now"
 * before it exists), and also the version it was written on when the code was that version's, for an agent
 * that handed over the version before replying.
 */
function fixedIn(ctx: Ctx, versions: VersionRow[], c: CommentRow): string[] {
  const on = versions.find((v) => v.id === c.version_id) ?? null;
  const next = versions.find((v) => v.number > (on?.number ?? 0));
  const out = [next ? `v${next.number}` : "now"];
  const tree = (sha: string | null) => (sha ? (getSnapshot(ctx, sha)?.tree ?? null) : null);
  if (on && tree(c.snapshot) !== null && tree(c.snapshot) === tree(on.snapshot)) out.push(`v${on.number}`);
  return out;
}

/** The last published `fixed` reply of each thread, by the origin (`vN`, `now`) it may have brought. */
function fixesByOrigin(ctx: Ctx, review: ReviewRow, versions: VersionRow[]): Map<string, Map<number, CommentRow>> {
  const rows = ctx.store.db
    .query<CommentRow, [number]>(
      `SELECT c.* FROM comments c JOIN threads t ON t.id = c.thread_id
       WHERE t.review_id = ? AND c.role = 'agent' AND c.intent = 'fixed' AND c.published_seq IS NOT NULL ORDER BY c.id`,
    )
    .all(review.id);
  const out = new Map<string, Map<number, CommentRow>>();
  for (const c of rows) {
    for (const key of fixedIn(ctx, versions, c)) {
      const byThread = out.get(key) ?? new Map<number, CommentRow>();
      byThread.set(c.thread_id, c);
      out.set(key, byThread);
    }
  }
  return out;
}

function roundOf(submissions: SubmissionDto[], at: string | null): BlameRoundDto | null {
  let k = 0;
  while (k < submissions.length && (at === null || submissions[k]!.at <= at)) k++;
  const s = submissions[k - 1];
  return s ? { index: k, at: s.at, verdict: s.verdict, version: s.version } : null;
}

export interface BlameInput {
  path: string;
  /** Without a range, the whole file. */
  start?: number;
  end?: number;
  /** A version (`N`, `latest`) or `now`; the latest version by default. */
  at?: string;
  pinnedNow?: string | null;
}

/** Per line at `at`: the version that brought it in its current form, the round of review it answered and the threads it fixed. */
export async function blame(ctx: Ctx, review: ReviewRow, input: BlameInput): Promise<BlameDto> {
  const cwd = ctx.repo.cwd;
  const versions = versionRows(ctx, review.id);
  const at = await resolveRef(ctx, review, input.at ?? "latest", { pinnedNow: input.pinnedNow });
  if (!at.version && !at.isNow) throw usage(`blame goes over the review's versions: --at takes a version number, latest or now, not '${at.ref}'`);
  const lines = await linesAt(cwd, at.sha, input.path);
  if (lines === null) throw notFound(`text file '${input.path}' at ${at.label}`);
  const dto: BlameDto = { path: input.path, at: { ref: at.ref, sha: at.sha, label: at.label }, range: null, runs: [] };
  if (input.start === undefined && input.end === undefined && !lines.length) return dto;
  const start = input.start ?? 1;
  const end = input.end ?? (input.start !== undefined ? start : lines.length);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
    throw usage(`range ${start}-${end} is outside '${input.path}' (${lines.length} lines at ${at.label})`);
  }
  dto.range = { start, end };

  const chain = await versionChain(ctx, review, versions);
  const latest = versions[versions.length - 1] ?? null;
  let commit: string;
  let nowSha: string | null = null;
  if (at.version) {
    commit = chain.links.get(at.version.number)!;
  } else {
    const trees = await treesOf(cwd, latest ? [at.sha, latest.snapshot] : [at.sha]);
    if (latest && trees.get(at.sha) === trees.get(latest.snapshot)) {
      commit = chain.links.get(latest.number)!;
    } else {
      nowSha = at.sha;
      const b = await baseSha(ctx, review, at.sha, chain.base?.sha ?? null);
      const base = { sha: b, tree: (await treesOf(cwd, [b])).get(b)! };
      commit = await link(cwd, chain.tip && chain.base ? { sha: chain.tip, base: chain.base } : null, trees.get(at.sha)!, base, "now");
    }
  }
  const porcelain = await git(["blame", "--porcelain", "--ignore-revs-file=", "-L", `${start},${end}`, commit, "--", input.path], {
    cwd: ctx.repo.toplevel ?? cwd,
  });
  const blamed = parsePorcelain(porcelain).sort((a, b) => a.line - b.line);

  const byNumber = new Map(versions.map((v) => [v.number, v]));
  const submissions = submissionTimes(ctx, review.id);
  const origins = new Map<string, { origin: BlameOriginDto; round: BlameRoundDto | null; sha: string | null }>();
  const originOf = (summary: string) => {
    const hit = origins.get(summary);
    if (hit) return hit;
    const v = /^v(\d+)$/.exec(summary) ? byNumber.get(Number(summary.slice(1))) : undefined;
    const o = v
      ? { origin: { kind: "version" as const, version: v.number, label: v.label, createdAt: v.created_at }, round: roundOf(submissions, v.created_at), sha: v.snapshot }
      : summary === "now"
        ? { origin: { kind: "now" as const, version: null, label: null, createdAt: null }, round: roundOf(submissions, null), sha: nowSha }
        : { origin: { kind: "base" as const, version: null, label: null, createdAt: null }, round: null, sha: null };
    origins.set(summary, o);
    return o;
  };

  const fixes = fixesByOrigin(ctx, review, versions);
  const threadsAt = new Map<string, { thread: BlameThreadDto; path: string; start: number; end: number }[]>();
  for (const summary of new Set(blamed.map((b) => b.summary))) {
    const o = originOf(summary);
    const replies = fixes.get(summary);
    if (o.origin.kind === "base" || !o.sha || !replies) continue;
    const ids = [...replies.keys()];
    const placed = await placementsAt(ctx, review, o.sha, null, { pinnedNow: o.origin.kind === "now" ? o.sha : null, ids });
    const titles = new Map((await threadSummaries(ctx, review, { ids, withAnchor: false })).map((t) => [t.id, t]));
    const list: { thread: BlameThreadDto; path: string; start: number; end: number }[] = [];
    for (const p of placed) {
      const t = titles.get(p.threadId);
      const reply = replies.get(p.threadId)!;
      if (!t) continue;
      list.push({
        thread: { id: t.id, title: t.title, status: t.status, reply: { id: reply.id, body: gist(reply.body) ?? firstLine(reply.body), at: reply.created_at } },
        path: p.path,
        start: p.range.start,
        end: p.range.end,
      });
    }
    list.sort((a, b) => a.thread.id - b.thread.id);
    threadsAt.set(summary, list);
  }

  let key = "";
  for (const b of blamed) {
    const o = originOf(b.summary);
    const threads = (threadsAt.get(b.summary) ?? [])
      .filter((t) => t.path === b.origPath && t.start <= b.origLine && b.origLine <= t.end)
      .map((t) => t.thread);
    const k = `${b.summary}|${threads.map((t) => t.id).join(",")}`;
    const last = dto.runs[dto.runs.length - 1];
    if (last && k === key && last.end === b.line - 1) {
      last.end = b.line;
      continue;
    }
    key = k;
    dto.runs.push({ start: b.line, end: b.line, origin: o.origin, round: o.round, threads } satisfies BlameRunDto);
  }
  return dto;
}
