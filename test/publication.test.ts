import { afterEach, expect, test } from "bun:test";
import { readFileSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { initReview, openContext, type Ctx } from "../src/core/context.ts";
import { addThread, createVersion, resolveWithMessage, status, submitReview, waitFor, markRead } from "../src/core/service.ts";
import { closeReview } from "../src/core/maintenance.ts";
import { clearNowCache } from "../src/core/snapshot.ts";
import { authorizePublication, gatePublication, pausePublication, planDigest, preparePublication, publicationState,
  revokePublication, showPublication } from "../src/core/publication/service.ts";
import { executePublication } from "../src/core/publication/executor.ts";
import type { PreparePublication, PublicationPlan } from "../src/core/publication/types.ts";
import { Fixture, lines } from "./helpers/fixture.ts";
import { stet } from "./helpers/cli.ts";
import { handleApi, type ServerState } from "../src/server/api.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { clearNowCache(); cleanup.splice(0).reverse().forEach((fn) => fn()); });

async function setup(staged = false) {
  const f = new Fixture();
  cleanup.push(() => f.cleanup());
  f.write("a.txt", lines(10)).write("b.txt", "before\n");
  const head = f.commit("Initial files");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write("a.txt", lines(12));
  if (staged) f.git(["add", "a.txt"]);
  const ctx = await openContext({ cwd: f.root, role: "agent", author: "author" });
  cleanup.push(() => ctx.store.close());
  const reviewer: Ctx = { ...ctx, role: "reviewer", author: "reviewer" };
  const { review } = await initReview(ctx, { staged, base: "main" });
  await createVersion(ctx, review);
  const input: PreparePublication = { schema: 1, review: review.id, version: 1, protection: "local", actions: ["commit"],
    commit: { message: "Update the queue\n\nKeep the reviewed behavior.\n", author: { name: "Author", email: "author@example.com" },
      committer: { name: "Publisher", email: "publisher@example.com" }, signing: "none", timestamps: "execution" } };
  const plan = await preparePublication(ctx, input);
  const authorize = async (p = plan) => {
    const view = await showPublication(ctx, p.id);
    return authorizePublication(reviewer, p.id, { digest: p.digest, versionId: p.versionId, revision: view.decision.revision }, ["commit"]);
  };
  const codes = async (p = plan) => (await gatePublication(ctx, p.id, "commit")).blockers.map((b) => b.code);
  return { f, ctx, reviewer, review, input, plan, head, authorize, codes };
}

test("approval and wait remain review signals when the worktree changes; no grant is inferred", async () => {
  const { f, ctx, reviewer, review, codes } = await setup();
  submitReview(reviewer, review, { verdict: "approved" });
  f.write("a.txt", lines(13));
  expect(await waitFor(ctx, review, "review", { timeoutMs: 10 })).toMatchObject({ reason: "approved", version: 1 });
  expect(await codes()).toContain("no_grant");
  expect(await codes()).toContain("candidate_tree_mismatch");
});

test("fresh gate ignores cached and pinned now; it never stages or updates HEAD", async () => {
  const { f, ctx, reviewer, review, plan, head, authorize, codes } = await setup();
  f.git(["add", "a.txt"]);
  await authorize();
  const pin = (await status(ctx, review)).now!.sha;
  const index = readFileSync(join(f.root, ".git", "index"));
  f.write("a.txt", lines(14));
  expect((await status(reviewer, review, { pinnedNow: pin })).lastSubmission?.changedAfter).toBe(false);
  expect(await codes()).toContain("candidate_tree_mismatch");
  expect(readFileSync(join(f.root, ".git", "index"))).toEqual(index);
  expect(f.git(["rev-parse", "HEAD"])).toBe(head);
  expect((await showPublication(ctx, plan.id)).receipts).toEqual([]);
});

test("worktree consent refuses partial staging and never supplies a hidden git add", async () => {
  const { f, ctx, plan, authorize, codes } = await setup();
  expect(await codes()).toContain("candidate_tree_mismatch");
  await expect(authorize()).rejects.toThrow("commit candidate");
  f.git(["add", "a.txt"]);
  await authorize();
  expect((await gatePublication(ctx, plan.id, "commit")).allowed).toBe(true);
});

test("index review publishes only the approved index and preserves unrelated work", async () => {
  const { f, ctx, plan, authorize, head } = await setup(true);
  f.write("b.txt", "Unstaged work\n").write("notes.txt", "Untracked notes\n");
  await authorize();
  const before = f.git(["status", "--porcelain"]);
  expect((await gatePublication(ctx, plan.id, "commit")).allowed).toBe(true);
  expect(f.git(["status", "--porcelain"])).toBe(before);
  const receipt = await executePublication(ctx, plan.id, "index-commit");
  expect(receipt.state).toBe("confirmed");
  expect(f.git(["show", "HEAD:b.txt"])).toBe("before");
  expect(f.git(["rev-parse", "HEAD^1"])).toBe(head);
  expect(readFileSync(f.path("b.txt"), "utf8")).toBe("Unstaged work\n");
  expect(readFileSync(f.path("notes.txt"), "utf8")).toBe("Untracked notes\n");
});

test("one exact commit uses approved metadata, skips hooks and retries return its receipt", async () => {
  const { f, ctx, plan, authorize, head } = await setup(true);
  f.write(".git/hooks/reference-transaction", "#!/bin/sh\ntouch hook-ran\n");
  chmodSync(f.path(".git/hooks/reference-transaction"), 0o755);
  await authorize();
  const receipt = await executePublication(ctx, plan.id, "commit-once");
  expect(receipt).toMatchObject({ action: "commit", state: "confirmed", plan: plan.id });
  expect(receipt.commit).not.toBe(plan.snapshot);
  expect(f.git(["rev-parse", "HEAD^{tree}"])).toBe(plan.tree);
  expect(f.git(["rev-parse", "HEAD^1"])).toBe(head);
  expect(f.git(["show", "-s", "--format=%an <%ae>|%cn <%ce>", "HEAD"])).toBe("Author <author@example.com>|Publisher <publisher@example.com>");
  expect(f.git(["show", "-s", "--format=%B", "HEAD"])).toBe(plan.commit.message.trim());
  expect(await Bun.file(f.path("hook-ran")).exists()).toBe(false);
  expect(await executePublication(ctx, plan.id, "commit-once")).toEqual(receipt);
  await expect(executePublication(ctx, plan.id, "another-commit")).rejects.toThrow("already has an operation");
  expect(f.git(["rev-list", "--count", `${head}..HEAD`])).toBe("1");
});

test("a new version invalidates a grant even when its bytes are identical", async () => {
  const { ctx, plan, review, authorize, codes } = await setup(true);
  await authorize();
  await createVersion(ctx, review, { allowEmpty: true });
  expect(await codes()).toContain("approval_stale");
  await expect(executePublication(ctx, plan.id, "stale")).rejects.toThrow("approval_stale");
});

test("nits and settled instructions block publication until a new final version is reviewed", async () => {
  const { ctx, reviewer, review, plan, authorize, codes } = await setup(true);
  const t = await addThread(reviewer, review, { path: "a.txt", start: 2, end: 2, at: "1", body: "Rename this before publishing.", draft: true });
  submitReview(reviewer, review, { verdict: "approved" });
  expect(await codes()).toContain("pending_review_work");
  await resolveWithMessage(reviewer, review, t.id, "Apply the final name.");
  submitReview(reviewer, review, { verdict: "approved" });
  expect(await codes()).toContain("pending_review_work");
  await expect(authorize(plan)).rejects.toThrow("instructions");
  await createVersion(ctx, review, { allowEmpty: true });
  expect(await codes()).toContain("approval_stale");
});

test("read markers and private drafts do not invalidate a grant; published instructions do", async () => {
  const { ctx, reviewer, review, authorize, plan } = await setup(true);
  const grant = await authorize();
  const t = await addThread(reviewer, review, { path: "a.txt", start: 2, end: 2, at: "1", body: "A private draft", draft: true });
  markRead(reviewer, review, t.id);
  expect(publicationState(ctx, review.id).revision).toBe(grant.revision);
  expect((await gatePublication(ctx, plan.id, "commit")).allowed).toBe(true);
  submitReview(reviewer, review, { verdict: "changes" });
  expect((await gatePublication(ctx, plan.id, "commit")).blockers.map((b) => b.code)).toContain("approval_stale");
});

test("consent is explicit, reviewer-only, stale-click-safe and refuses unpublished nits", async () => {
  const { f, ctx, reviewer, review, plan, authorize } = await setup(true);
  const expected = { digest: plan.digest, versionId: plan.versionId, revision: publicationState(ctx, review.id).revision };
  await expect(authorizePublication(ctx, plan.id, expected, ["commit"])).rejects.toThrow("only the reviewer");
  await expect(authorizePublication(reviewer, plan.id, expected, [])).rejects.toThrow("explicitly select");
  await addThread(reviewer, review, { path: "a.txt", start: 2, end: 2, at: "1", body: "A private instruction", draft: true });
  await expect(authorize()).rejects.toThrow("submit your drafts");
  f.write("a.txt", lines(13));
  f.git(["add", "a.txt"]);
  await createVersion(ctx, review);
  await expect(authorizePublication(reviewer, plan.id, expected, ["commit"])).rejects.toThrow("changed");
});

test("pause, resume, expiry, revoke and close never revive old permission", async () => {
  const { ctx, reviewer, review, plan, authorize, codes } = await setup(true);
  await authorize();
  pausePublication(reviewer, review.id, true);
  expect(await codes()).toContain("grant_revoked");
  pausePublication(reviewer, review.id, false);
  expect(await codes()).toContain("approval_stale");
  const grant = await authorize();
  ctx.store.db.run("UPDATE publication_grants SET document = ? WHERE id = ?", [JSON.stringify({ ...grant, expiresAt: "2000-01-01T00:00:00Z" }), grant.id]);
  expect(await codes()).toContain("grant_expired");
  await authorize();
  revokePublication(reviewer, plan.id);
  expect(await codes()).toContain("grant_revoked");
  await authorize();
  closeReview(ctx, review);
  expect(await codes()).toContain("repository_mismatch");
});

test("excluded tracked and newly staged omitted files cannot slip into a commit", async () => {
  const { f, ctx, review, input } = await setup();
  ctx.store.setMeta("snapshot.exclude", JSON.stringify(["b.txt"]));
  f.write("b.txt", "Excluded tracked edit\n");
  await createVersion(ctx, review, { allowEmpty: true });
  const plan = await preparePublication(ctx, { ...input, version: 2 });
  f.git(["add", "a.txt", "b.txt"]);
  expect((await gatePublication(ctx, plan.id, "commit")).blockers.map((b) => b.code)).toContain("candidate_tree_mismatch");
});

test("safe names with binary bytes, symlinks, executable bits and deletions are bound by tree identity", async () => {
  const { f, ctx, review, input, authorize } = await setup();
  f.write("image.bin", "\0\x01\x02").write("run.sh", "#!/bin/sh\nexit 0\n");
  chmodSync(f.path("run.sh"), 0o755);
  symlinkSync("a.txt", f.path("alias.txt"));
  f.rm("b.txt");
  f.git(["add", "-A"]);
  await createVersion(ctx, review);
  const plan = await preparePublication(ctx, { ...input, version: 2 });
  await authorize(plan);
  expect((await gatePublication(ctx, plan.id, "commit")).allowed).toBe(true);
  chmodSync(f.path("run.sh"), 0o644);
  expect((await gatePublication(ctx, plan.id, "commit")).allowed).toBe(false);
});

test("branch movement, missing worktree and sparse/assume-unchanged entries fail closed", async () => {
  const { f, ctx, plan, authorize, codes } = await setup(true);
  await authorize();
  f.git(["update-index", "--assume-unchanged", "a.txt"]);
  expect(await codes()).toContain("candidate_unavailable");
  f.git(["update-index", "--no-assume-unchanged", "a.txt"]);
  f.commit("Unreviewed history");
  expect(await codes()).toContain("ref_changed");
  f.git(["checkout", "-q", "main"]);
  expect((await gatePublication(ctx, plan.id, "commit")).allowed).toBe(false);
});

test("changed metadata is a new immutable plan, invalidating the earlier grant", async () => {
  const { ctx, input, plan, authorize, codes } = await setup(true);
  await authorize();
  expect(planDigest(plan)).toBe(plan.digest);
  const next = await preparePublication(ctx, { ...input, commit: { ...input.commit, message: "A different final message\n" } });
  expect(next.digest).not.toBe(plan.digest);
  expect(await codes()).toContain("approval_stale");
  expect((await gatePublication(ctx, next.id, "commit")).blockers.map((b) => b.code)).toContain("no_grant");
});

test("unsupported protection, actions, signing and plan-provided commands are rejected", async () => {
  const { ctx, input, plan } = await setup(true);
  for (const extra of [{ protection: "protected" }, { actions: ["push"] }, { command: "git push" }, { schema: 2 }, { commit: { ...input.commit, signing: "gpg" } }]) {
    await expect(preparePublication(ctx, { ...input, ...extra })).rejects.toThrow();
  }
  expect((await gatePublication(ctx, plan.id, "push")).allowed).toBe(false);
});

test("crash recovery confirms the recorded commit after revocation without a second dispatch", async () => {
  const { f, ctx, reviewer, plan, authorize } = await setup(true);
  await authorize();
  const receipt = await executePublication(ctx, plan.id, "recover");
  ctx.store.db.run("UPDATE publication_executions SET state = 'dispatched' WHERE id = ?", [receipt.id]);
  revokePublication(reviewer, plan.id);
  expect(await executePublication(ctx, plan.id, "recover")).toMatchObject({ state: "confirmed", commit: receipt.commit });
  f.git(["update-ref", plan.ref, plan.head!]);
  ctx.store.db.run("UPDATE publication_executions SET state = 'dispatched' WHERE id = ?", [receipt.id]);
  expect(await executePublication(ctx, plan.id, "recover")).toMatchObject({ state: "outcome_unknown" });
  expect(f.git(["rev-parse", "HEAD"])).toBe(plan.head!);
});

test("concurrent requests cannot make two commits or consume another operation", async () => {
  const { f, ctx, plan, authorize, head } = await setup(true);
  await authorize();
  const results = await Promise.allSettled([executePublication(ctx, plan.id, "first"), executePublication(ctx, plan.id, "second")]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await showPublication(ctx, plan.id)).receipts).toHaveLength(1);
  expect(f.git(["rev-list", "--count", `${head}..HEAD`])).toBe("1");
});

test("CLI gate denial is structured exit 3 and diagnostics do not claim protected enforcement", async () => {
  const { f, plan } = await setup(true);
  const gate = await stet(["gate", "--plan", plan.id, "--action", "commit"], { cwd: f.root });
  expect(gate.code).toBe(3);
  expect(gate.json).toMatchObject({ schema: 1, allowed: false, protection: "local" });
  expect(gate.json.blockers.map((b: { code: string }) => b.code)).toContain("no_grant");
  const doctor = await stet(["doctor", "--approval"], { cwd: f.root });
  expect(doctor.code).toBe(0);
  expect(doctor.json).toMatchObject({ protectedApproval: false, supportedActions: ["commit"] });
});

test("the API derives permission from its context, rejects stale consent and never trusts a supplied role", async () => {
  const { f, ctx, reviewer, review, plan } = await setup(true);
  const state: ServerState = { ctx, defaultReview: review.id, pinnedNow: new Map(), pinning: new Map() };
  const request = (path: string, body?: unknown) => {
    const url = new URL(`http://localhost${path}`);
    return handleApi(state, new Request(url, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url);
  };
  const view = await (await request("/api/publication")).json();
  expect(view.plan.digest).toBe(plan.digest);
  for (const path of [`/api/publication/${plan.id}/gate`, `/api/publication/${plan.id}/authorize`, `/api/publication/${plan.id}/execute`, "/api/publication/pause"]) {
    expect((await request(path, null)).status).toBe(400);
    expect((await request(path, { schema: 2, action: "commit", operation: "unknown-schema" })).status).toBe(400);
  }
  const consent = { expected: { digest: plan.digest, versionId: plan.versionId, revision: view.decision.revision }, actions: ["commit"], role: "reviewer" };
  expect((await request(`/api/publication/${plan.id}/authorize`, consent)).status).toBe(409);
  state.ctx = reviewer;
  expect((await request(`/api/publication/${plan.id}/authorize`, consent)).status).toBe(200);
  expect((await (await request(`/api/publication/${plan.id}/gate`, { action: "commit" })).json()).allowed).toBe(true);
  expect((await request(`/api/publication/${plan.id}/gate`, { action: "unknown" })).status).toBe(400);
  f.write("a.txt", lines(13));
  f.git(["add", "a.txt"]);
  await createVersion(ctx, review);
  expect((await request(`/api/publication/${plan.id}/authorize`, consent)).status).toBe(409);
});

test("new metadata cannot bind an old version to new unreviewed ancestry", async () => {
  const { f, ctx, input } = await setup(true);
  f.commit("An unreviewed parent");
  await expect(preparePublication(ctx, input)).rejects.toThrow("source history changed");
});

test("split-index capture leaves staging intact and still binds the full candidate", async () => {
  const { f, ctx, plan, authorize } = await setup(true);
  f.git(["update-index", "--split-index"]);
  const index = readFileSync(f.path(".git/index"));
  await authorize();
  expect((await gatePublication(ctx, plan.id, "commit")).allowed).toBe(true);
  expect(readFileSync(f.path(".git/index"))).toEqual(index);
});

test("an omitted untracked secret blocks worktree publication without being copied into Git objects", async () => {
  const { f, ctx, plan, authorize } = await setup();
  f.git(["add", "a.txt"]);
  await authorize();
  f.write(".env", "EXAMPLE_VALUE=not-a-real-secret\n");
  const blob = f.git(["hash-object", "--no-filters", ".env"]);
  expect((await gatePublication(ctx, plan.id, "commit")).blockers.map((b) => b.code)).toContain("candidate_unavailable");
  const probe = Bun.spawnSync(["git", "cat-file", "-e", blob], { cwd: f.root });
  expect(probe.exitCode).not.toBe(0);
});

test("the first authored commit can be authorized against an empty base", async () => {
  const f = new Fixture();
  cleanup.push(() => f.cleanup());
  f.write("a.txt", "A first file\n");
  f.git(["add", "a.txt"]);
  const ctx = await openContext({ cwd: f.root });
  cleanup.push(() => ctx.store.close());
  const { review } = await initReview(ctx, { base: "empty", staged: true });
  await createVersion(ctx, review);
  const plan = await preparePublication(ctx, { schema: 1, review: review.id, version: 1, protection: "local", actions: ["commit"],
    commit: { message: "Initial files\n", author: { name: "Author", email: "author@example.com" }, committer: { name: "Publisher", email: "publisher@example.com" }, signing: "none", timestamps: "execution" } });
  expect(plan.head).toBeNull();
  const view = await showPublication(ctx, plan.id);
  await authorizePublication({ ...ctx, role: "reviewer" }, plan.id, { digest: plan.digest, versionId: plan.versionId, revision: view.decision.revision }, ["commit"]);
  const receipt = await executePublication(ctx, plan.id, "initial");
  expect(receipt.state).toBe("confirmed");
  expect(f.git(["rev-list", "--count", "HEAD"])).toBe("1");
});
