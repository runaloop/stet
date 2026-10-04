import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture, lines } from "./helpers/fixture.ts";

const fixtures: Fixture[] = [];
afterAll(() => fixtures.forEach((f) => f.cleanup()));
const fresh = () => {
  const f = new Fixture();
  fixtures.push(f);
  return f;
};

test("a thread anchored on an older version gets a timeline through the later ones", async () => {
  const f = fresh();
  f.write("f.txt", "a\nb\nc\nd\ne\nf\ng\n");
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  const agent = { cwd: f.root };
  const reviewer = { cwd: f.root, role: "reviewer" as const };
  await ok(stet(["version", "create"], agent));
  f.write("f.txt", "a\nb\nc\nX\nY\nf\ng\n");
  await ok(stet(["version", "create"], agent));
  for (const side of ["old", "new"]) {
    const t = await ok(stet(["comment", "add", "--file", "f.txt", "--range", "4-5", "--at", "1", "--side", side, "--body", side], reviewer));
    expect(t.version).toBe(1);
    const d = await ok(stet(["thread", "show", String(t.id)], reviewer));
    expect(d.timeline.map((s: any) => [s.label, s.state])).toEqual([["v1", "ok"], ["v2", "changed"]]);
    expect(d.code.now.lines).toContain("X");
    expect(d.code.interdiff).toContain("+X");
  }
});

test("base..vN uses the merge-base stored with that version", async () => {
  const f = fresh();
  f.write("f.txt", "one\n").write("g.txt", "base\n");
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write("f.txt", "two\n");
  f.commit("feature work");
  await ok(stet(["version", "create"], { cwd: f.root }));
  f.git(["checkout", "-q", "main"]);
  f.write("g.txt", "upstream\n");
  f.commit("upstream");
  f.git(["checkout", "-q", "feat"]);
  f.git(["rebase", "-q", "main"]);
  await ok(stet(["version", "create"], { cwd: f.root }));
  const d1 = await ok(stet(["versions", "diff", "base", "1"], { cwd: f.root }));
  expect(d1.files.map((x: any) => x.path)).toEqual(["f.txt"]);
  const d2 = await ok(stet(["versions", "diff", "base", "2"], { cwd: f.root }));
  expect(d2.files.map((x: any) => x.path)).toEqual(["f.txt"]);
});

test("a branch that shares its name with a tag still resolves", async () => {
  const f = fresh();
  f.write("a.txt", "x\n");
  f.commit("init");
  f.git(["tag", "v1.0"]);
  f.git(["checkout", "-q", "-b", "v1.0"]);
  f.write("a.txt", "y\n");
  const v = await ok(stet(["version", "create"], { cwd: f.root }));
  expect(v.version.number).toBe(1);
  const s = await ok(stet(["status"], { cwd: f.root }));
  expect(s.review.branch).toBe("v1.0");
  expect(s.now).not.toBeNull();
});

test("a relative --worktree hint is stored as the worktree root", async () => {
  const f = fresh();
  f.write("root.txt", "old\n").write("sub/s.txt", "s\n");
  f.commit("init");
  f.git(["checkout", "-q", "--detach"]);
  await ok(stet(["init", "--branch", "feat", "--worktree", "."], { cwd: join(f.root, "sub") }));
  f.write("root.txt", "new\n");
  mkdirSync(join(f.root, "sub", "deep"), { recursive: true });
  const v = await ok(stet(["version", "create"], { cwd: join(f.root, "sub", "deep") }));
  expect(f.git(["show", `${v.version.snapshot}:root.txt`])).toBe("new");
});

test("a repository with a single branch reviews against the commit it started from", async () => {
  const f = new Fixture();
  try {
    f.write("a.kt", lines(5));
    const head = f.commit("init");
    f.write("a.kt", lines(6));
    const init = await ok(stet(["init"], { cwd: f.root }));
    expect(init.review.baseRef).toBe(head);
    const diff = await ok(stet(["versions", "diff", "base", "now"], { cwd: f.root }));
    expect(diff.files.map((x: any) => x.path)).toEqual(["a.kt"]);
  } finally {
    f.cleanup();
  }
});

test("an older review without a base compares against the parent of its first snapshot", async () => {
  const f = new Fixture();
  try {
    f.write("a.kt", lines(5));
    f.commit("init");
    f.write("a.kt", lines(6));
    await ok(stet(["init"], { cwd: f.root }));
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(f.root, ".git", "stet", "review.db"));
    db.run("UPDATE reviews SET base_ref = NULL");
    db.close();
    const diff = await ok(stet(["versions", "diff", "base", "now"], { cwd: f.root }));
    expect(diff.files.map((x: any) => x.path)).toEqual(["a.kt"]);
  } finally {
    f.cleanup();
  }
});
