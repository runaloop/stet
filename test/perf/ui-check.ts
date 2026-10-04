import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bidi } from "./bidi.ts";
import { card as pngCard } from "../helpers/png.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "cli.ts");
const OUT = join(ROOT, "perf-out");
const env = { ...process.env, GIT_AUTHOR_NAME: "ui", GIT_AUTHOR_EMAIL: "ui@example.com", GIT_COMMITTER_NAME: "ui", GIT_COMMITTER_EMAIL: "ui@example.com" };

function run(cwd: string, cmd: string[], extra: Record<string, string> = {}): string {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...env, ...extra } });
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

const repo = realpathSync(mkdtempSync(join(tmpdir(), "stet-ui-")));
mkdirSync(join(repo, "src"));
const cache = (lines: string[]) => writeFileSync(join(repo, "src/Cache.kt"), lines.join("\n") + "\n");
const big = (edits: Record<number, string>) =>
  writeFileSync(join(repo, "src/Zbig.kt"), Array.from({ length: 120 }, (_, i) => edits[i + 1] ?? `val line${i + 1} = ${i + 1}`).join("\n") + "\n");
const test = (lines: string[]) => { mkdirSync(join(repo, "src/test"), { recursive: true }); writeFileSync(join(repo, "src/test/CacheTest.kt"), lines.join("\n") + "\n"); };
const long = `    // ${"a very long comment that does not fit the width of the diff at all ".repeat(4)}`;
const base = ["package demo", "", "class Cache {", "    private val map = HashMap<String, String>()", "", "    fun get(key: String): String? = map[key]", "", "    fun put(key: String, value: String) {", "        map[key] = value", "    }", "}"];
run(repo, ["git", "init", "-q", "-b", "main"]);
cache(base);
big({});
run(repo, ["git", "add", "-A"]);
run(repo, ["git", "commit", "-q", "-m", "base"]);
cache(base.map((l, i) => (i === 3 ? "    private val map = HashMap<String, String>(16)" : i === 8 ? `        map[key] = value\n        map[key] = value\n${long}` : l)));
big({ 10: "val line10 = 1000", 100: "val line100 = 100000" });
test(["class CacheTest {", "    @Test fun put() = assertEquals(1, 1)", "}"]);
run(repo, ["git", "add", "-A"]);
run(repo, ["bun", CLI, "init", "--staged", "--json"]);
run(repo, ["bun", CLI, "version", "create", "--json"]);
const threadAt = (line: number, body: string) =>
  JSON.parse(run(repo, ["bun", CLI, "comment", "add", "--file", "src/Zbig.kt", "--range", `${line}-${line}`, "--at", "1", "--body", body, "--as", "reviewer", "--json"])).id as number;
const t10 = threadAt(10, "why 1000?");
const t100 = threadAt(100, "why 100000?");
cache(base.map((l, i) => (i === 3 ? "    private val map = HashMap<String, String>(16)" : l)));
big({ 10: "val line10 = TEN_V2", 100: "val line100 = HUNDRED_V2" });
test(["class CacheTest {", "    @Test fun put() = assertEquals(2, 1)", "}"]);
writeFileSync(join(repo, "src/a<img src=x onerror=window.__pwned=1>.kt"), "val evil = 1\n");
run(repo, ["git", "add", "-A"]);
run(repo, ["bun", CLI, "version", "create", "--json"]);

const serve = () => Bun.spawn(["bun", CLI, "serve", "--json"], { cwd: repo, env: { ...env, STET_WATCH_MS: "500" }, stdout: "pipe", stderr: "ignore" });
let server = serve();
const url = JSON.parse(await firstMatch(server.stdout as ReadableStream<Uint8Array>, /^(\{.*\})$/m, 20_000)).url as string;
mkdirSync(join(OUT, "shots"), { recursive: true });
rmSync(join(OUT, "ui-prof"), { recursive: true, force: true });
mkdirSync(join(OUT, "ui-prof"), { recursive: true });
const firefox = Bun.spawn(["firefox", "--headless", "--no-remote", "--profile", join(OUT, "ui-prof"), `--remote-debugging-port=${9800 + Math.floor(Math.random() * 100)}`], { stdout: "ignore", stderr: "pipe" });

const checks: [string, boolean, unknown][] = [];
const check = (name: string, ok: boolean, detail: unknown) => checks.push([name, ok, detail]);

try {
  const ws = await firstMatch(firefox.stderr as ReadableStream<Uint8Array>, /WebDriver BiDi listening on (ws:\/\/\S+)/, 30_000);
  const b = await Bidi.connect(`${ws}/session`);
  const sleep = (ms: number) => b.eval(`new Promise(r => setTimeout(r, ${ms}))`);
  const pointer = (actions: unknown[]) => b.send("input.performActions", { context: b.context, actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });
  const keys = (...ks: string[]) => b.send("input.performActions", { context: b.context, actions: [{ type: "key", id: "kbd", actions: ks.flatMap((k) => [{ type: "keyDown", value: k }, { type: "keyUp", value: k }]) }] });
  const chord = (mods: string[], key: string) => b.send("input.performActions", { context: b.context, actions: [{ type: "key", id: "kbd", actions: [...mods.map((m) => ({ type: "keyDown", value: m })), { type: "keyDown", value: key }, { type: "keyUp", value: key }, ...mods.map((m) => ({ type: "keyUp", value: m }))] }] });
  const CTRL = "\uE009";
  const SHIFT = "\uE008";
  const shadow = `document.querySelector(".codeview-host diffs-container").shadowRoot`;
  const lines = () => b.eval(`[...document.querySelector(".codeview-host diffs-container")?.shadowRoot?.querySelectorAll("[data-column-number]") ?? []].map(e => +e.getAttribute("data-column-number"))`) as Promise<number[]>;
  const cell = (n: number) => b.eval(`(() => { const el = [...${shadow}.querySelectorAll("[data-column-number='${n}']")].pop(); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`) as Promise<{ x: number; y: number }>;
  const plus = () => b.eval(`(() => { const btn = ${shadow}.querySelector("button"); const r = btn?.getBoundingClientRect(); return r && r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`) as Promise<{ x: number; y: number } | null>;
  const composer = () => b.eval(`document.querySelector(".codeview-host .new-thread .note")?.textContent ?? null`) as Promise<string | null>;
  const rect = (sel: string) => b.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: Math.round(r.top) } : null; })()`) as Promise<{ x: number; y: number; top: number } | null>;
  const click = async (sel: string) => {
    const r = await rect(sel);
    if (!r) return false;
    await pointer([{ type: "pointerMove", x: r.x, y: r.y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
    return true;
  };
  const cancel = async () => {
    await b.eval(`(() => { [...document.querySelectorAll(".new-thread button")].find(x => x.textContent === "Cancel")?.click(); return true; })()`);
    await sleep(200);
  };
  const waitFor = (expr: string, ms = 5000) => b.eval(`new Promise(r => { const end = Date.now() + ${ms}; const t = () => { let v; try { v = ${expr}; } catch { v = null; } if (v || Date.now() > end) r(v ?? null); else setTimeout(t, 50); }; t(); })`);
  const csp = `window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI)); true`;
  const codeText = () => b.eval(`[...document.querySelectorAll(".code-area diffs-container")].map(c => c.shadowRoot.textContent).join("\\n")`) as Promise<string>;
  try {
    await b.viewport(1400, 900);
    await b.navigate(url);
    await b.eval(csp);
    await waitFor(`document.querySelector(".codeview-host diffs-container")?.shadowRoot?.querySelector("[data-column-number]")`, 15000);
    await sleep(800);
    check("landing opens the compare of the latest version", (await b.eval("location.hash")) === "#/compare/1..2", await b.eval("location.hash"));

    await b.eval(`location.hash = "#/compare/base..1"; true`);
    await sleep(1500);
    const shown = await lines();
    check("switching versions redraws the code", shown.includes(4) && shown.includes(1), shown.slice(0, 12));
    const overflow = () => b.eval(`${shadow}.querySelector("[data-overflow]")?.getAttribute("data-overflow")`);
    check("long lines wrap by default", (await overflow()) === "wrap", await overflow());
    await keys("w");
    await sleep(800);
    check("w turns wrapping off", (await overflow()) === "scroll", await overflow());
    await keys("w");
    await sleep(800);

    const c4 = await cell(4);
    await pointer([{ type: "pointerMove", x: c4.x + 30, y: c4.y }, { type: "pointerMove", x: c4.x, y: c4.y }]);
    await sleep(300);
    const p = await plus();
    check("hovering a line shows the + button", p !== null, p);
    if (p) {
      await pointer([{ type: "pointerMove", x: p.x, y: p.y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
      await sleep(500);
      const c = await composer();
      check("clicking + opens a comment box on that line", c?.includes("lines 4") ?? false, c);
      const box = await rect(".codeview-host .new-thread");
      const line4 = await cell(4);
      check("the comment box opens right under the line, inside the diff", !!box && box.top > line4.y && box.top - line4.y < 60, { box, line4 });
      const focused = await b.eval(`document.activeElement?.tagName === "TEXTAREA" && !!document.activeElement.closest(".codeview-host")`);
      check("the comment box takes the keyboard focus", focused === true, focused);
      await keys("h", "i", "j", "k");
      const typed = await b.eval(`document.querySelector(".codeview-host .new-thread textarea")?.value`);
      check("typing goes into the box, not to the diff or the hotkeys", typed === "hijk", typed);
      await b.screenshot(join(OUT, "shots", "ui-check-inline.png"));
      await cancel();
    }

    const c6 = await cell(6);
    const c8 = await cell(8);
    await pointer([{ type: "pointerMove", x: c6.x, y: c6.y }]);
    await sleep(300);
    const p2 = await plus();
    if (p2) {
      await pointer([{ type: "pointerMove", x: p2.x, y: p2.y }, { type: "pointerDown", button: 0 }, { type: "pointerMove", x: p2.x, y: c8.y, duration: 150 }, { type: "pointerUp", button: 0 }]);
      await sleep(500);
    }
    const dragged = await composer();
    check("dragging from + selects a range", dragged?.includes("lines 6–8") ?? false, dragged);
    await cancel();

    const c9 = await cell(9);
    const c10 = await cell(10);
    await pointer([{ type: "pointerMove", x: c9.x, y: c9.y }, { type: "pointerDown", button: 0 }, { type: "pointerMove", x: c10.x, y: c10.y, duration: 100 }, { type: "pointerUp", button: 0 }]);
    await sleep(500);
    const selected = await composer();
    check("dragging over line numbers selects a range", selected?.includes("lines 9–10") ?? false, selected);
    await b.eval(`(() => { const ta = document.querySelector(".codeview-host .new-thread textarea"); ta.value = "duplicate write"; ta.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await b.navigate(url.replace("#", "#/compare/base..1&"));
    await b.eval(`location.hash = "#/compare/base..1"; true`);
    await b.eval(csp);
    const restored = await waitFor(`document.querySelector(".codeview-host .new-thread textarea")?.value`, 8000);
    check("an unsent comment survives a reload", restored === "duplicate write", restored);
    const saved = await b.eval(`(() => { const ta = document.querySelector(".codeview-host .new-thread textarea"); ta?.focus(); return !!ta; })()`);
    await chord([CTRL], "s");
    await sleep(1000);
    const annotated = await b.eval(`document.querySelector(".codeview-host .thread-mini")?.textContent ?? null`);
    check("Ctrl+S in the comment box saves the draft, and it appears on the diff", saved && (annotated?.includes("duplicate write") ?? false), annotated);
    const bar = await b.eval(`document.querySelector(".draft-bar")?.textContent ?? null`);
    check("a bar says the draft is not sent yet", bar?.includes("1 draft") ?? false, bar);
    await b.screenshot(join(OUT, "shots", "ui-check-compare.png"));

    await b.eval(`location.hash = "#/compare/1..2"; true`);
    await waitFor(`document.querySelectorAll(".codeview-host .thread-mini").length >= 2`, 8000);
    await keys("]", "t");
    await sleep(300);
    const first = await b.eval(`document.querySelector(".codeview-host .thread-mini.focused")?.dataset.thread ?? null`);
    await keys("]", "t");
    await sleep(300);
    const second = await b.eval(`document.querySelector(".codeview-host .thread-mini.focused")?.dataset.thread ?? null`);
    check("]t steps through the threads on the diff", first === String(t10) && second === String(t100), { first, second });
    await keys("");
    await sleep(800);
    check("Enter opens the highlighted thread", (await b.eval("location.hash")) === `#/thread/${t100}`, await b.eval("location.hash"));

    await waitFor(`document.querySelector(".code-area diffs-container")?.shadowRoot?.textContent.includes("HUNDRED_V2")`, 8000);
    const at100 = await codeText();
    check("a thread's diff shows its own lines", at100.includes("HUNDRED_V2") && !at100.includes("TEN_V2"), at100.slice(0, 200));
    await keys("k");
    await waitFor(`location.hash === "#/thread/${t10}" && document.querySelector(".code-area diffs-container")?.shadowRoot?.textContent.includes("TEN_V2")`, 8000);
    const at10 = await codeText();
    check("k goes to the previous thread, and its diff shows its own lines", at10.includes("TEN_V2") && !at10.includes("HUNDRED_V2"), at10.slice(0, 200));
    const area = `document.querySelector(".code-area diffs-container").shadowRoot`;
    const a12 = (await b.eval(`(() => { const el = [...${area}.querySelectorAll("[data-column-number='12']")].pop(); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`)) as { x: number; y: number };
    await pointer([{ type: "pointerMove", x: a12.x + 30, y: a12.y }, { type: "pointerMove", x: a12.x, y: a12.y }]);
    await sleep(300);
    const areaPlus = (await b.eval(`(() => { const btn = ${area}.querySelector("button"); const r = btn?.getBoundingClientRect(); return r && r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`)) as { x: number; y: number } | null;
    if (areaPlus) await pointer([{ type: "pointerMove", x: areaPlus.x, y: areaPlus.y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
    await sleep(500);
    const hereBox = await b.eval(`document.querySelector(".code-area .new-thread .note")?.textContent ?? null`);
    check("in a thread's diff, + on another line opens a new-thread box there", hereBox?.includes("lines 12") ?? false, hereBox);
    await keys("o", "k");
    await chord([CTRL], "s");
    const savedHere = await waitFor(`document.querySelector(".toast")?.textContent.startsWith("draft #") ? document.querySelector(".toast").textContent : null`, 5000);
    const stillHere = await b.eval("location.hash");
    check("Ctrl+S saves it as a new draft thread and keeps you in the thread", !!savedHere && stillHere === `#/thread/${t10}`, { savedHere, stillHere });
    const neighbour = await waitFor(`(() => { const all = [...document.querySelectorAll(".code-area .thread-mini")].map(x => x.textContent); return all.some(x => x.includes("ok")) ? all : null; })()`, 6000);
    check("the thread's code shows other threads on the lines it shows (the one just written), not threads further away", !!neighbour && !neighbour.some((x: string) => x.includes("100000")), neighbour);
    await b.screenshot(join(OUT, "shots", "ui-check-thread.png"));

    await keys("");
    await sleep(1200);
    const back = await b.eval("location.hash");
    const focusedBack = await b.eval(`document.querySelector(".codeview-host .thread-mini.focused")?.dataset.thread ?? null`);
    check("Esc goes back to the same compare, at the thread you came from", back === "#/compare/1..2" && focusedBack === String(t10), { back, focusedBack });

    await keys("S");
    await sleep(600);
    check("S opens the drafts page first", (await b.eval("location.hash")) === "#/drafts", await b.eval("location.hash"));
    await keys("S");
    await sleep(1000);
    const after = await b.eval(`({ hash: location.hash, bar: !!document.querySelector(".draft-bar") })`);
    check("S on the drafts page submits and returns to the compare", after.hash === "#/compare/1..2" && after.bar === false, after);

    await b.eval(`location.hash = "#/thread/${t10}"; true`);
    await waitFor(`document.querySelector(".detail-head .tid")?.textContent === "#${t10}"`, 8000);
    await keys("x");
    const closed = await waitFor(`[...document.querySelectorAll(".head-actions button")].some(x => x.textContent === "Reopen")`, 5000);
    check("x resolves in one keypress", closed === true, closed);
    await b.eval(`(() => { const s = document.querySelector(".head-actions select"); s.value = "wontfix"; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
    const reason = await waitFor(`[...document.querySelectorAll(".head-badges .badge")].map(x => x.textContent).find(x => x === "✓ resolved: wontfix")`, 5000);
    check("a reason can be added afterwards", reason === "✓ resolved: wontfix", reason);
    await keys("\uE00C");
    await waitFor(`document.querySelectorAll(".codeview-host .thread-mini").length >= 1`, 8000);
    await sleep(500);
    const visible = await b.eval(`[...document.querySelectorAll(".codeview-host .thread-mini")].map(x => x.dataset.thread)`);
    const toggle = await b.eval(`[...document.querySelectorAll(".compare .note .link")].find(x => x.textContent.includes("resolved"))?.textContent ?? null`);
    check("a resolved thread leaves the compare, with a switch to show it", !visible.includes(String(t10)) && (toggle?.includes("1 resolved hidden") ?? false), { visible, toggle });
    await b.eval(`[...document.querySelectorAll(".compare .note .link")].find(x => x.textContent.includes("resolved")).click(); true`);
    await sleep(800);
    const withResolved = await b.eval(`[...document.querySelectorAll(".codeview-host .thread-mini")].map(x => x.dataset.thread)`);
    check("show resolved brings it back", withResolved.includes(String(t10)), withResolved);
    await b.eval(`location.hash = "#/thread/${t10}"; true`);
    await waitFor(`[...document.querySelectorAll(".head-actions button")].some(x => x.textContent === "Reopen")`, 8000);
    await keys("X");
    const reopened = await waitFor(`[...document.querySelectorAll(".head-actions button")].some(x => x.textContent === "Resolve")`, 5000);
    check("X reopens it", reopened === true, reopened);

    await b.eval(`location.hash = "#/compare/1..2"; true`);
    await waitFor(`document.querySelectorAll(".codeview-host .thread-mini").length >= 2`, 8000);
    const tr = JSON.parse(run(repo, ["bun", CLI, "comment", "add", "--file", "src/Zbig.kt", "--range", "98-101", "--at", "2", "--body", "range thread <img src=x onerror=window.__pwned=2>", "--as", "reviewer", "--json"])).id as number;
    await waitFor(`!!document.querySelector('.codeview-host .thread-mini[data-thread="${tr}"]')`, 8000);
    await sleep(500);
    const zbig = `[...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot.textContent.includes("HUNDRED_V2")).shadowRoot`;
    const marked = (tag: string) => b.eval(`[...${zbig}.querySelectorAll('code[data-additions] [data-content] > [data-stet-mark~="${tag}"]')].map(e => +e.getAttribute("data-line"))`) as Promise<number[]>;
    const ranged = await marked("thread");
    check("every line of a multi-line thread is highlighted on the compare", [98, 99, 100, 101].every((n) => ranged.includes(n)), ranged);
    await b.eval(`document.querySelector('.codeview-host .thread-mini[data-thread="${tr}"]')?.scrollIntoView({ block: "center" }); true`);
    await sleep(400);
    const card = await rect(`.codeview-host .thread-mini[data-thread="${tr}"]`);
    if (card) await pointer([{ type: "pointerMove", x: card.x, y: card.y }]);
    await sleep(300);
    const focusedRange = await marked("focus");
    await b.screenshot(join(OUT, "shots", "ui-check-range.png"));
    check("hovering the thread card highlights its lines stronger", [98, 99, 100, 101].every((n) => focusedRange.includes(n)), focusedRange);
    await pointer([{ type: "pointerMove", x: 5, y: 5 }]);

    await chord([CTRL], "f");
    await sleep(400);
    const searchFocused = await b.eval(`document.activeElement?.id === "diff-search"`);
    check("Ctrl+F on the compare opens the diff search", searchFocused === true, await b.eval(`document.activeElement?.outerHTML?.slice(0, 80)`));
    await keys(..."HUNDRED".split(""));
    await waitFor(`document.querySelectorAll(".search .hit").length === 1`, 4000);
    await keys("");
    await sleep(800);
    await b.screenshot(join(OUT, "shots", "ui-check-search.png"));
    const hit = await b.eval(`({ lines: [...${zbig}.querySelectorAll('[data-content] > [data-stet-mark~="hit-current"]')].map(e => +e.getAttribute("data-line")), words: CSS.highlights?.get("stet-hit-current")?.size ?? -1, label: document.querySelector(".search .side-head.subtle")?.textContent ?? "", snippet: document.querySelector(".search .hit.current .snip.match mark")?.textContent ?? null })`);
    check("Enter jumps to the match: the line is outlined, the word highlighted, the snippet shown", hit.lines.includes(100) && hit.words >= 1 && hit.label.startsWith("1 of 1") && hit.snippet === "HUNDRED", hit);
    await b.eval(`document.querySelector(".search-head .btn[title='regular expression']").click(); true`);
    await b.eval(`(() => { const i = document.getElementById("diff-search"); i.focus(); i.value = "HUNDRED|HashMap"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await waitFor(`document.querySelectorAll(".search .hit-file").length === 2`, 4000);
    await keys("");
    await sleep(600);
    await chord([SHIFT], "");
    await sleep(900);
    const wrapped = await b.eval(`(() => { const row = ${zbig}.querySelector('[data-content] > [data-stet-mark~="hit-current"]'); const host = document.querySelector(".codeview-host").getBoundingClientRect(); const r = row?.getBoundingClientRect(); return { line: row ? +row.getAttribute("data-line") : null, inView: !!r && r.top >= host.top && r.bottom <= host.bottom }; })()`);
    check("Shift+Enter wraps to the last match, in another file, and scrolls it into view", wrapped.line === 100 && wrapped.inView, wrapped);

    const hitInView = () => b.eval(`(() => { const row = ${zbig}.querySelector('[data-content] > [data-stet-mark~="hit-current"]'); const host = document.querySelector(".codeview-host").getBoundingClientRect(); const r = row?.getBoundingClientRect(); return !!r && r.top >= host.top && r.bottom <= host.bottom; })()`);
    const clickAway = async (sel: string) => {
      await b.eval(`document.querySelector(".codeview-host").scrollTop = 0; true`);
      await sleep(500);
      const away = await hitInView();
      const r = await rect(sel);
      if (r) await pointer([{ type: "pointerMove", x: r.x, y: r.y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
      await sleep(900);
      return { away, found: !!r, back: await hitInView() };
    };
    const viaContext = await clickAway(".search .hit.current a.snip:not(.match)");
    const viaHead = await clickAway(".search .hit-file h4 .file-name");
    check("a click on a line around a match, or on the file name, scrolls the diff back to the match", !viaContext.away && viaContext.found && viaContext.back && viaHead.found && viaHead.back, { viaContext, viaHead });

    await b.eval(`[...document.querySelectorAll(".search-scope button")].find(x => x.textContent === "in all files").click(); true`);
    await b.eval(`(() => { const i = document.getElementById("diff-search"); i.focus(); i.value = "line50 = 50|HUNDRED"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await waitFor(`[...document.querySelectorAll(".search .snip.match .no")].some(x => x.textContent === "50")`, 6000);
    const fileHits = await b.eval(`[...document.querySelectorAll(".search .snip.match")].map(x => x.querySelector(".sign").textContent + x.querySelector(".no").textContent)`);
    check("search in all files finds unchanged lines too, and marks which are in the diff", fileHits.includes("↗50") && fileHits.includes("±100"), fileHits);
    await keys("");
    await sleep(1200);
    const peeked = await b.eval(`(() => { const p = document.querySelector(".compare .peek"); const c = p?.querySelector("diffs-container"); return { open: !!p, current: c ? [...c.shadowRoot.querySelectorAll('[data-content] > [data-stet-mark~="hit-current"]')].map(e => +e.getAttribute("data-line")) : [] }; })()`);
    check("a match outside the diff opens that file at the line", peeked.open && peeked.current.includes(50), peeked);
    await b.screenshot(join(OUT, "shots", "ui-check-peek.png"));
    await keys("");
    await sleep(1000);
    const inDiff = await b.eval(`({ peek: !!document.querySelector(".compare .peek"), lines: [...${zbig}.querySelectorAll('[data-content] > [data-stet-mark~="hit-current"]')].map(e => +e.getAttribute("data-line")) })`);
    check("a match inside the diff closes the preview and jumps into the diff", !inDiff.peek && inDiff.lines.includes(100), inDiff);
    await chord([SHIFT], "");
    await sleep(800);
    await keys("");
    await sleep(300);
    check("Esc closes the preview", (await b.eval(`!document.querySelector(".compare .peek")`)) === true, null);

    const nameAt = `(() => { const walker = document.createTreeWalker(${zbig}, 4); for (let n = walker.nextNode(); n; n = walker.nextNode()) { const i = n.nodeValue.indexOf("HUNDRED_V2"); if (i < 0 || !n.parentElement.closest("[data-additions]")) continue; const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 10); const b = r.getBoundingClientRect(); return { el: n.parentElement, x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; } return null; })()`;
    await b.eval(`${nameAt}?.el.scrollIntoView({ block: "center" }); true`);
    await sleep(600);
    await b.eval(`(() => { const i = document.getElementById("diff-search"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); i.blur(); window.getSelection().removeAllRanges(); return true; })()`);
    const onChanges = await b.eval(`(() => { const p = ${nameAt}; return p && { x: p.x, y: p.y }; })()`);
    if (onChanges) await pointer([{ type: "pointerMove", x: onChanges.x, y: onChanges.y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
    const changesSearch = await waitFor(`document.getElementById("diff-search")?.value || null`, 5000);
    check("on the Changes page too, a double-click on a name finds where it is used", changesSearch === "\\bHUNDRED_V2\\b", { onChanges, changesSearch });
    await b.eval(`(() => { const i = document.getElementById("diff-search"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); window.getSelection().removeAllRanges(); return true; })()`);

    await b.eval(`[...document.querySelectorAll(".side-tabs button")].find(x => x.textContent.startsWith("Files")).click(); true`);
    await sleep(400);
    const fileRowsNow = () => b.eval(`[...document.querySelectorAll(".file-row")].map(r => ({ name: r.querySelector(".file-name").textContent, active: r.classList.contains("active"), kept: r.querySelector(".kept")?.title ?? null }))`) as Promise<{ name: string; active: boolean; kept: string | null }[]>;
    const listed = await fileRowsNow();
    check("Files lists the diff; a test that changes an assertion stays in the list, with the reason", listed.length === 4 && listed.find((r) => r.name === "CacheTest.kt")?.kept === "1 test line removed or changed", listed);
    await click(".file-row .file-link");
    await sleep(900);
    const atTop = (await fileRowsNow()).find((r) => r.active)?.name;
    const host = await rect(".codeview-host");
    await b.send("input.performActions", { context: b.context, actions: [{ type: "wheel", id: "wheel", actions: [{ type: "scroll", x: host!.x, y: host!.y, deltaX: 0, deltaY: 20000 }] }] });
    await sleep(900);
    const atBottom = (await fileRowsNow()).find((r) => r.active)?.name;
    check("scrolling the diff moves the active file in the list", atTop === "Cache.kt" && atBottom === "CacheTest.kt", { atTop, atBottom });

    await b.eval(`document.querySelector(".file-row input[type=checkbox]").click(); true`);
    await click(".file-row .file-link");
    await sleep(900);
    const collapsed = await b.eval(`(() => { const c = [...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot.textContent.includes("Cache.kt") && !c.shadowRoot.textContent.includes("CacheTest")); return { lines: c ? c.shadowRoot.querySelectorAll("[data-column-number]").length : -1, head: document.querySelector(".file-list .side-head")?.textContent ?? "" }; })()`);
    check("marking a file viewed collapses it and counts it", collapsed.lines === 0 && collapsed.head.includes("1/4 viewed"), collapsed);

    await b.eval(`location.hash = "#/compare/base..1"; true`);
    await waitFor(`document.querySelector(".codeview-footer")?.textContent.includes("show 1 test file")`, 8000);
    const names = () => b.eval(`[...document.querySelectorAll(".codeview-host diffs-container")].map(c => c.shadowRoot.textContent.includes("CacheTest.kt"))`) as Promise<boolean[]>;
    const before = await names();
    await b.eval(`document.querySelector(".codeview-footer .btn").click(); true`);
    await sleep(600);
    await b.eval(`document.querySelector(".codeview-host").scrollTop = 1e6; true`);
    await sleep(700);
    const afterShow = await names();
    check("a new test file is folded into one group at the end, and opens on click", !before.includes(true) && afterShow.includes(true), { before, afterShow });

    await b.eval(`document.querySelector(".fold-summary .fold-tests").click(); true`);
    await sleep(500);
    await b.eval(`document.querySelector(".codeview-host").scrollTop = 0; true`);
    await sleep(400);
    const chip = (await b.eval(`document.querySelector(".fold-summary .fold-tests")?.textContent ?? ""`)) as string;
    await b.eval(`document.querySelector(".fold-summary .fold-tests").click(); true`);
    await sleep(1200);
    const testAt = await b.eval(`(() => { const host = document.querySelector(".codeview-host"); const c = [...host.querySelectorAll("diffs-container")].find(c => c.shadowRoot.textContent.includes("CacheTest.kt")); return c ? { top: Math.round(c.getBoundingClientRect().top - host.getBoundingClientRect().top), scrollTop: Math.round(host.scrollTop), max: host.scrollHeight - host.clientHeight } : null; })()`);
    check("the header counts the folded tests and its show button scrolls to them", chip.includes("1 test file") && chip.includes("folded") && testAt !== null && testAt.scrollTop > 0 && (testAt.top < 80 || testAt.scrollTop >= testAt.max - 2), { chip, testAt });

    await b.eval(`location.hash = "#/compare/1..2"; true`);
    await waitFor(`document.querySelector(".compare .range-title")?.textContent.includes("(v1 → v2)") && [...document.querySelectorAll(".codeview-host diffs-container")].some(c => c.shadowRoot.textContent.includes("HUNDRED_V2"))`, 8000);
    await sleep(300);
    await b.eval(`document.activeElement?.blur(); true`);
    const cursorAt = (container: string) =>
      b.eval(`(() => { const c = [...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot.textContent.includes(${JSON.stringify(container)})); const rows = c ? [...c.shadowRoot.querySelectorAll('[data-content] > [data-stet-mark~="cursor"]')] : []; return rows.map(r => r.getAttribute("data-line-type") + ":" + r.getAttribute("data-line")); })()`) as Promise<string[]>;
    await keys("z", "R", "g", "g");
    await sleep(500);
    const top = await cursorAt("Cache.kt");
    await keys("]", "c");
    await sleep(500);
    const change = await cursorAt("Cache.kt");
    check("gg puts a cursor on the first line, ]c jumps to the first change", top.length > 0 && change.some((x) => x.startsWith("change-")), { top, change });
    await keys("]", "b", "]", "c", "j");
    await sleep(600);
    const onAdd = await cursorAt("HUNDRED_V2");
    await keys("V", "2", "j");
    await sleep(400);
    const visualRows = await b.eval(`[...[...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot.textContent.includes("HUNDRED_V2")).shadowRoot.querySelectorAll('code[data-additions] [data-content] > [data-stet-mark~="visual"]')].map(r => +r.getAttribute("data-line"))`);
    check("]b goes to the next file, V with a count selects lines", onAdd.includes("change-addition:10") && [10, 11, 12].every((n) => visualRows.includes(n)), { onAdd, visualRows });
    await keys("i");
    await sleep(700);
    const vimBox = await composer();
    await keys("v", "i", "m", "j", "j");
    await sleep(300);
    const afterJj = await b.eval(`({ value: document.querySelector(".codeview-host .new-thread textarea")?.value, focused: document.activeElement?.tagName })`);
    check("i opens the comment box on the selection; jj leaves it and keeps the text", (vimBox?.includes("lines 10–12") ?? false) && afterJj.value === "vim" && afterJj.focused !== "TEXTAREA", { vimBox, afterJj });
    await keys("");
    await sleep(500);
    check("Esc then closes the box", (await b.eval(`!document.querySelector(".codeview-host .new-thread")`)) === true, null);
    await keys("z", "c");
    await sleep(600);
    const closedLines = await b.eval(`[...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot.textContent.includes("Zbig.kt") && !c.shadowRoot.textContent.includes("Cache"))?.shadowRoot.querySelectorAll("[data-column-number]").length ?? -1`);
    await keys("z", "o");
    await sleep(600);
    const openLines = await cursorAt("HUNDRED_V2");
    check("zc closes the file under the cursor, zo opens it again", closedLines === 0 && openLines.length > 0, { closedLines, openLines });
    await keys(" ");
    await sleep(300);
    const which = await b.eval(`[...document.querySelectorAll(".which-key .which-item")].map(x => x.textContent)`);
    await b.screenshot(join(OUT, "shots", "ui-check-whichkey.png"));
    await keys("f", "f");
    await sleep(300);
    const pickerFocused = await b.eval(`document.activeElement?.closest(".picker") ? true : false`);
    await keys("c", "a", "c", "h", "e", "t");
    await sleep(200);
    const picked = await b.eval(`document.querySelector(".picker li.on .file-name")?.textContent ?? null`);
    await keys("");
    await sleep(900);
    const afterPick = await cursorAt("CacheTest");
    check("Space shows what can follow; Space f f finds a file fuzzily and jumps there", which.some((x: string) => x.includes("find")) && pickerFocused && picked === "CacheTest.kt" && afterPick.length > 0, { which, pickerFocused, picked, afterPick });
    await keys("?");
    await sleep(300);
    const helpText = await b.eval(`document.querySelector(".help")?.textContent ?? ""`);
    await b.screenshot(join(OUT, "shots", "ui-check-help.png"));
    await keys("");
    await sleep(200);
    check("? lists the keys by place, Esc closes it", helpText.includes("Changes (the diff)") && helpText.includes("next change") && (await b.eval(`!document.querySelector(".help")`)) === true, helpText.slice(0, 120));
    await b.screenshot(join(OUT, "shots", "ui-check-vim.png"));

    await keys("g", "g", " ", "s", "k");
    await sleep(300);
    await keys(..."next change".split(""));
    await sleep(300);
    const keyRows = await b.eval(`[...document.querySelectorAll(".picker li .key-desc")].map(x => x.textContent).slice(0, 3)`);
    await b.screenshot(join(OUT, "shots", "ui-check-keys.png"));
    await keys("");
    await sleep(600);
    const ran = await cursorAt("Cache.kt");
    check("Space s k searches the keys and Enter runs the chosen one", keyRows[0] === "next change" && ran.some((x) => x.startsWith("change-")) && (await b.eval(`!document.querySelector(".picker")`)) === true, { keyRows, ran });
    await keys("?");
    await sleep(300);
    await keys(..."close the file".split(""));
    await sleep(200);
    const filtered = await b.eval(`[...document.querySelectorAll(".help td:last-child")].map(x => x.textContent)`);
    await keys("");
    await sleep(200);
    check("the ? help filters as you type", filtered.length > 0 && filtered.length <= 3 && filtered.every((x: string) => x.includes("close the file")), filtered);

    const sideTab = (name: string) => b.eval(`[...document.querySelectorAll(".side-tabs button")].find(x => x.textContent.startsWith(${JSON.stringify(name)}))?.click(); true`);
    await b.eval(`location.hash = "#/compare/1..2"; true`);
    await waitFor(`[...document.querySelectorAll(".codeview-host diffs-container")].some(c => c.shadowRoot.textContent.includes("HUNDRED_V2"))`, 8000);
    await sideTab("Threads");
    await sleep(300);
    const hrefs = await b.eval(`({ tree: document.querySelector(".thread-row a")?.getAttribute("href") ?? null, ver: document.querySelector("header .versions a.ver")?.getAttribute("href") ?? null, mini: document.querySelector(".codeview-host .thread-mini")?.getAttribute("href") ?? null })`);
    await sideTab("Files");
    await sleep(300);
    const fileHref = await b.eval(`document.querySelector(".file-row a.file-link")?.getAttribute("href") ?? null`);
    check("threads, versions, thread cards and files are real links, so a middle click opens them in a new tab", !!hrefs.tree?.startsWith("#/thread/") && hrefs.ver === "#/compare/base..1" && !!hrefs.mini?.startsWith("#/thread/") && !!fileHref?.startsWith("#/compare/1..2?file="), { hrefs, fileHref });

    const mainContext = b.context;
    const tab = await b.send("browsingContext.create", { type: "tab" });
    b.context = tab.context;
    await b.navigate(`${url.split("#")[0]}#/thread/${t100}`);
    const opened = await waitFor(`document.querySelector(".detail-head .tid")?.textContent ?? null`, 10000);
    await b.send("browsingContext.close", { context: tab.context });
    b.context = mainContext;
    await b.send("browsingContext.activate", { context: mainContext }).catch(() => null);
    check("a link opened in a new tab works without the token in the URL", opened === `#${t100}`, opened);

    const boxAt = await rect(".file-row input[type=checkbox]");
    const scrollBefore = await b.eval(`document.querySelector(".codeview-host").scrollTop`);
    if (boxAt) await pointer([{ type: "pointerMove", x: boxAt.x, y: boxAt.y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
    await sleep(400);
    await keys(" ");
    await sleep(400);
    const afterSpace = await b.eval(`({ which: !!document.querySelector(".which-key"), scroll: document.querySelector(".codeview-host").scrollTop, focus: document.activeElement?.tagName })`);
    await keys("");
    await sleep(200);
    if (boxAt) await b.eval(`document.querySelector(".file-row input[type=checkbox]").click(); true`);
    check("after a click on a “viewed” checkbox the keys still work: Space opens the menu, the diff does not scroll", afterSpace.which === true && afterSpace.scroll === scrollBefore, { afterSpace, scrollBefore });

    await b.eval(`location.hash = "#/compare/base..2?file=src%2FZbig.kt&line=100"; true`);
    const deep = await waitFor(`(() => { const c = [...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot.textContent.includes("HUNDRED_V2")); const rows = c ? [...c.shadowRoot.querySelectorAll('code[data-additions] [data-content] > [data-stet-mark~="cursor"]')].map(r => +r.getAttribute("data-line")) : []; return rows.includes(100) ? rows : null; })()`, 10000);
    const activeRow = await b.eval(`document.querySelector(".file-row.active .file-name")?.textContent ?? null`);
    check("a link with a file and a line opens the diff there with the cursor on it, and Files follows the cursor", !!deep && activeRow === "Zbig.kt", { deep, activeRow });

    await b.eval(`[...document.querySelectorAll(".presets .chip")].find(x => x.textContent === "what changed in v2")?.click(); true`);
    await sleep(800);
    const strip = await b.eval(`({ hash: location.hash, title: document.querySelector(".range-title")?.textContent ?? "", from: document.querySelector(".vstep.from .vlabel")?.textContent ?? null, to: document.querySelector(".vstep.to .vlabel")?.textContent ?? null })`);
    check("a preset picks the range, the strip marks both ends, the title says what is shown", strip.hash === "#/compare/1..2" && strip.from === "v1" && strip.to === "v2" && strip.title.startsWith("What changed in v2"), strip);
    const stepEl = (label: string) => `[...document.querySelectorAll(".vstep")].find(x => x.querySelector(".vlabel").textContent === ${JSON.stringify(label)})`;
    const stripClick = async (label: string, what: "from" | "to" | "body") => {
      await b.eval(`${stepEl(label)}.querySelector(${JSON.stringify(what === "body" ? ".vbody" : `.vend:nth-child(${what === "from" ? 1 : 2})`)}).click(); true`);
      await sleep(600);
      return (await b.eval("location.hash")) as string;
    };
    const ends = [await stripClick("base", "from"), await stripClick("v1", "to"), await stripClick("v2", "from"), await stripClick("v2", "body")];
    check(
      "the strip: from / to under a step set that end (crossing the other end moves it along), a click on a step shows what changed in it",
      JSON.stringify(ends) === JSON.stringify(["#/compare/base..2", "#/compare/base..1", "#/compare/2..now", "#/compare/1..2"]),
      ends,
    );
    await b.screenshot(join(OUT, "shots", "ui-check-strip.png"));

    await b.eval(`[...document.querySelectorAll(".compare-head .btn")].find(x => x.textContent.includes("Done up to"))?.click(); true`);
    const remembered = await waitFor(`document.querySelector(".reviewed-mark")?.textContent ?? null`, 5000);
    big({ 10: "val line10 = TEN_V3", 100: "val line100 = HUNDRED_V2" });
    const zbigPath = join(repo, "src/Zbig.kt");
    writeFileSync(zbigPath, readFileSync(zbigPath, "utf8").split("\n").filter((_, i) => i !== 117).join("\n"));
    run(repo, ["git", "add", "-A"]);
    run(repo, ["bun", CLI, "version", "create", "--label", "round three", "--json"]);
    await waitFor(`document.querySelectorAll("header .versions a.ver").length === 3`, 8000);
    await sleep(400);
    await keys(" ", "r", "v");
    await sleep(900);
    check("after “Done up to v2”, Space r v opens what changed since then: v2 → v3", (remembered?.includes("v2") ?? false) && (await b.eval("location.hash")) === "#/compare/2..3", { remembered, hash: await b.eval("location.hash") });
    await b.eval(`location.hash = "#/overview"; true`);
    const round = await waitFor(`document.querySelectorAll(".round li").length === 3 ? [...document.querySelectorAll(".round li")].map(x => x.className + ": " + x.textContent.slice(0, 60)) : null`, 5000);
    check("the Round page lists what is left: threads, new code since the last pass, drafts", Array.isArray(round) && round[1]!.startsWith("todo: Go through the new code"), round);

    run(repo, ["bun", CLI, "reply", String(t100), "--body", `Should I rename it too? Answer thread #${t10} first.`, "--intent", "question", "--json"]);
    run(repo, ["bun", CLI, "reply", String(tr), "--body", "Fixed.", "--intent", "fixed", "--json"]);
    await b.eval(`location.hash = "#/thread/${t100}"; true`);
    const strip2 = await waitFor(`document.querySelector(".state-strip.intent-question")?.textContent ?? null`, 8000);
    const codeOk = await waitFor(`(() => { const a = document.querySelector(".code-area"); const c = a?.querySelector("diffs-container"); const text = (a?.textContent ?? "") + (c?.shadowRoot?.textContent ?? ""); return text.includes("HUNDRED_V2") ? { mismatch: text.includes("mismatch") } : null; })()`, 8000);
    check("a thread's code renders when the file has other changes that shift its lines (v1 → v3 removes a line below)", codeOk?.mismatch === false, codeOk);
    const refHref = await b.eval(`document.querySelector(".thread-msgs .tref a")?.getAttribute("href") ?? null`);
    const roles = await b.eval(`[...document.querySelectorAll(".comment")].map(c => [c.className.includes("role-agent") ? "agent" : "reviewer", getComputedStyle(c).backgroundColor])`);
    check("a question from the agent says it waits for you, and #N in a reply links to that thread", (strip2?.includes("waits for your answer") ?? false) && refHref === `#/thread/${t10}`, { strip2, refHref });
    check("the agent's and the reviewer's messages have different backgrounds", roles.length >= 2 && new Set(roles.map((r: string[]) => r[1])).size >= 2, roles);
    await b.eval(`location.hash = "#/thread/${tr}"; true`);
    const unchanged = await waitFor(`[...document.querySelectorAll(".comment .badge")].map(x => x.textContent).find(x => x.includes("unchanged")) ?? null`, 8000);
    check("a “fixed” reply whose lines did not change is flagged", unchanged?.includes("lines unchanged since v2") ?? false, unchanged);

    await b.eval(`location.hash = "#/thread/${t100}"; true`);
    await waitFor(`document.querySelector(".detail-head .tid")?.textContent === "#${t100}"`, 8000);
    await sideTab("Threads");
    await b.eval(`document.activeElement?.blur(); true`);
    await keys("x");
    const resolvedLook = await waitFor(`document.querySelector(".state-strip.resolved") ? ({ strip: document.querySelector(".state-strip.resolved").textContent, event: document.querySelector(".conv-event.resolved")?.textContent ?? null, tree: !!document.querySelector(".thread-row.active.resolved .check") }) : null`, 5000);
    await b.screenshot(join(OUT, "shots", "ui-check-resolved.png"));
    check("a resolved thread shows it: a green strip, an entry in the conversation, a check in the tree (it stays there)", !!resolvedLook && resolvedLook.strip.includes("Resolved") && (resolvedLook.event?.includes("resolved") ?? false) && resolvedLook.tree, resolvedLook);
    await keys("X");
    await waitFor(`!document.querySelector(".state-strip.resolved")`, 5000);

    await keys("/");
    await sleep(300);
    await keys(..."line50 = 50".split(""));
    await waitFor(`document.querySelector(".search .snip.match")`, 6000);
    await keys("");
    const peekHere = await waitFor(`document.querySelector(".thread-code .peek diffs-container") && document.querySelector(".thread-msgs textarea") ? document.querySelector(".thread-code .peek .peek-head").textContent : null`, 6000);
    await b.eval(`document.querySelector(".search .quote").click(); true`);
    const quoted = await waitFor(`document.querySelector(".thread-msgs > .composer textarea")?.value.includes("src/Zbig.kt:50") ? document.querySelector(".thread-msgs > .composer textarea").value : null`, 5000);
    await b.screenshot(join(OUT, "shots", "ui-check-thread-search.png"));
    check("on a thread, / searches all files at that step; a hit opens over the code, the conversation stays; ❝ quotes it into the reply", !!peekHere && !!quoted, { peekHere, quoted });
    await b.eval(`(() => { const ta = document.querySelector(".thread-msgs > .composer textarea"); ta.value = ""; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.blur(); return true; })()`);
    const n50 = await b.eval(`(() => { const c = document.querySelector(".thread-code .peek diffs-container"); const el = [...c.shadowRoot.querySelectorAll("[data-column-number='50']")].pop(); const r = el?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`);
    if (n50) await pointer([{ type: "pointerMove", x: n50.x, y: n50.y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
    await waitFor(`document.querySelector(".thread-code .peek .new-thread textarea")`, 5000);
    await b.eval(`document.querySelector(".thread-code .peek .new-thread textarea").focus(); true`);
    await keys(..."peek note".split(""));
    await chord([CTRL], "s");
    const peekCard = await waitFor(`[...document.querySelectorAll(".thread-code .peek .thread-mini")].map(x => x.textContent).find(x => x.includes("peek note")) ?? null`, 8000);
    const toastLink = await b.eval(`document.querySelector(".toast a")?.getAttribute("href") ?? null`);
    check("a thread written in the file preview shows up on its line there, and the toast links to it", !!peekCard && !!toastLink?.startsWith("#/thread/"), { n50, peekCard, toastLink });
    await keys("");
    await sleep(300);

    const word = await b.eval(`(() => { const c = document.querySelector(".thread-code .code-area diffs-container"); const walker = document.createTreeWalker(c.shadowRoot, 4); for (let n = walker.nextNode(); n; n = walker.nextNode()) { const i = n.nodeValue.indexOf("HUNDRED_V2"); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 10); const b = r.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; } } return null; })()`);
    if (word) await pointer([{ type: "pointerMove", x: word.x, y: word.y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
    const usages = await waitFor(`document.getElementById("diff-search")?.value.includes("HUNDRED") ? document.getElementById("diff-search").value : null`, 5000);
    check("double-clicking a name in the thread's code finds where it is used", usages === "\\bHUNDRED_V2\\b", { word, usages });

    await b.eval(`(async () => { document.querySelector(".thread-code .code-area").style.width = "420px"; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true; })()`);
    const columns = await b.eval(`(() => { const pre = document.querySelector(".thread-code .code-area diffs-container").shadowRoot.querySelector('[data-diff-type="split"][data-overflow="wrap"]'); return pre ? getComputedStyle(pre).gridTemplateColumns : null; })()`);
    const [, oldW, , newW] = String(columns).split(" ").map(parseFloat);
    check("split + wrap in a narrow pane: the old and the new column keep the same width", !!oldW && !!newW && Math.abs(oldW - newW) < 2, { columns });

    const piece = await b.eval(`(async () => { const area = document.querySelector(".thread-code .code-area"); const c = area.querySelector("diffs-container"); for (let w = 320; w >= 100; w -= 10) { area.style.width = w + "px"; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const walker = document.createTreeWalker(c.shadowRoot, 4); for (let n = walker.nextNode(); n; n = walker.nextNode()) { const i = n.nodeValue.indexOf("HUNDRED_V2"); if (i < 0 || !n.parentElement.closest("[data-additions]")) continue; const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 10); const rects = [...r.getClientRects()].filter(x => x.width > 0); if (rects.length > 1) { const last = rects[rects.length - 1]; return { w, x: Math.round(last.left + last.width / 2), y: Math.round(last.top + last.height / 2) }; } } } return null; })()`);
    await b.eval(`(() => { const i = document.getElementById("diff-search"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); window.getSelection().removeAllRanges(); return true; })()`);
    if (piece) await pointer([{ type: "pointerMove", x: piece.x, y: piece.y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]);
    const wholeName = await waitFor(`document.getElementById("diff-search")?.value || null`, 5000);
    await b.eval(`document.querySelector(".thread-code .code-area").style.width = ""; true`);
    check("a double-click on a name that a wrapped line breaks in two searches for the whole name", wholeName === "\\bHUNDRED_V2\\b", { piece, wholeName });

    await b.eval(`document.activeElement?.blur(); true`);
    const startHash = await b.eval("location.hash");
    await keys("k");
    await sleep(700);
    const nextHash = await b.eval("location.hash");
    await chord([CTRL], "o");
    await sleep(700);
    const backHash = await b.eval("location.hash");
    await chord([CTRL], "i");
    await sleep(700);
    const fwdHash = await b.eval("location.hash");
    check("Ctrl+O jumps back to the thread you came from, Ctrl+I forward again", nextHash !== startHash && backHash === startHash && fwdHash === nextHash, { startHash, nextHash, backHash, fwdHash });

    await b.viewport(1920, 1000);
    await b.eval(`location.hash = "#/thread/${t100}"; true`);
    await waitFor(`document.querySelector(".detail-head .tid")?.textContent === "#${t100}"`, 8000);
    await sleep(800);
    const wide = await b.eval(`(() => { const c = document.querySelector(".thread-code").getBoundingClientRect(); const m = document.querySelector(".thread-msgs").getBoundingClientRect(); return { code: [Math.round(c.left), Math.round(c.right)], msgs: [Math.round(m.left), Math.round(m.right)], scroll: getComputedStyle(document.querySelector(".thread-msgs")).overflowY }; })()`);
    await b.screenshot(join(OUT, "shots", "ui-check-wide.png"));
    check("on a wide screen the thread is threads | code | messages, each column scrolling on its own", wide.msgs[0] >= wide.code[1] && wide.scroll === "auto", wide);
    const aside0 = await b.eval(`Math.round(document.querySelector("aside").getBoundingClientRect().width)`);
    const grip = await rect(".side-splitter");
    if (grip) await pointer([{ type: "pointerMove", x: grip.x, y: grip.y }, { type: "pointerDown", button: 0 }, { type: "pointerMove", x: grip.x + 120, y: grip.y, duration: 150 }, { type: "pointerUp", button: 0 }]);
    await sleep(300);
    const aside1 = await b.eval(`Math.round(document.querySelector("aside").getBoundingClientRect().width)`);
    await b.eval(`document.querySelector(".side-splitter").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); true`);
    await sleep(300);
    const aside2 = await b.eval(`Math.round(document.querySelector("aside").getBoundingClientRect().width)`);
    check("the border next to the side panel can be dragged, a double-click resets it", Math.abs(aside1 - aside0 - 120) <= 4 && aside2 === aside0, { aside0, aside1, aside2 });

    run(repo, ["git", "add", "-A"]);
    run(repo, ["git", "commit", "-q", "-m", "ui: first commit"]);
    writeFileSync(join(repo, "src/Extra.kt"), "val extra = 1\n");
    run(repo, ["git", "add", "-A"]);
    run(repo, ["git", "commit", "-q", "-m", "ui: second commit"]);
    await b.eval(`location.hash = "#/compare/base..now"; true`);
    await waitFor(`document.querySelector(".commits-chip")`, 8000);
    await b.eval(`document.activeElement?.blur(); true`);
    await keys(" ", "g", "c");
    const cpListed = await waitFor(`document.querySelectorAll(".commit-row").length >= 3 ? [...document.querySelectorAll(".commit-row .subject")].map(x => x.textContent) : null`, 8000);
    const commitRow = (s: string) => `[...document.querySelectorAll(".commit-row")].find(r => r.textContent.includes(${JSON.stringify(s)}))`;
    await b.eval(`${commitRow("ui: second commit")}.querySelector("a.commit-msg").click(); true`);
    const cpSingle = await waitFor(`document.querySelector(".range-title")?.textContent.startsWith("Commit ") && document.querySelector(".range-title").textContent.includes("1 file") ? document.querySelector(".range-title").textContent : null`, 8000);
    await b.eval(`${commitRow("ui: first commit")}.querySelector(".end").click(); true`);
    const cpBoth = await waitFor(`document.querySelector(".range-title")?.textContent.startsWith("2 commits") ? document.querySelector(".range-title").textContent : null`, 8000);
    const cpMarked = await b.eval(`document.querySelectorAll(".commit-row.in").length`);
    await b.eval(`${commitRow("base")}.querySelector("a.commit-msg").click(); true`);
    const cpRoot = await waitFor(`/^Commit \\w{8}: base · 2 files$/.test(document.querySelector(".range-title")?.textContent) ? location.hash : null`, 8000);
    const cpRootIn = await b.eval(`[...document.querySelectorAll(".commit-row.in")].map(r => r.querySelector(".subject").textContent)`);
    check("the repository's first commit shows alone, from the empty tree", (cpRoot?.startsWith("#/compare/empty..") ?? false) && JSON.stringify(cpRootIn) === JSON.stringify(["base"]), { cpRoot, cpRootIn });
    await keys("");
    await sleep(300);
    const cpClosed = await b.eval(`!document.querySelector(".commit-picker")`);
    check("Space g c lists the branch's commits; a message shows one commit, first/last pick an inclusive range; Esc closes", (cpListed?.includes("ui: second commit") ?? false) && !!cpSingle && !!cpBoth && cpMarked === 2 && cpClosed, { cpListed, cpSingle, cpBoth, cpMarked, cpClosed });

    mkdirSync(join(repo, "app"));
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "README.md"), "# demo\n");
    writeFileSync(join(repo, "app/build.gradle.kts"), "plugins {}\n");
    writeFileSync(join(repo, "docs/notes.md"), "notes\n");
    writeFileSync(join(repo, "src/Zzz.kt"), "val z = 1\n");
    test(["class CacheTest {", "    @Test fun put() = assertEquals(3, 1)", "}"]);
    run(repo, ["git", "add", "-A"]);
    run(repo, ["git", "commit", "-q", "-m", "ui: kinds"]);
    await b.eval(`location.hash = "#/compare/HEAD~1..HEAD"; true`);
    await sideTab("Files");
    const kinds = await waitFor(
      `(() => { const names = [...document.querySelectorAll(".file-row .file-name")].map(x => x.textContent); return names.includes("notes.md") ? { names, heads: [...document.querySelectorAll(".file-list h4")].map(x => x.textContent) } : null; })()`,
      8000,
    );
    const at = (n: string) => kinds?.names.indexOf(n) ?? -1;
    check(
      "files are ordered by kind: code, then resources, build and config, changed tests, docs, each group with a heading",
      at("Zzz.kt") < at("build.gradle.kts") && at("build.gradle.kts") < at("CacheTest.kt") && at("CacheTest.kt") < at("README.md") && at("README.md") < at("notes.md") &&
        JSON.stringify(kinds?.heads) === JSON.stringify(["Code (1)", "Resources, build and config (1)", "Changed tests (1)", "Docs (2)"]),
      kinds,
    );

    const said = (n: number, who: string) => Array.from({ length: n }, (_, i) => `${who} line ${i + 1} of a long message about the cache`).join("\n");
    const cli = (args: string[]) => JSON.parse(run(repo, ["bun", CLI, ...args, "--json"]));
    const talk = cli(["comment", "add", "--file", "src/Zzz.kt", "--range", "1-1", "--body", "why z?", "--as", "reviewer"]).id as number;
    const reply = (body: string, reviewer = false) => cli(["reply", String(talk), "--body", body, ...(reviewer ? ["--as", "reviewer"] : [])]).id as number;
    const longOld = reply(said(30, "old"));
    reply("ok, and the tests?", true);
    reply(said(6, "tests"));
    reply("fine", true);
    await b.viewport(1600, 800);
    await b.eval(`location.hash = "#/thread/${talk}"; true`);
    await waitFor(`document.querySelector(".detail-head .tid")?.textContent === "#${talk}"`, 8000);
    await sleep(1200);
    await b.eval(`location.hash = "#/compare/1..2"; true`);
    await sleep(500);
    const firstNewId = reply(said(4, "new"));
    reply(said(30, "newer"));
    await b.eval(`location.hash = "#/thread/${talk}"; true`);
    const convState = `(() => { const line = document.querySelector(".thread-msgs .new-line"); const col = document.querySelector(".thread-msgs"); if (!line) return null; const head = document.querySelector(".msgs-head"); return { head: head.textContent, scrollHeight: col.scrollHeight, clientHeight: col.clientHeight, lineTop: Math.round(line.getBoundingClientRect().top - col.getBoundingClientRect().top), scrollTop: col.scrollTop, next: line.nextElementSibling.querySelector(".msg").dataset.id, folded: [...document.querySelectorAll(".msg.folded")].map(x => x.dataset.id) }; })()`;
    await waitFor(`(${convState})?.lineTop < 80`, 8000);
    const convOpen = await b.eval(convState);
    check(
      "a long conversation opens at the first new message under a “new” line; the header counts messages and new ones; a long read message is folded",
      !!convOpen && convOpen.next === String(firstNewId) && convOpen.lineTop < 80 && convOpen.head.includes("7 messages") && convOpen.head.includes("2 new") && JSON.stringify(convOpen.folded) === JSON.stringify([String(longOld)]),
      convOpen,
    );
    await b.eval(`document.activeElement?.blur(); true`);
    const msgAt = () => b.eval(`document.querySelector(".msg.at-cursor")?.dataset.id ?? null`);
    await keys("G");
    await sleep(300);
    const atLast = await b.eval(`(() => { const col = document.querySelector(".thread-msgs"); return { id: document.querySelector(".msg.at-cursor")?.dataset.id ?? null, bottom: Math.round(col.scrollHeight - col.scrollTop - col.clientHeight) }; })()`);
    await keys("g", "g");
    await sleep(200);
    const atFirst = await msgAt();
    await keys("}");
    await sleep(200);
    const atSecond = await msgAt();
    await keys("z", "a");
    await sleep(200);
    const unfolded = await b.eval(`!document.querySelector('.msg[data-id="${longOld}"]').classList.contains("folded")`);
    await keys("r");
    await sleep(400);
    const replyingTo = await b.eval(`document.activeElement?.tagName === "TEXTAREA" ? document.activeElement.closest(".comment")?.querySelector(".msg")?.dataset.id ?? "?" : null`);
    await keys("\uE00C");
    await b.eval(`document.activeElement?.blur(); true`);
    check(
      "message keys: G the last message with the reply box, gg the first, } the next, za unfolds it, r replies to it",
      atLast.bottom <= 2 && atLast.id !== null && atFirst !== null && atSecond === String(longOld) && unfolded && replyingTo === String(longOld),
      { atLast, atFirst, atSecond, unfolded, replyingTo },
    );
    await b.screenshot(join(OUT, "shots", "ui-check-conversation.png"));
    await b.viewport(1400, 900);
    const injected = await b.eval(`({ pwned: String(window.__pwned ?? "none"), imgs: document.querySelectorAll("img").length + [...document.querySelectorAll("diffs-container")].reduce((n, c) => n + c.shadowRoot.querySelectorAll("img").length, 0), csp: window.__csp })`);
    check("HTML in file names and comments renders as text, and the page breaks no CSP rule", injected.pwned === "none" && injected.imgs === 0 && injected.csp.length === 0, injected);
    await b.screenshot(join(OUT, "shots", "ui-check-files.png"));

    for (let i = 0; i < 12; i++) {
      writeFileSync(join(repo, "src/Many.kt"), `val many = ${i}\n`);
      run(repo, ["git", "add", "-A"]);
      run(repo, ["bun", CLI, "version", "create", "--label", `step ${i}`, "--json"]);
    }
    const latest = JSON.parse(run(repo, ["bun", CLI, "status", "--json"])).versions as number;
    await b.viewport(1280, 800);
    await b.eval(`location.hash = "#/compare/3..4"; true`);
    await waitFor(`document.querySelector("header.top button.older") && [...document.querySelectorAll("header.top a.ver")].some(a => a.textContent === "v${latest}")`, 10000);
    await sleep(800);
    const many = await b.eval(`(() => { const strip = document.querySelector(".vstrip").getBoundingClientRect(); const inStrip = (sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return !!r && r.left >= strip.left - 1 && r.right <= strip.right + 1; }; return { pageW: document.documentElement.scrollWidth, winW: innerWidth, navRight: Math.round(document.querySelector("header.top nav").getBoundingClientRect().right), chips: document.querySelectorAll("header.top .versions a.ver").length, ends: [inStrip(".vstep.from"), inStrip(".vstep.to")], folds: document.querySelectorAll(".vstrip .vstep.fold").length, steps: [...document.querySelectorAll(".vstrip .vstep .vlabel")].map(e => e.textContent).join(" ") }; })()`);
    await b.screenshot(join(OUT, "shots", "ui-check-many-versions.png"));
    check(
      "with many versions the page stays as wide as the window: the last 6 in the header, the strip folds the versions far from the range and scrolls to it",
      many.pageW <= many.winW && many.navRight <= many.winW && many.chips === 6 && many.ends.every(Boolean) && many.folds >= 1,
      many,
    );
    await b.eval(`document.querySelector(".vstrip .vstep.fold .vbody").click(); true`);
    await sleep(300);
    const foldsAfterClick = await b.eval(`document.querySelectorAll(".vstrip .vstep.fold").length`);

    const pickVersion = async (query: string, mods: string[]) => {
      await b.eval(`document.activeElement?.blur(); true`);
      await keys(" ", "f", "v");
      await waitFor(`document.querySelector(".picker input")`, 3000);
      await b.eval(`(() => { const i = document.querySelector(".picker input"); i.value = ${JSON.stringify(query)}; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await sleep(200);
      await chord(mods, "");
      await sleep(400);
      return b.eval("location.hash") as Promise<string>;
    };
    const seven = latest - 4;
    const alone = await pickVersion("step 7", []);
    const asFrom = await pickVersion(`v${latest - 8}`, [SHIFT]);
    const asTo = await pickVersion(`v${latest}`, [CTRL]);
    check(
      "Space f v finds a version by its label: Enter shows what changed in it, Shift+Enter makes it “from”, Ctrl+Enter “to”; a click on a folded step shows its versions",
      alone === `#/compare/${seven - 1}..${seven}` && asFrom === `#/compare/${latest - 8}..${seven}` && asTo === `#/compare/${latest - 8}..${latest}` && foldsAfterClick < many.folds,
      { alone, asFrom, asTo, seven, latest, folds: many.folds, foldsAfterClick },
    );

    await b.eval(`location.hash = "#/thread/1"; true`);
    await waitFor(`document.querySelector(".timeline .step")`, 8000);
    await sleep(600);
    const timeline = await b.eval(`[...document.querySelectorAll(".timeline .step")].map(e => e.querySelector(".step-label").textContent + (e.classList.contains("fold") ? "*" : "")).join(" ")`);
    await b.eval(`location.hash = "#/overview"; true`);
    await waitFor(`document.querySelector(".round-versions")`, 8000);
    const roundsShown = await b.eval(`[...document.querySelectorAll(".round-versions")].map(d => (d.open ? "open " : "") + d.querySelector("summary").textContent.trim().slice(0, 40))`);
    check(
      "a thread's timeline folds the versions where nothing happened to it; the Round page groups versions by the review they answer",
      /\*/.test(timeline) && roundsShown.length >= 1 && roundsShown[0].startsWith("open"),
      { timeline, roundsShown },
    );
    mkdirSync(join(repo, "res"), { recursive: true });
    writeFileSync(join(repo, "res/card.png"), pngCard(240, 160, { bar: { y: 0, h: 30, color: [40, 90, 200, 255] } }));
    writeFileSync(join(repo, "res/logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="#2f6fdd"/></svg>\n`);
    mkdirSync(join(repo, "app"), { recursive: true });
    writeFileSync(join(repo, "app/Long.kt"), Array.from({ length: 300 }, (_, i) => `val long${i} = ${i}`).join("\n") + "\n");
    run(repo, ["git", "add", "-A"]);
    run(repo, ["bun", CLI, "version", "create", "--label", "card", "--json"]);
    writeFileSync(join(repo, "res/card.png"), pngCard(240, 160, { bar: { y: 0, h: 30, color: [200, 60, 60, 255] }, box: { x: 20, y: 60, w: 40, h: 40, color: [0, 160, 80, 255] } }));
    writeFileSync(join(repo, "res/icon.png"), pngCard(24, 24, { box: { x: 4, y: 4, w: 8, h: 8, color: [200, 0, 0, 255] } }));
    writeFileSync(join(repo, "res/logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="10" fill="#c53030"/></svg>\n`);
    run(repo, ["git", "add", "-A"]);
    run(repo, ["bun", CLI, "version", "create", "--label", "red card", "--json"]);
    const imgV = JSON.parse(run(repo, ["bun", CLI, "status", "--json"])).versions as number;
    await b.viewport(1400, 900);
    await b.eval(`location.hash = "#/compare/${imgV - 1}..${imgV}"; true`);
    await waitFor(`[...document.querySelectorAll(".imgdiff img")].length >= 5 && [...document.querySelectorAll(".imgdiff img")].every(i => i.complete && i.naturalWidth > 0)`, 10000);
    await sleep(500);
    const imgShown = await b.eval(`({ files: [...document.querySelectorAll(".imgdiff")].map(d => d.dataset.file), caption: document.querySelector('.imgdiff[data-file="res/card.png"] .imgdiff-caption')?.textContent, icon: (() => { const i = document.querySelector('.imgdiff[data-file="res/icon.png"] img'); return i ? [i.naturalWidth, Math.round(i.getBoundingClientRect().width)] : null; })(), emptyRow: [...document.querySelectorAll(".codeview-host diffs-container[data-stet-viewer]")].length })`);
    check(
      "an image in the diff shows as pictures with its size and bytes; an icon is enlarged; old and new side by side",
      imgShown.files.join(",") === "res/card.png,res/icon.png,res/logo.svg" && (imgShown.caption?.startsWith("PNG · 240×160 ·") ?? false) && imgShown.icon?.[0] === 24 && imgShown.icon[1] >= 96 && imgShown.emptyRow === 3,
      imgShown,
    );
    const modeOf = async (name: string, ready: string) => {
      await b.eval(`[...document.querySelectorAll('.imgdiff[data-file="res/card.png"] .seg button')].find(x => x.textContent === ${JSON.stringify(name)}).click(); true`);
      return waitFor(ready, 5000);
    };
    const swipe = await modeOf("swipe", `document.querySelector(".imgstack.mode-swipe .imgstack-divider")`);
    const onion = await modeOf("onion skin", `document.querySelector(".imgstack.mode-onion")`);
    const diffText = await modeOf("difference", `(() => { const t = document.querySelector(".imgdiff-canvas .imgstack-labels")?.textContent ?? ""; return /px differ/.test(t) ? t : null; })()`);
    await modeOf("side by side", `document.querySelectorAll('.imgdiff[data-file="res/card.png"] .imgpane').length === 2`);
    check("an image that changed can be compared side by side, by swipe, onion skin and pixel difference", !!swipe && !!onion && /all within/.test(diffText ?? ""), { swipe: !!swipe, onion: !!onion, diffText });

    const svgToggle = (want: string) => b.eval(`(() => { const t = [...document.querySelectorAll(".svg-toggle")][0]; if (!t) return null; const before = t.textContent; t.click(); return before; })()`).then(async (before) => ({ before, ok: await waitFor(want, 5000) }));
    const toCode = await svgToggle(`!document.querySelector('.imgdiff[data-file="res/logo.svg"]') && [...document.querySelectorAll(".codeview-host diffs-container")].some(h => h.shadowRoot?.querySelector("[data-title]")?.textContent === "res/logo.svg" && h.shadowRoot.querySelector("[data-line]")?.textContent.includes("circle"))`);
    const toPicture = await svgToggle(`document.querySelector('.imgdiff[data-file="res/logo.svg"] img')?.getBoundingClientRect().width >= 96`);
    check("an SVG (only a viewBox, no size) shows as a picture, enlarged, and the button on its header switches it to its code and back", toCode.before?.includes("code") && !!toCode.ok && toPicture.before?.includes("picture") && !!toPicture.ok, { toCode, toPicture });

    const pane = await b.eval(`(() => { const r = document.querySelectorAll('.imgdiff[data-file="res/card.png"] .imgbox')[1].getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    await pointer([{ type: "pointerMove", x: pane.x + 10, y: pane.y + 5 }, { type: "pointerDown", button: 0 }, { type: "pointerMove", x: pane.x + Math.round(pane.w / 2), y: pane.y + 40 }, { type: "pointerMove", x: pane.x + Math.round(pane.w / 2) + 5, y: pane.y + 45 }, { type: "pointerUp", button: 0 }]);
    await waitFor(`document.querySelector(".imgdiff .new-thread textarea")`, 3000);
    await b.eval(`(() => { const t = document.querySelector(".imgdiff .new-thread textarea"); t.focus(); return true; })()`);
    await keys(..."why red?");
    await b.eval(`[...document.querySelectorAll(".imgdiff .new-thread button")].find(x => x.textContent.includes("Save draft")).click(); true`);
    const framed = await waitFor(`document.querySelector('.imgdiff[data-file="res/card.png"] a.img-frame[data-thread]')?.dataset.thread`, 8000);
    const imgThread = framed ? JSON.parse(run(repo, ["bun", CLI, "thread", "show", String(framed), "--as", "reviewer", "--json"])) : null;
    check(
      "a drag on an image starts a thread on that area; it is drawn as a frame, and the agent gets the image with the area framed and a crop",
      !!imgThread && imgThread.thread.region.iw === 240 && imgThread.thread.region.w > 50 && imgThread.thread.region.h > 10 && existsSync(imgThread.image?.shot ?? "") && existsSync(imgThread.image?.crop ?? ""),
      { framed, region: imgThread?.thread.region, image: imgThread?.image },
    );

    await b.eval(`location.hash = "#/thread/${framed}"; true`);
    await waitFor(`document.querySelector(".image-area .region-crop img")?.complete && document.querySelector(".timeline .step-thumb")`, 8000);
    await b.eval(`[...document.querySelectorAll(".side-tabs button")].find(x => x.textContent.startsWith("Threads")).click(); true`);
    await waitFor(`document.querySelector('.thread-row a[href="#/thread/${framed}"]')`, 3000);
    const page = await b.eval(`({ head: document.querySelector(".detail-head h2")?.textContent, crop: !!document.querySelector(".image-area .region-crop .img-frame"), tree: document.querySelector('.thread-row a[href="#/thread/${framed}"] .line')?.textContent, csp: window.__csp.length })`);
    await b.screenshot(join(OUT, "shots", "ui-check-image-thread.png"));
    check(
      "a thread on an image shows the area on its page and in each timeline step; lists say “area W×H” instead of lines",
      (page.head?.includes("area") ?? false) && page.crop && (page.tree?.startsWith("area ") ?? false) && page.csp === 0,
      page,
    );

    writeFileSync(join(repo, "docs/guide.md"), ["# Guide", "", "Intro.", "", "Old paragraph that goes away.", "", "## Usage", "", "Run it.", ""].join("\n"));
    run(repo, ["git", "add", "-A"]);
    run(repo, ["bun", CLI, "version", "create", "--label", "guide", "--json"]);
    writeFileSync(
      join(repo, "docs/guide.md"),
      ["# Guide", "", "Intro.", "", "## Usage", "", "Run it, then open the card:", "", "![the card](../res/card.png)", "", "![remote](https://example.com/remote.png)", "", "```ts", 'const card: string = "red";', "```", ""].join("\n"),
    );
    run(repo, ["git", "add", "-A"]);
    run(repo, ["bun", CLI, "version", "create", "--label", "guide with a picture", "--json"]);
    const mdV = JSON.parse(run(repo, ["bun", CLI, "status", "--json"])).versions as number;
    await b.eval(`location.hash = "#/compare/${mdV - 1}..${mdV}"; true`);
    await waitFor(`document.querySelector(".md-toggle")`, 10000);
    await sleep(800);
    const mdToggle = await b.eval(`document.querySelector(".md-toggle").textContent`);
    await b.eval(`document.querySelector(".md-toggle").click(); true`);
    const picture = await waitFor(`(() => { const i = document.querySelector(".md-view img"); return i?.complete && i.naturalWidth > 0 ? { w: i.naturalWidth, src: i.getAttribute("src") } : null; })()`, 10000);
    const lit = await waitFor(`!!document.querySelector(".md-view pre.shiki")`, 8000);
    const rendered = await b.eval(`({ changed: [...document.querySelectorAll(".md-view .md-changed")].map(e => e.tagName.toLowerCase() + ":" + e.dataset.start), removed: document.querySelector(".md-view .md-removed")?.textContent, removedAt: document.querySelector(".md-view .md-removed")?.nextElementSibling?.textContent, remote: document.querySelector(".md-view .md-image-off")?.textContent, outside: document.querySelectorAll('.md-view img[src^="http"]').length, csp: window.__csp })`);
    await b.screenshot(join(OUT, "shots", "ui-check-markdown.png"));
    check(
      "a Markdown file switches to rendered: its picture loads from the repository, a remote one stays a link, code is highlighted, changed blocks are marked, removed lines are counted where they were",
      mdToggle.includes("rendered") && picture?.w === 240 && picture.src.startsWith("/api/raw?") && picture.src.includes("path=res%2Fcard.png") && lit === true &&
        JSON.stringify(rendered.changed) === JSON.stringify(["p:7", "p:9", "p:11", "div:13"]) && rendered.removed === "− 2 lines removed here" && rendered.removedAt === "Usage" &&
        (rendered.remote?.includes("https://example.com/remote.png") ?? false) && rendered.outside === 0 && rendered.csp.length === 0,
      { mdToggle, picture, lit, rendered },
    );
    await b.eval(`document.querySelector('.md-view p[data-start="7"]')?.scrollIntoView({ block: "center" }); true`);
    await sleep(400);
    await click('.md-view p[data-start="7"]');
    const jumped = await waitFor(`(() => { const c = [...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot.textContent.includes("Run it, then open the card")); const rows = c ? [...c.shadowRoot.querySelectorAll('[data-content] > [data-stet-mark~="cursor"]')].map(r => r.getAttribute("data-line-type") + ":" + r.getAttribute("data-line")) : []; return rows.length ? { rows, toggle: document.querySelector(".md-toggle")?.textContent } : null; })()`, 8000);
    check("a click on a rendered block shows the code with the cursor on its line, to comment there", !!jumped && jumped.rows.includes("change-addition:7") && jumped.toggle.includes("rendered"), jumped);

    await b.eval(`location.hash = "#/compare/${imgV - 1}..${imgV}"; true`);
    await waitFor(`[...document.querySelectorAll(".imgdiff img")].length >= 5`, 10000);
    await sleep(800);
    await b.eval(`location.hash = "#/compare/1..${imgV}?file=app/Long.kt"; true`);
    await waitFor(`document.querySelectorAll(".codeview-host diffs-container").length >= 2 && /v1/.test(document.querySelector(".range-title")?.textContent ?? "")`, 10000);
    await sleep(1500);
    const drawn = await b.eval(`(() => { const v = window.__INSTANCE; const s = v.renderState; return { children: v.stickyContainer.children.length, window: s.lastIndex - s.firstIndex + 1, items: v.items.length, kids: [...v.stickyContainer.children].map(c => c.shadowRoot?.querySelector("[data-title]")?.textContent) }; })()`);
    check("after another range, only the files drawn for it stay on the page (a file left from the old range makes the scroll stick and jump)", drawn.children === drawn.window, drawn);

    await b.eval(`location.hash = "#/compare/base..${imgV}"; true`);
    await waitFor(`document.querySelector(".gitchip")`, 8000);
    const chipBefore = await b.eval(`document.querySelector(".gitchip")?.textContent`);
    writeFileSync(join(repo, "app/Long.kt"), readFileSync(join(repo, "app/Long.kt"), "utf8") + "// not staged\n");
    writeFileSync(join(repo, "src/Notes.kt"), "val notes = 1\n");
    const chipAfter = await waitFor(`(() => { const t = document.querySelector(".gitchip")?.textContent ?? ""; return /2 not in review/.test(t) ? t : null; })()`, 8000);
    await b.eval(`[...document.querySelectorAll(".side-tabs button")].find(x => x.textContent.startsWith("Files")).click(); true`);
    const fileMark = await waitFor(`(() => { const row = [...document.querySelectorAll(".file-row")].find(r => r.textContent.includes("Long.kt")); const m = row?.querySelector(".gmark"); return m ? { text: m.textContent, warn: m.classList.contains("gmark-warn") } : null; })()`, 5000);

    check(
      "the header says where the branch is in git (here: on no remote, a staged review) and counts what is outside the review; a changed file is marked in Files",
      /not pushed/.test(chipBefore ?? "") && !!chipAfter && fileMark?.text === "partly staged" && fileMark.warn,
      { chipBefore, chipAfter, fileMark },
    );

    await click(".gitchip");
    const panel = await waitFor(`(() => { const p = document.querySelector(".git-panel"); return p ? [...p.querySelectorAll("h4")].map(h => h.textContent) : null; })()`, 3000);
    await b.screenshot(join(OUT, "shots", "ui-check-git-panel.png"));
    await keys("\uE00C");
    const panelClosed = await waitFor(`!document.querySelector(".git-panel")`, 2000);
    check("a click on it lists the files by state, and says which are not in the review; Esc closes it", !!panel?.some((h: string) => h.startsWith("Not staged: not in this review")) && !!panel?.some((h: string) => h.startsWith("New, not in git")) && !!panelClosed, { panel, panelClosed });

    run(repo, ["git", "add", "src/Notes.kt"]);
    const moved = await waitFor(`document.querySelector("header .refresh.moved")?.textContent`, 8000);
    const hashBefore = await b.eval("location.hash");
    await keys("R");
    const settled = await waitFor(`!document.querySelector("header .refresh.moved")`, 8000);
    check("when the agent edits “now” without a version, the header says so (↻ N files changed) and R re-reads it", /1 file changed/.test(moved ?? "") && !!settled && (await b.eval("location.hash")) === hashBefore, { moved, settled });

    server.kill("SIGTERM");
    await server.exited;
    const offline = await waitFor(`document.querySelector("header .offline")?.textContent`, 10000);
    server = serve();
    const reconnected = await waitFor(`!document.querySelector("header .offline") && document.querySelector(".gitchip")`, 20000);
    check("when the server goes away the header says so, and the page picks it up again when it comes back on its port", /offline/.test(offline ?? "") && !!reconnected, { offline, reconnected });

  } catch (e) {
    check("script ran to the end", false, (e as Error).message);
    await b.screenshot(join(OUT, "shots", "ui-check-error.png")).catch(() => null);
  } finally {
    await b.close();
  }
} finally {
  firefox.kill();
  server.kill();
  rmSync(repo, { recursive: true, force: true });
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
}
process.exit(failed ? 1 : 0);
