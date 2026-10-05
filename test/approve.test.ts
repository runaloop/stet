import { afterAll, expect, test } from "bun:test";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture, lines } from "./helpers/fixture.ts";

const fixtures: Fixture[] = [];
afterAll(() => fixtures.forEach((f) => f.cleanup()));

async function handedOver() {
  const f = new Fixture();
  fixtures.push(f);
  f.write("a.txt", lines(10));
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write("a.txt", lines(12));
  const reviewer = { cwd: f.root, role: "reviewer" as const };
  const agent = { cwd: f.root, role: "agent" as const };
  await ok(stet(["version", "create"], agent));
  const thread = async (line: number, body: string, draft = true) =>
    (await ok(stet(["comment", "add", "--file", "a.txt", "--range", String(line), "--at", "1", "--body", body, ...(draft ? ["--draft"] : [])], reviewer))).id as number;
  return { f, reviewer, agent, thread };
}

test("requesting changes needs drafts, approving does not; status says what the reviewer decided", async () => {
  const { reviewer, agent } = await handedOver();
  const empty = await stet(["review", "submit"], reviewer);
  expect(empty.code).toBe(3);
  expect(empty.stderr).toContain("no drafts to submit");
  expect((await ok(stet(["status"], agent))).lastSubmission).toBeNull();

  expect((await stet(["review", "submit", "--approve"], agent)).code).toBe(3);
  const approved = await ok(stet(["review", "submit", "--approve", "--body", "all good"], reviewer));
  expect(approved).toMatchObject({ verdict: "approved", version: 1, comments: 0, threads: [], resolved: [] });
  const s = await ok(stet(["status"], agent));
  expect(s.lastSubmission).toMatchObject({ verdict: "approved", version: 1, body: "all good", changedAfter: false });
  expect(s.review.state).toBe("active");
  const events = await ok(stet(["events"], agent));
  expect(events.filter((e: any) => e.type === "review.submitted").map((e: any) => [e.verdict, e.version])).toEqual([["approved", 1]]);
});

test("an approval with drafts publishes them as nits, and wakes the waiting agent with the approved version", async () => {
  const { f, reviewer, agent, thread } = await handedOver();
  const nit = await thread(3, "a typo here");
  const waiting = stet(["wait", "--for", "review", "--timeout", "20s"], agent);
  await Bun.sleep(400);
  const approved = await ok(stet(["review", "submit", "--approve"], reviewer));
  expect(approved).toMatchObject({ verdict: "approved", version: 1, comments: 1, threads: [nit] });
  const woke = await waiting;
  expect(woke.code).toBe(0);
  expect(woke.json).toMatchObject({ reason: "approved", version: 1, threads: [nit] });
  expect((await ok(stet(["threads", "list", "--needs-reply"], agent))).map((t: any) => t.id)).toEqual([nit]);

  const again = await ok(stet(["wait", "--for", "review", "--timeout", "2s"], agent));
  expect(again).toMatchObject({ reason: "approved", version: 1 });

  f.write("a.txt", lines(13));
  expect((await ok(stet(["status"], agent))).lastSubmission).toMatchObject({ verdict: "approved", version: 1, changedAfter: true });
  await ok(stet(["reply", String(nit), "--intent", "fixed", "--body", "fixed the typo"], agent));
  await ok(stet(["version", "create"], agent));
  expect((await ok(stet(["status"], agent))).lastSubmission).toMatchObject({ verdict: "approved", version: 1, changedAfter: true });
  const after = await stet(["wait", "--for", "review", "--timeout", "600ms"], agent);
  expect(after.code).toBe(5);
}, 60_000);

test("approving while other threads are open asks for --force or --resolve-all", async () => {
  const { reviewer, thread } = await handedOver();
  const open = await thread(2, "why?", false);
  const refused = await stet(["review", "submit", "--approve"], reviewer);
  expect(refused.code).toBe(3);
  expect(refused.stderr).toContain(`1 thread is still open: #${open}`);
  expect(refused.stderr).toContain("--resolve-all");
  expect(refused.stderr).toContain("--force");
  expect((await stet(["review", "submit", "--force"], reviewer)).code).toBe(1);
  expect((await stet(["review", "submit", "--approve", "--force", "--resolve-all"], reviewer)).code).toBe(1);

  const forced = await ok(stet(["review", "submit", "--approve", "--force"], reviewer));
  expect(forced).toMatchObject({ verdict: "approved", resolved: [] });
  expect((await ok(stet(["threads", "list"], reviewer))).map((t: any) => t.id)).toEqual([open]);

  const withReply = await thread(5, "and this?", false);
  await ok(stet(["reply", String(withReply), "--body", "rename it", "--draft"], reviewer));
  const both = await ok(stet(["review", "submit", "--approve", "--resolve-all"], reviewer));
  expect(both).toMatchObject({ verdict: "approved", threads: [withReply], comments: 1, resolved: [open] });
  const listed = await ok(stet(["threads", "list", "--status", "all"], reviewer));
  expect(listed.map((t: any) => [t.id, t.status])).toEqual([[open, "resolved"], [withReply, "open"]]);
});

test("a later request for changes replaces the approval", async () => {
  const { reviewer, agent, thread } = await handedOver();
  await ok(stet(["review", "submit", "--approve"], reviewer));
  const t = await thread(4, "one more thing");
  const changes = await ok(stet(["review", "submit"], reviewer));
  expect(changes).toMatchObject({ verdict: "changes", version: 1, threads: [t] });
  expect((await ok(stet(["status"], agent))).lastSubmission).toMatchObject({ verdict: "changes", version: 1, changedAfter: false });
  const woke = await ok(stet(["wait", "--for", "review", "--timeout", "2s"], agent));
  expect(woke).toMatchObject({ reason: "pending", threads: [t] });
});
