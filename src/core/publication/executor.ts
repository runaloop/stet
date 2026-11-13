import { conflict, usage, type Ctx } from "../context.ts";
import { git, gitLine, gitTry } from "../git.ts";
import { nowIso } from "../store/db.ts";
import { gatePublication, publicationPlan, publicationReceipts, recheckDecision } from "./service.ts";
import type { GateDecision, PublicationReceipt } from "./types.ts";

function requireAllowed(d: GateDecision): void {
  if (!d.allowed) throw conflict(d.blockers.map((b) => `${b.code}: ${b.message}`).join(" "));
}
function event(ctx: Ctx, review: number): void {
  ctx.store.addEvent({ review_id: review, type: "publication.changed", role: ctx.role, thread_id: null, comment_id: null, version_id: null, submission_id: null });
}
function update(ctx: Ctx, r: PublicationReceipt, state: PublicationReceipt["state"], commit: string | null, detail: string | null = null): void {
  ctx.store.tx(() => {
    ctx.store.db.run("UPDATE publication_executions SET state = ?, result_commit = ?, updated_at = ?, detail = ? WHERE id = ?", [state, commit, nowIso(), detail, r.id]);
    event(ctx, publicationPlan(ctx, r.plan).review);
  });
}

/** One immutable commit and expected-old-value branch update. No shell, staging, hooks or remote calls. */
export async function executePublication(ctx: Ctx, planId: string, operation: string): Promise<PublicationReceipt> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(operation)) throw usage("operation ID must contain 1–100 letters, digits, underscores or hyphens");
  const p = publicationPlan(ctx, planId);
  let receipt = publicationReceipts(ctx, planId)[0];
  if (receipt && receipt.id !== operation) throw conflict("this plan already has an operation; use its operation ID for recovery");
  if (receipt?.state === "confirmed") return receipt;
  const opts = { cwd: p.worktree, env: { GIT_NO_REPLACE_OBJECTS: "1", GIT_NAMESPACE: undefined } };
  // Dispatched operations are never blindly repeated, even after revocation or expiry.
  if (receipt && ["dispatched", "outcome_unknown"].includes(receipt.state)) {
    const actual = await gitTry(["rev-parse", "--verify", p.ref], opts);
    if (receipt.commit && actual === receipt.commit) update(ctx, receipt, "confirmed", receipt.commit);
    else update(ctx, receipt, "outcome_unknown", receipt.commit, "Cannot confirm the branch update. Inspect the recorded commit and branch; this operation will not be redispatched.");
    return publicationReceipts(ctx, planId)[0]!;
  }
  // A concurrent caller observes the same reservation; it does not become a second runner.
  // If the first runner crashed before dispatch, a new plan and fresh consent are needed.
  if (receipt) return receipt;
  const initial = await gatePublication(ctx, planId, "commit");
  requireAllowed(initial);
  if (!receipt) {
    ctx.store.tx(() => {
      requireAllowed(recheckDecision(ctx, initial));
      const at = nowIso();
      ctx.store.db.run(`INSERT INTO publication_executions(id, plan_id, grant_id, state, created_at, updated_at) VALUES (?, ?, ?, 'reserved', ?, ?)`, [operation, planId, initial.grant!, at, at]);
      event(ctx, p.review);
    });
    receipt = publicationReceipts(ctx, planId)[0]!;
  }
  // Do not transfer a reservation to a replacement grant after a failed attempt.
  if (initial.grant !== receipt.grant) throw conflict("this reservation belongs to an earlier grant; prepare a new plan");
  try {
    let commit = receipt.commit;
    if (!commit) {
      const stamp = `${Math.floor(Date.parse(receipt.createdAt) / 1000)} +0000`;
      commit = await gitLine(["-c", "core.hooksPath=/dev/null", "-c", "i18n.commitEncoding=UTF-8", "commit-tree", "--no-gpg-sign", p.tree, ...(p.head ? ["-p", p.head] : []), "-F", "-"], {
        cwd: p.worktree, input: p.commit.message,
        env: { ...opts.env, GIT_AUTHOR_NAME: p.commit.author.name, GIT_AUTHOR_EMAIL: p.commit.author.email,
          GIT_COMMITTER_NAME: p.commit.committer.name, GIT_COMMITTER_EMAIL: p.commit.committer.email,
          GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
      });
      const expected = `tree ${p.tree}\n${p.head ? `parent ${p.head}\n` : ""}author ${p.commit.author.name} <${p.commit.author.email}> ${stamp}\ncommitter ${p.commit.committer.name} <${p.commit.committer.email}> ${stamp}\n\n${p.commit.message}${p.commit.message.endsWith("\n") ? "" : "\n"}`;
      if (await git(["cat-file", "commit", commit], opts) !== expected) throw conflict("Git altered the approved commit metadata; no branch update was dispatched");
      await gitLine(["-c", "core.hooksPath=/dev/null", "update-ref", `refs/stet/publication/${operation}`, commit], opts);
      update(ctx, receipt, "reserved", commit);
      receipt = publicationReceipts(ctx, planId)[0]!;
    }
    const fresh = await gatePublication(ctx, planId, "commit", { operation });
    requireAllowed(fresh);
    ctx.store.tx(() => {
      requireAllowed(recheckDecision(ctx, fresh, operation));
      ctx.store.db.run("UPDATE publication_executions SET state = 'dispatched', updated_at = ? WHERE id = ?", [nowIso(), operation]);
      event(ctx, p.review);
    });
    // A hook must not mutate the artifact or execute repository commands as a side effect.
    await gitLine(["-c", "core.hooksPath=/dev/null", "update-ref", "--no-deref", p.ref, commit, p.head ?? "0".repeat(p.objectFormat === "sha256" ? 64 : 40)], opts);
    update(ctx, receipt, "confirmed", commit);
  } catch (error) {
    const current = publicationReceipts(ctx, planId)[0]!;
    if (current.state === "dispatched") {
      const actual = await gitTry(["rev-parse", "--verify", p.ref], opts);
      if (current.commit && actual === current.commit) update(ctx, current, "confirmed", current.commit);
      else update(ctx, current, "outcome_unknown", current.commit, "Branch update was not confirmed. Reconcile the same operation ID before taking further action.");
    } else update(ctx, current, "blocked", current.commit, "The operation stopped before dispatch. Inspect its current blockers before resuming.");
    throw error;
  }
  return publicationReceipts(ctx, planId)[0]!;
}
