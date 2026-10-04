import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture } from "./helpers/fixture.ts";

const fixtures: Fixture[] = [];
afterAll(() => fixtures.forEach((f) => f.cleanup()));

function oneCommit(): Fixture {
  const f = new Fixture();
  fixtures.push(f);
  f.write("a.kt", "val a = 1\n").write("src/b.kt", "val b = 2\n");
  f.commit("first");
  return f;
}

const changes = (d: any) => d.files.map((x: any) => [x.path, x.status]);

test("--base empty reviews a repository's first commit: every file is added", async () => {
  const f = oneCommit();
  const init = await ok(stet(["init", "--base", "empty"], { cwd: f.root }));
  expect(init.review.baseRef).toBe("empty");
  const v1 = await ok(stet(["version", "create", "--at", "HEAD"], { cwd: f.root }));
  expect(v1.version.baseSha).toBe(f.git(["rev-parse", "refs/stet/empty"]));
  expect(changes(await ok(stet(["versions", "diff", "base", "1"], { cwd: f.root })))).toEqual([["a.kt", "A"], ["src/b.kt", "A"]]);

  f.write("c.kt", "val c = 3\n");
  await ok(stet(["version", "create"], { cwd: f.root }));
  expect(changes(await ok(stet(["versions", "diff", "base", "2"], { cwd: f.root })))).toEqual([["a.kt", "A"], ["c.kt", "A"], ["src/b.kt", "A"]]);
  expect(changes(await ok(stet(["versions", "diff", "empty", "now"], { cwd: f.root })))).toHaveLength(3);
});

test("the empty base is the same commit in every repository and has no files", async () => {
  const shas = [];
  for (const f of [oneCommit(), oneCommit()]) {
    await ok(stet(["init", "--base", "empty"], { cwd: f.root }));
    await ok(stet(["versions", "diff", "base", "now"], { cwd: f.root }));
    const sha = f.git(["rev-parse", "refs/stet/empty"]);
    expect(f.git(["ls-tree", "-r", sha])).toBe("");
    expect(f.git(["rev-list", "--parents", "-n", "1", sha])).toBe(sha);
    shas.push(sha);
  }
  expect(shas[0]).toBe(shas[1]);
});

test("a review without a base ref compares a root commit against the empty base", async () => {
  const f = oneCommit();
  await ok(stet(["init"], { cwd: f.root }));
  const { Database } = await import("bun:sqlite");
  const db = new Database(join(f.root, ".git", "stet", "review.db"));
  db.run("UPDATE reviews SET base_ref = NULL");
  db.close();
  await ok(stet(["version", "create", "--at", "HEAD"], { cwd: f.root }));
  expect(changes(await ok(stet(["versions", "diff", "base", "1"], { cwd: f.root })))).toEqual([["a.kt", "A"], ["src/b.kt", "A"]]);
});

test("a branch with no history in common with its base starts from the empty base", async () => {
  const f = oneCommit();
  f.git(["checkout", "-q", "--orphan", "docs"]);
  f.git(["rm", "-rqf", "."]);
  f.write("index.md", "# docs\n");
  f.commit("docs");
  const init = await ok(stet(["init"], { cwd: f.root }));
  expect(init.review.baseRef).toBe("main");
  await ok(stet(["version", "create"], { cwd: f.root }));
  expect(changes(await ok(stet(["versions", "diff", "base", "1"], { cwd: f.root })))).toEqual([["index.md", "A"]]);
});

test("stet prune and git gc keep the empty base", async () => {
  const f = oneCommit();
  await ok(stet(["init", "--base", "empty"], { cwd: f.root }));
  await ok(stet(["version", "create", "--at", "HEAD"], { cwd: f.root }));
  const empty = f.git(["rev-parse", "refs/stet/empty"]);
  const stray = f.git(["commit-tree", "-m", "stray", "HEAD^{tree}"]);
  f.git(["update-ref", `refs/stet/snap/${stray}`, stray]);
  const pruned = await ok(stet(["prune"], { cwd: f.root }));
  expect(pruned.refs).toEqual([`refs/stet/snap/${stray}`]);
  f.git(["gc", "-q", "--prune=now"]);
  expect(f.git(["rev-parse", "refs/stet/empty"])).toBe(empty);
  expect(f.git(["cat-file", "-t", empty])).toBe("commit");
  expect(changes(await ok(stet(["versions", "diff", "base", "1"], { cwd: f.root })))).toHaveLength(2);
});
