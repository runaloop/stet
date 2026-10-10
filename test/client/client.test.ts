import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { ApiError, clientApi } from "../../src/client/api.ts";
import { subscribe, type Live } from "../../src/client/live.ts";
import { findServer, stop } from "../../src/client/server.ts";
import { findReview, openContext, type Ctx } from "../../src/core/context.ts";
import type { RunningServer } from "../../src/server/info.ts";
import { stet, ok } from "../helpers/cli.ts";
import { Fixture, GIT_ENV, lines } from "../helpers/fixture.ts";

const f = new Fixture();
let ctx: Ctx;
let review = 0;
let thread = 0;
let old: ReturnType<typeof Bun.spawn> | null = null;

beforeAll(async () => {
  f.write("a.kt", lines(20));
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write("a.kt", lines(21));
  await ok(stet(["version", "create"], { cwd: f.root }));
  thread = (await ok(stet(["comment", "add", "--file", "a.kt", "--range", "3-4", "--body", "why?"], { cwd: f.root }))).id;
  ctx = await openContext({ cwd: f.root, role: "reviewer" });
  review = (await findReview(ctx))!.id;
});

afterAll(async () => {
  old?.kill();
  await old?.exited;
  await stop(ctx);
  ctx.store.close();
  f.cleanup();
});

/** `connect` from another process, as `stet tui` will call it: in this one Bun.main is the test file. */
async function connect(): Promise<RunningServer & { stderr: string }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "helpers", "client.ts")], {
    cwd: f.root,
    env: { ...process.env, ...GIT_ENV, STET_ROLE: "reviewer" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`connect failed (${code}): ${stderr}`);
  return { ...JSON.parse(stdout), stderr };
}

/** A server of another build in the foreground, on the port the repository's server last had. */
async function startOld(): Promise<{ port: number; pid: number }> {
  old = Bun.spawn(["bun", "--define", 'STET_BUILD="old"', join(import.meta.dir, "..", "..", "src", "cli.ts"), "serve", "--json"], {
    cwd: f.root,
    env: { ...process.env, ...GIT_ENV, STET_ROLE: "reviewer" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = (old.stdout as ReadableStream<Uint8Array>).getReader();
  const info = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  reader.releaseLock();
  return info;
}

/** A reply of the agent: a new event, so the reviewer's next read mark moves. */
const agentReply = () => ok(stet(["reply", String(thread), "--body", "it is needed"], { cwd: f.root }));

/** Records what a subscription hears, and waits for what it should hear. */
class Heard {
  readonly got: { kind: keyof Live; value: unknown; at: number }[] = [];
  readonly live: Live = {
    hello: (build) => this.push("hello", build),
    otherBuild: (build) => this.push("otherBuild", build),
    change: (seq) => this.push("change", seq),
    store: (kinds) => this.push("store", kinds),
    connection: (up) => this.push("connection", up),
  };
  private push(kind: keyof Live, value: unknown) {
    this.got.push({ kind, value, at: Date.now() });
  }
  /** The first message of a kind after `from` (an index into `got`) whose value passes `want`. */
  async next(kind: keyof Live, want: (v: unknown) => boolean = () => true, from = 0, ms = 8000): Promise<{ value: unknown; at: number; index: number }> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const index = this.got.findIndex((m, i) => i >= from && m.kind === kind && want(m.value));
      if (index !== -1) return { ...this.got[index]!, index };
      await Bun.sleep(20);
    }
    throw new Error(`no ${kind} in ${ms} ms; heard ${JSON.stringify(this.got)}`);
  }
}

test("connect starts a server when none runs, then finds the running one", async () => {
  expect(await findServer(ctx)).toBeNull();
  const started = await connect();
  expect(started.build).toBe("dev");
  const found = await findServer(ctx);
  expect(found).toMatchObject({ port: started.port, pid: started.pid, token: started.token, build: "dev" });
  const again = await connect();
  expect(again.pid).toBe(started.pid);
});

test("the API answers with the token and fails with typed errors", async () => {
  const server = (await findServer(ctx))!;
  const api = clientApi(server);
  expect(await api.ping()).toEqual({ ok: true, build: "dev" });
  expect((await api.review(review)).review.id).toBe(review);
  expect((await api.threads(review)).map((t) => t.id)).toEqual([thread]);
  expect((await api.thread(review, thread)).thread.id).toBe(thread);

  const draft = await api.reply(review, thread, { body: "because", draft: true });
  expect((await api.drafts(review)).map((d) => d.id)).toEqual([draft.id]);
  expect(await api.read(review, thread)).toEqual({ ok: true });
  expect((await api.cursors(review)).viewed).toEqual([]);
  const submitted = await api.submit(review, "a look", { verdict: "changes" });
  expect(submitted).toMatchObject({ verdict: "changes", comments: 1 });
  expect(await api.drafts(review)).toEqual([]);

  const missing = await api.thread(review, 9999).catch((e) => e);
  expect(missing).toBeInstanceOf(ApiError);
  expect(missing).toMatchObject({ status: 404, code: "not_found", exitCode: 2 });
  expect(await clientApi({ ...server, token: "0".repeat(32) }).ping().catch((e) => e)).toMatchObject({ status: 401, code: "unauthorized" });
  expect(await clientApi({ port: 1, token: server.token }).ping().catch((e) => e)).toMatchObject({ status: 0, code: "unreachable" });
});

test("a read mark from another process reaches a subscriber as a store change within 500 ms", async () => {
  const server = (await findServer(ctx))!;
  await agentReply();
  const heard = new Heard();
  const sub = subscribe(server, review, 0, heard.live);
  expect((await heard.next("hello")).value).toBe("dev");
  const from = heard.got.length;
  await ok(stet(["read", String(thread)], { cwd: f.root, role: "reviewer" }));
  const written = Date.now();
  const store = await heard.next("store", () => true, from);
  expect(store.value).toEqual(["reads"]);
  expect(store.at - written).toBeLessThan(500);
  expect(heard.got.some((m) => m.kind === "otherBuild")).toBe(false);
  await sub.close();
});

test("a subscriber opens the stream again after the server restarts on its port", async () => {
  const server = (await findServer(ctx))!;
  const heard = new Heard();
  const sub = subscribe(server, review, 0, heard.live);
  await heard.next("hello");
  const from = heard.got.length;

  expect(await stop(ctx)).toBe(true);
  const restarted = await connect();
  expect(restarted.port).toBe(server.port);
  expect(restarted.pid).not.toBe(server.pid);

  await heard.next("hello", (b) => b === "dev", from);
  const back = heard.got.length;
  await ok(stet(["config", "set", "compare.order", "kinds"], { cwd: f.root, role: "reviewer" }));
  expect((await heard.next("store", () => true, back)).value).toEqual(["config"]);
  await sub.close();
});

test("a subscriber notices a server of another build; connect replaces it on its port", async () => {
  const server = (await findServer(ctx))!;
  const heard = new Heard();
  const sub = subscribe(server, review, 0, heard.live);
  await heard.next("hello");
  const from = heard.got.length;

  expect(await stop(ctx)).toBe(true);
  const info = await startOld();
  expect(info.port).toBe(server.port);
  expect((await findServer(ctx))?.build).toBe("old");
  expect((await heard.next("otherBuild", () => true, from)).value).toBe("old");

  const replaced = await connect();
  expect(replaced.stderr).toContain("stopped the server of another build (old)");
  expect(replaced).toMatchObject({ port: server.port, build: "dev" });
  expect(await old!.exited).toBe(0);
  await heard.next("hello", (b) => b === "dev", heard.got.findIndex((m, i) => i >= from && m.kind === "otherBuild") + 1);
  await sub.close();
});

test("close ends the stream and its retries", async () => {
  const server = (await findServer(ctx))!;
  const heard = new Heard();
  const sub = subscribe(server, review, 0, heard.live);
  await heard.next("hello");
  await sub.close();
  const n = heard.got.length;
  await agentReply();
  await ok(stet(["read", String(thread)], { cwd: f.root, role: "reviewer" }));
  await Bun.sleep(700);
  expect(heard.got.length).toBe(n);

  const refused = new Heard();
  const lost = subscribe({ port: 1, token: server.token }, review, 0, refused.live);
  await Bun.sleep(300);
  await lost.close();
  await Bun.sleep(3500);
  expect(refused.got).toEqual([]);
});
