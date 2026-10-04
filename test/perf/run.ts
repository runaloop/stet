import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureReview, openContext } from "../../src/core/context.ts";
import { addReply, addThread, createVersion } from "../../src/core/service.ts";
import { Bidi } from "./bidi.ts";

const ROOT = join(import.meta.dir, "..", "..");
const OUT = join(ROOT, "perf-out");
const FILES = Number(process.env.PERF_FILES ?? 3500);
const THREADS = Number(process.env.PERF_THREADS ?? 200);

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "perf", GIT_AUTHOR_EMAIL: "perf@example.com", GIT_COMMITTER_NAME: "perf", GIT_COMMITTER_EMAIL: "perf@example.com" },
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

async function stand(): Promise<string> {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "stet-perf-")));
  git(repo, "init", "-q", "-b", "main");
  const body = (d: number, i: number, v: string) => Array.from({ length: 30 }, (_, k) => `fun f${d}_${i}_${k}() = "${v}${k}"`).join("\n") + "\n";
  const dirs = Math.ceil(FILES / 100);
  const each = (fn: (d: number, i: number) => void) => {
    for (let n = 0; n < FILES; n++) fn(Math.floor(n / 100), n % 100);
  };
  for (let d = 0; d < dirs; d++) mkdirSync(join(repo, `mod${d}/src`), { recursive: true });
  each((d, i) => writeFileSync(join(repo, `mod${d}/src/F${i}.kt`), body(d, i, "a")));
  writeFileSync(join(repo, "Big.kt"), Array.from({ length: 5000 }, (_, k) => `val line${k} = ${k}`).join("\n") + "\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feat");
  each((d, i) => writeFileSync(join(repo, `mod${d}/src/F${i}.kt`), body(d, i, "b")));
  writeFileSync(join(repo, "Big.kt"), Array.from({ length: 5000 }, (_, k) => `val line${k} = ${k * 2}`).join("\n") + "\n");
  const reviewer = await openContext({ cwd: repo, role: "reviewer", author: "you" });
  const agent = await openContext({ cwd: repo, role: "agent", author: "claude" });
  const review = await ensureReview(agent);
  await createVersion(agent, review, { label: "perf" });
  for (let n = 0; n < THREADS; n++) {
    const t = await addThread(reviewer, review, { path: `mod${n % dirs}/src/F${n % 100}.kt`, start: 3, end: 5, at: "1", body: `thread ${n}` });
    if (n % 2 === 0) await addReply(agent, review, t.id, { body: `reply ${n}`, intent: "answered", at: "1" });
  }
  await addThread(reviewer, review, { path: "Big.kt", start: 4000, end: 4002, at: "1", body: "deep in a big file" });
  return repo;
}

async function firstLine(stream: ReadableStream<Uint8Array>, match: RegExp, timeoutMs: number): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true }))]);
    if (done) break;
    buf += dec.decode(value);
    const m = match.exec(buf);
    if (m) {
      reader.releaseLock();
      return m[1] ?? m[0];
    }
  }
  throw new Error(`did not see ${match} in time; got: ${buf.slice(0, 400)}`);
}

const repo = await stand();
console.log(`stand: ${FILES} changed files + Big.kt (5000 changed lines), ${THREADS + 1} threads in ${repo}`);
const server = Bun.spawn(["bun", join(ROOT, "src", "cli.ts"), "serve", "--json"], { cwd: repo, stdout: "pipe", stderr: "ignore" });
const url = JSON.parse(await firstLine(server.stdout as ReadableStream<Uint8Array>, /^(\{.*\})$/m, 20_000)).url as string;
rmSync(join(OUT, "prof"), { recursive: true, force: true });
mkdirSync(join(OUT, "prof"), { recursive: true });
mkdirSync(join(OUT, "shots"), { recursive: true });
const port = 9300 + Math.floor(Math.random() * 500);
const firefox = Bun.spawn(["firefox", "--headless", "--no-remote", "--profile", join(OUT, "prof"), `--remote-debugging-port=${port}`], { stdout: "ignore", stderr: "pipe" });
const results: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
  set(t, k, v) {
    t[String(k)] = v;
    console.log(`${String(k)}: ${JSON.stringify(v)}`);
    return true;
  },
});
try {
  const ws = await firstLine(firefox.stderr as ReadableStream<Uint8Array>, /WebDriver BiDi listening on (ws:\/\/\S+)/, 30_000);
  const b = await Bidi.connect(`${ws}/session`);
  try {
    await b.viewport(1600, 1000);
    const wait = (cond: string, timeout = 30000) =>
      b.eval(`new Promise((res, rej) => { const t0 = performance.now(); let gap = 0, last = t0; const tick = () => { const n = performance.now(); gap = Math.max(gap, n - last); last = n; let ok = false; try { ok = (${cond}); } catch {} if (ok) return res({ ms: Math.round(n - t0), worstFrameMs: Math.round(gap), dom: document.getElementsByTagName("*").length }); if (n - t0 > ${timeout}) return rej(new Error("timeout")); requestAnimationFrame(tick); }; requestAnimationFrame(tick); })`);
    const scroll = (sel: string, px: number) =>
      b.eval(`(async () => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollTop = 200000; await new Promise(r => setTimeout(r, 600)); const f = []; for (let i = 0; i < 40; i++) { const t0 = performance.now(); el.scrollTop += ${px}; await new Promise(r => requestAnimationFrame(r)); f.push(performance.now() - t0); } f.sort((a, b) => a - b); return { medianFrameMs: Math.round(f[20]), p90FrameMs: Math.round(f[36]), worstFrameMs: Math.round(f[39]) }; })()`);

    const t0 = Date.now();
    await b.navigate(url);
    results["open the page (tree of threads)"] = { ...(await wait(`document.querySelectorAll(".thread-row").length > 0`)), sinceNavigationMs: Date.now() - t0 };
    await b.screenshot(join(OUT, "shots", "1-home.png"));
    await b.eval(`location.hash = "#/compare/base..1"; true`);
    results[`compare base..v1 (${FILES + 1} files)`] = await wait(`document.querySelectorAll(".codeview-host diffs-container").length > 0 && document.querySelector(".compare .range-title")?.textContent.includes("${FILES + 1} files")`);
    await b.eval(`new Promise(r => setTimeout(r, 1500))`);
    await b.screenshot(join(OUT, "shots", "2-compare.png"));
    for (const px of [100, 400, 1000]) results[`compare scroll ${px}px/frame`] = await scroll(".codeview-host", px);
    results["compare jump to the end"] = await b.eval(`(async () => { const el = document.querySelector(".codeview-host"); const t0 = performance.now(); el.scrollTop = el.scrollHeight; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return { ms: Math.round(performance.now() - t0) }; })()`);
    const search = (q: string) =>
      b.eval(`(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "/" })); await new Promise(r => requestAnimationFrame(r)); const i = document.getElementById("diff-search"); const label = () => document.querySelector(".search .side-head.subtle")?.textContent ?? ""; const before = label(); const t0 = performance.now(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); await new Promise(r => { const c = () => label() !== before && document.querySelector(".search .hit") ? r(0) : requestAnimationFrame(c); c(); }); return { ms: Math.round(performance.now() - t0), found: document.querySelector(".search .side-head.subtle")?.textContent.split(" · ")[0] }; })()`);
    results["search 'fun' over the whole diff (incl. 120 ms debounce)"] = await search("fun");
    results["search 'f34_99_' (one file in the middle)"] = await search("f34_99_");
    results["search: Shift+Enter jumps to the last match"] = await b.eval(`(async () => { const i = document.getElementById("diff-search"); const t0 = performance.now(); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })); await new Promise(r => { const c = () => [...document.querySelectorAll(".codeview-host diffs-container")].some(d => d.shadowRoot.querySelector('[data-stet-mark~="hit-current"]')) ? r(0) : requestAnimationFrame(c); c(); }); return { ms: Math.round(performance.now() - t0) }; })()`);
    await b.screenshot(join(OUT, "shots", "2b-search.png"));
    results["vim: j x20 on the big diff"] = await b.eval(`(async () => { document.activeElement?.blur(); const t = []; for (let i = 0; i < 20; i++) { const t0 = performance.now(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", code: "KeyJ" })); await new Promise(r => requestAnimationFrame(r)); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return { medianMs: Math.round(t[10]), worstMs: Math.round(t[19]) }; })()`);
    results["vim: G (end of 3501 files)"] = await b.eval(`(async () => { const t0 = performance.now(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "G", code: "KeyG", shiftKey: true })); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return { ms: Math.round(performance.now() - t0) }; })()`);
    await b.eval(`location.hash = "#/thread/2"; true`);
    results["open a thread"] = await wait(`document.querySelectorAll(".timeline .step").length > 0`);
    results["j: next thread x15"] = await b.eval(`(async () => { const t = []; for (let i = 0; i < 15; i++) { const before = location.hash; const t0 = performance.now(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })); await new Promise(r => { const c = () => (location.hash !== before && document.querySelector(".detail-head .tid")?.textContent === "#" + location.hash.split("/").pop()) ? r(0) : requestAnimationFrame(c); c(); }); t.push(performance.now() - t0); } t.sort((a, b) => a - b); return { medianMs: Math.round(t[7]), worstMs: Math.round(t[14]) }; })()`);
    await b.eval(`location.hash = "#/thread/${THREADS + 1}"; true`);
    results["thread on Big.kt:4000 (marker scrolled into view)"] = {
      ...(await wait(`!!document.querySelector(".code-area .thread-marker")`, 15000)),
      markerVisible: await b.eval(`new Promise(r => setTimeout(() => { const a = document.querySelector(".code-area .thread-marker").getBoundingClientRect(); r(a.top >= 0 && a.bottom <= innerHeight); }, 500))`),
    };
    await b.screenshot(join(OUT, "shots", "3-big-thread.png"));
  } finally {
    await b.close();
  }
} finally {
  firefox.kill();
  server.kill();
  rmSync(repo, { recursive: true, force: true });
}
console.log(`screenshots: ${join(OUT, "shots")}`);
process.exit(0);
