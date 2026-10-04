import { afterAll, expect, test } from "bun:test";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture, lines } from "./helpers/fixture.ts";

const f = new Fixture();
afterAll(() => f.cleanup());

test("wait modes: reply, version and timeout", async () => {
  f.write("a.txt", lines(10));
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  const reviewer = { cwd: f.root, role: "reviewer" as const };
  const agent = { cwd: f.root, role: "agent" as const };
  await ok(stet(["version", "create"], agent));
  const t = await ok(stet(["comment", "add", "--file", "a.txt", "--range", "2-3", "--at", "1", "--body", "why?"], reviewer));

  const timedOut = await stet(["wait", "--for", "reply", "--timeout", "600ms"], reviewer);
  expect(timedOut.code).toBe(5);
  expect(timedOut.json.reason).toBe("timeout");

  const forReply = stet(["wait", "--for", "reply", "--timeout", "15s"], reviewer);
  await Bun.sleep(300);
  await ok(stet(["reply", String(t.id), "--intent", "answered", "--body", "because"], agent));
  const replied = await forReply;
  expect(replied.code).toBe(0);
  expect(replied.json).toMatchObject({ reason: "pending", threads: [t.id] });

  const seq = ((await ok(stet(["events"], reviewer))) as { seq: number }[]).at(-1)?.seq ?? 0;
  const forVersion = stet(["wait", "--for", "version", "--timeout", "15s", "--since", String(seq)], reviewer);
  f.write("a.txt", lines(11));
  await ok(stet(["version", "create"], agent));
  const versioned = await forVersion;
  expect(versioned.json.reason).toBe("event");
  expect(versioned.json.events.map((e: any) => [e.type, e.version])).toEqual([["version.created", 2]]);

  await ok(stet(["read", String(t.id)], reviewer));
  const nothing = await stet(["wait", "--for", "reply", "--timeout", "400ms"], reviewer);
  expect(nothing.code).toBe(5);
}, 60_000);
