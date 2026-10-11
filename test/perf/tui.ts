// `bun run perf:tui`: the terminal UI's numbers on the big stand (3,500 changed Kotlin files and Big.kt with 5,000
// changed lines), the compiled binary in a pseudo-terminal: the Changes tab's first frame, scroll steps on Big.kt and
// across the files, G and ]b, a resize, memory, and no frame while nothing happens. Times "inside" are the TUI's own,
// from the bytes of a key to the frame written (STET_TUI_TRACE); "outside" from the write to the pty to the screen.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPty, type PtyRun } from "../tui/pty.ts";
import { stand } from "./stand.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FILES = Number(process.env.PERF_FILES ?? 3500);
const THREADS = Number(process.env.PERF_THREADS ?? 200);
const out = mkdtempSync(join(tmpdir(), "stet-perf-tui-"));
const bin = join(out, "stet");
const trace = join(out, "trace.jsonl");
const frames = join(out, "frames");

const build = Bun.spawnSync(["bun", "build", "--compile", "--minify", "--splitting", "src/cli.ts", "src/tui/diff/hl-worker.ts", "--outfile", bin], { cwd: ROOT, stderr: "pipe" });
if (build.exitCode !== 0) throw new Error(build.stderr.toString());
const repo = await stand(FILES, THREADS);
console.log(`stand: ${FILES} changed files + Big.kt (5000 changed lines), ${THREADS + 1} threads in ${repo}`);

const env = { STET_ROLE: "reviewer", STET_TUI_TRACE: trace, STET_TUI_FRAMES: frames, COLORTERM: "truecolor" };
// the server first, so the numbers are the terminal UI's
const serve = Bun.spawnSync([bin, "serve", "--detach", "--json"], { cwd: repo, env: { ...process.env, ...env } });
if (serve.exitCode !== 0) throw new Error(serve.stderr.toString());

const results: Record<string, unknown> = {};
const report = (k: string, v: unknown) => {
  results[k] = v;
  console.log(`${k}: ${JSON.stringify(v)}`);
};

/** The key-to-frame times the TUI traced, from the `from`th on. */
function keyTimes(from = 0): number[] {
  if (!existsSync(trace)) return [];
  return readFileSync(trace, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { ev: string; ms?: number })
    .filter((e) => e.ev === "key")
    .slice(from)
    .map((e) => e.ms!);
}

const mark = () => keyTimes().length;

function stats(xs: number[]): { n: number; median: number; p95: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { n: s.length, median: r(at(0.5)), p95: r(at(0.95)), max: r(s[s.length - 1] ?? NaN) };
}

const rss = (pid: number) => Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) / 1024);

async function keys(run: PtyRun, key: string, n: number, gap: number): Promise<number[]> {
  await Bun.sleep(300);
  const from = mark();
  for (let i = 0; i < n; i++) {
    run.write(key);
    await Bun.sleep(gap);
  }
  await Bun.sleep(400);
  return keyTimes(from);
}

/** Outside: from the write to the screen showing the change. */
async function screenStep(run: PtyRun, key: string, changed: (before: string, now: string) => boolean): Promise<number> {
  const before = run.screen();
  const t0 = performance.now();
  run.write(key);
  await run.waitFor((s) => changed(before, s), 10_000);
  return performance.now() - t0;
}

/** The text of the diff's first line under its file's header, without the gutter's layout. */
const topLine = (s: string) => {
  const row = s.split("\n")[6] ?? "";
  return row.slice(row.indexOf("││") + 2).replace(/[│\s]+/g, " ").trim().slice(0, 30);
};

let run: PtyRun | null = null;
try {
  run = startPty([bin, "tui"], { cwd: repo, cols: 160, rows: 45, env });
  const r = run;
  report("start → the Round tab with its threads (ms)", Math.round(await r.waitFor((s) => s.includes(" Threads ") && s.includes("thread 0"), 30_000)));
  report("RSS after the Round tab (MB)", rss(r.pid));

  const t0 = performance.now();
  r.write(" rv");
  await r.waitFor((s) => s.includes("Big.kt") && /val line\d+ = \d+/.test(s) && s.includes(`${FILES + 1} files`), 30_000);
  report(`Changes tab, ${FILES + 1} files: key → full first frame (ms, target ≤ 800)`, Math.round(performance.now() - t0));
  await Bun.sleep(1500);
  const loaded = readFileSync(trace, "utf8").split("\n").filter((l) => l.includes('"changes"')).pop();
  const part = loaded ? (JSON.parse(loaded) as Record<string, number>) : null;
  report("  of it, in the TUI (trace): the server's compare, the patch, its parsing, the rows (ms)", part ? { total: Math.round(part.ms!), compare: Math.round(part.compare!), patch: Math.round(part.patch!), parse: Math.round(part.parse!), rows: Math.round(part.rows!) } : null);
  report("RSS after the first Changes frame (MB, target ≤ 200)", rss(r.pid));

  report("j on Big.kt, 300 keys 20 ms apart: input → frame (ms, median ≤ 4, p95 ≤ 16, max ≤ 50)", stats(await keys(r, "j", 300, 20)));
  report("Ctrl+d on Big.kt, 40 keys: input → frame (ms)", stats(await keys(r, "\x04", 40, 30)));
  report("]b across the files, 200 keys: input → frame (ms, ≤ 30)", stats(await keys(r, "]b", 200, 30)));
  report("j across the files, 300 keys: input → frame (ms)", stats(await keys(r, "j", 300, 20)));

  const gIn = mark();
  const gOut = await screenStep(r, "G", (b, s) => b !== s && s.includes("fun f9_99_29"));
  await Bun.sleep(300);
  report("G to the end of the diff: input → frame / write → screen (ms, ≤ 30)", { inside: stats(keyTimes(gIn)).max, outside: Math.round(gOut) });
  await Bun.sleep(1500);
  const ggIn = mark();
  const ggOut = await screenStep(r, "gg", (_b, s) => s.includes("Big.kt") && s.includes("val line0 "));
  await Bun.sleep(300);
  report("gg back to the top (ms)", { inside: stats(keyTimes(ggIn)).max, outside: Math.round(ggOut) });
  await Bun.sleep(1000);
  report("RSS after the end and back (MB, target ≤ 300)", rss(r.pid));

  const bOut = await screenStep(r, "]b", (b, s) => b !== s);
  report("]b write → screen (ms)", Math.round(bOut));

  // a resize keeps the line at the top of the diff
  for (let i = 0; i < 30; i++) r.write("j");
  await Bun.sleep(500);
  const before = topLine(r.screen());
  r.resize(130, 45);
  await r.waitFor((s) => s.split("\n")[1]!.trimEnd().length === 130 && s.split("\n")[1]!.trimEnd().endsWith("╮"), 10_000);
  await Bun.sleep(500);
  const after = topLine(r.screen());
  report("resize 160 → 130 columns keeps the top line", { before, after, same: before === after });

  await Bun.sleep(1500);
  const f0 = Number(readFileSync(frames, "utf8"));
  const b0 = r.raw().length;
  await Bun.sleep(3000);
  report("idle 3 s: frames, bytes (target 0, 0)", [Number(readFileSync(frames, "utf8")) - f0, r.raw().length - b0]);

  r.write("q");
  await Bun.sleep(300);
  r.write("q");
  await Promise.race([r.exited, Bun.sleep(5000)]);
} finally {
  run?.close();
  Bun.spawnSync([bin, "serve", "--stop"], { cwd: repo, env: { ...process.env, ...env } });
  rmSync(repo, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
process.exit(0);
