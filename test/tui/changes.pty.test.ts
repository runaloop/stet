import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stet, ok } from "../helpers/cli.ts";
import { Fixture, GIT_ENV } from "../helpers/fixture.ts";
import { seedTui, type Seeded } from "../fixtures/tui-seed.ts";
import { parseHash, takeToken } from "../../src/ui/route.ts";
import { startPty, type PtyRun } from "./pty.ts";
import { clientApi } from "../../src/client/api.ts";
import { findServer } from "../../src/client/server.ts";
import { openContext } from "../../src/core/context.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const f = new Fixture();
const tools = join(f.root, "..", `${f.root.split("/").pop()}-tools`);
const opened = join(tools, "opened");
let ids: Seeded;

beforeAll(() => {
  ids = seedTui(f.root, ["bun", CLI]);
  // the browser key's URL lands here instead of in a browser
  mkdirSync(tools, { recursive: true });
  for (const name of ["xdg-open", "open"]) {
    writeFileSync(join(tools, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${opened}\n`);
    chmodSync(join(tools, name), 0o755);
  }
}, 120_000);

afterAll(async () => {
  await stet(["serve", "--stop"], { cwd: f.root, role: "reviewer" });
  f.cleanup();
  Bun.spawnSync(["rm", "-rf", tools]);
});

const footer = (s: string) => s.trimEnd().split("\n").at(-1)!;

function tui(cols = 120, rows = 40): PtyRun {
  return startPty(["bun", CLI, "tui"], { cwd: f.root, cols, rows, env: { ...GIT_ENV, STET_ROLE: "reviewer", STET_AUTHOR: "arkadiy", PATH: `${tools}:${process.env.PATH}` } });
}

/** Keys one at a time, as typed. */
async function type(run: PtyRun, keys: string): Promise<void> {
  for (const k of keys) {
    run.write(k);
    await Bun.sleep(15);
  }
}

async function quit(run: PtyRun): Promise<void> {
  for (let i = 0; i < 4 && !(await Promise.race([run.exited.then(() => true), Bun.sleep(400).then(() => false)])); i++) run.write("q");
  expect(await Promise.race([run.exited, Bun.sleep(10_000).then(() => "timeout" as const)])).toBe(0);
}

const urls = () => (existsSync(opened) ? readFileSync(opened, "utf8").trim().split("\n") : []);

/** The route of the URL the browser key opens next: it presses the key itself. */
async function browserKey(run: PtyRun): Promise<ReturnType<typeof parseHash>> {
  const before = urls().length;
  run.write("gx");
  const until = Date.now() + 5000;
  while (Date.now() < until && urls().length === before) await Bun.sleep(50);
  const url = new URL(urls().at(-1)!);
  const { review: _, ...route } = parseHash(takeToken(url.hash)!.hash) as ReturnType<typeof parseHash> & { review?: number };
  return route as ReturnType<typeof parseHash>;
}

test("stet tui, the Changes tab: / searches, n and F3 step; V and i start a draft thread; the finders jump; g x opens the lines in the browser", async () => {
  const run = tui();
  try {
    await run.waitFor((s) => s.includes(" Threads ") && footer(s).includes("THREADS"), 30_000);
    run.write(" fv");
    await run.waitFor((s) => s.includes("Find a version") && s.includes("rate limit and API key"));
    await type(run, "v2");
    run.write("\r");
    await run.waitFor((s) => s.includes("What changed in v2 v1 → v2") && footer(s).includes("CHANGES"));

    await type(run, "/given");
    await run.waitFor((s) => footer(s).includes("SEARCH  /given▏") && footer(s).includes("4 matches"));
    run.write("\r");
    await run.waitFor((s) => s.includes("/given · match 1 of 4"));
    run.write("n");
    await run.waitFor((s) => s.includes("/given · match 2 of 4"));
    run.write("\x1bOR");
    await run.waitFor((s) => s.includes("/given · match 3 of 4"));
    run.write("N");
    await run.waitFor((s) => s.includes("/given · match 2 of 4"));
    run.write("\x1b");
    await run.waitFor((s) => !s.includes("/given ·") && s.includes("threads on this diff"));

    // the removed lines 4–5 of src/auth.ts, from the second of them up
    await type(run, "/return given === KEY");
    run.write("\r");
    await run.waitFor((s) => s.includes("match 1 of 1"));
    run.write("\x1b");
    await run.waitFor((s) => !s.includes("match 1 of 1"));
    run.write("V");
    await run.waitFor((s) => footer(s).includes("VISUAL"));
    run.write("k");
    expect(await browserKey(run)).toEqual({ name: "compare", from: "1", to: "2", file: "src/auth.ts", line: 4, end: 5, side: "old" });
    run.write("i");
    await run.waitFor((s) => s.includes("New thread on src/auth.ts:4–5 · removed lines (v1) · draft") && footer(s).includes("NEW THREAD"));
    await type(run, "Both lines compare a secret with ===.");
    run.write("\x13");
    await run.waitFor((s) => s.includes("draft #") && s.includes("saved on src/auth.ts:4–5"), 10_000);
    const api = clientApi((await findServer(await openContext({ cwd: f.root, role: "reviewer" })))!);
    const review = (await api.reviews()).default!;
    const mine = (await api.threads(review)).find((t) => t.title.startsWith("Both lines compare"));
    expect(mine).toMatchObject({ draft: true, path: "src/auth.ts", side: "old", range: { start: 4, end: 5 } });

    run.write("  ");
    await run.waitFor((s) => s.includes("Find a file") && s.includes("a file of this diff"));
    await type(run, "limiter.ts");
    run.write("\r");
    await run.waitFor((s) => !s.includes("Find a file") && /▾ src\/limiter\.ts/.test(s.split("\n").slice(3, 8).join("\n")));
    await quit(run);
  } finally {
    run.close();
  }
}, 90_000);

test("stet tui, a thread's page: a file its message names opens over the code at its lines; a name two files have opens the finder with it typed in", async () => {
  const run = tui(180, 46);
  try {
    await run.waitFor((s) => s.includes(" Threads ") && s.includes(`#${ids.port}`), 30_000);
    // the last thread in the list
    run.write("G");
    await run.waitFor((s) => s.includes(`#${ids.port} src/server.ts:3`));
    run.write("l");
    await run.waitFor((s) => footer(s).includes("CODE"));
    run.write("gf");
    await run.waitFor((s) => s.includes("Files the messages name") && s.includes("routes.ts:12 · claude · 2 files have this name"));
    run.write("1");
    await run.waitFor((s) => s.includes("src/server.ts · as in the agent's reply on #") && s.includes("lines 3–4") && s.includes("Esc  back to the thread's code"));
    expect(await browserKey(run)).toEqual({ name: "compare", from: "base", to: "2", file: "src/server.ts", line: 3, end: 4 });
    run.write("\x1b");
    await run.waitFor((s) => !s.includes("Esc  back to the thread's code") && s.includes("src/server.ts · line 3"));
    run.write("gf");
    await run.waitFor((s) => s.includes("Files the messages name"));
    run.write("2");
    await run.waitFor((s) => s.includes("Find a file") && s.includes(" > routes.ts▏") && s.includes("open it at line 12"));
    run.write("\x0e");
    run.write("\r");
    await run.waitFor((s) => /src\/(admin\/)?routes\.ts · as in the agent's reply on #\d+ \(v2\) · line 12/.test(s));
    await quit(run);
  } finally {
    run.close();
  }
}, 90_000);
