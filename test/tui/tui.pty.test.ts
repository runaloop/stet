import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { stet, ok } from "../helpers/cli.ts";
import { Fixture, GIT_ENV, lines } from "../helpers/fixture.ts";
import { startPty } from "./pty.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const f = new Fixture();
let thread = 0;

beforeAll(async () => {
  f.write("a.kt", lines(20));
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write("a.kt", lines(21));
  await ok(stet(["version", "create"], { cwd: f.root }));
  thread = (await ok(stet(["comment", "add", "--file", "a.kt", "--range", "3-4", "--body", "Why is this line here?"], { cwd: f.root, role: "reviewer" }))).id;
  await ok(stet(["reply", String(thread), "--body", "It keeps the order stable.", "--intent", "answered"], { cwd: f.root }));
});

afterAll(async () => {
  await stet(["serve", "--stop"], { cwd: f.root, role: "reviewer" });
  f.cleanup();
});

test("stet tui shows the threads, opens one, quits on q and gives the terminal back", async () => {
  const run = startPty(["bun", CLI, "tui"], { cwd: f.root, cols: 100, rows: 30, env: { ...GIT_ENV, STET_ROLE: "reviewer", STET_AUTHOR: "alice" } });
  try {
    await run.waitFor((s) => s.includes("Threads") && s.includes(`#${thread}`) && s.includes("Why is this line here?"), 20_000);
    expect(run.modes.state.altScreen).toBe(true);
    expect(run.screen()).toContain("your turn");
    run.write("\r");
    await run.waitFor((s) => s.includes("It keeps the order stable.") && s.includes("2 messages"));
    expect(run.screen()).toContain("esc back");
    expect(run.screen().split("\n")[0]).toContain("1 unread");
    await run.waitFor((s) => !s.split("\n")[0]!.includes("unread"));
    run.write("q");
    await run.waitFor((s) => s.includes("showing open threads"));
    run.write("q");
    const code = await Promise.race([run.exited, Bun.sleep(10_000).then(() => "timeout" as const)]);
    expect(code).toBe(0);
    const s = run.modes.state;
    expect(s.altScreen).toBe(false);
    expect(run.xt.buffer.active.type).toBe("normal");
    expect(s.cursorHidden).toBe(false);
    expect(s.kittyDepth).toBe(0);
    expect(s.mouse).toBe(false);
    expect(s.bracketedPaste).toBe(false);
  } finally {
    run.close();
  }
  const read = await ok(stet(["threads", "list", "--unread"], { cwd: f.root, role: "reviewer" }));
  expect(read.map((t: { id: number }) => t.id)).not.toContain(thread);
}, 60_000);

test("stet tui refuses without a terminal", async () => {
  const r = await stet(["tui"], { cwd: f.root, role: "reviewer", json: false });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("needs a terminal");
});
