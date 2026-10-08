import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture, GIT_ENV, lines } from "./helpers/fixture.ts";

const f = new Fixture();
f.write("a.kt", lines(5));
f.commit("init");
f.git(["checkout", "-q", "-b", "feat"]);
f.write("a.kt", lines(6));

afterAll(async () => {
  await stet(["serve", "--stop"], { cwd: f.root, role: "reviewer" });
  f.cleanup();
});

const ping = (port: number) =>
  fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1000) }).then(
    (r) => r.status,
    () => 0,
  );

test("serve --detach returns at once and the server outlives the command; --stop stops it", async () => {
  await ok(stet(["version", "create"], { cwd: f.root }));
  const t0 = Date.now();
  const started = await ok(stet(["serve", "--detach"], { cwd: f.root, role: "reviewer" }));
  expect(Date.now() - t0).toBeLessThan(15_000);
  expect(started.url).toContain("review=");
  expect(await ping(started.port)).toBe(401);

  const again = await ok(stet(["serve", "--detach"], { cwd: f.root, role: "reviewer" }));
  expect(again.port).toBe(started.port);

  const status = await ok(stet(["status"], { cwd: f.root }));
  expect(status.server.url).toBe(started.url);

  expect((await ok(stet(["serve", "--stop"], { cwd: f.root, role: "reviewer" }))).stopped).toBe(true);
  expect(await ping(started.port)).toBe(0);
  expect((await ok(stet(["serve", "--stop"], { cwd: f.root, role: "reviewer" }))).stopped).toBe(false);
});

test("serve replaces a server of another build, on its port", async () => {
  const old = Bun.spawn(["bun", "--define", 'STET_BUILD="old"', join(import.meta.dir, "..", "src", "cli.ts"), "serve", "--json"], {
    cwd: f.root,
    env: { ...process.env, ...GIT_ENV, STET_ROLE: "reviewer" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = (old.stdout as ReadableStream<Uint8Array>).getReader();
  const before = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  reader.releaseLock();
  const token = before.url.split("token=")[1];
  const build = () =>
    fetch(`http://127.0.0.1:${before.port}/api/ping`, { headers: { "x-stet-token": token }, signal: AbortSignal.timeout(1000) })
      .then((r) => r.json())
      .then((b: { build: string }) => b.build);
  expect(await build()).toBe("old");

  const r = await stet(["serve", "--detach"], { cwd: f.root, role: "reviewer" });
  expect(r.code).toBe(0);
  expect(r.stderr).toContain("stopped the server of another build (old)");
  expect(r.json).toMatchObject({ port: before.port, reused: false });
  expect(r.json.pid).not.toBe(before.pid);
  expect(await old.exited).toBe(0);
  expect(await build()).toBe("dev");

  expect((await ok(stet(["serve", "--detach"], { cwd: f.root, role: "reviewer" }))).reused).toBe(true);
});
