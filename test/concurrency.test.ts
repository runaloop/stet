import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Store } from "../src/core/store/db.ts";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture } from "./helpers/fixture.ts";

const f = new Fixture();
afterAll(() => f.cleanup());

const WORKER = `
import { openContext, requireReview } from "${join(import.meta.dir, "..", "src", "core", "context.ts")}";
import { addReply } from "${join(import.meta.dir, "..", "src", "core", "service.ts")}";
const [threadId, n, name] = process.argv.slice(2);
const ctx = await openContext({ cwd: process.cwd(), role: "agent", author: name });
const review = await requireReview(ctx);
for (let i = 0; i < Number(n); i++) await addReply(ctx, review, Number(threadId), { body: name + " " + i, at: "latest" });
`;

test("parallel writers lose nothing and leave no gaps in events", async () => {
  f.write("a.txt", "one\ntwo\nthree\n");
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  await ok(stet(["version", "create"], { cwd: f.root }));
  const t = await ok(stet(["comment", "add", "--file", "a.txt", "--range", "1-2", "--body", "hi", "--at", "1"], { cwd: f.root, role: "reviewer" }));
  const script = join(f.root, "..", `${f.root.split("/").pop()}-worker.ts`);
  await Bun.write(script, WORKER);
  const workers = Array.from({ length: 4 }, (_, i) =>
    Bun.spawn(["bun", script, String(t.id), "50", `w${i}`], { cwd: f.root, stdout: "pipe", stderr: "pipe" }),
  );
  const codes = await Promise.all(workers.map(async (w) => {
    const code = await w.exited;
    if (code !== 0) console.error(await new Response(w.stderr).text());
    return code;
  }));
  expect(codes).toEqual([0, 0, 0, 0]);
  const store = new Store(join(f.root, ".git", "stet", "review.db"));
  const count = store.db.query<{ n: number }, [number]>("SELECT count(*) AS n FROM comments WHERE thread_id = ?").get(t.id)!.n;
  expect(count).toBe(1 + 200);
  const seqs = store.db.query<{ seq: number }, []>("SELECT seq FROM events ORDER BY seq").all().map((r) => r.seq);
  expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1)).toBe(true);
  store.close();
  await Bun.file(script).delete();
}, 60_000);
