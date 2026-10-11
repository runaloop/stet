import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fixture, GIT_ENV } from "./helpers/fixture.ts";
import { startPty } from "./tui/pty.ts";

const ROOT = join(import.meta.dir, "..");
const out = mkdtempSync(join(tmpdir(), "stet-build-"));
const f = new Fixture();
let server: ReturnType<typeof Bun.spawn> | null = null;

afterAll(() => {
  server?.kill();
  f.cleanup();
  rmSync(out, { recursive: true, force: true });
});

test("the compiled binary runs from any directory and serves every asset", async () => {
  const bin = join(out, "stet");
  const build = Bun.spawnSync(["bun", "build", "--compile", "--minify", "--splitting", "src/cli.ts", "src/tui/diff/hl-worker.ts", "--outfile", bin], { cwd: ROOT, stderr: "pipe" });
  expect(build.exitCode).toBe(0);

  f.write("a.txt", "x\n");
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write("b.ts", "export const answer: number = 42;\n");
  const env = { ...process.env, ...GIT_ENV };
  expect(Bun.spawnSync([bin, "version", "create", "--json"], { cwd: f.root, env }).exitCode).toBe(0);
  const help = Bun.spawnSync([bin, "--help"], { cwd: tmpdir() }).stdout.toString();
  expect(help).toContain("thread-first local code review");

  server = Bun.spawn([bin, "serve", "--json"], { cwd: f.root, env, stdout: "pipe", stderr: "pipe" });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const info = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  reader.releaseLock();
  const base = `http://127.0.0.1:${info.port}`;
  const html = await (await fetch(base + "/")).text();
  const entry = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);
  expect(entry.some((a) => a.endsWith(".js"))).toBe(true);
  expect(entry.some((a) => a.endsWith(".css"))).toBe(true);
  const seen = new Set<string>();
  const queue = [...entry];
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const res = await fetch(base + path);
    expect(res.status).toBe(200);
    if (path.endsWith(".js")) {
      const body = await res.text();
      for (const m of body.matchAll(/["'(]\.?\/?(chunk-[a-z0-9]+\.(?:js|css))/g)) queue.push(`/${m[1]}`);
    }
  }
  expect(seen.size).toBeGreaterThan(5);
  const worker = await fetch(`${base}/diffs-worker.js`);
  expect(worker.status).toBe(200);
  expect(worker.headers.get("content-type")).toContain("javascript");
  expect((await worker.text()).length).toBeGreaterThan(100_000);
  const skill = Bun.spawnSync([bin, "skill", "install", "--dir", out, "--json"], { cwd: tmpdir() });
  expect(JSON.parse(skill.stdout.toString()).installed).toEqual([{ path: join(out, "stet-review", "SKILL.md"), harnesses: [] }]);

  // the terminal UI colours code with Shiki in a worker, an entry point of its own in the binary
  const trace = join(out, "trace.log");
  const tui = startPty([bin, "tui"], { cwd: f.root, cols: 120, rows: 30, env: { ...GIT_ENV, STET_ROLE: "reviewer", STET_TUI_TRACE: trace } });
  try {
    await tui.waitFor((s) => s.includes(" Threads "), 20_000);
    tui.write(" rv");
    await tui.waitFor((s) => s.includes("b.ts"), 20_000);
    const until = Date.now() + 15_000;
    let log = "";
    while (Date.now() < until && !log.includes("hlFirst")) {
      await Bun.sleep(200);
      log = existsSync(trace) ? readFileSync(trace, "utf8") : "";
      if (!log.includes("hlFirst")) tui.write("j");
    }
    expect(log).not.toContain("hlError");
    expect(log).toContain("hlFirst");
    tui.write("q");
    await Bun.sleep(300);
    tui.write("q");
    expect(await Promise.race([tui.exited, Bun.sleep(10_000).then(() => "timeout" as const)])).toBe(0);
  } finally {
    tui.close();
  }
}, 120_000);
