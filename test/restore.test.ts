import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensureReview, openContext, type Ctx } from "../src/core/context.ts";
import { collectExport, exportMarkdown } from "../src/core/export.ts";
import {
  addThread,
  createVersion,
  discardDraft,
  editDraft,
  linesInPlace,
  listDrafts,
  requestRestore,
  submitReview,
  threadDetail,
  threadSummaries,
} from "../src/core/service.ts";
import { clearNowCache } from "../src/core/snapshot.ts";
import type { ReviewRow } from "../src/core/store/db.ts";
import { formatThreadDetail, formatThreadList } from "../src/cli/format.ts";
import { ok, stet } from "./helpers/cli.ts";
import { Fixture, edit, lines } from "./helpers/fixture.ts";

test("the lines that stand where old lines were: unchanged ones follow, replaced ones give their replacement", () => {
  const hunks = [
    { oldStart: 3, oldCount: 2, newStart: 3, newCount: 3 },
    { oldStart: 8, oldCount: 2, newStart: 8, newCount: 0 },
  ];
  expect(linesInPlace(1, 2, hunks, 20)).toEqual({ start: 1, end: 2 });
  expect(linesInPlace(3, 4, hunks, 20)).toEqual({ start: 3, end: 5 });
  expect(linesInPlace(2, 5, hunks, 20)).toEqual({ start: 2, end: 6 });
  expect(linesInPlace(8, 9, hunks, 20)).toEqual({ start: 9, end: 9 });
  expect(linesInPlace(8, 9, hunks, 8)).toEqual({ start: 8, end: 8 });
  expect(linesInPlace(1, 1, [], 0)).toBeNull();
});

describe("restore as in a version", () => {
  const f = new Fixture();
  let reviewer: Ctx;
  let agent: Ctx;
  let review: ReviewRow;
  const v1 = edit(lines(20), (l) => {
    l[4] = "five in v1";
    l[9] = "ten in v1";
    l[10] = "eleven in v1";
  });
  const change = (text: string) => {
    f.write("a.kt", text);
    clearNowCache();
  };

  beforeAll(async () => {
    f.write("a.kt", lines(20));
    f.write("gone.kt", lines(4, "gone"));
    f.commit("base");
    f.git(["checkout", "-q", "-b", "feat"]);
    reviewer = await openContext({ cwd: f.root, role: "reviewer", author: "alice" });
    agent = await openContext({ cwd: f.root, role: "agent", author: "claude" });
    review = await ensureReview(agent);
    change(v1);
    await createVersion(agent, review, { label: "v1" });
    change(edit(v1, (l) => {
      l[4] = "five in v2";
      l.splice(9, 2);
    }));
    f.rm("gone.kt");
    await createVersion(agent, review, { label: "v2" });
  });

  afterAll(() => f.cleanup());

  test("from a version: a draft in a new thread on the lines that replaced them, with the version's exact text", async () => {
    const c = await requestRestore(reviewer, review, { from: "v1", path: "a.kt", start: 5, end: 5, at: "2" });
    expect(c).toMatchObject({ draft: true, body: "", parentId: null, restore: { path: "a.kt", range: { start: 5, end: 5 }, version: 1, text: "five in v1" } });
    const [t] = await threadSummaries(reviewer, review, { ids: [c.threadId], includeDrafts: true });
    expect(t).toMatchObject({ path: "a.kt", side: "new", range: { start: 5, end: 5 }, excerpt: ["five in v2"], title: "Restore as in v1: a.kt line 5" });
    discardDraft(reviewer, review, c.id);
  });

  test("lines deleted since: the thread sits on the line now in their place", async () => {
    const c = await requestRestore(reviewer, review, { from: "1", path: "a.kt", start: 10, end: 11, at: "2", body: "The fallback is needed" });
    expect(c.restore).toEqual({ path: "a.kt", range: { start: 10, end: 11 }, version: 1, text: "ten in v1\neleven in v1" });
    const [t] = await threadSummaries(reviewer, review, { ids: [c.threadId], includeDrafts: true });
    expect(t).toMatchObject({ range: { start: 10, end: 10 }, excerpt: ["line 12"], title: "The fallback is needed" });
    discardDraft(reviewer, review, c.id);
  });

  test("from the base, and from a file that is gone: the thread is then on the old lines", async () => {
    const base = await requestRestore(reviewer, review, { from: "base", path: "a.kt", start: 5, end: 5, at: "2" });
    expect(base.restore).toEqual({ path: "a.kt", range: { start: 5, end: 5 }, version: "base", text: "line 5" });
    const gone = await requestRestore(reviewer, review, { from: "base", path: "gone.kt", start: 2, end: 3, at: "2" });
    expect(gone.restore?.text).toBe("gone 2\ngone 3");
    const [t] = await threadSummaries(reviewer, review, { ids: [gone.threadId], includeDrafts: true });
    expect(t).toMatchObject({ path: "gone.kt", side: "old", range: { start: 2, end: 3 } });
    expect(listDrafts(reviewer, review).map((d) => d.restore?.version)).toEqual(["base", "base"]);
    discardDraft(reviewer, review, base.id);
    discardDraft(reviewer, review, gone.id);
  });

  test("only a version or the base, and only lines the file has there", async () => {
    const sha = f.git(["rev-parse", "HEAD"]);
    await expect(requestRestore(reviewer, review, { from: sha, path: "a.kt", start: 1, end: 1 })).rejects.toThrow("restore takes a version or base");
    await expect(requestRestore(reviewer, review, { from: "now", path: "a.kt", start: 1, end: 1 })).rejects.toThrow("restore takes a version or base");
    await expect(requestRestore(reviewer, review, { from: "v1", path: "a.kt", start: 19, end: 21 })).rejects.toThrow("outside");
  });

  test("in an existing thread, edited, submitted, and read by the agent", async () => {
    const t = await addThread(reviewer, review, { path: "a.kt", start: 5, end: 5, at: "2", body: "Why did this change?", draft: false });
    const c = await requestRestore(reviewer, review, { from: "v1", path: "a.kt", start: 5, end: 5, thread: t.id });
    expect(c).toMatchObject({ threadId: t.id, draft: true, restore: { version: 1, text: "five in v1" } });
    expect((await threadSummaries(reviewer, review, { ids: [t.id] }))[0]!.commentCount).toBe(2);

    editDraft(reviewer, review, c.id, "Keep the old name");
    editDraft(reviewer, review, c.id, "");

    const sent = submitReview(reviewer, review);
    expect(sent.threads).toEqual([t.id]);
    const d = await threadDetail(agent, review, t.id);
    expect(d.comments.map((x) => [x.draft, x.restore?.text ?? null])).toEqual([[false, null], [false, "five in v1"]]);

    const shown = await ok(stet(["thread", "show", String(t.id)], { cwd: f.root }));
    expect(shown.comments[1].restore).toEqual({ path: "a.kt", range: { start: 5, end: 5 }, version: 1, text: "five in v1" });
    const listed = await ok(stet(["threads", "list", "--needs-reply"], { cwd: f.root }));
    expect(listed.find((x: any) => x.id === t.id).last).toMatchObject({ preview: "Restore as in v1: a.kt line 5", restore: { version: 1 } });

    const human = formatThreadDetail(d);
    expect(human).toContain("restore as in v1, a.kt:5:");
    expect(human).toContain("  | five in v1");
    expect(formatThreadList(await threadSummaries(agent, review, { ids: [t.id] }))).toContain("restore v1");
    expect(exportMarkdown(await collectExport(reviewer, review), { all: true })).toContain("Restore as in v1, `a.kt:5`:\n\n```\nfive in v1\n```");
  });
});
