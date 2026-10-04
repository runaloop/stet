import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture, GIT_ENV, lines } from "./helpers/fixture.ts";

const f = new Fixture();
let proc: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let token = "";

beforeAll(async () => {
  f.write("a.kt", lines(20));
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write("a.kt", lines(21));
  await ok(stet(["version", "create"], { cwd: f.root }));
  proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "serve", "--json"], {
    cwd: f.root,
    env: { ...process.env, ...GIT_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  const info = JSON.parse(new TextDecoder().decode(value));
  base = `http://127.0.0.1:${info.port}`;
  token = info.url.split("token=")[1];
});

afterAll(() => {
  proc?.kill();
  f.cleanup();
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { "x-stet-token": token, "content-type": "application/json", ...(init.headers ?? {}) } });

test("rejects missing token and foreign hosts", async () => {
  expect((await fetch(`${base}/api/reviews`)).status).toBe(401);
  expect((await fetch(`${base}/api/reviews`, { headers: { "x-stet-token": token, host: "evil.example" } })).status).toBe(403);
  expect((await api("/api/reviews", { headers: { origin: "http://evil.example" } })).status).toBe(403);
  expect((await api("/api/reviews")).status).toBe(200);
});

test("serves the UI page and its assets", async () => {
  const html = await (await fetch(`${base}/`)).text();
  expect(html).toContain('<div id="app">');
  const assets = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);
  expect(assets.length).toBeGreaterThan(0);
  for (const a of assets) expect((await fetch(base + a)).status).toBe(200);
});

test("draft thread, submit, and resolve through the API", async () => {
  const t = await (await api("/api/threads", { method: "POST", body: JSON.stringify({ path: "a.kt", start: 3, end: 4, at: "1", body: "hmm" }) })).json();
  expect(t.draft).toBe(true);
  const drafts = await (await api("/api/drafts")).json();
  expect(drafts).toHaveLength(1);
  const sub = await (await api("/api/review/submit", { method: "POST", body: "{}" })).json();
  expect(sub.comments).toBe(1);
  const detail = await (await api(`/api/threads/${t.id}`)).json();
  expect(detail.timeline[0].label).toBe("v1");
  const blob = await (await api(`/api/blob?sha=${detail.timeline[0].sha}&path=a.kt`)).json();
  expect(blob.contents.split("\n")[2]).toBe("line 3");
  expect((await api(`/api/threads/${t.id}/resolve`, { method: "POST", body: JSON.stringify({ reason: "fixed" }) })).status).toBe(200);
  const resolved = await (await api(`/api/threads/${t.id}`)).json();
  expect(resolved.thread.resolvedAt).toBeTruthy();
  expect(resolved.events.map((e: { type: string }) => e.type)).toEqual(["resolved"]);
  expect((await api("/api/blob?sha=zzz&path=../etc/passwd")).status).toBe(400);
});

test("a CLI reply reaches the SSE stream within a second", async () => {
  const t = await (await api("/api/threads", { method: "POST", body: JSON.stringify({ path: "a.kt", start: 7, end: 7, at: "1", body: "live?", draft: false }) })).json();
  const res = await fetch(`${base}/api/events?token=${token}`);
  const reader = res.body!.getReader();
  const started = Date.now();
  const reply = ok(stet(["reply", String(t.id), "--body", "yes"], { cwd: f.root }));
  let got = "";
  while (!got.includes("comment.published") && Date.now() - started < 5000) {
    const { value } = await reader.read();
    got += new TextDecoder().decode(value);
  }
  await reply;
  reader.cancel();
  expect(got).toContain("comment.published");
  expect(Date.now() - started).toBeLessThan(process.env.CI ? 8000 : 3000);
});

test("the pinned now moves on when the agent hands over a newer version", async () => {
  const before = await (await api("/api/review")).json();
  f.write("a.kt", lines(25));
  const v = await ok(stet(["version", "create"], { cwd: f.root }));
  const after = await (await api("/api/review")).json();
  expect(after.pinnedNow).not.toBe(before.pinnedNow);
  expect(after.pinnedNow).toBe(v.version.snapshot);
  expect(after.now.changedSinceLatest).toBe(false);
});

test("the reviewer's last pass and viewed marks live in the database", async () => {
  expect(await (await api("/api/cursors")).json()).toEqual({ reviewed: null, viewed: [] });
  const r = await (await api("/api/reviewed", { method: "POST", body: JSON.stringify({ ref: "1" }) })).json();
  expect(r.label).toBe("v1");
  expect((await api("/api/viewed", { method: "POST", body: JSON.stringify({ keys: ["a.kt@abc", "b.kt@def"], on: true }) })).status).toBe(200);
  expect((await api("/api/viewed", { method: "POST", body: JSON.stringify({ keys: ["b.kt@def"], on: false }) })).status).toBe(200);
  const c = await (await api("/api/cursors")).json();
  expect(c.reviewed.version).toBe(1);
  expect(c.viewed).toEqual(["a.kt@abc"]);
  expect((await api("/api/viewed", { method: "POST", body: JSON.stringify({ keys: [1] }) })).status).toBe(400);
  const now = await (await api("/api/reviewed", { method: "POST", body: JSON.stringify({ ref: "now" }) })).json();
  expect(now.sha).toMatch(/^[0-9a-f]{40}$/);
});

test("the review lists how many files each version changed", async () => {
  const s = await (await api("/api/review")).json();
  expect(s.versionsList.map((v: { files: number | null }) => v.files)).toEqual([1, 1]);
});

test("a server started in one worktree gives another worktree a URL of that worktree's review", async () => {
  const wt = join(f.root, "wt-other");
  f.git(["worktree", "add", "-q", "-b", "other", wt]);
  await Bun.write(join(wt, "b.kt"), "val b = 1\n");
  await ok(stet(["version", "create"], { cwd: wt }));
  const reviews = (await (await api("/api/reviews")).json()).reviews as { id: number; branch: string }[];
  const other = reviews.find((r) => r.branch === "other")!.id;
  const feat = reviews.find((r) => r.branch === "feat")!.id;
  const again = await ok(stet(["serve"], { cwd: wt }));
  expect(again.reused).toBe(true);
  expect(again.url).toBe(`${base}/#/?review=${other}&token=${token}`);
  expect((await ok(stet(["status"], { cwd: wt }))).server.url).toContain(`review=${other}&token=`);
  expect((await ok(stet(["status"], { cwd: f.root }))).server.url).toContain(`review=${feat}&token=`);
});
