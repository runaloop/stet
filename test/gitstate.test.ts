import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openContext, initReview } from "../src/core/context.ts";
import { gitState, parseStatus, worktreeStatus } from "../src/core/gitstate.ts";
import { Fixture, lines, sh } from "./helpers/fixture.ts";

const f = new Fixture();
const remote = realpathSync(mkdtempSync(join(tmpdir(), "stet-remote-")));
afterAll(() => {
  f.cleanup();
  rmSync(remote, { recursive: true, force: true });
});

test("parses porcelain v2: ordinary, renamed, unmerged and untracked entries", () => {
  const out = [
    "# branch.oid 1111111111111111111111111111111111111111",
    "# branch.head feat",
    "1 M. N... 100644 100644 100644 aaa bbb a b.kt",
    "1 .M N... 100644 100644 100644 aaa aaa c.kt",
    "2 R. N... 100644 100644 100644 aaa aaa R100 new name.kt",
    "old name.kt",
    "u UU N... 100644 100644 100644 100644 a b c d.kt",
    "? e f.txt",
    "",
  ].join("\0");
  const s = parseStatus(out);
  expect(s.head).toBe("1111111111111111111111111111111111111111");
  expect(s.branch).toBe("feat");
  expect(s.files.map((x) => [x.path, x.staged, x.unstaged, x.untracked, x.conflict])).toEqual([
    ["a b.kt", true, false, false, false],
    ["c.kt", false, true, false, false],
    ["new name.kt", true, false, false, false],
    ["d.kt", false, true, false, true],
    ["e f.txt", false, false, true, false],
  ]);
});

test("tells what is pushed, committed, staged, unstaged and new", async () => {
  f.write("a.kt", lines(5)).write("b.kt", lines(5)).write("c.kt", lines(5));
  f.commit("init");
  sh(remote, ["init", "-q", "--bare"]);
  f.git(["remote", "add", "origin", remote]);
  f.git(["push", "-q", "origin", "main"]);
  f.git(["checkout", "-q", "-b", "feat"]);
  const ctx = await openContext({ cwd: f.root, role: "reviewer" });
  const { review } = await initReview(ctx, { base: "main" });

  f.write("a.kt", lines(6));
  f.commit("one");
  let s = await gitState(ctx, review);
  expect(s).toMatchObject({ branch: "feat", upstream: null, tracking: false, ahead: 1, behind: 0, detached: false });
  expect(s.files).toEqual([{ path: "a.kt", staged: false, unstaged: false, untracked: false, conflict: false, unpushed: true }]);

  f.git(["push", "-q", "-u", "origin", "feat"]);
  f.write("b.kt", lines(7));
  f.git(["add", "b.kt"]);
  f.write("b.kt", lines(8));
  f.write("c.kt", lines(9));
  f.write("new.txt", "hello\n");
  s = await gitState(ctx, review);
  expect(s).toMatchObject({ upstream: "origin/feat", tracking: true, gone: false, ahead: 0, behind: 0, unpushed: [] });
  expect(s.files.map((x) => [x.path, x.staged, x.unstaged, x.untracked, x.unpushed])).toEqual([
    ["b.kt", true, true, false, false],
    ["c.kt", false, true, false, false],
    ["new.txt", false, false, true, false],
  ]);

  f.commit("two");
  s = await gitState(ctx, review);
  expect(s.ahead).toBe(1);
  expect(s.unpushed.map((c) => c.subject)).toEqual(["two"]);
  expect(s.files.every((x) => x.unpushed && !x.staged && !x.unstaged)).toBe(true);

  f.git(["update-ref", "-d", "refs/remotes/origin/feat"]);
  s = await gitState(ctx, review);
  expect(s).toMatchObject({ upstream: "origin/feat", tracking: true, gone: true });
});

test("the fingerprint moves when a changed file changes again, and not otherwise", async () => {
  const a = await worktreeStatus(f.root);
  expect((await worktreeStatus(f.root)).fingerprint).toBe(a.fingerprint);
  f.write("c.kt", lines(10));
  const b = await worktreeStatus(f.root);
  expect(b.fingerprint).not.toBe(a.fingerprint);
  f.write("c.kt", lines(11));
  expect((await worktreeStatus(f.root)).fingerprint).not.toBe(b.fingerprint);
});
