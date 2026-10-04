import { afterAll, expect, test } from "bun:test";
import { stet, ok } from "./helpers/cli.ts";
import { edit, Fixture, lines } from "./helpers/fixture.ts";

const f = new Fixture();
afterAll(() => f.cleanup());

test("reviewing staged changes: the index against HEAD, unstaged edits stay out", async () => {
  f.write("app.kt", lines(20)).write("notes.txt", "scratch\n");
  f.commit("base");
  f.write("app.kt", edit(lines(20), (l) => (l[4] = "val staged = 5")));
  f.git(["add", "app.kt"]);
  f.write("notes.txt", "unstaged noise\n");
  const reviewer = { cwd: f.root, role: "reviewer" as const };
  const agent = { cwd: f.root, role: "agent" as const };

  const init = await ok(stet(["init", "--staged"], reviewer));
  expect(init.review).toMatchObject({ branch: "main", source: "index", baseRef: "HEAD" });
  const v1 = await ok(stet(["version", "create", "--label", "staged"], agent));
  const d1 = await ok(stet(["versions", "diff", "base", "1"], reviewer));
  expect(d1.files.map((x: any) => x.path)).toEqual(["app.kt"]);
  expect(f.git(["show", `${v1.version.snapshot}:notes.txt`])).toBe("scratch");

  const t = await ok(stet(["comment", "add", "--file", "app.kt", "--range", "5", "--at", "1", "--body", "rename it", "--draft"], reviewer));
  await ok(stet(["review", "submit"], reviewer));
  const pending = await ok(stet(["wait", "--for", "review", "--timeout", "5s"], agent));
  expect(pending.threads).toEqual([t.id]);

  f.write("app.kt", edit(lines(20), (l) => (l[4] = "val renamed = 5")));
  expect((await stet(["version", "create"], agent)).code).toBe(3);
  f.git(["add", "app.kt"]);
  await ok(stet(["reply", String(t.id), "--intent", "fixed", "--body", "renamed"], agent));
  const v2 = await ok(stet(["version", "create", "--label", "fixes"], agent));
  expect(f.git(["show", `${v2.version.snapshot}:app.kt`]).split("\n")[4]).toBe("val renamed = 5");
  const shown = await ok(stet(["thread", "show", String(t.id)], reviewer));
  expect(shown.timeline.map((s: any) => [s.label, s.state])).toEqual([["v1", "ok"], ["v2", "changed"]]);
  expect(f.git(["status", "--porcelain"])).toBe("M  app.kt\n M notes.txt");
});
