import { createHash } from "node:crypto";
import { baseBelow, conflict, forbidden, notFound, reviewById, usage, type Ctx } from "../context.ts";
import { latestVersion, listDrafts, settledThreads, submitReview } from "../service.ts";
import { nowIso, type ReviewRow, type SubmissionRow } from "../store/db.ts";
import { getSnapshot } from "../snapshot.ts";
import { captureCandidate } from "./candidate.ts";
import { evaluatePublication } from "./gate.ts";
import type { Blocker, CandidateEvidence, ConsentExpectation, GateDecision, Identity, PreparePublication,
  PublicationAction, PublicationGrant, PublicationPlan, PublicationReceipt, PublicationView } from "./types.ts";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function planDigest(p: Omit<PublicationPlan, "digest"> | PublicationPlan): string {
  const { digest: _, ...document } = p as PublicationPlan;
  return createHash("sha256").update(canonical(document)).digest("hex");
}

function exactKeys(value: unknown, keys: string[], name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k)) || keys.some((k) => !(k in value))) throw usage(`invalid ${name}`);
}
function identity(v: unknown): asserts v is Identity {
  exactKeys(v, ["name", "email"], "commit identity");
  if (typeof v.name !== "string" || !v.name.trim() || v.name !== v.name.trim() || /[\x00-\x1f\x7f<>]/.test(v.name) ||
      typeof v.email !== "string" || !/^[^\s<>@]+@[^\s<>@]+$/.test(v.email)) throw usage("invalid commit identity");
}
export function checkPrepare(input: unknown): asserts input is PreparePublication {
  exactKeys(input, ["schema", "review", "version", "protection", "actions", "commit"], "publication plan input");
  if (input.schema !== 1 || input.protection !== "local") throw usage("only schema 1 with Local checks is available; Protected approval is unavailable");
  if (!Number.isSafeInteger(input.review) || Number(input.review) < 1 || !Number.isSafeInteger(input.version) || Number(input.version) < 1) throw usage("review and version must be positive integers");
  if (!Array.isArray(input.actions) || input.actions.length !== 1 || input.actions[0] !== "commit") throw usage("only one exact commit is implemented; push, MR and merge are unavailable");
  exactKeys(input.commit, ["message", "author", "committer", "signing", "timestamps"], "commit metadata");
  const c = input.commit;
  if (typeof c.message !== "string" || !c.message.trim() || c.message.includes("\0") || c.message.length > 100_000) throw usage("invalid commit message");
  identity(c.author);
  identity(c.committer);
  if (c.signing !== "none" || c.timestamps !== "execution") throw usage("only unsigned commits with execution timestamps are implemented");
}

function changed(ctx: Ctx, review: number): void {
  ctx.store.addEvent({ review_id: review, type: "publication.changed", role: ctx.role, thread_id: null, comment_id: null, version_id: null, submission_id: null });
}
export function publicationState(ctx: Ctx, review: number): { revision: number; paused: boolean } {
  const s = ctx.store.db.query<{ revision: number; paused: number }, [number]>("SELECT revision, paused FROM publication_state WHERE review_id = ?").get(review);
  if (!s) throw notFound("publication review state");
  return { revision: s.revision, paused: !!s.paused };
}
function repositoryId(ctx: Ctx, create = false): string | null {
  const key = "publication.repository";
  if (!create) return ctx.store.meta(key);
  return ctx.store.tx(() => {
    const id = ctx.store.meta(key) ?? crypto.randomUUID();
    if (!ctx.store.meta(key)) ctx.store.setMeta(key, id);
    return id;
  });
}
export function publicationPlan(ctx: Ctx, id: string): PublicationPlan {
  const row = ctx.store.db.query<{ document: string; digest: string; review_id: number; version_id: number }, [string]>("SELECT document, digest, review_id, version_id FROM publication_plans WHERE id = ?").get(id);
  if (!row) throw notFound("publication plan");
  const p: PublicationPlan = JSON.parse(row.document);
  if (p.id !== id || p.digest !== row.digest || p.review !== row.review_id || p.versionId !== row.version_id || p.schema !== 1 || p.policy !== 1 || p.digest !== planDigest(p)) throw conflict("publication plan integrity check failed");
  return p;
}
function grantFor(ctx: Ctx, id: string): PublicationGrant | null {
  const row = ctx.store.db.query<{ document: string; revoked_at: string | null }, [string]>("SELECT document, revoked_at FROM publication_grants WHERE plan_id = ? ORDER BY rowid DESC LIMIT 1").get(id);
  return row ? { ...JSON.parse(row.document), revokedAt: row.revoked_at } : null;
}
export function publicationReceipts(ctx: Ctx, id: string): PublicationReceipt[] {
  return ctx.store.db.query<PublicationReceipt, [string]>(`SELECT id, plan_id AS plan, grant_id AS grant, 'commit' AS action, state,
    result_commit AS 'commit', created_at AS createdAt, updated_at AS updatedAt, detail FROM publication_executions WHERE plan_id = ? ORDER BY rowid`).all(id);
}

export async function preparePublication(ctx: Ctx, input: unknown): Promise<PublicationPlan> {
  checkPrepare(input);
  const r = reviewById(ctx.store, input.review);
  if (r.state !== "active") throw conflict("the review is closed");
  const v = latestVersion(ctx, r.id);
  if (!v || v.number !== input.version) throw conflict("prepare the latest reviewed version");
  const before = publicationState(ctx, r.id).revision;
  const e = await captureCandidate(ctx, r, v.snapshot);
  const snap = getSnapshot(ctx, v.snapshot);
  if (!snap?.worktree || snap.parent !== e.head) throw conflict("source history changed since the version; hand over a worktree/index version based on the current HEAD");
  // Plans can be prepared before staging. Consent will check both trees again.
  const p: PublicationPlan = { ...structuredClone(input), id: crypto.randomUUID(), repository: repositoryId(ctx, true)!,
    worktree: e.worktree, gitDir: e.gitDir, objectFormat: e.objectFormat, source: r.source,
    versionId: v.id, snapshot: v.snapshot, tree: e.reviewedTree, base: v.base_sha, baseRef: r.base_ref,
    ref: e.ref, head: e.head, policy: 1, createdAt: nowIso(), digest: "" };
  p.digest = planDigest(p);
  ctx.store.tx(() => {
    if (publicationState(ctx, r.id).revision !== before) throw conflict("the review changed while preparing the plan; try again");
    ctx.store.db.run("INSERT INTO publication_plans(id, review_id, version_id, digest, document, created_at) VALUES (?, ?, ?, ?, ?, ?)", [p.id, r.id, v.id, p.digest, canonical(p), p.createdAt]);
    changed(ctx, r.id);
  });
  return p;
}

/** The authoritative review checks are synchronous, so consent/reservation can recheck them in a transaction. */
export function reviewBlockers(ctx: Ctx, p: PublicationPlan, requireApproval = true, operation?: string): Blocker[] {
  const blockers: Blocker[] = [];
  const deny = (code: Blocker["code"], message: string, remedy: string) => blockers.push({ code, message, remedy });
  const r = reviewById(ctx.store, p.review);
  if (r.state !== "active" || r.branch !== p.ref.slice("refs/heads/".length) || r.source !== p.source || r.base_ref !== p.baseRef) {
    deny("repository_mismatch", "The review is closed or its source changed.", "Prepare a plan for the active review and current branch.");
  }
  if (repositoryId(ctx) !== p.repository) deny("repository_mismatch", "The repository identity does not match.", "Prepare a new plan in this repository.");
  const v = latestVersion(ctx, p.review);
  const last = ctx.store.db.query<SubmissionRow, [number]>("SELECT * FROM submissions WHERE review_id = ? AND role = 'reviewer' ORDER BY id DESC LIMIT 1").get(p.review);
  if (v?.id !== p.versionId || v.snapshot !== p.snapshot || v.base_sha !== p.base || (requireApproval && (!last || last.verdict !== "approved" || last.version_id !== p.versionId))) {
    deny("approval_stale", "The current version is not approved for this plan.", "Review the latest version and authorize a plan bound to it.");
  }
  if (getSnapshot(ctx, p.snapshot)?.parent !== p.head) deny("history_mismatch", "The version's parent differs from the planned source HEAD.", "Hand over a worktree/index version based on the current HEAD.");
  const open = ctx.store.db.query<{ id: number }, [number]>(`SELECT t.id FROM threads t WHERE t.review_id = ? AND t.status = 'open'
    AND EXISTS(SELECT 1 FROM comments c WHERE c.thread_id = t.id AND c.published_seq IS NOT NULL)`).all(p.review);
  if (open.length || settledThreads(ctx, r).length) deny("pending_review_work", "Published threads or settled instructions still need work.", "Complete the instructions, hand over a new version and have the reviewer close the remaining threads.");
  if (publicationState(ctx, p.review).paused) deny("grant_revoked", "Publication is paused.", "The reviewer can resume publication and give fresh consent.");
  if (publicationReceipts(ctx, p.id).some((r) => r.id !== operation)) deny("operation_consumed", "This plan already has a reserved or completed operation.", "Use the existing operation ID to inspect or reconcile its receipt.");
  return blockers;
}

export async function gatePublication(ctx: Ctx, id: string, action: PublicationAction, opts: { consent?: boolean; operation?: string } = {}): Promise<GateDecision> {
  const p = publicationPlan(ctx, id);
  const before = publicationState(ctx, p.review).revision;
  let evidence: CandidateEvidence | null = null;
  const blockers: Blocker[] = [];
  try {
    const r = reviewById(ctx.store, p.review);
    evidence = await captureCandidate(ctx, r, p.snapshot);
    const base = r.base_ref ? await baseBelow(evidence.worktree, r.base_ref, p.snapshot) : null;
    if (base !== p.base) blockers.push({ code: "history_mismatch", message: "The review base changed.", remedy: "Hand over the current history and prepare a new plan." });
  } catch {
    blockers.push({ code: "candidate_unavailable", message: "A fresh complete candidate could not be established.", remedy: "Check that the worktree, index and reviewed objects are available and no unsupported Git operation, pointer format or sparse state is present." });
  }
  const state = publicationState(ctx, p.review);
  if (state.revision !== before) blockers.push({ code: "approval_stale", message: "The review changed during inspection.", remedy: "Inspect the current plan again." });
  blockers.push(...reviewBlockers(ctx, p, !opts.consent, opts.operation));
  return evaluatePublication({ plan: p, action, revision: state.revision, grant: grantFor(ctx, id), evidence, blockers, now: Date.now(), requireGrant: !opts.consent });
}

/** Recheck store state and grant expiry at the transaction's dispatch boundary. */
export function recheckDecision(ctx: Ctx, previous: GateDecision, operation?: string): GateDecision {
  const p = publicationPlan(ctx, previous.plan);
  const revision = publicationState(ctx, p.review).revision;
  const blockers = reviewBlockers(ctx, p, true, operation);
  if (revision !== previous.revision) blockers.push({ code: "approval_stale", message: "The review changed before dispatch.", remedy: "Inspect and authorize the current plan." });
  return evaluatePublication({ plan: p, action: previous.action, revision, grant: grantFor(ctx, p.id), evidence: previous.evidence,
    blockers: [...previous.blockers, ...blockers], now: Date.now(), requireGrant: true });
}

export async function showPublication(ctx: Ctx, id: string): Promise<PublicationView> {
  const plan = publicationPlan(ctx, id);
  return { plan, grant: grantFor(ctx, id), paused: publicationState(ctx, plan.review).paused,
    decision: await gatePublication(ctx, id, "commit"), receipts: publicationReceipts(ctx, id) };
}
export function publicationPlans(ctx: Ctx, review: number): PublicationPlan[] {
  return ctx.store.db.query<{ id: string }, [number]>("SELECT id FROM publication_plans WHERE review_id = ? ORDER BY rowid DESC").all(review).map((r) => publicationPlan(ctx, r.id));
}
function reviewer(ctx: Ctx): void {
  if (ctx.role !== "reviewer") throw forbidden("only the reviewer grants, pauses or revokes publication permission");
}
function expectConsent(ctx: Ctx, p: PublicationPlan, expected: ConsentExpectation): void {
  if (!expected || expected.digest !== p.digest || expected.versionId !== p.versionId || expected.revision !== publicationState(ctx, p.review).revision) throw conflict("the plan or review changed; inspect it again before authorizing");
}
export async function authorizePublication(ctx: Ctx, id: string, expected: ConsentExpectation, actions: unknown): Promise<PublicationGrant> {
  reviewer(ctx);
  if (!Array.isArray(actions) || actions.length !== 1 || actions[0] !== "commit") throw usage("explicitly select the commit action");
  const p = publicationPlan(ctx, id);
  expectConsent(ctx, p, expected);
  const decision = await gatePublication(ctx, id, "commit", { consent: true });
  if (!decision.allowed) throw conflict(decision.blockers.map((b) => b.message).join(" "));
  return ctx.store.tx(() => {
    expectConsent(ctx, p, expected);
    const blockers = reviewBlockers(ctx, p, false);
    if (blockers.length) throw conflict(blockers.map((b) => b.message).join(" "));
    const r: ReviewRow = reviewById(ctx.store, p.review);
    if (listDrafts(ctx, r).length) throw conflict("submit your drafts before authorizing publication");
    submitReview(ctx, r, { verdict: "approved" });
    const at = nowIso();
    ctx.store.db.run("UPDATE publication_grants SET revoked_at = ? WHERE plan_id IN (SELECT id FROM publication_plans WHERE review_id = ?) AND revoked_at IS NULL", [at, p.review]);
    const g: PublicationGrant = { id: crypto.randomUUID(), plan: id, digest: p.digest, versionId: p.versionId,
      revision: publicationState(ctx, p.review).revision, actions: ["commit"], reviewer: ctx.author, provenance: "local",
      issuedAt: at, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), revokedAt: null };
    ctx.store.db.run("INSERT INTO publication_grants(id, plan_id, document, created_at) VALUES (?, ?, ?, ?)", [g.id, id, canonical(g), at]);
    changed(ctx, p.review);
    return g;
  });
}
export function revokePublication(ctx: Ctx, id: string): void {
  reviewer(ctx);
  const p = publicationPlan(ctx, id);
  ctx.store.tx(() => {
    ctx.store.db.run("UPDATE publication_grants SET revoked_at = ? WHERE plan_id = ? AND revoked_at IS NULL", [nowIso(), id]);
    ctx.store.db.run("UPDATE publication_state SET revision = revision + 1 WHERE review_id = ?", [p.review]);
    changed(ctx, p.review);
  });
}
export function pausePublication(ctx: Ctx, review: number, paused: boolean): void {
  reviewer(ctx);
  reviewById(ctx.store, review);
  ctx.store.tx(() => {
    ctx.store.db.run("UPDATE publication_state SET paused = ?, revision = revision + 1 WHERE review_id = ?", [paused ? 1 : 0, review]);
    changed(ctx, review);
  });
}
