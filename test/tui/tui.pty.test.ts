import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stet, ok } from "../helpers/cli.ts";
import { Fixture, GIT_ENV, lines } from "../helpers/fixture.ts";
import { startPty } from "./pty.ts";
import { clientApi } from "../../src/client/api.ts";
import { findServer } from "../../src/client/server.ts";
import { openContext } from "../../src/core/context.ts";

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
  const long = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long answer.`).join("\n");
  await ok(stet(["reply", String(second), "--body", long, "--intent", "answered"], { cwd: f.root }));
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
    const shown = await run.waitFor((s) => s.includes(" Threads ") && s.includes(" Files ") && s.includes("preview") && s.includes("It keeps the order stable."), 20_000);
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
    await run.waitFor((s) => s.includes(`#${second} b.kt:2`) && s.includes("Line 1 of a long answer.") && s.includes("preview"));
    run.write("k");
    await run.waitFor((s) => s.includes(`#${first} a.kt:3–4`) && s.includes("preview"));
    expect(run.screen()).toContain(`● #${first}`);

    run.write("l");
    await run.waitFor((s) => footer(s).includes("THREAD ") && s.includes("1 of 2"));
    await run.waitFor((s) => !s.includes(`● #${first}`));

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

/** A left click at a cell (0-based), as a terminal in SGR mouse mode sends it. */
const click = (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`;
const wheelDown = (x: number, y: number) => `\x1b[<65;${x + 1};${y + 1}M`;

function cellOf(screen: string, text: string): { x: number; y: number } {
  const rows = screen.split("\n");
  const y = rows.findIndex((r) => r.includes(text));
  if (y === -1) throw new Error(`no ${JSON.stringify(text)} on screen:\n${screen}`);
  return { x: rows[y]!.indexOf(text), y };
}

test("stet tui with the mouse: a click on a row previews its thread, a click on a side tab opens it, the wheel scrolls the column under the pointer", async () => {
  const run = startPty(["bun", CLI, "tui"], { cwd: f.root, cols: 120, rows: 30, env: { ...GIT_ENV, STET_ROLE: "reviewer", STET_AUTHOR: "alice" } });
  try {
    await run.waitFor((s) => s.includes(" Files ") && s.includes("preview") && s.includes(`#${first} a.kt:3–4`), 20_000);
    expect(run.modes.state.mouse).toBe(true);

    const row = cellOf(run.screen(), `#${second} L2`);
    run.write(click(row.x + 2, row.y));
    await run.waitFor((s) => s.includes(`#${second} b.kt:2`) && s.includes("preview"));

    const pane = cellOf(run.screen(), `#${second} b.kt:2`);
    const before = run.screen().split("\n")[pane.y + 1];
    run.write(wheelDown(pane.x + 10, pane.y + 5));
    await run.waitFor((s) => s.split("\n")[pane.y + 1] !== before);
    run.write(wheelDown(pane.x + 10, pane.y + 5));
    await run.waitFor((s) => s.includes("Line 30 of a long answer."));

    const tab = cellOf(run.screen(), " Files ");
    run.write(click(tab.x + 2, tab.y));
    await run.waitFor((s) => s.includes("2 files · base → v1") && footer(s).includes("FILES"));

    const chip = cellOf(run.screen(), " Space s t ");
    run.write(click(chip.x + 2, chip.y));
    await run.waitFor((s) => footer(s).includes("THREADS") && s.includes(`#${first} L3–4`));

    run.write("q");
    expect(await Promise.race([run.exited, Bun.sleep(10_000).then(() => "timeout" as const)])).toBe(0);
    expect(run.modes.state.mouse).toBe(false);
  } finally {
    run.close();
  }
}, 60_000);

test("stet tui refuses without a terminal", async () => {
  const r = await stet(["tui"], { cwd: f.root, role: "reviewer", json: false });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("needs a terminal");
});

test("stet tui, the Changes tab: m marks a file viewed through the server, ]t and Enter open a thread, Esc comes back", async () => {
  const run = startPty(["bun", CLI, "tui"], { cwd: f.root, cols: 120, rows: 36, env: { ...GIT_ENV, STET_ROLE: "reviewer", STET_AUTHOR: "alice" } });
  try {
    await run.waitFor((s) => s.includes(" Threads ") && s.includes(`#${first} a.kt:3–4`), 20_000);
    run.write(" rv");
    await run.waitFor((s) => footer(s).includes("CHANGES") && s.includes("▾ a.kt") && s.includes("[ ] viewed"));
    run.write("m");
    await run.waitFor((s) => s.includes("▸ a.kt") && s.includes("[x] viewed"));
    const server = await findServer(await openContext({ cwd: f.root, role: "reviewer" }));
    const api = clientApi(server!);
    const review = (await api.reviews()).default!;
    const until = Date.now() + 5000;
    while (Date.now() < until && !(await api.cursors(review)).viewed.length) await Bun.sleep(100);
    expect((await api.cursors(review)).viewed.length).toBe(1);

    run.write("]t");
    await run.waitFor((s) => s.includes(`▲ #${second}`));
    run.write("\r");
    await run.waitFor((s) => footer(s).includes("THREAD") && s.includes(`#${second} b.kt:2`));
    run.write("\x1b");
    await run.waitFor((s) => footer(s).includes("CHANGES"), 5000);
    // q: back to the round, out of the thread's code into the list, then out
    for (const want of ["THREAD", "THREADS"]) {
      run.write("q");
      await run.waitFor((s) => footer(s).includes(want));
    }
    run.write("q");
    expect(await Promise.race([run.exited, Bun.sleep(10_000).then(() => "timeout" as const)])).toBe(0);
  } finally {
    run.close();
  }
}, 60_000);
