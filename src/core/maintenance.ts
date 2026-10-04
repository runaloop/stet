import { conflict, type Ctx } from "./context.ts";
import { git, gitTry } from "./git.ts";
import { nowIso, type ReviewRow } from "./store/db.ts";

export function closeReview(ctx: Ctx, review: ReviewRow): void {
  ctx.store.db.run("UPDATE reviews SET state = 'closed', closed_at = ? WHERE id = ?", [nowIso(), review.id]);
}

export function moveReview(ctx: Ctx, review: ReviewRow, to: string): void {
  ctx.store.tx(() => {
    const clash = ctx.store.db
      .query<{ id: number }, [string]>("SELECT id FROM reviews WHERE branch = ? AND state = 'active'")
      .get(to);
    if (clash) throw conflict(`branch '${to}' already has active review ${clash.id}`);
    ctx.store.db.run("UPDATE reviews SET branch = ? WHERE id = ?", [to, review.id]);
  });
}

export async function prune(ctx: Ctx, opts: { dryRun: boolean }): Promise<{ refs: string[]; rows: number }> {
  const referenced = new Set<string>(
    ctx.store.db
      .query<{ sha: string }, []>(
        `SELECT snapshot AS sha FROM versions
         UNION SELECT anchor_sha FROM threads
         UNION SELECT snapshot FROM comments WHERE snapshot IS NOT NULL`,
      )
      .all()
      .map((r) => r.sha),
  );
  const out = await gitTry(["for-each-ref", "--format=%(refname) %(objectname)", "refs/stet/snap/"], { cwd: ctx.repo.cwd });
  const refs = (out ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ") as [string, string])
    .filter(([, sha]) => !referenced.has(sha))
    .map(([ref]) => ref);
  const staleRows = ctx.store.db
    .query<{ sha: string }, []>("SELECT sha FROM snapshots")
    .all()
    .filter((r) => !referenced.has(r.sha))
    .map((r) => r.sha);
  if (!opts.dryRun) {
    if (refs.length) {
      await git(["update-ref", "--stdin"], { cwd: ctx.repo.cwd, input: refs.map((r) => `delete ${r}\n`).join("") });
    }
    ctx.store.tx(() => {
      for (const sha of staleRows) ctx.store.db.run("DELETE FROM snapshots WHERE sha = ?", [sha]);
      ctx.store.db.run("DELETE FROM anchor_cache");
    });
  }
  return { refs, rows: staleRows.length };
}
