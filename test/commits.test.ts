import { expect, test } from "bun:test";
import { ensureReview, openContext } from "../src/core/context.ts";
import { branchCommits, compare, createVersion } from "../src/core/service.ts";
import { Fixture, lines } from "./helpers/fixture.ts";

test("lists the branch's commits, where it leaves main, and the versions taken at or on top of them", async () => {
  const f = new Fixture();
  try {
    f.write("a.kt", lines(10));
    f.commit("init");
    f.git(["checkout", "-q", "-b", "feat"]);
    f.write("a.kt", lines(11));
    f.commit("one");
    f.write("a.kt", lines(12));
    f.commit("two");
    const ctx = await openContext({ cwd: f.root, role: "agent", author: "claude" });
    const review = await ensureReview(ctx);
    await createVersion(ctx, review, { at: "HEAD~1" });
    f.write("a.kt", lines(13));
    await createVersion(ctx, review, {});

    const r = await branchCommits(ctx, review);
    expect(r.commits.map((c) => c.subject)).toEqual(["two", "one", "init"]);
    expect(r.commits.map((c) => c.onBranch)).toEqual([true, true, false]);
    expect(r.forkRef).toBe("main");
    expect(r.forkPoint).toBe(r.commits[2]!.sha);
    expect(r.commits[0]!.parent).toBe(r.commits[1]!.sha);
    expect(r.commits[1]!.versions).toEqual([{ number: 1, exact: true }]);
    expect(r.commits[0]!.versions).toEqual([{ number: 2, exact: false }]);
    expect(r.more).toBe(false);
    expect((await branchCommits(ctx, review, { limit: 1 })).more).toBe(true);

    const one = await compare(ctx, review, r.commits[1]!.parent!.slice(0, 10), r.commits[0]!.sha.slice(0, 12));
    expect(one.files.map((x) => x.path)).toEqual(["a.kt"]);
  } finally {
    f.cleanup();
  }
});
