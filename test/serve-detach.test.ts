import { afterAll, expect, test } from "bun:test";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture, lines } from "./helpers/fixture.ts";

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
