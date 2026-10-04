import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Bidi } from "./bidi.ts";

// A diff like a real review with wrap on: 250 files, 30..730 lines, 40% of the lines long enough to wrap.
// Checks that a fast mouse wheel does not shift the code under the pointer, and that every click on a
// search hit brings the match into view, on a warm page and right after opening it.

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "cli.ts");
const OUT = join(ROOT, "perf-out");
const env = { ...process.env, GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@example.com", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@example.com" };

function run(cwd: string, cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { cwd, env });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

async function firstMatch(stream: ReadableStream<Uint8Array>, re: RegExp, ms: number): Promise<string> {
  const reader = stream.getReader();
  let buf = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true }))]);
    if (done) break;
    buf += new TextDecoder().decode(value);
    const m = re.exec(buf);
    if (m) {
      reader.releaseLock();
      return m[1] ?? m[0];
    }
  }
  throw new Error(`no ${re} in: ${buf.slice(0, 300)}`);
}

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const repo = realpathSync(mkdtempSync(join(tmpdir(), "stet-scroll-")));
const write = (p: string, t: string) => {
  mkdirSync(dirname(join(repo, p)), { recursive: true });
  writeFileSync(join(repo, p), t);
};
const files = Array.from({ length: 250 }, (_, id) => {
  const n = 30 + Math.floor(rnd() * 700);
  const edits = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => 1 + Math.floor(rnd() * n));
  const long = new Set(Array.from({ length: Math.floor(n * 0.4) }, () => 1 + Math.floor(rnd() * n)));
  const needles = new Set(edits.flatMap((e) => (rnd() < 0.6 ? [e, e + 2] : [])));
  return { id, path: `mod${id % 12}/src/main/kotlin/p${id % 12}/File${id}.kt`, n, edits, long, needles };
});
const text = (f: (typeof files)[number], v: "a" | "b") =>
  Array.from({ length: f.n }, (_, k) => {
    const line = k + 1;
    const body = f.long.has(line) ? `val f${f.id}_x${line} = listOf(${Array.from({ length: 30 }, (_, j) => `"item${j}"`).join(", ")})` : `val f${f.id}_x${line} = ${line}`;
    const changed = v === "b" && f.edits.includes(line) ? `${body} + 1` : body;
    return f.needles.has(line) ? `${changed} // needle` : changed;
  }).join("\n") + "\n";
for (const f of files) write(f.path, text(f, "a"));
run(repo, ["git", "init", "-q", "-b", "main"]);
run(repo, ["git", "add", "-A"]);
run(repo, ["git", "commit", "-q", "-m", "base"]);
run(repo, ["git", "checkout", "-q", "-b", "feat"]);
for (const f of files) write(f.path, text(f, "b"));
for (let i = 0; i < 8; i++) write(`mod${i}/src/test/kotlin/T${i}Test.kt`, `class T${i}Test {\n  @Test fun a() = check(1) // needle\n}\n`);
run(repo, ["bun", CLI, "version", "create", "--json"]);

const server = Bun.spawn(["bun", CLI, "serve", "--json"], { cwd: repo, env, stdout: "pipe", stderr: "ignore" });
const prof = join(OUT, "scroll-prof");
rmSync(prof, { recursive: true, force: true });
mkdirSync(prof, { recursive: true });
const firefox = Bun.spawn(["firefox", "--headless", "--no-remote", "--profile", prof, `--remote-debugging-port=${9700 + Math.floor(Math.random() * 90)}`], { stdout: "ignore", stderr: "pipe" });

const checks: [string, boolean, unknown][] = [];
const check = (name: string, ok: boolean, detail: unknown) => checks.push([name, ok, detail]);

try {
  const url = JSON.parse(await firstMatch(server.stdout as ReadableStream<Uint8Array>, /^(\{.*\})$/m, 20_000)).url as string;
  const ws = await firstMatch(firefox.stderr as ReadableStream<Uint8Array>, /WebDriver BiDi listening on (ws:\/\/\S+)/, 30_000);
  const b = await Bidi.connect(`${ws}/session`);
  try {
    await b.viewport(1600, 1000);
    await b.navigate(url);
    const sleep = (ms: number) => b.eval(`new Promise(r => setTimeout(r, ${ms}))`);
    const waitFor = (expr: string, ms = 15000) => b.eval(`new Promise(r => { const end = Date.now() + ${ms}; const t = () => { let v; try { v = ${expr}; } catch { v = null; } if (v || Date.now() > end) r(v ?? null); else setTimeout(t, 50); }; t(); })`);
    const pointer = (actions: unknown[]) => b.send("input.performActions", { context: b.context, actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });
    const openCompare = async () => {
      await b.navigate("about:blank");
      await b.navigate(`${url.replace(/#.*/, "")}#/compare/base..1`);
      await waitFor(`document.querySelectorAll(".codeview-host diffs-container").length > 0`);
      await sleep(1500);
    };
    const tab = (name: string) => b.eval(`[...document.querySelectorAll(".side-tabs button")].find(x => x.textContent.startsWith(${JSON.stringify(name)})).click(); true`);

    await openCompare();
    await tab("Files");
    await b.eval(`(() => {
      const host = document.querySelector(".codeview-host");
      window.__rec = { on: false, samples: [] };
      const sample = () => {
        if (!__rec.on) return;
        const hr = host.getBoundingClientRect();
        const rows = [];
        outer: for (const c of host.querySelectorAll("diffs-container")) {
          const cr = c.getBoundingClientRect();
          if (cr.bottom < hr.top || cr.top > hr.bottom) continue;
          for (const code of c.shadowRoot.querySelectorAll("code[data-code]:not([data-deletions])")) {
            for (const row of code.querySelector(":scope > [data-content]")?.children ?? []) {
              if (!row.hasAttribute("data-line")) continue;
              const r = row.getBoundingClientRect();
              if (r.bottom < hr.top + 60 || r.top > hr.bottom) continue;
              rows.push([row.textContent.slice(0, 48), r.top]);
              if (rows.length >= 8) break outer;
            }
          }
        }
        __rec.samples.push({ st: host.scrollTop, rows });
        requestAnimationFrame(sample);
      };
      window.__start = () => { __rec.on = true; __rec.samples = []; requestAnimationFrame(sample); };
      window.__stop = () => { __rec.on = false; return __rec.samples; };
      return true;
    })()`);
    const at = await b.eval(`(() => { const r = document.querySelector(".codeview-host").getBoundingClientRect(); return { x: Math.round(r.left + r.width * 0.7), y: Math.round(r.top + r.height / 2) }; })()`);
    // A frame where the code moved while the scroll position did not, or moved by a different amount than
    // the scroll position did, is a jump the reader sees: rows measured on screen pushed the code around.
    const wheel = async (notch: number, count: number, pause: number) => {
      await b.eval(`__start(); true`);
      const actions = Array.from({ length: count }, () => [{ type: "scroll", x: at.x, y: at.y, deltaX: 0, deltaY: notch }, { type: "pause", duration: pause }]).flat();
      await b.send("input.performActions", { context: b.context, actions: [{ type: "wheel", id: "wheel", actions }] });
      await sleep(800);
      const samples = (await b.eval(`__stop()`)) as { st: number; rows: [string, number][] }[];
      let jumps = 0;
      let worst = 0;
      for (let i = 1; i < samples.length; i++) {
        const prev = new Map(samples[i - 1]!.rows);
        const moved = samples[i]!.rows.filter(([k]) => prev.has(k)).map(([k, top]) => top - prev.get(k)!).sort((a, c) => a - c);
        if (!moved.length) continue;
        const d = moved[Math.floor(moved.length / 2)]!;
        const dst = samples[i]!.st - samples[i - 1]!.st;
        const off = Math.abs(d + dst);
        if (Math.abs(dst) < 2000 && off > 1) {
          jumps++;
          worst = Math.max(worst, Math.round(off));
        }
      }
      return { frames: samples.length, jumps, worstPx: worst };
    };
    const fast = await wheel(300, 40, 16);
    const flick = await wheel(600, 30, 16);
    check("a fast mouse wheel over code not seen yet (wrapped lines) does not shift it under the pointer", fast.jumps === 0 && flick.jumps === 0, { fast, flick });

    const query = async (q: string) => {
      await tab("Search");
      await b.eval(`(() => { const el = document.getElementById("diff-search"); el.value = ${JSON.stringify(q)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await waitFor(`document.querySelectorAll(".search .snip.match").length > 5`);
      await sleep(500);
      return (await b.eval(`document.querySelectorAll(".search .snip.match").length`)) as number;
    };
    const clickHit = async (i: number) => {
      const r = await b.eval(`(() => { const a = document.querySelectorAll(".search .snip.match")[${i}]; if (!a) return null; a.scrollIntoView({ block: "center" }); const r = a.getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }; })()`);
      if (r) await pointer([{ type: "pointerMove", x: r.x, y: r.y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
      await sleep(1300);
      return b.eval(`(() => {
        const host = document.querySelector(".codeview-host");
        const hr = host.getBoundingClientRect();
        for (const c of host.querySelectorAll("diffs-container"))
          for (const row of c.shadowRoot.querySelectorAll('[data-stet-mark~="hit-current"]')) { const r = row.getBoundingClientRect(); if (r.bottom > hr.top + 40 && r.top < hr.bottom) return true; }
        return false;
      })()`) as Promise<boolean>;
    };
    const missed: string[] = [];
    let total = await query("needle");
    for (let k = 0; k < 20; k++) {
      const i = Math.floor(rnd() * total);
      if (!(await clickHit(i))) missed.push(`warm #${i}`);
    }
    for (let k = 0; k < 4; k++) {
      await openCompare();
      total = await query("needle");
      const i = Math.floor(total * (0.3 + 0.7 * rnd()));
      if (!(await clickHit(i))) missed.push(`cold #${i}`);
    }
    total = await query("check(1)");
    for (let i = 0; i < total; i++) if (!(await clickHit(i))) missed.push(`folded test #${i}`);
    check("every click on a search hit brings the match into view (warm page, fresh page, folded tests)", missed.length === 0, missed);
  } catch (e) {
    check("script ran to the end", false, (e as Error).message);
  } finally {
    await b.close();
  }
} finally {
  firefox.kill();
  server.kill();
  rmSync(repo, { recursive: true, force: true });
  rmSync(prof, { recursive: true, force: true });
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
}
process.exit(failed ? 1 : 0);
