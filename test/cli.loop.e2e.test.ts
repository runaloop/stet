import { afterAll, expect, test } from "bun:test";
import { stet, ok } from "./helpers/cli.ts";
import { edit, Fixture, lines } from "./helpers/fixture.ts";

const f = new Fixture();
afterAll(() => f.cleanup());

test("full review loop across two worktrees", async () => {
  f.write("src/app.kt", lines(40, "val x"));
  f.write("README.md", "# demo\n");
  f.commit("base");
  const wt = f.addWorktree("agent", "feat");
  const reviewer = { cwd: f.root, role: "reviewer" as const };
  const agent = { cwd: wt, role: "agent" as const };
  const B = ["--branch", "feat"];

  f.write("src/app.kt", edit(lines(40, "val x"), (l) => l.push("val added = 1")), wt);
  const v1 = await ok(stet(["version", "create", "--label", "first cut"], agent));
  expect(v1.version.number).toBe(1);

  await ok(stet(["comment", "add", ...B, "--file", "src/app.kt", "--range", "5-9", "--at", "1", "--body", "Rename these", "--draft"], reviewer));
  await ok(stet(["comment", "add", ...B, "--file", "src/app.kt", "--range", "20-22", "--at", "1", "--body", "Bug here", "--draft"], reviewer));
  await ok(stet(["comment", "add", ...B, "--file", "src/app.kt", "--range", "30", "--at", "1", "--body", "Drop this line", "--draft"], reviewer));
  await ok(stet(["comment", "add", ...B, "--file", "README.md", "--range", "1", "--at", "1", "--body", "Title?", "--draft"], reviewer));

  expect(await ok(stet(["threads", "list", "--needs-reply"], agent))).toEqual([]);

  const waiting = stet(["wait", "--for", "review", "--timeout", "20s"], agent);
  await Bun.sleep(400);
  const submitted = await ok(stet(["review", "submit", ...B, "--body", "first pass"], reviewer));
  expect(submitted.comments).toBe(4);
  const woke = await waiting;
  expect(woke.code).toBe(0);
  expect(woke.json.reason).toBe("pending");
  expect(woke.json.threads).toHaveLength(4);

  const todo = await ok(stet(["threads", "list", "--needs-reply"], agent));
  expect(todo.map((t: any) => t.title).sort()).toEqual(["Bug here", "Drop this line", "Rename these", "Title?"]);
  const byTitle = Object.fromEntries(todo.map((t: any) => [t.title, t.id]));

  const content = edit(lines(40, "val x"), (l) => {
    l.push("val added = 1");
    l.splice(29, 1);
    l[20] = "val fixed = 21";
    l.splice(2, 0, "import foo", "import bar");
  });
  f.write("src/app.kt", content, wt);
  await ok(stet(["reply", String(byTitle["Rename these"]), "--intent", "answered", "--body", "They are fine."], agent));
  await ok(stet(["reply", String(byTitle["Bug here"]), "--intent", "fixed", "--body", "Fixed line 21."], agent));
  await ok(stet(["reply", String(byTitle["Drop this line"]), "--intent", "fixed", "--body", "-"], { ...agent, input: "Removed.\nSecond line." }));
  await ok(stet(["reply", String(byTitle["Title?"]), "--intent", "question", "--body", "Which title?"], agent));
  const v2 = await ok(stet(["version", "create", "--label", "fixes for review 1"], agent));
  expect(v2.version.number).toBe(2);
  const again = await stet(["version", "create"], agent);
  expect(again.code).toBe(3);

  const listed = await ok(stet(["threads", "list", ...B], reviewer));
  const state = Object.fromEntries(listed.map((t: any) => [t.title, t.anchor.state]));
  expect(state).toEqual({ "Rename these": "moved", "Bug here": "changed", "Drop this line": "outdated", "Title?": "ok" });
  expect(listed.every((t: any) => t.needsReply === "reviewer" && t.unread)).toBe(true);

  const diff = await ok(stet(["versions", "diff", ...B, "1", "2"], reviewer));
  expect(diff.files.map((x: any) => x.path)).toEqual(["src/app.kt"]);
  expect(diff.outside).toEqual([byTitle["Title?"]]);
  const placed = Object.fromEntries(diff.placements.map((p: any) => [p.threadId, p]));
  expect(placed[byTitle["Rename these"]]).toMatchObject({ side: "additions", range: { start: 7, end: 11 } });
  expect(placed[byTitle["Drop this line"]]).toMatchObject({ side: "deletions", state: "outdated", range: { start: 30, end: 30 } });

  const shown = await ok(stet(["thread", "show", ...B, String(byTitle["Bug here"])], reviewer));
  expect(shown.timeline.map((s: any) => [s.label, s.state])).toEqual([["v1", "ok"], ["v2", "changed"]]);
  expect(shown.comments.map((c: any) => [c.role, c.step])).toEqual([["reviewer", 0], ["agent", 1]]);
  expect(shown.code.interdiff).toContain("+val fixed = 21");

  await ok(stet(["read", ...B, String(byTitle["Bug here"])], reviewer));
  const unread = await ok(stet(["threads", "list", ...B, "--unread"], reviewer));
  expect(unread).toHaveLength(3);

  const denied = await stet(["resolve", String(byTitle["Bug here"]), "--reason", "fixed"], agent);
  expect(denied.code).toBe(3);
  await ok(stet(["resolve", ...B, String(byTitle["Bug here"]), "--reason", "fixed"], reviewer));
  await ok(stet(["reply", ...B, String(byTitle["Title?"]), "--body", "Use the tool name."], reviewer));

  const fromMain = await ok(stet(["threads", "list", ...B, "--status", "all"], reviewer));
  const fromWt = await ok(stet(["threads", "list", "--status", "all"], agent));
  expect(fromWt.map((t: any) => t.id)).toEqual(fromMain.map((t: any) => t.id));
  expect(fromMain.find((t: any) => t.id === byTitle["Bug here"]).status).toBe("resolved");

  const next = await ok(stet(["wait", "--for", "review", "--timeout", "2s"], agent));
  expect(next.threads).toEqual([byTitle["Title?"]]);
  const status = await ok(stet(["status", ...B], reviewer));
  expect(status.counts).toMatchObject({ open: 3, resolved: 1, needsAgent: 1, needsReviewer: 2, drafts: 0 });
}, 60_000);
