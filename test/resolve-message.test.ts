import { afterAll, describe, expect, test } from "bun:test";
import { ensureReview, openContext } from "../src/core/context.ts";
import { exportMarkdown, collectExport } from "../src/core/export.ts";
import {
  addReply,
  addThread,
  createVersion,
  discardDraft,
  listDrafts,
  listThreads,
  reopenThread,
  resolveThread,
  resolveWithMessage,
  status,
  submitReview,
  threadDetail,
  waitFor,
} from "../src/core/service.ts";
import { clearNowCache } from "../src/core/snapshot.ts";
import { ok, stet } from "./helpers/cli.ts";
import { Fixture, lines } from "./helpers/fixture.ts";

const fixtures: Fixture[] = [];
afterAll(() => fixtures.forEach((f) => f.cleanup()));

async function round() {
  const f = new Fixture();
  fixtures.push(f);
  f.write("a.txt", lines(10));
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write("a.txt", lines(12));
  const reviewer = await openContext({ cwd: f.root, role: "reviewer", author: "alice" });
  const agent = await openContext({ cwd: f.root, role: "agent", author: "claude" });
  const review = await ensureReview(agent);
  await createVersion(agent, review, { label: "v1" });
  const thread = await addThread(reviewer, review, { path: "a.txt", start: 3, end: 4, at: "1", body: "add a block to configure the columns" });
  await addReply(agent, review, thread.id, { body: "I wrote the idea up in docs/x.md", intent: "answered" });
  return { f, reviewer, agent, review, id: thread.id };
}

describe("resolve with a message", () => {
  test("is a draft until the review is submitted; then the thread is resolved as go with the message, and the agent has it to do", async () => {
    const { f, reviewer, agent, review, id } = await round();
    const draft = await resolveWithMessage(reviewer, review, id, "yes, let's do it");
    expect(draft).toMatchObject({ threadId: id, role: "reviewer", body: "yes, let's do it", draft: true, resolves: true });
    expect((await threadDetail(reviewer, review, id)).thread).toMatchObject({ status: "open", resolveReason: null });
    expect(listDrafts(reviewer, review).map((d) => [d.id, d.resolves])).toEqual([[draft.id, true]]);
    expect((await status(agent, review)).settled).toEqual([]);

    const again = await resolveWithMessage(reviewer, review, id, "yes, do it as in docs/x.md");
    expect(again.id).toBe(draft.id);
    expect(listDrafts(reviewer, review).map((d) => d.body)).toEqual(["yes, do it as in docs/x.md"]);

    const sent = submitReview(reviewer, review);
    expect(sent).toMatchObject({ verdict: "changes", threads: [id], comments: 1, resolved: [], settled: [id] });
    const d = await threadDetail(agent, review, id);
    expect(d.thread).toMatchObject({ status: "resolved", resolveReason: "go", resolvedBy: "alice", needsReply: null });
    expect(d.comments.at(-1)).toMatchObject({ role: "reviewer", body: "yes, do it as in docs/x.md", draft: false, resolves: true });
    expect(d.events.map((e) => [e.type, e.role])).toEqual([["resolved", "reviewer"]]);

    const s = await status(agent, review);
    expect(s.counts).toMatchObject({ open: 0, resolved: 1, needsAgent: 0, settled: 1 });
    expect(s.settled).toEqual([
      { id, path: "a.txt", range: { start: 3, end: 4 }, title: "add a block to configure the columns", message: "yes, do it as in docs/x.md", by: "alice", at: expect.any(String) },
    ]);
    expect((await listThreads(agent, review, { settled: true })).map((t) => t.id)).toEqual([id]);
    expect((await listThreads(agent, review, { needsReply: true })).map((t) => t.id)).toEqual([]);
    expect(await waitFor(agent, review, "review", { timeoutMs: 0 })).toMatchObject({ reason: "pending", threads: [], settled: [id] });

    f.write("a.txt", lines(14));
    clearNowCache();
    await createVersion(agent, review, { label: "the columns block" });
    expect((await status(agent, review)).settled).toEqual([]);
    expect(await listThreads(agent, review, { settled: true })).toEqual([]);
    expect(await waitFor(agent, review, "review", { timeoutMs: 0 })).toMatchObject({ reason: "timeout", settled: [] });

    const md = exportMarkdown(await collectExport(reviewer, review));
    expect(md).toContain(`#${id} add a block to configure the columns (a.txt:3-4) — go ahead at v1: yes, do it as in docs/x.md`);
  });

  test("goes along with an approval: the agent gets the approval and the thread to act on", async () => {
    const { reviewer, agent, review, id } = await round();
    await resolveWithMessage(reviewer, review, id, "go with the second option");
    const approved = submitReview(reviewer, review, { verdict: "approved" });
    expect(approved).toMatchObject({ verdict: "approved", version: 1, threads: [id], resolved: [], settled: [id] });
    expect(await waitFor(agent, review, "review", { timeoutMs: 0 })).toMatchObject({ reason: "approved", version: 1, threads: [id], settled: [id] });
    const s = await status(agent, review);
    expect(s.lastSubmission).toMatchObject({ verdict: "approved", version: 1 });
    expect(s.counts).toMatchObject({ needsAgent: 0, settled: 1 });
  });

  test("a discarded draft leaves the thread open, and only the reviewer resolves with a message", async () => {
    const { reviewer, agent, review, id } = await round();
    const draft = await resolveWithMessage(reviewer, review, id, "ok");
    discardDraft(reviewer, review, draft.id);
    expect(listDrafts(reviewer, review)).toEqual([]);
    expect((await threadDetail(reviewer, review, id)).thread.status).toBe("open");
    await expect(resolveWithMessage(agent, review, id, "I'll just do it")).rejects.toThrow("only the reviewer");
    await expect(resolveWithMessage(reviewer, review, id, "  ")).rejects.toThrow("empty");
    expect(() => resolveThread(reviewer, review, id, "go")).toThrow("message");
    const fresh = await addThread(reviewer, review, { path: "a.txt", start: 1, end: 1, at: "1", body: "draft", draft: true });
    await expect(resolveWithMessage(reviewer, review, fresh.id, "go")).rejects.toThrow("is a draft");
  });

  test("the agent reopens a settled thread by asking a question; a plain reply leaves it resolved", async () => {
    const { reviewer, agent, review, id } = await round();
    await resolveWithMessage(reviewer, review, id, "yes, let's do it");
    submitReview(reviewer, review);

    await addReply(agent, review, id, { body: "Done in Table.kt:40.", intent: "fixed" });
    expect((await threadDetail(agent, review, id)).thread).toMatchObject({ status: "resolved", resolveReason: "go" });
    expect(() => reopenThread(agent, review, id)).toThrow("--intent question");

    await addReply(agent, review, id, { body: "The table has no column model yet: add one, or keep a fixed set?", intent: "question" });
    const d = await threadDetail(reviewer, review, id);
    expect(d.thread).toMatchObject({ status: "open", resolveReason: null, needsReply: "reviewer" });
    expect(d.events.map((e) => [e.type, e.role])).toEqual([["resolved", "reviewer"], ["reopened", "agent"]]);
    expect((await status(agent, review)).settled).toEqual([]);
    expect(await waitFor(reviewer, review, "reply", { timeoutMs: 0 })).toMatchObject({ reason: "pending", threads: [id] });
  });

  test("a question on a thread resolved without a message leaves it resolved", async () => {
    const { reviewer, agent, review, id } = await round();
    resolveThread(reviewer, review, id, "answered");
    await addReply(agent, review, id, { body: "one more thing?", intent: "question" });
    expect((await threadDetail(agent, review, id)).thread).toMatchObject({ status: "resolved", resolveReason: "answered" });
  });
});

describe("stet resolve --body", () => {
  test("saves a draft that the next submit turns into a resolution, in the JSON the agent reads", async () => {
    const f = new Fixture();
    fixtures.push(f);
    f.write("a.txt", lines(10));
    f.commit("init");
    f.git(["checkout", "-q", "-b", "feat"]);
    f.write("a.txt", lines(12));
    const reviewer = { cwd: f.root, role: "reviewer" as const };
    const agent = { cwd: f.root, role: "agent" as const };
    await ok(stet(["version", "create"], agent));
    const t = await ok(stet(["comment", "add", "--file", "a.txt", "--range", "2-3", "--at", "1", "--body", "configurable columns?"], reviewer));
    await ok(stet(["reply", String(t.id), "--intent", "answered", "--body", "Idea in docs/x.md"], agent));

    const refused = await stet(["resolve", String(t.id), "--body", "do it"], agent);
    expect(refused.code).toBe(3);
    expect((await stet(["resolve", String(t.id), "--reason", "go"], reviewer)).code).toBe(1);
    expect((await stet(["resolve", String(t.id), "--reason", "fixed", "--body", "x"], reviewer)).code).toBe(1);

    const draft = await ok(stet(["resolve", String(t.id), "--body", "-"], { ...reviewer, input: "Yes, let's do it.\n\nKeep the defaults as they are." }));
    expect(draft).toMatchObject({ threadId: t.id, role: "reviewer", draft: true, resolves: true, body: "Yes, let's do it.\n\nKeep the defaults as they are." });
    expect((await ok(stet(["drafts", "list"], reviewer))).map((d: any) => [d.id, d.resolves])).toEqual([[draft.id, true]]);

    const sent = await ok(stet(["review", "submit"], reviewer));
    expect(sent).toMatchObject({ verdict: "changes", threads: [t.id], comments: 1, resolved: [], settled: [t.id] });

    const s = await ok(stet(["status"], agent));
    expect(s.counts).toMatchObject({ open: 0, resolved: 1, needsAgent: 0, settled: 1 });
    expect(s.settled).toEqual([
      { id: t.id, path: "a.txt", range: { start: 2, end: 3 }, title: "configurable columns?", message: "Yes, let's do it.\n\nKeep the defaults as they are.", by: "alice", at: expect.any(String) },
    ]);
    const listed = await ok(stet(["threads", "list", "--settled"], agent));
    expect(listed.map((x: any) => [x.id, x.status, x.resolveReason])).toEqual([[t.id, "resolved", "go"]]);
    expect(await ok(stet(["threads", "list", "--needs-reply"], agent))).toEqual([]);
    expect(await ok(stet(["wait", "--for", "review", "--timeout", "2s"], agent))).toMatchObject({ reason: "pending", threads: [], settled: [t.id] });

    await ok(stet(["reply", String(t.id), "--intent", "question", "--body", "Which defaults?"], agent));
    const reopened = await ok(stet(["thread", "show", String(t.id)], reviewer));
    expect(reopened.thread).toMatchObject({ status: "open", needsReply: "reviewer" });
    expect((await ok(stet(["status"], agent))).settled).toEqual([]);
  }, 60_000);
});
