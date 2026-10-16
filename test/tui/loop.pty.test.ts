// The review loop of phase 5 end to end, in one terminal UI that is never restarted: the reviewer compares v1..v2,
// comments on a range and submits; the agent's CLI replies and creates v3; the TUI shows both as they come.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { clientApi, type Api } from "../../src/client/api.ts";
import { findServer } from "../../src/client/server.ts";
import { openContext } from "../../src/core/context.ts";
import { seedTui } from "../fixtures/tui-seed.ts";
import { ok, stet } from "../helpers/cli.ts";
import { Fixture, GIT_ENV } from "../helpers/fixture.ts";
import { startPty, type PtyRun } from "./pty.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const f = new Fixture();

beforeAll(() => {
  seedTui(f.root, ["bun", CLI]);
}, 120_000);

afterAll(async () => {
  await stet(["serve", "--stop"], { cwd: f.root, role: "reviewer" });
  f.cleanup();
});

const header = (s: string) => s.split("\n")[0]!;
const footer = (s: string) => s.trimEnd().split("\n").at(-1)!;

async function type(run: PtyRun, keys: string): Promise<void> {
  for (const k of keys) {
    run.write(k);
    await Bun.sleep(15);
  }
}

test("the loop: compare v1..v2, comment a range, submit; the agent replies and makes v3; the TUI shows both without a restart", async () => {
  const run = startPty(["bun", CLI, "tui"], { cwd: f.root, cols: 140, rows: 42, env: { ...GIT_ENV, STET_ROLE: "reviewer", STET_AUTHOR: "arkadiy" } });
  let api: Api;
  try {
    await run.waitFor((s) => s.includes(" Threads ") && footer(s).includes("THREADS"), 30_000);
    api = clientApi((await findServer(await openContext({ cwd: f.root, role: "reviewer" })))!);
    const review = (await api.reviews()).default!;

    // compare v1..v2
    run.write(" fv");
    await run.waitFor((s) => s.includes("Find a version"));
    await type(run, "2");
    run.write("\r");
    await run.waitFor((s) => s.includes("What changed in v2 v1 → v2") && footer(s).includes("CHANGES"));

    // comment on the two lines of the limiter's sweep call and its return
    await type(run, "/this.sweep(now)");
    run.write("\r");
    await run.waitFor((s) => s.includes("match 1 of 1"));
    run.write("\x1b");
    await run.waitFor((s) => s.includes("threads on this diff"));
    run.write("V");
    run.write("j");
    await run.waitFor((s) => footer(s).includes("VISUAL"));
    run.write("i");
    await run.waitFor((s) => s.includes("New thread on src/limiter.ts:11–12 (v2) · draft"));
    await type(run, "Sweep before the push, so a full map never takes one more key.");
    run.write("\x13");
    await run.waitFor((s) => s.includes("saved on src/limiter.ts:11–12"), 10_000);
    const mine = (await api.threads(review)).find((t) => t.title.startsWith("Sweep before the push"))!;
    expect(mine).toMatchObject({ draft: true, path: "src/limiter.ts", range: { start: 11, end: 12 } });

    // submit: S shows the drafts, S again requests changes
    run.write("S");
    await run.waitFor((s) => footer(s).includes("DRAFTS") && s.includes("Request changes"));
    run.write("S");
    await run.waitFor((s) => s.includes("changes requested:"), 10_000);
    expect((await api.drafts(review)).length).toBe(0);
    expect((await api.thread(review, mine.id)).thread.draft).toBe(false);

    // the agent answers from its CLI and hands over v3
    await ok(stet(["reply", String(mine.id), "--body", "Moved the sweep before the push.", "--intent", "fixed"], { cwd: f.root }));
    writeFileSync(join(f.root, "src/limiter.ts"), (await Bun.file(join(f.root, "src/limiter.ts")).text()).replace("    list.push(now);\n    this.hits.set(key, list);\n    if (this.hits.size > 10_000) this.sweep(now);", "    if (this.hits.size > 10_000) this.sweep(now);\n    list.push(now);\n    this.hits.set(key, list);"));
    await ok(stet(["version", "create", "--label", "sweep first"], { cwd: f.root }));

    await run.waitFor((s) => s.includes("The agent handed over v3.") && / v3 /.test(header(s)), 15_000);
    // n goes through the unread threads to the one the agent answered
    const shown = (s: string) => /╭─ #(\d+) \S+:\d/.exec(s)?.[1];
    for (let i = 0; i < 8 && shown(run.screen()) !== String(mine.id); i++) {
      const was = shown(run.screen());
      run.write("n");
      await run.waitFor((s) => !!shown(s) && shown(s) !== was, 5000).catch(() => null);
    }
    await run.waitFor((s) => s.includes(`#${mine.id} src/limiter.ts:`) && s.includes("Moved the sweep before the push."), 10_000);
    run.write(" rv");
    await run.waitFor((s) => footer(s).includes("CHANGES") && /v2 → v3|→ v3/.test(s) && s.includes("src/limiter.ts"), 10_000);
    for (let i = 0; i < 3; i++) run.write("q");
    run.write("q");
    expect(await Promise.race([run.exited, Bun.sleep(10_000).then(() => "timeout" as const)])).toBe(0);
  } finally {
    run.close();
  }
}, 120_000);
