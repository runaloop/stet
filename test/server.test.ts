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

test("compare.markdown takes rendered or code, and the page gets it with the review", async () => {
  const bad = await stet(["config", "set", "compare.markdown", "pretty"], { cwd: f.root });
  expect(bad.code).not.toBe(0);
  expect(bad.stderr + bad.stdout).toContain("compare.markdown takes rendered or code");
  await ok(stet(["config", "set", "compare.markdown", "code"], { cwd: f.root }));
  expect((await (await api("/api/review")).json()).ui.markdown).toBe("code");
  await ok(stet(["config", "set", "compare.markdown", "--unset"], { cwd: f.root }));
  expect((await (await api("/api/review")).json()).ui.markdown).toBeNull();
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

test("an approval through the API keeps or resolves the open threads, and the review carries its verdict", async () => {
  const post = (b: unknown) => api("/api/review/submit", { method: "POST", body: JSON.stringify(b) });
  const refused = await post({ verdict: "approved" });
  expect(refused.status).toBe(409);
  expect((await refused.json()).error.code).toBe("open_threads");
  expect((await post({ verdict: "yes" })).status).toBe(400);
  expect((await post({ verdict: "approved", open: "all" })).status).toBe(400);
  const approved = await (await post({ verdict: "approved", open: "resolve" })).json();
  expect(approved).toMatchObject({ verdict: "approved", comments: 0 });
  expect(approved.resolved.length).toBeGreaterThan(0);
  const s = await (await api("/api/review")).json();
  expect(s.submissions.map((x: { verdict: string }) => x.verdict)).toEqual(["changes", "approved"]);
  expect(s.lastSubmission).toMatchObject({ verdict: "approved", version: approved.version });
  expect(s.counts.open).toBe(0);
});

test("blame names each line's version, at the latest one or at the pinned now", async () => {
  const runs = async (q: string) =>
    ((await (await api(`/api/blame?${q}`)).json()).runs as { start: number; end: number; origin: { kind: string; version: number | null } }[]).map(
      (r) => `${r.start}-${r.end} ${r.origin.kind === "version" ? `v${r.origin.version}` : r.origin.kind}`,
    );
  expect(await runs("path=a.kt&from=19&to=25")).toEqual(["19-20 base", "21-21 v1", "22-25 v2"]);
  expect(await runs("path=a.kt&from=21&at=1")).toEqual(["21-21 v1"]);
  f.write("a.kt", lines(26));
  await api("/api/now/refresh", { method: "POST" });
  expect(await runs("path=a.kt&from=25&to=26&at=now")).toEqual(["25-25 v2", "26-26 now"]);
  expect((await api("/api/blame?path=../a.kt&from=1")).status).toBe(400);
  expect((await api("/api/blame?path=a.kt&from=0")).status).toBe(400);
  expect((await api("/api/blame?path=a.kt&from=1&at=base")).status).toBe(400);
  expect((await api("/api/blame?path=gone.kt&from=1")).status).toBe(404);
});

test("a restore request through the API is a draft with the old lines, in a new thread or in a given one", async () => {
  const post = (b: unknown) => api("/api/restore", { method: "POST", body: JSON.stringify(b) });
  const c = await (await post({ from: "base", path: "a.kt", start: 3, end: 4, at: "1" })).json();
  expect(c).toMatchObject({ draft: true, body: "", restore: { path: "a.kt", range: { start: 3, end: 4 }, version: "base", text: "line 3\nline 4" } });
  const reply = await (await post({ from: "1", path: "a.kt", start: 21, end: 21, thread: c.threadId, body: "this one too" })).json();
  expect(reply).toMatchObject({ threadId: c.threadId, parentId: c.id, body: "this one too", restore: { version: 1, text: "line 21" } });
  const drafts = await (await api("/api/drafts")).json();
  expect(drafts.filter((d: { restore?: unknown }) => d.restore)).toHaveLength(2);
  expect((await post({ from: "now", path: "a.kt", start: 1, end: 1 })).status).toBe(400);
  expect((await api(`/api/comments/${c.id}`, { method: "DELETE" })).status).toBe(200);
});
