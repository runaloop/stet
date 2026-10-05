import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { blame } from "../src/core/blame.ts";
import { ensureReview, openContext, type Ctx } from "../src/core/context.ts";
import { addReply, addThread, createVersion, submitReview } from "../src/core/service.ts";
import { clearNowCache } from "../src/core/snapshot.ts";
import type { ReviewRow } from "../src/core/store/db.ts";
import type { BlameDto } from "../src/core/types.ts";
import { formatBlame } from "../src/cli/format.ts";
import { ok, stet } from "./helpers/cli.ts";
import { Fixture, edit, lines } from "./helpers/fixture.ts";

const brief = (d: BlameDto) =>
  d.runs.map((r) => {
    const from = r.origin.kind === "version" ? `v${r.origin.version}` : r.origin.kind;
    const round = r.round ? ` r${r.round.index}` : "";
    const threads = r.threads.length ? ` #${r.threads.map((t) => t.id).join(",#")}` : "";
    return `${r.start}-${r.end} ${from}${round}${threads}`;
  });

describe("blame across versions and rounds", () => {
  const f = new Fixture();
  let reviewer: Ctx;
  let agent: Ctx;
  let review: ReviewRow;
  let first = 0;
  let second = 0;
  let question = 0;
  const change = (text: string) => {
    f.write("a.kt", text);
    clearNowCache();
  };

  beforeAll(async () => {
    f.write("a.kt", lines(30));
    f.commit("base");
    f.git(["checkout", "-q", "-b", "feat"]);
    reviewer = await openContext({ cwd: f.root, role: "reviewer", author: "alice" });
    agent = await openContext({ cwd: f.root, role: "agent", author: "claude" });
    review = await ensureReview(agent);

    change(edit(lines(30), (l) => (l[4] = "cache.clear() in v1")));
    await createVersion(agent, review, { label: "add a cache" });
    first = (await addThread(reviewer, review, { path: "a.kt", start: 5, end: 5, at: "1", body: "Clear the cache on logout too", draft: true })).id;
    question = (await addThread(reviewer, review, { path: "a.kt", start: 15, end: 15, at: "1", body: "Why line 15?", draft: true })).id;
    submitReview(reviewer, review);

    change(edit(lines(30), (l) => {
      l[4] = "cache.clear() in v1";
      l[14] = "changed in v2";
    }));
    await addReply(agent, review, first, { body: "Done: logout() clears it now. See Session.kt.", intent: "fixed" });
    await addReply(agent, review, question, { body: "Changed line 15 instead.", intent: "fixed" });
    await createVersion(agent, review, { label: "fixes for review 1" });

    second = (await addThread(reviewer, review, { path: "a.kt", start: 5, end: 5, at: "2", body: "cache invalidation on logout\n\nStill clears too much.", draft: true })).id;
    submitReview(reviewer, review);

    change(edit(lines(30), (l) => {
      l[4] = "cache.remove(user) in v3";
      l[14] = "changed in v2";
    }));
    await addReply(agent, review, second, { body: "Only the user's entry goes now. The rest stays.", intent: "fixed" });
    await createVersion(agent, review, { label: "fixes for review 2" });
  }, 60_000);

  afterAll(() => f.cleanup());

  test("base lines, a version's lines with their round, and the thread a fix answered", async () => {
    const d = await blame(agent, review, { path: "a.kt", start: 1, end: 30 });
    expect(d.at.label).toBe("v3");
    expect(brief(d)).toEqual([`1-4 base`, `5-5 v3 r2 #${second}`, `6-14 base`, `15-15 v2 r1 #${question}`, `16-30 base`]);
    const fix = d.runs[1]!;
    expect(fix.origin).toMatchObject({ kind: "version", version: 3, label: "fixes for review 2" });
    expect(fix.round).toMatchObject({ index: 2, verdict: "changes", version: 2 });
    expect(fix.threads).toEqual([
      { id: second, title: "cache invalidation on logout", status: "open", reply: { id: expect.any(Number), body: "Only the user's entry goes now. The rest stays.", at: expect.any(String) } },
    ]);
  });

  test("a range spanning origins, and a version in the past", async () => {
    expect(brief(await blame(agent, review, { path: "a.kt", start: 4, end: 6 }))).toEqual(["4-4 base", `5-5 v3 r2 #${second}`, "6-6 base"]);
    const v2 = await blame(agent, review, { path: "a.kt", start: 5, end: 5, at: "2" });
    expect(brief(v2)).toEqual(["5-5 v1"]);
    expect(v2.runs[0]!.round).toBeNull();
  });

  test("a fix whose thread is anchored elsewhere is not credited to the line", async () => {
    const d = await blame(agent, review, { path: "a.kt", start: 15, end: 15 });
    expect(d.runs[0]!.threads.map((t) => t.id)).toEqual([question]);
    expect(d.runs[0]!.threads.map((t) => t.id)).not.toContain(first);
  });

  test("a line only in the working tree is now; the rest keeps its versions", async () => {
    change(edit(lines(30), (l) => {
      l[4] = "cache.remove(user) in v3";
      l[14] = "changed in v2";
      l[24] = "not handed over yet";
    }));
    expect(brief(await blame(agent, review, { path: "a.kt", start: 24, end: 26, at: "now" }))).toEqual(["24-24 base", "25-25 now r2", "26-26 base"]);
    expect(brief(await blame(agent, review, { path: "a.kt", start: 5, end: 5, at: "now" }))).toEqual([`5-5 v3 r2 #${second}`]);
  });

  test("the chain is kept under one ref per review and rebuilt for a new version", async () => {
    const refs = () => f.git(["for-each-ref", "--format=%(refname)", "refs/stet/blame/"]).split("\n").filter(Boolean);
    expect(refs()).toHaveLength(1);
    const before = refs()[0];
    await createVersion(agent, review, { label: "now as a version" });
    expect(brief(await blame(agent, review, { path: "a.kt", start: 25, end: 25 }))).toEqual(["25-25 v4 r2"]);
    expect(refs()).toHaveLength(1);
    expect(refs()[0]).not.toBe(before);
  });

  test("stet blame <path>:<a>-<b> prints the runs, and one compact line per run for a person", async () => {
    const d = await ok(stet(["blame", "a.kt:4-6"], { cwd: f.root }));
    expect(brief(d)).toEqual(["4-4 base", `5-5 v3 r2 #${second}`, "6-6 base"]);
    expect((await ok(stet(["blame", "./a.kt:15", "--at", "2"], { cwd: f.root }))).runs[0].origin.version).toBe(2);
    expect((await ok(stet(["blame", "a.kt"], { cwd: f.root }))).range).toEqual({ start: 1, end: 30 });
    expect(formatBlame(d)).toBe(["4  base", `5  v3 (round 2) · fixed #${second} "cache invalidation on logout"`, "6  base"].join("\n"));
    const wide = await blame(agent, review, { path: "a.kt", start: 9, end: 16 });
    expect(formatBlame(wide)).toBe(["9-14  base", `15    v2 (round 1) · fixed #${question} "Why line 15?"`, "16    base"].join("\n"));
  });

  test("stet blame refuses what it cannot answer", async () => {
    expect((await stet(["blame"], { cwd: f.root })).code).toBe(1);
    expect((await stet(["blame", "a.kt:0"], { cwd: f.root })).code).toBe(1);
    expect((await stet(["blame", "a.kt:1", "--at", "base"], { cwd: f.root })).code).toBe(1);
    const gone = await stet(["blame", "gone.kt:1"], { cwd: f.root });
    expect(gone.code).toBe(2);
    expect(gone.stderr).toContain("text file 'gone.kt' at v4 not found");
  });

  test("a whole file without a range, and bad requests", async () => {
    const d = await blame(agent, review, { path: "a.kt" });
    expect(d.range).toEqual({ start: 1, end: 30 });
    expect(d.runs[0]!.start).toBe(1);
    expect(d.runs[d.runs.length - 1]!.end).toBe(30);
    await expect(blame(agent, review, { path: "a.kt", start: 30, end: 31 })).rejects.toThrow("outside 'a.kt'");
    await expect(blame(agent, review, { path: "nope.kt", start: 1, end: 1 })).rejects.toThrow("text file 'nope.kt' at v4 not found");
    await expect(blame(agent, review, { path: "a.kt", start: 1, end: 1, at: "base" })).rejects.toThrow("--at takes a version number");
  });
});

describe("a fix replied after its version", () => {
  test("is found on the lines of that version", async () => {
    const f = new Fixture();
    try {
      f.write("a.kt", lines(10));
      f.commit("base");
      f.git(["checkout", "-q", "-b", "feat"]);
      const reviewer = await openContext({ cwd: f.root, role: "reviewer", author: "alice" });
      const agent = await openContext({ cwd: f.root, role: "agent", author: "claude" });
      const review = await ensureReview(agent);
      f.write("a.kt", lines(11));
      await createVersion(agent, review);
      const t = await addThread(reviewer, review, { path: "a.kt", start: 3, end: 3, at: "1", body: "Off by one", draft: true });
      submitReview(reviewer, review);
      f.write("a.kt", edit(lines(11), (l) => (l[2] = "fixed line 3")));
      clearNowCache();
      await createVersion(agent, review);
      await addReply(agent, review, t.id, { body: "Fixed the bound.", intent: "fixed" });
      expect(brief(await blame(agent, review, { path: "a.kt", start: 3, end: 3 }))).toEqual([`3-3 v2 r1 #${t.id}`]);
    } finally {
      f.cleanup();
    }
  }, 30_000);
});

describe("blame after a rebase between versions", () => {
  test("lines the newer base brought are base, not the version's", async () => {
    const f = new Fixture();
    try {
      f.write("a.kt", lines(10));
      f.commit("base");
      f.git(["checkout", "-q", "-b", "feat"]);
      const agent = await openContext({ cwd: f.root, role: "agent", author: "claude" });
      const review = await ensureReview(agent);
      expect(review.base_ref).toBe("main");
      f.write("a.kt", edit(lines(10), (l) => (l[2] = "branch change")));
      f.commit("branch change");
      await createVersion(agent, review);

      f.git(["checkout", "-q", "main"]);
      f.write("a.kt", edit(lines(10), (l) => (l[7] = "upstream change")));
      f.write("up.kt", lines(3, "up"));
      f.commit("upstream");
      f.git(["checkout", "-q", "feat"]);
      f.git(["rebase", "-q", "main"]);
      f.write("a.kt", edit(lines(10), (l) => {
        l[2] = "branch change";
        l[4] = "v2 change";
        l[7] = "upstream change";
      }));
      await createVersion(agent, review);

      expect(brief(await blame(agent, review, { path: "a.kt", start: 1, end: 10 }))).toEqual(["1-2 base", "3-3 v1", "4-4 base", "5-5 v2", "6-10 base"]);
      expect(brief(await blame(agent, review, { path: "up.kt" }))).toEqual(["1-3 base"]);
    } finally {
      f.cleanup();
    }
  }, 30_000);
});

describe("blame of renamed and deleted files", () => {
  test("a rename keeps the lines' origins; a deleted file is not found, and its past versions still blame", async () => {
    const f = new Fixture();
    try {
      f.write("old.kt", lines(5));
      f.commit("base");
      f.git(["checkout", "-q", "-b", "feat"]);
      const agent = await openContext({ cwd: f.root, role: "agent", author: "claude" });
      const review = await ensureReview(agent);
      f.write("old.kt", edit(lines(5), (l) => (l[1] = "v1 line")));
      await createVersion(agent, review);
      f.rm("old.kt");
      f.write("new.kt", edit(lines(5), (l) => (l[1] = "v1 line")));
      await createVersion(agent, review);
      expect(brief(await blame(agent, review, { path: "new.kt" }))).toEqual(["1-1 base", "2-2 v1", "3-5 base"]);
      f.rm("new.kt");
      await createVersion(agent, review);
      await expect(blame(agent, review, { path: "new.kt", start: 1, end: 1 })).rejects.toThrow("text file 'new.kt' at v3 not found");
      expect(brief(await blame(agent, review, { path: "new.kt", start: 2, end: 2, at: "2" }))).toEqual(["2-2 v1"]);
    } finally {
      f.cleanup();
    }
  }, 30_000);
});
