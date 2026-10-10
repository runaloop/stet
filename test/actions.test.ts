import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionTarget } from "../src/core/actions.ts";
import { BUILD } from "../src/core/build.ts";
import { openContext, ensureReview, type Ctx } from "../src/core/context.ts";
import type { ModuleSpec } from "../src/core/module.ts";
import { actionOf, actionsOf } from "../src/core/modules.ts";
import { clearNowCache } from "../src/core/snapshot.ts";
import type { ReviewRow } from "../src/core/store/db.ts";
import { handleApi, type ServerState } from "../src/server/api.ts";
import { writeServerInfo } from "../src/server/info.ts";
import { parseHash, takeToken } from "../src/ui/route.ts";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture, lines } from "./helpers/fixture.ts";

const notes: ModuleSpec = {
  id: "notes",
  label: "notes on files",
  default: "on",
  actions: [{
    id: "notes.pin",
    label: "pin a note",
    command: "notes.pin",
    where: ["thread"],
    available: () => true,
    resolve: async (ctx) => ({ kind: "argv", argv: ["notes", "pin", "a b"], cwd: ctx.repo.cwd }),
  }],
};

const f = new Fixture();
const tools = mkdtempSync(join(tmpdir(), "stet-actions-"));
const TOKEN = "f".repeat(32);
let ctx: Ctx;
let review: ReviewRow;
let thread = 0;
let fake: ReturnType<typeof Bun.serve>;
let state: ServerState;

beforeAll(async () => {
  f.write("a.kt", lines(20));
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write("a.kt", lines(21));
  await ok(stet(["version", "create"], { cwd: f.root }));
  thread = (await ok(stet(["comment", "add", "--file", "a.kt", "--range", "5-6", "--body", "why?"], { cwd: f.root, role: "reviewer" }))).id;
  f.write("a.kt", "new 1\nnew 2\n" + lines(21));
  ctx = await openContext({ cwd: f.root, role: "reviewer", author: "alice" });
  review = await ensureReview(ctx);
  clearNowCache();
  // Stands in for `stet serve` of this build: browser.open only needs a server that answers ping with the token and the build.
  fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => (req.headers.get("x-stet-token") === TOKEN ? Response.json({ ok: true, build: BUILD }) : new Response("no", { status: 401 })),
  });
  writeServerInfo(ctx.repo.commonDir, { pid: process.pid, port: fake.port!, token: TOKEN, url: "", startedAt: new Date().toISOString() });
  state = { ctx, defaultReview: review.id, pinnedNow: new Map(), pinning: new Map() };
});

afterAll(() => {
  fake?.stop(true);
  f.cleanup();
  rmSync(tools, { recursive: true, force: true });
});

const post = async (s: ServerState, id: string, target: unknown) => {
  const req = new Request(`http://127.0.0.1/api/actions/${id}?review=${review.id}`, { method: "POST", body: JSON.stringify(target) });
  const res = await handleApi(s, req, new URL(req.url));
  return { status: res.status, body: (await res.json()) as any };
};

/** Runs `fn` with these variables in this process's environment, as the server would see them. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("editor.open", () => {
  test("the route and stet open --print give the same command for a thread, without STET_EDITOR", async () => {
    const env = { STET_EDITOR: "", VISUAL: "", EDITOR: "nvim" };
    const web = await withEnv(env, () => post(state, "editor.open", { thread }));
    const cli = await ok(stet(["open", String(thread), "--print"], { cwd: f.root, env }));
    expect(web.status).toBe(200);
    expect(web.body.launched).toBe(false);
    expect(web.body.launch).toEqual({ kind: "file", root: f.root, path: "a.kt", file: join(f.root, "a.kt"), line: 7 });
    expect(cli).toEqual({ argv: ["nvim", "+7", join(f.root, "a.kt")], cwd: f.root, shell: web.body.command, file: join(f.root, "a.kt"), line: 7 });
    const old = new Request(`http://127.0.0.1/api/open?review=${review.id}`, { method: "POST", body: JSON.stringify({ threadId: thread }) });
    expect((await handleApi(state, old, new URL(old.url))).status).toBe(404);
  });

  test("the server runs STET_EDITOR with the same file, line and repository path as stet open gives", async () => {
    const out = join(tools, "editor.out");
    const editor = join(tools, "editor.sh");
    writeFileSync(editor, `#!/bin/sh\nprintf '%s\\n' "$@" > ${out}\n`);
    chmodSync(editor, 0o755);
    const env = { STET_EDITOR: `${editor} {file} {line} {path} {root}` };
    const web = await withEnv(env, () => post(state, "editor.open", { thread }));
    expect(web.body.launched).toBe(true);
    for (let i = 0; i < 40 && !existsSync(out); i++) await Bun.sleep(50);
    const ran = readFileSync(out, "utf8").trim().split("\n");
    const cli = await ok(stet(["open", String(thread), "--print"], { cwd: f.root, env }));
    expect(ran).toEqual([join(f.root, "a.kt"), "7", "a.kt", f.root]);
    expect(cli.argv).toEqual([editor, ...ran]);
    expect(web.body.command).toBe(cli.shell);
  });

  test("a line of a version opens where that line is now", async () => {
    const at = async (target: object) => (await actionOf(ctx, "editor.open").resolve(ctx, review, actionTarget(target)));
    expect(await at({ path: "a.kt", line: 5, at: "1" })).toMatchObject({ path: "a.kt", line: 7 });
    expect(await at({ path: "a.kt", line: 5 })).toMatchObject({ path: "a.kt", line: 5 });
    expect((await post(state, "editor.open", {})).status).toBe(400);
  });
});

describe("browser.open", () => {
  const route = (url: string) => {
    const { origin, hash } = new URL(url);
    const t = takeToken(hash)!;
    return { origin, token: t.token, route: parseHash(t.hash) };
  };

  test("resolves a thread, a file's line in a compare, and the review to the page's routes on the running server", async () => {
    const open = async (target: object) => {
      const r = await post(state, "browser.open", target);
      expect(r.body).toMatchObject({ launched: false, command: r.body.launch.url });
      return r.body.launch.url as string;
    };
    const origin = `http://127.0.0.1:${fake.port}`;
    expect(await open({ thread })).toBe(`${origin}/#/thread/${thread}?review=${review.id}&token=${TOKEN}`);
    expect(route(await open({ thread }))).toEqual({ origin, token: TOKEN, route: { name: "thread", id: thread, review: review.id } });
    expect(route(await open({ path: "a.kt", line: 7, from: "1", at: "now" })).route).toEqual({ name: "compare", from: "1", to: "now", file: "a.kt", line: 7, review: review.id });
    expect(route(await open({ path: "a.kt" })).route).toEqual({ name: "compare", from: "base", to: "now", file: "a.kt", review: review.id });
    expect(route(await open({})).route).toEqual({ name: "home", review: review.id });
    expect((await post(state, "browser.open", { thread: 999 })).status).toBe(404);
  });

  test("stet open --browser gives the same URL as the route", async () => {
    const cli = await ok(stet(["open", String(thread), "--browser", "--print"], { cwd: f.root }));
    expect(cli.url).toBe((await post(state, "browser.open", { thread })).body.launch.url);
    const home = await ok(stet(["open", "--browser", "--print"], { cwd: f.root }));
    expect(route(home.url).route).toEqual({ name: "home", review: review.id });
  });
});

describe("a module's actions", () => {
  const ids = (s: ServerState) => actionsOf(s.ctx, s.modules).map((a) => a.id);

  test("are listed and run while the module is on", async () => {
    const s = { ...state, modules: [notes] };
    expect(ids(s)).toEqual(["editor.open", "browser.open", "notes.pin"]);
    const res = await handleApi(s, new Request(`http://127.0.0.1/api/review?review=${review.id}`), new URL(`http://127.0.0.1/api/review?review=${review.id}`));
    expect(((await res.json()) as any).ui.actions.map((a: { id: string }) => a.id)).toEqual(["editor.open", "browser.open", "notes.pin"]);
    expect((await post(s, "notes.pin", {})).body).toEqual({ launch: { kind: "argv", argv: ["notes", "pin", "a b"], cwd: f.root }, launched: false, command: "notes pin 'a b'" });
  });

  test("are not listed while the module is off or not built, and their route says why", async () => {
    ctx.store.setMeta("modules.notes", "off");
    try {
      const off = { ...state, modules: [notes] };
      expect(ids(off)).toEqual(["editor.open", "browser.open"]);
      expect(await post(off, "notes.pin", {})).toEqual({
        status: 400,
        body: { error: { code: "usage", message: "the action notes.pin belongs to the notes module, which is off in this repository: stet config set modules.notes on" } },
      });
    } finally {
      ctx.store.setMeta("modules.notes", "on");
    }
    const without = { ...state, modules: [] };
    expect(ids(without)).toEqual(["editor.open", "browser.open"]);
    expect(await post(without, "notes.pin", {})).toEqual({
      status: 404,
      body: { error: { code: "not_found", message: "no action notes.pin in this build; it has editor.open, browser.open" } },
    });
  });
});

describe("browser.open without a server", () => {
  const g = new Fixture();
  g.write("a.kt", lines(3)).commit("init");
  g.git(["checkout", "-q", "-b", "feat"]);

  afterAll(async () => {
    await stet(["serve", "--stop"], { cwd: g.root, role: "reviewer" });
    g.cleanup();
  });

  test("starts one on its own, as stet serve --open does", async () => {
    await ok(stet(["version", "create"], { cwd: g.root }));
    const { url } = await ok(stet(["open", "--browser", "--print"], { cwd: g.root }));
    const port = new URL(url).port;
    const status = await ok(stet(["status"], { cwd: g.root }));
    expect(new URL(status.server.url).port).toBe(port);
    expect((await fetch(`http://127.0.0.1:${port}/api/ping`)).status).toBe(401);
  });
});
