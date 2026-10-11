import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stet, ok } from "../helpers/cli.ts";
import { Fixture, GIT_ENV, lines } from "../helpers/fixture.ts";
import { startPty } from "./pty.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const f = new Fixture();
let first = 0;
let second = 0;

beforeAll(async () => {
  f.write("a.kt", lines(20));
  f.write("b.kt", lines(10));
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write("a.kt", lines(21));
  f.write("b.kt", lines(11));
  await ok(stet(["version", "create"], { cwd: f.root }));
  first = (await ok(stet(["comment", "add", "--file", "a.kt", "--range", "3-4", "--body", "Why is this line here?"], { cwd: f.root, role: "reviewer" }))).id;
  second = (await ok(stet(["comment", "add", "--file", "b.kt", "--range", "2", "--body", "And this one?"], { cwd: f.root, role: "reviewer" }))).id;
  await ok(stet(["reply", String(first), "--body", "It keeps the order stable.", "--intent", "answered"], { cwd: f.root }));
});

afterAll(async () => {
  await stet(["serve", "--stop"], { cwd: f.root, role: "reviewer" });
  f.cleanup();
});

const header = (s: string) => s.split("\n")[0]!;
const footer = (s: string) => s.trimEnd().split("\n").at(-1)!;

test("stet tui: the list previews the selected thread, l goes into it and marks it read, h comes back, q quits and gives the terminal back", async () => {
  const frames = join(f.root, ".git", "frames");
  const run = startPty(["bun", CLI, "tui"], { cwd: f.root, cols: 120, rows: 36, env: { ...GIT_ENV, STET_ROLE: "reviewer", STET_AUTHOR: "alice", STET_TUI_FRAMES: frames } });
  try {
    const skeleton = await run.waitFor((s) => header(s).startsWith("stet"), 20_000);
    const shown = await run.waitFor((s) => s.includes("Threads Files Search") && s.includes("preview") && s.includes("It keeps the order stable."), 20_000);
    expect(run.modes.state.altScreen).toBe(true);
    expect(footer(run.screen())).toContain("THREADS");

    // Nothing moves on screen: no frame is drawn and nothing is written to the terminal.
    await Bun.sleep(300);
    const framesBefore = Number(readFileSync(frames, "utf8"));
    const bytesBefore = run.raw().length;
    await Bun.sleep(2000);
    const idleFrames = Number(readFileSync(frames, "utf8")) - framesBefore;
    const idleBytes = run.raw().length - bytesBefore;
    console.log(`tui pty: first frame ${skeleton.toFixed(0)} ms, with the data ${shown.toFixed(0)} ms; idle 2 s: ${idleFrames} frames, ${idleBytes} bytes`);
    expect(idleFrames).toBe(0);
    expect(idleBytes).toBe(0);

    run.write("j");
    await run.waitFor((s) => s.includes(`#${second} b.kt:2`) && s.includes("And this one?") && s.includes("preview"));
    run.write("k");
    await run.waitFor((s) => s.includes(`#${first} a.kt:3–4`) && s.includes("preview"));
    expect(run.screen()).toContain("●");

    run.write("l");
    await run.waitFor((s) => footer(s).includes("THREAD ") && s.includes("1 of 2"));
    await run.waitFor((s) => !s.includes("●"));

    run.write("h");
    await run.waitFor((s) => footer(s).includes("THREADS") && s.includes("preview"));
    expect(header(run.screen())).toContain("stet");
    run.write("q");
    const code = await Promise.race([run.exited, Bun.sleep(10_000).then(() => "timeout" as const)]);
    expect(code).toBe(0);
    const st = run.modes.state;
    expect(st.altScreen).toBe(false);
    expect(run.xt.buffer.active.type).toBe("normal");
    expect(st.cursorHidden).toBe(false);
    expect(st.kittyDepth).toBe(0);
    expect(st.mouse).toBe(false);
    expect(st.bracketedPaste).toBe(false);
  } finally {
    run.close();
  }
  const unread = await ok(stet(["threads", "list", "--unread"], { cwd: f.root, role: "reviewer" }));
  expect(unread.map((t: { id: number }) => t.id)).not.toContain(first);
}, 60_000);

test("stet tui refuses without a terminal", async () => {
  const r = await stet(["tui"], { cwd: f.root, role: "reviewer", json: false });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("needs a terminal");
});
