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
// lets the page read the clipboard without a paste prompt, to check what "Copy link" put there
writeFileSync(join(OUT, "ui-prof", "user.js"), `user_pref("dom.events.testing.asyncClipboard", true);\n`);
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

    await keys("S");
    await waitFor(`location.hash === "#/drafts" && document.querySelector(".drafts .submit-actions")`, 3000);
    const actions = await b.eval(`[...document.querySelectorAll(".drafts .submit-actions button")].map(x => [x.textContent, x.disabled])`);
    await keys("S");
    const asked = await waitFor(`document.querySelector(".choice h3")?.textContent ?? null`, 3000);
    await sleep(200);
    const offered = await b.eval(`({ options: [...document.querySelectorAll(".choice button")].map(x => x.textContent), focused: document.activeElement?.textContent ?? null })`);
    await b.screenshot(join(OUT, "shots", "ui-check-approve.png"));
    await keys("");
    const cancelled = await waitFor(`!document.querySelector(".choice") && !document.querySelector("header .verdict")`, 2000);
    await keys("S");
    await waitFor(`document.querySelector(".choice")`, 3000);
    await sleep(200);
    await keys("");
    const approved = await waitFor(`document.querySelector("header .verdict")?.textContent ?? null`, 5000);
    const approvedAt = await b.eval(`({ hash: location.hash, toast: document.querySelector(".toast")?.textContent ?? null })`);
    await b.screenshot(join(OUT, "shots", "ui-check-approved.png"));
    check(
      "with no drafts, S on the drafts page approves: open threads ask first (Esc cancels), Enter on “Approve anyway” approves, the header says so",
      actions[0]?.[1] === true && /Approve v2/.test(actions[1]?.[0] ?? "") && /threads still open/.test(asked ?? "") && offered.focused === "Approve anyway" &&
        offered.options.join("|") === "Approve anyway|Resolve all and approve|Cancel" && cancelled === true && approved === "✓ approved at v2" &&
        approvedAt.hash === "#/compare/1..2" && /^approved v2/.test(approvedAt.toast ?? ""),
      { actions, asked, offered, cancelled, approved, approvedAt },
    );

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

    const zbigItem = `[...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot.textContent.includes("HUNDRED_V2"))`;
    const rowsMarked = (tag: string, side: string) => `[...(${zbigItem}?.shadowRoot.querySelectorAll('code[data-${side}] [data-content] > [data-stet-mark~="${tag}"]') ?? [])].map(r => +r.getAttribute("data-line"))`;
    const lineTop = (n: number) => `Math.round([...${zbigItem}.shadowRoot.querySelectorAll('code[data-additions] [data-content] > [data-line="${n}"]')][0].getBoundingClientRect().top - document.querySelector(".codeview-host").getBoundingClientRect().top)`;
    await b.eval(`location.hash = "#/compare/base..2?file=src%2FZbig.kt&line=8-12"; true`);
    await waitFor(`${rowsMarked("linked", "additions")}.join() === "8,9,10,11,12"`, 10000);
    await sleep(1600);
    const linkedRange = await b.eval(`({ linked: ${rowsMarked("linked", "additions")}, cursor: ${rowsMarked("cursor", "additions")}, first: ${lineTop(8)}, last: ${lineTop(12)}, height: document.querySelector(".codeview-host").clientHeight })`);
    await keys("j");
    await sleep(200);
    const inside = await b.eval(`${rowsMarked("linked", "additions")}.length`);
    await keys("5", "j");
    await sleep(300);
    const left = await b.eval(`${rowsMarked("linked", "additions")}.length`);
    await b.eval(`location.hash = "#/compare/base..2?file=src%2FZbig.kt&line=9-10&side=old"; true`);
    const oldSide = await waitFor(`(() => { const o = ${rowsMarked("linked", "deletions")}; return o.length ? { old: o, new: ${rowsMarked("linked", "additions")} } : null; })()`, 8000);
    check(
      "a link to a range of lines scrolls it into view from near the top and highlights it, the cursor on its first line; the highlight stays while the cursor is on those lines and goes when it leaves; side=old marks the old side",
      JSON.stringify(linkedRange.cursor) === "[8]" && linkedRange.first > 20 && linkedRange.first < 160 && linkedRange.last < linkedRange.height && inside === 5 && left === 0 && JSON.stringify(oldSide) === JSON.stringify({ old: [9, 10], new: [] }),
      { linkedRange, inside, left, oldSide },
    );

    const clipboard = () => b.eval(`navigator.clipboard.readText().catch(e => "error: " + e)`) as Promise<string>;
    const origin = url.split("#")[0];
    await b.eval(`location.hash = "#/compare/base..2?file=src%2FZbig.kt&line=98"; true`);
    await waitFor(`${rowsMarked("cursor", "additions")}.join() === "98"`, 8000);
    await sleep(500);
    await keys("V", "j", " ", "g", "Y");
    await sleep(400);
    const byKey = { copied: await clipboard(), toast: await b.eval(`document.querySelector(".toast")?.textContent ?? null`), visual: await b.eval(`${rowsMarked("visual", "additions")}.length`) };
    const g99 = await b.eval(`(() => { const r = [...${zbigItem}.shadowRoot.querySelectorAll("[data-column-number='99']")].pop().getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const g101 = await b.eval(`(() => { const r = [...${zbigItem}.shadowRoot.querySelectorAll("[data-column-number='101']")].pop().getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    await pointer([{ type: "pointerMove", x: g99.x, y: g99.y }, { type: "pointerDown", button: 0 }, { type: "pointerMove", x: g101.x, y: g101.y, duration: 100 }, { type: "pointerUp", button: 0 }]);
    await waitFor(`document.querySelector(".codeview-host .new-thread .copy-link")`, 3000);
    await click(".codeview-host .new-thread .copy-link");
    await sleep(400);
    const byButton = await clipboard();
    await b.screenshot(join(OUT, "shots", "ui-check-copy-link.png"));
    await cancel();
    check(
      "Space g Y copies a link to the selected lines and leaves visual mode; Copy link on the comment box of selected lines copies theirs; the link has the review and no token",
      byKey.copied === `${origin}#/compare/base..2?file=src%2FZbig.kt&line=98-99&review=1` && (byKey.toast?.includes("copied a link to src/Zbig.kt:98–99") ?? false) && byKey.visual === 0 &&
        byButton === `${origin}#/compare/base..2?file=src%2FZbig.kt&line=99-101&review=1`,
      { byKey, byButton, origin },
    );

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
    const stale = await waitFor(`document.querySelector("header a.verdict.changed")?.textContent ?? null`, 5000);
    check("once a newer version is handed over, the header says the approval is of an older one", stale === "✓ approved at v2 · changed after", stale);
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

    const edges = (sel: string) => `(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.right)] : null; })()`;
    const threadCols = () => b.eval(`({ side: ${edges("aside")}, code: ${edges(".thread-code")}, msgs: ${edges(".thread-msgs")}, swapped: !!document.querySelector(".detail.msgs-left") })`) as Promise<{ side: [number, number]; code: [number, number]; msgs: [number, number]; swapped: boolean }>;
    const msgsW = async () => (await threadCols()).msgs.reduce((l, r) => r - l);
    const msgs0 = await msgsW();
    const msgsGrip = await rect(".msgs-splitter");
    if (msgsGrip) await pointer([{ type: "pointerMove", x: msgsGrip.x, y: msgsGrip.y }, { type: "pointerDown", button: 0 }, { type: "pointerMove", x: msgsGrip.x - 80, y: msgsGrip.y, duration: 150 }, { type: "pointerUp", button: 0 }]);
    await sleep(300);
    const msgs1 = await msgsW();
    await click(".msgs-splitter .splitter-swap");
    await sleep(400);
    const msgsLeft = await threadCols();
    await b.screenshot(join(OUT, "shots", "ui-check-msgs-left.png"));
    check(
      "the button on the messages border puts the conversation left of the code, next to the threads, and it keeps its width",
      msgsLeft.swapped && msgsLeft.side[1] <= msgsLeft.msgs[0] && msgsLeft.msgs[1] <= msgsLeft.code[0] && Math.abs(msgs1 - msgs0 - 80) <= 4 && Math.abs(msgsLeft.msgs[1] - msgsLeft.msgs[0] - msgs1) <= 2,
      { msgs0, msgs1, msgsLeft },
    );
    const leftGrip = await rect(".msgs-splitter");
    if (leftGrip) await pointer([{ type: "pointerMove", x: leftGrip.x, y: leftGrip.y + 40 }, { type: "pointerDown", button: 0 }, { type: "pointerMove", x: leftGrip.x + 50, y: leftGrip.y + 40, duration: 150 }, { type: "pointerUp", button: 0 }]);
    await sleep(300);
    const msgs2 = await msgsW();
    await b.eval(`document.activeElement?.blur(); true`);
    await keys("r");
    await sleep(400);
    const replyLeft = await b.eval(`document.activeElement?.tagName === "TEXTAREA" && !!document.activeElement.closest(".thread-msgs")`);
    await keys("\uE00C");
    await b.eval(`document.activeElement?.blur(); true`);
    const stepNow = `document.querySelector(".timeline .step.selected .step-label")?.textContent ?? null`;
    const step0 = await b.eval(stepNow);
    await keys("[");
    await sleep(300);
    const stepLeft = [step0, await b.eval(stepNow)];
    await b.navigate(url.replace("#", `#/thread/${t100}&`));
    await b.eval(`location.hash = "#/thread/${t100}"; true`);
    await waitFor(`document.querySelector(".detail-head .tid")?.textContent === "#${t100}" && document.querySelector(".thread-code .code-area")`, 8000);
    await sleep(800);
    const msgsReloaded = await threadCols();
    await b.eval(`document.activeElement?.blur(); true`);
    await keys(" ", "u", "L");
    await sleep(400);
    const msgsReset = await threadCols();
    const swapStore = await b.eval(`[localStorage.getItem("stet.swap.thread"), localStorage.getItem("stet.w.msgs")]`);
    check(
      "with the conversation on the left, dragging its border right widens it, r replies in it, the timeline keys work, a reload keeps it; Space u L puts it back on the right at its default width",
      Math.abs(msgs2 - msgs1 - 50) <= 4 && replyLeft === true && !!stepLeft[0] && !!stepLeft[1] && stepLeft[0] !== stepLeft[1] && msgsReloaded.swapped && msgsReloaded.msgs[1] <= msgsReloaded.code[0] && Math.abs(msgsReloaded.msgs[1] - msgsReloaded.msgs[0] - msgs2) <= 2 &&
        !msgsReset.swapped && msgsReset.msgs[0] >= msgsReset.code[1] && Math.abs(msgsReset.msgs[1] - msgsReset.msgs[0] - msgs0) <= 2 && JSON.stringify(swapStore) === "[null,null]",
      { msgs2, replyLeft, stepLeft, msgsReloaded, msgsReset, swapStore },
    );
    await keys(" ", "u", "l");
    await sleep(300);
    await keys("j");
    await waitFor(`location.hash !== "#/thread/${t100}" && document.querySelector(".thread-code .code-area")`, 8000);
    await sleep(500);
    const nextLeft = await threadCols();
    await keys(" ", "u", "l");
    await sleep(300);
    const backRight = await threadCols();
    check(
      "Space u l moves the conversation left and back; j opens the next thread with the conversation still on the left",
      nextLeft.swapped && nextLeft.msgs[1] <= nextLeft.code[0] && !backRight.swapped && backRight.msgs[0] >= backRight.code[1],
      { nextLeft, backRight },
    );

    await b.eval(`location.hash = "#/compare/1..2"; true`);
    await waitFor(`[...document.querySelectorAll(".codeview-host diffs-container")].some(c => c.shadowRoot.textContent.includes("HUNDRED_V2"))`, 8000);
    await sleep(500);
    const compareCols = () => b.eval(`({ side: ${edges("aside")}, pane: ${edges(".pane")}, swapped: !!document.querySelector("main.side-right") })`) as Promise<{ side: [number, number]; pane: [number, number]; swapped: boolean }>;
    const sideGrip = await rect(".side-splitter");
    if (sideGrip) await pointer([{ type: "pointerMove", x: sideGrip.x, y: sideGrip.y }, { type: "pointerDown", button: 0 }, { type: "pointerMove", x: sideGrip.x + 60, y: sideGrip.y, duration: 150 }, { type: "pointerUp", button: 0 }]);
    await sleep(300);
    const sideBefore = await compareCols();
    await b.eval(`document.activeElement?.blur(); true`);
    await keys(" ", "u", "l");
    await sleep(400);
    const sideRight = await compareCols();
    await b.screenshot(join(OUT, "shots", "ui-check-side-right.png"));
    const cursorRows = `[...document.querySelectorAll(".codeview-host diffs-container")].flatMap(c => [...c.shadowRoot.querySelectorAll('[data-content] > [data-stet-mark~="cursor"]')].map(r => r.getAttribute("data-line-type") + ":" + r.getAttribute("data-line")))`;
    await keys("z", "R", "g", "g");
    await sleep(500);
    const cur0 = await b.eval(cursorRows);
    await keys("j");
    await sleep(300);
    const cur1 = await b.eval(cursorRows);
    await keys(" ", "e");
    await sleep(300);
    await b.eval(`[...document.querySelectorAll(".file-row")].find(r => r.querySelector(".file-name")?.textContent === "Zbig.kt")?.querySelector(".file-link").click(); true`);
    await sleep(800);
    const onZbig = await b.eval(`[...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot.textContent.includes("HUNDRED_V2"))?.shadowRoot.querySelector('[data-content] > [data-stet-mark~="cursor"]') ? true : false`);
    const rightGrip = await rect(".side-splitter");
    if (rightGrip) await pointer([{ type: "pointerMove", x: rightGrip.x, y: rightGrip.y + 40 }, { type: "pointerDown", button: 0 }, { type: "pointerMove", x: rightGrip.x - 40, y: rightGrip.y + 40, duration: 150 }, { type: "pointerUp", button: 0 }]);
    await sleep(300);
    const sideWide = await compareCols();
    check(
      "Space u l puts the side panel right of the diff with its width; the cursor keys, the Files tab and a click on a file still work, and dragging its border left widens it",
      sideRight.swapped && sideRight.pane[1] <= sideRight.side[0] && sideRight.side[1] - sideRight.side[0] === sideBefore.side[1] - sideBefore.side[0] && cur0.length > 0 && cur1.length > 0 && JSON.stringify(cur0) !== JSON.stringify(cur1) && onZbig &&
        Math.abs(sideWide.side[1] - sideWide.side[0] - (sideRight.side[1] - sideRight.side[0]) - 40) <= 4,
      { sideBefore, sideRight, cur0, cur1, onZbig, sideWide },
    );
    await b.navigate(url.replace("#", "#/compare/1..2&"));
    await b.eval(`location.hash = "#/compare/1..2"; true`);
    await waitFor(`document.querySelector(".codeview-host diffs-container")`, 8000);
    await sleep(500);
    const sideKept = await compareCols();
    await b.viewport(700, 900);
    await sleep(400);
    const sidePhone = await compareCols();
    await b.viewport(1920, 1000);
    await sleep(300);
    await b.eval(`document.activeElement?.blur(); true`);
    await keys(" ", "u", "L");
    await sleep(400);
    const sideReset = await compareCols();
    check(
      "a reload keeps the side panel on the right; a narrow window stacks it above the diff as before; Space u L puts it back on the left at its default width",
      sideKept.swapped && sideKept.pane[1] <= sideKept.side[0] && sideKept.side[1] - sideKept.side[0] === sideWide.side[1] - sideWide.side[0] &&
        sidePhone.side[0] === sidePhone.pane[0] && !sideReset.swapped && sideReset.side[0] === 0 && sideReset.side[1] === aside0,
      { sideKept, sidePhone, sideReset, aside0 },
    );

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
    await b.eval(`document.activeElement?.blur(); true`);
    await keys("g", "g");
    await sleep(200);
    await keys("j", "j", "j");
    await sleep(300);
    const svgStop = await b.eval(`document.querySelector(".file-toggle.at-cursor")?.closest("diffs-container")?.shadowRoot?.querySelector("[data-title]")?.textContent ?? "none"`);
    check("an SVG shown as a picture is one stop for the cursor, like an image: j does not walk its hidden code", svgStop === "res/logo.svg", svgStop);
    await keys("g", "g");
    await sleep(500);

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

    writeFileSync(join(repo, "docs/guide.md"), ["# Guide", "", "Intro.", "", "Old paragraph that goes away.", "", "## Usage", "", "Run it.", "", "![the card](../res/card.png)", ""].join("\n"));
    run(repo, ["git", "add", "-A"]);
    const mdFrom = JSON.parse(run(repo, ["bun", CLI, "version", "create", "--label", "guide", "--json"])).version.snapshot as string;
    writeFileSync(
      join(repo, "docs/guide.md"),
      ["# Guide", "", "Intro.", "", "## Usage", "", "Run it, then open the card:", "", "![the card](../res/card.png)", "", "![remote](https://example.com/remote.png)", "", "```ts", 'const card: string = "red";', "```", ""].join("\n"),
    );
    writeFileSync(join(repo, "res/card.png"), pngCard(240, 160, { bar: { y: 0, h: 30, color: [120, 40, 160, 255] } }));
    writeFileSync(join(repo, "docs/added.md"), "# Added\n\nA new page.\n");
    rmSync(join(repo, "docs/notes.md"));
    run(repo, ["git", "add", "-A"]);
    const mdTo = JSON.parse(run(repo, ["bun", CLI, "version", "create", "--label", "guide with a picture", "--json"])).version.snapshot as string;
    const mdV = JSON.parse(run(repo, ["bun", CLI, "status", "--json"])).versions as number;
    await b.eval(`location.hash = "#/compare/${mdV - 1}..${mdV}"; true`);
    await waitFor(`document.querySelectorAll(".md-toggle").length === 3`, 10000);
    const toggleOf = (path: string) => `[...document.querySelectorAll(".md-toggle")].find(t => t.closest("diffs-container")?.shadowRoot?.querySelector("[data-title]")?.textContent === ${JSON.stringify(path)})`;
    const clickIn = async (sel: string) => {
      for (let i = 0; i < 6; i++) {
        await b.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: "center" }); true`);
        await sleep(350);
        const r = await rect(sel);
        if (r && r.y > 60 && r.y < 860) return click(sel);
      }
      return false;
    };
    const md = `document.querySelector('.md-view[data-file="docs/guide.md"]')`;
    const brokenBefore = await b.eval(`[...document.querySelectorAll(".codeview-host diffs-container")].filter(c => c.shadowRoot?.textContent.includes("VirtualizedFile")).map(c => c.shadowRoot.querySelector("[data-title]")?.textContent ?? "?")`);
    const pictures = await waitFor(`(() => { const i = [...${md}?.querySelectorAll("img") ?? []]; return i.length === 2 && i.every(x => x.complete && x.naturalWidth > 0) ? i.map(x => ({ side: x.closest(".md-cell").dataset.side, w: x.naturalWidth, src: x.getAttribute("src") })) : null; })()`, 10000);
    const mdToggle = await b.eval(`${toggleOf("docs/guide.md")}?.textContent`);
    const lit = await waitFor(`!!${md}.querySelector("pre.shiki")`, 8000);
    await sleep(500);
    const topOf = (sel: string) => `Math.round(${md}.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect().top ?? -1)`;
    const rendered = await b.eval(`({
      changed: ["old", "new"].map(s => [...${md}.querySelectorAll('.md-cell[data-side="' + s + '"] .md-changed')].map(e => e.tagName.toLowerCase() + ":" + e.dataset.start)),
      level: [${topOf('.md-cell[data-side="old"] h2')}, ${topOf('.md-cell[data-side="new"] h2')}, ${topOf('.md-cell[data-side="old"] p[data-start="11"]')}, ${topOf('.md-cell[data-side="new"] p[data-start="9"]')}],
      facing: [...${md}.querySelector('.md-cell[data-side="old"] p[data-start="5"]').closest(".md-cell").nextElementSibling.classList].join(" "),
      words: { del: [...${md}.querySelectorAll('.md-cell[data-side="old"] p[data-start="9"] del')].map(e => e.textContent), ins: [...${md}.querySelectorAll('.md-cell[data-side="new"] p[data-start="7"] ins')].map(e => e.textContent) },
      remote: ${md}.querySelector(".md-image-off")?.textContent, outside: ${md}.querySelectorAll('img[src^="http"]').length, broken: [...document.querySelectorAll(".codeview-host diffs-container")].filter(c => c.shadowRoot?.textContent.includes("VirtualizedFile")).map(c => c.shadowRoot.querySelector("[data-title]")?.textContent ?? "?"), csp: window.__csp })`);
    await b.screenshot(join(OUT, "shots", "ui-check-markdown.png"));
    check(
      "a Markdown file opens rendered, old and new side by side: unchanged blocks level, what was removed red on the old side, what was added green on the new, the changed words marked, each side's picture from its own version",
      mdToggle.includes("code") && lit === true && pictures?.length === 2 && pictures.every((p: { w: number }) => p.w === 240) &&
        pictures.some((p: { side: string; src: string }) => p.side === "old" && p.src.includes(`sha=${mdFrom}`)) && pictures.some((p: { side: string; src: string }) => p.side === "new" && p.src.includes(`sha=${mdTo}`)) &&
        JSON.stringify(rendered.changed) === JSON.stringify([["p:5", "p:9"], ["p:7", "p:11", "div:13"]]) && rendered.level[0] === rendered.level[1] && rendered.level[2] === rendered.level[3] && rendered.level[0] > 0 &&
        JSON.stringify(rendered.words) === JSON.stringify({ del: ["."], ins: [", then open the card:"] }) &&
        rendered.facing.includes("md-empty") && rendered.broken.length + brokenBefore.length === 0 && (rendered.remote?.includes("https://example.com/remote.png") ?? false) && rendered.outside === 0 && rendered.csp.length === 0,
      { brokenBefore, mdToggle, pictures, mdFrom, mdTo, lit, rendered },
    );

    const oneSide = await waitFor(`(() => { const a = document.querySelector('.md-view[data-file="docs/added.md"]'); const d = document.querySelector('.md-view[data-file="docs/notes.md"]'); return a && d ? { added: [...a.querySelectorAll(".md-cell")].map(c => c.dataset.side), deleted: [...d.querySelectorAll(".md-cell")].map(c => c.dataset.side) } : null; })()`, 8000);
    check("an added Markdown file renders its new side only, a deleted one its old side", JSON.stringify(oneSide) === JSON.stringify({ added: ["new", "new"], deleted: ["old"] }), oneSide);

    await b.eval(`[...document.querySelectorAll(".compare-head .btn")].find(x => x.textContent === "unified").click(); true`);
    const unified = await waitFor(`(() => { const v = document.querySelector('.md-view.md-one[data-file="docs/guide.md"]'); return v ? { cells: [...v.querySelectorAll(".md-cell")].map(c => c.dataset.side + ":" + c.firstElementChild?.tagName.toLowerCase() + (c.firstElementChild?.dataset.start ?? "")), inline: v.querySelector('p[data-start="7"]')?.innerHTML } : null; })()`, 8000);
    check(
      "in unified view one column: unchanged blocks once, a block with a few words changed once with them struck through and inserted, a removed block in its place",
      JSON.stringify(unified?.cells) === JSON.stringify(["new:h11", "new:p3", "old:p5", "new:h25", "new:p7", "new:p9", "new:p11", "new:div13"]) && unified.inline === "Run it<del>.</del><ins>, then open the card:</ins>",
      unified,
    );
    await b.eval(`[...document.querySelectorAll(".compare-head .btn")].find(x => x.textContent === "split").click(); true`);
    await waitFor(`${md}?.classList.contains("md-split") && ${md}.querySelector("pre.shiki")`, 8000);
    await sleep(500);

    await b.eval(`${md}.querySelector('.md-cell[data-side="new"] p[data-start="7"]').scrollIntoView({ block: "center" }); true`);
    await sleep(400);
    await clickIn(`.md-view[data-file="docs/guide.md"] .md-cell[data-side="new"] p[data-start="7"]`);
    const clicked = await waitFor(`(() => { const c = [...document.querySelectorAll(".md-view .md-cursor")].map(e => e.closest(".md-cell").dataset.side + ":" + e.dataset.start); return c.length ? c : null; })()`, 3000);
    const hoverAt = await rect(`.md-view[data-file="docs/guide.md"] .md-cell[data-side="new"] p[data-start="7"]`);
    await pointer([{ type: "pointerMove", x: hoverAt!.x, y: hoverAt!.y }]);
    await waitFor(`document.querySelector(".md-gutter .md-plus")`, 3000);
    await click(".md-gutter .md-plus");
    const box = await waitFor(`(() => { const n = document.querySelector(".md-view .new-thread .note"); return n && document.activeElement?.tagName === "TEXTAREA" ? { note: n.textContent, after: n.closest(".md-threads").previousElementSibling?.dataset.start } : null; })()`, 3000);
    await keys(..."why a colon?");
    await b.eval(`[...document.querySelectorAll(".md-view .new-thread button")].find(x => x.textContent.includes("Save draft")).click(); true`);
    const mdCard = await waitFor(`(() => { const c = document.querySelector('.md-view .md-cell[data-side="new"] p[data-start="7"]'); const m = c?.nextElementSibling?.querySelector(".thread-mini"); return m && c.classList.contains("md-thread") ? m.dataset.thread : null; })()`, 8000);
    const blockThread = mdCard ? JSON.parse(run(repo, ["bun", CLI, "thread", "show", String(mdCard), "--as", "reviewer", "--json"])).thread : null;
    check(
      "a click on a rendered block puts the cursor on it; its + starts a thread on the block's lines, shown on the block like a thread on lines",
      JSON.stringify(clicked) === JSON.stringify(["new:7"]) && (box?.note.includes("lines 7") ?? false) && box?.after === "7" && blockThread?.range.start === 7 && blockThread.range.end === 7 && blockThread.side === "new",
      { clicked, box, mdCard, range: blockThread?.range, side: blockThread?.side },
    );

    const stops = () => b.eval(`[...document.querySelectorAll(".md-view .md-cursor")].map(e => e.closest(".md-cell").dataset.side + ":" + e.dataset.start)`) as Promise<string[]>;
    await b.eval(`document.activeElement?.blur(); true`);
    await b.eval(`${md}.querySelector('.md-cell[data-side="new"] h1').scrollIntoView({ block: "center" }); true`);
    await sleep(400);
    await clickIn(`.md-view[data-file="docs/guide.md"] .md-cell[data-side="new"] h1`);
    await sleep(200);
    await keys("j");
    await sleep(200);
    const afterJ = await stops();
    await keys("j");
    await sleep(200);
    const afterJJ = await stops();
    await keys("]", "c");
    await sleep(300);
    const nextChange = await stops();
    await keys("]", "c");
    await sleep(300);
    const nextChange2 = await stops();
    await keys("[", "c");
    await sleep(300);
    const prevChange = await stops();
    for (let i = 0; i < 6; i++) {
      await keys("]", "t");
      await sleep(400);
      if (await b.eval(`!!document.querySelector('.md-view .thread-mini.focused[data-thread="${mdCard}"]')`)) break;
    }
    const onThread = await stops();
    await keys("");
    const mdOpened = await waitFor(`location.hash === "#/thread/${mdCard}" ? location.hash : null`, 5000);
    check(
      "in the rendered view j/k step over the blocks and ]c/[c over the changed ones, both sides in reading order; ]t goes to the block of a thread, Enter opens it",
      JSON.stringify([afterJ, afterJJ, nextChange, nextChange2, prevChange, onThread]) === JSON.stringify([["old:3", "new:3"], ["old:5"], ["old:9"], ["new:11"], ["old:9"], ["new:7"]]) && !!mdOpened,
      { afterJ, afterJJ, nextChange, nextChange2, prevChange, onThread, mdOpened },
    );

    await b.eval(`location.hash = "#/compare/${mdV - 1}..${mdV}"; true`);
    await waitFor(`${md}?.querySelector("[data-stop]")`, 8000);
    await sleep(500);
    await b.eval(`${md}.querySelector('.md-cell[data-side="old"] p[data-start="5"]').scrollIntoView({ block: "center" }); true`);
    await sleep(400);
    await clickIn(`.md-view[data-file="docs/guide.md"] .md-cell[data-side="old"] p[data-start="5"]`);
    await keys("i");
    const oldBox = await waitFor(`document.querySelector(".md-view .new-thread .note")?.textContent ?? null`, 3000);
    await keys("");
    await sleep(150);
    await keys("");
    const mdClosed = await waitFor(`!document.querySelector(".md-view .new-thread")`, 3000);
    const before7 = await b.eval(`Math.round(${md}.querySelector('.md-cell[data-side="new"] p[data-start="7"]').getBoundingClientRect().top)`);
    const jumpAt = await rect(`.md-view[data-file="docs/guide.md"] .md-cell[data-side="new"] p[data-start="7"]`);
    await pointer([{ type: "pointerMove", x: jumpAt!.x, y: jumpAt!.y }]);
    await waitFor(`document.querySelector(".md-gutter .md-jump")`, 3000);
    await click(".md-gutter .md-jump");
    const jumped = await waitFor(`(() => { const c = [...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot.textContent.includes("Run it, then open the card")); const rows = c ? [...c.shadowRoot.querySelectorAll('[data-content] > [data-stet-mark~="cursor"]')] : []; return rows.length ? { rows: rows.map(r => r.getAttribute("data-line-type") + ":" + r.getAttribute("data-line")), top: Math.round(rows.find(r => r.getAttribute("data-line") === "7")?.getBoundingClientRect().top ?? -1), toggle: ${toggleOf("docs/guide.md")}?.textContent } : null; })()`, 8000);
    await sleep(600);
    const jumpSettled = await b.eval(`(() => { const c = [...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot.textContent.includes("Run it, then open the card")); const r = [...c.shadowRoot.querySelectorAll('[data-content] > [data-stet-mark~="cursor"]')].find(r => r.getAttribute("data-line") === "7"); return r ? Math.round(r.getBoundingClientRect().top) : null; })()`);
    check(
      "i comments on the block under the cursor, on its side (a removed block: the old lines); its ‹/› shows the block's lines in the code where the block was, with the cursor on them",
      (oldBox?.includes("removed lines") ?? false) && (oldBox?.includes("lines 5") ?? false) && !!mdClosed && !!jumped && jumped.rows.includes("change-addition:7") && jumped.toggle.includes("rendered") && Math.abs(jumpSettled - before7) <= 3,
      { oldBox, mdClosed, jumped, before7, jumpSettled },
    );

    await b.eval(`document.activeElement?.blur(); ${toggleOf("docs/guide.md")}.click(); true`);
    await waitFor(`${md}?.querySelector("[data-stop]")`, 8000);
    const findIn = async (q: string) => {
      await b.eval(`document.activeElement?.blur(); true`);
      await keys("/");
      await waitFor(`document.activeElement?.tagName === "INPUT"`, 3000);
      await b.eval(`(() => { const i = document.activeElement; i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await sleep(700);
      await b.eval(`document.activeElement?.blur(); true`);
      await keys("n");
      await sleep(1200);
      return b.eval(`({ cursor: [...document.querySelectorAll(".md-view .md-cursor")].map(e => e.closest(".md-view").dataset.file + ":" + e.closest(".md-cell").dataset.side + ":" + e.dataset.start), current: [...(CSS.highlights.get("stet-hit-current") ?? [])].map(r => r.toString() + (r.startContainer.parentElement?.closest(".md-view") ? "@rendered" : "@code")), rendered: !!${md}, toast: document.querySelector(".toast")?.textContent ?? null })`);
    };
    const inText = await findIn("open the card");
    const inSource = await findIn("card.png");
    check(
      "search finds a match in the rendered text: it is highlighted there and the cursor goes to its block; a match only in the Markdown source (a picture's path) shows that file as code and says so",
      JSON.stringify(inText.cursor) === JSON.stringify(["docs/guide.md:new:7"]) && inText.current.includes("open the card@rendered") && inText.rendered &&
        !inSource.rendered && inSource.current.some((c: string) => c === "card.png@code") && (inSource.toast?.includes("Markdown source") ?? false),
      { inText, inSource },
    );

    run(repo, ["bun", CLI, "config", "set", "compare.markdown", "code"]);
    await b.navigate("about:blank");
    await b.navigate(url);
    await b.eval(`location.hash = "#/compare/${mdV - 1}..${mdV}"; true`);
    await waitFor(`document.querySelectorAll(".md-toggle").length === 3`, 10000);
    await sleep(800);
    const asCode = await b.eval(`({ views: document.querySelectorAll(".md-view").length, toggle: ${toggleOf("docs/guide.md")}?.textContent })`);
    run(repo, ["bun", CLI, "config", "set", "compare.markdown", "--unset"]);
    await b.navigate("about:blank");
    await b.navigate(url);
    await b.eval(csp);
    await b.eval(`location.hash = "#/compare/${mdV - 1}..${mdV}"; true`);
    const asRendered = await waitFor(`document.querySelectorAll(".md-view").length === 3 ? ${toggleOf("docs/guide.md")}?.textContent : null`, 10000);
    check("stet config set compare.markdown code opens Markdown files as code; unset, they open rendered", asCode.views === 0 && (asCode.toggle?.includes("rendered") ?? false) && (asRendered?.includes("code") ?? false), { asCode, asRendered });

    const longMd = (v: number) =>
      Array.from({ length: 40 }, (_, i) => {
        const part = [`## Part ${i + 1}`, "", `Paragraph ${i + 1} of the long page, version ${v}${i % 6 === 2 ? ", with a tail long enough to wrap onto a second line in a narrow column of the split view" : ""}.`, ""];
        if (i === 12) part.push(...Array.from({ length: 12 }, (_, k) => `Tall line ${k + 1} of the tall paragraph${k % 2 ? `, version ${v}` : ""} that goes on`), "");
        if (i === 18) part.push("| Key | Value | Note |", "|---|---|---|", ...Array.from({ length: 10 }, (_, k) => `| key${k + 1} | value ${k % 3 ? v : 1} | note ${k + 1} |`), "");
        return part.join("\n");
      }).join("\n");
    // the real UI reference against an older wording of a few of its paragraphs
    const uiNow = readFileSync(join(ROOT, "docs/ui.md"), "utf8");
    const uiThen = uiNow
      .replace("## Markdown\n\n", "## Markdown\n\nRendered Markdown, in short.\n\n")
      .replace("block facing block", "next to each other")
      .replace("Threads are on lines here too.", "Threads are on lines.")
      .replace(/\nSearch reads the rendered text[^]*?\n\n/, "\n");
    // a README: two small changes far apart, a list and a table in the long unchanged middle
    const readmeMd = (v: number) => {
      const out = ["# Project", "", `Intro paragraph, version ${v === 1 ? "one" : "two"} of the project page.`, ""];
      for (let i = 1; i <= 60; i++) {
        out.push(`## Section ${i}`, "", `Text of section ${i}, the same in every version, long enough to wrap onto a second line in a narrow column of the page.`, "");
        if (i === 20) out.push(...Array.from({ length: 8 }, (_, k) => `- item ${k + 1} of the list in section ${i}`), "");
        if (i === 40) out.push("| Key | Value |", "|---|---|", ...Array.from({ length: 8 }, (_, k) => `| key${k + 1} | value ${k + 1} |`), "");
      }
      out.push("## Last", "", `Closing paragraph, version ${v === 1 ? "one" : "two"}.`, "");
      return out.join("\n");
    };
    const listMd = (v: number) =>
      (v === 1
        ? ["- Cart with items", "- Pay by card", "- Order history", "", "| Setting | Default |", "|---|---|", "| port | 8080 |", "| cache | off |", ""]
        : ["- Cart with items", "- Pay by card or by invoice", "- Order history", "- Promo codes", "", "| Setting | Default |", "|---|---|", "| port | 8080 |", "| cache | 64 MB |", "| theme | dark |", ""]
      ).join("\n");
    writeFileSync(join(repo, "docs/long.md"), longMd(1));
    writeFileSync(join(repo, "docs/list.md"), listMd(1));
    writeFileSync(join(repo, "docs/ui.md"), uiThen);
    writeFileSync(join(repo, "docs/readme.md"), readmeMd(1));
    run(repo, ["git", "add", "-A"]);
    run(repo, ["bun", CLI, "version", "create", "--label", "long page", "--json"]);
    writeFileSync(join(repo, "docs/long.md"), longMd(2));
    writeFileSync(join(repo, "docs/list.md"), listMd(2));
    writeFileSync(join(repo, "docs/ui.md"), uiNow);
    writeFileSync(join(repo, "docs/readme.md"), readmeMd(2));
    run(repo, ["git", "add", "-A"]);
    run(repo, ["bun", CLI, "version", "create", "--label", "long page changed", "--json"]);
    const longV = JSON.parse(run(repo, ["bun", CLI, "status", "--json"])).versions as number;
    const lmd = `document.querySelector('.md-view[data-file="docs/list.md"]')`;
    await b.eval(`location.hash = "#/compare/${longV - 1}..${longV}?file=docs/list.md"; true`);
    await waitFor(`${lmd}?.querySelector("[data-stop]")`, 10000);
    await sleep(1800);
    const lined = await b.eval(`(() => { const top = (s, t) => Math.round([...${lmd}.querySelectorAll('.md-cell[data-side="' + s + '"] li, .md-cell[data-side="' + s + '"] tr')].find(e => e.textContent.trim().startsWith(t))?.getBoundingClientRect().top ?? -1); return {
      items: ["Cart with items", "Pay by card", "Order history"].map(t => top("new", t) > 0 && top("old", t) > 0 ? top("new", t) - top("old", t) : NaN),
      rows: ["port", "cache"].map(t => top("new", t) > 0 && top("old", t) > 0 ? top("new", t) - top("old", t) : NaN),
      gaps: [...${lmd}.querySelectorAll(".md-gap")].map(g => { const facing = [...${lmd}.querySelectorAll('.md-cell[data-side="new"] li, .md-cell[data-side="new"] tr')].find(e => e.textContent.trim().startsWith(g.tagName === "LI" ? "Promo" : "theme")); return g.tagName.toLowerCase() + ":" + Math.round(g.getBoundingClientRect().top - (facing?.getBoundingClientRect().top ?? NaN)) + ":" + g.parentElement.tagName; }),
      words: [...${lmd}.querySelectorAll("del, ins")].map(e => e.tagName.toLowerCase() + ":" + e.textContent) }; })()`);
    check(
      "inside a changed list or table, items and rows face each other: level, the changed words marked, an added one facing an empty slot",
      JSON.stringify(lined.items) === "[0,0,0]" && JSON.stringify(lined.rows) === "[0,0]" && JSON.stringify(lined.gaps) === JSON.stringify(["li:0:UL", "tr:0:TBODY"]) &&
        JSON.stringify(lined.words) === JSON.stringify(["ins:or by invoice", "del:off", "ins:64 MB"]),
      lined,
    );

    const onLine = (line: number, body: string) => JSON.parse(run(repo, ["bun", CLI, "comment", "add", "--file", "docs/list.md", "--range", `${line}-${line}`, "--at", String(longV), "--body", body, "--as", "reviewer", "--json"])).id as number;
    const onRows = [onLine(8, "which port?"), onLine(9, "why 64 MB?"), onLine(2, "invoices how?")];
    // where each card is: what stands before and after its slot, how far below its row, and whether the facing slot is level
    const cardsAt = () =>
      b.eval(`(() => { const v = ${lmd}; if (!v) return null; const ids = ${JSON.stringify(onRows)}; return ids.map(id => {
        const mini = v.querySelector('.md-slot .thread-mini[data-thread="' + id + '"]'); if (!mini) return null;
        const slot = mini.closest(".md-slot"); const cell = slot.closest(".md-cell"); const before = slot.previousElementSibling; const after = slot.nextElementSibling;
        const rows = (e) => e ? [...e.querySelectorAll(":scope > * > tr, :scope > li")].map(r => r.textContent.trim().split(/\\s+/)[0]) : [];
        const last = before?.tagName === "TABLE" ? [...before.querySelectorAll("tr")].pop() : before?.lastElementChild;
        const facing = [...v.querySelectorAll('.md-cell[data-row="' + cell.dataset.row + '"]')].find(c => c !== cell)?.querySelector('.md-slot[data-pair="' + slot.dataset.pair + '"]');
        return { before: rows(before).join("|"), after: rows(after).join("|"), gap: Math.round(mini.getBoundingClientRect().top - last.getBoundingClientRect().bottom), facing: facing ? Math.round(facing.getBoundingClientRect().top - slot.getBoundingClientRect().top) : null };
      }); })()`);
    const inSplit = (await waitFor(`${lmd}?.querySelectorAll(".md-slot .thread-mini").length === 3`, 10000)) ? await cardsAt() : null;
    await b.eval(`[...document.querySelectorAll(".compare-head .btn")].find(x => x.textContent === "unified").click(); true`);
    await sleep(800);
    await b.eval(`[...document.querySelectorAll(".side-tabs button")].find(x => x.textContent.startsWith("Files")).click(); true`);
    await sleep(200);
    await b.eval(`[...document.querySelectorAll(".file-row")].find(r => r.textContent.includes("list.md")).querySelector(".file-link").click(); true`);
    const inUnified = (await waitFor(`document.querySelector('.md-view.md-one[data-file="docs/list.md"]')?.querySelectorAll(".md-slot .thread-mini").length === 3`, 10000)) ? await cardsAt() : null;
    await b.eval(`[...document.querySelectorAll(".compare-head .btn")].find(x => x.textContent === "split").click(); true`);
    await sleep(800);
    const wantRows = (cards: { before: string; after: string; gap: number }[] | null) =>
      !!cards &&
      cards[0]!.before === "Setting|port" && cards[0]!.after === "Setting|cache" &&
      cards[1]!.before === "Setting|cache" && cards[1]!.after === "Setting|theme" &&
      cards[2]!.before === "Cart|Pay" && cards[2]!.after === "Order|Promo" &&
      cards.every((c) => c.gap >= 0 && c.gap <= 16);
    check(
      "a thread on a table row or a list item has its card right under the row: the table goes on below with its header again, the list from the next item; in split view the other side breaks level with it",
      wantRows(inSplit) && inSplit!.every((c: { facing: number | null }) => c.facing !== null && Math.abs(c.facing) <= 2) && wantRows(inUnified),
      { inSplit, inUnified },
    );

    // The first text in view stays where it was when a file switches between rendered and code: in the page, the same
    // rules the switch follows, to know which line or block it should be and where.
    await b.eval(`
      window.__h = () => document.querySelector(".codeview-host");
      window.__band = () => __h().getBoundingClientRect().top + 48;
      window.__md = (f) => document.querySelector('.md-view[data-file="' + f + '"]');
      window.__item = (f) => [...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot?.querySelector("[data-title]")?.textContent === f);
      window.__rtop = (f) => { const band = __band(); const hb = __h().getBoundingClientRect(); let best = null; for (const e of __md(f).querySelectorAll("[data-stop]")) { const r = e.getBoundingClientRect(); if (!r.height || r.bottom <= band || r.top >= hb.bottom) continue; const isNew = e.closest(".md-cell").dataset.side !== "old"; if (!best || r.top < best.r.top - 0.5 || (Math.abs(r.top - best.r.top) <= 0.5 && !best.isNew && isNew)) best = { e, r, isNew }; } if (!best) return null; const start = +best.e.dataset.start, n = +best.e.dataset.end - start + 1; const k = Math.min(n - 1, Math.floor(Math.min(1, Math.max(0, (band - best.r.top) / best.r.height)) * n)); return { side: best.isNew ? "additions" : "deletions", line: start + k, y: best.r.top - hb.top + (k / n) * best.r.height }; };
      window.__row = (f, side, line) => { const c = __item(f); if (!c) return null; let best = null; for (const col of c.shadowRoot.querySelectorAll(side === "additions" ? "code[data-additions]" : "code[data-deletions]")) for (const r of col.querySelectorAll(":scope > [data-content] > [data-line]")) { const n = +r.getAttribute("data-line"); if (!best || Math.abs(n - line) < Math.abs(best.n - line)) best = { r, n }; } return best?.r ?? null; };
      window.__ctop = (f) => { const c = __item(f); const band = __band(); const hb = __h().getBoundingClientRect(); let best = null; for (const col of c.shadowRoot.querySelectorAll("code[data-code]")) { const add = !col.hasAttribute("data-deletions"); for (const r of col.querySelectorAll(":scope > [data-content] > [data-line]")) { const b = r.getBoundingClientRect(); if (!b.height || b.bottom <= band || b.top >= hb.bottom) continue; if (!best || b.top < best.b.top - 0.5 || (Math.abs(b.top - best.b.top) <= 0.5 && !best.add && add)) best = { r, b, add }; } } return best ? { side: best.add ? "additions" : "deletions", line: +best.r.getAttribute("data-line"), y: best.b.top - hb.top } : null; };
      window.__block = (f, side, line) => { const cell = side === "deletions" ? "old" : "new"; let best = null; for (const e of __md(f)?.querySelectorAll('.md-cell[data-side="' + cell + '"] [data-stop]') ?? []) { const s = +e.dataset.start, en = +e.dataset.end; if (s <= line && line <= en && (!best || en - s < best.en - best.s)) best = { e, s, en }; } if (!best) for (const e of __md(f)?.querySelectorAll('.md-cell[data-side="' + cell + '"] [data-stop]') ?? []) if (+e.dataset.start <= line) best = { e, s: +e.dataset.start, en: +e.dataset.end }; return best; };
      window.__share = (f, side, line) => { const b = __block(f, side, line); if (!b) return null; const r = b.e.getBoundingClientRect(); return r.top - __h().getBoundingClientRect().top + Math.min(1, (line - b.s) / (b.en - b.s + 1)) * r.height; };
      window.__cursorAt = (f) => { const e = __md(f)?.querySelector(".md-cursor"); if (e) return "block " + e.dataset.start; const r = __item(f)?.shadowRoot?.querySelector('[data-content] > [data-stet-mark~="cursor"]'); return r ? "line " + r.getAttribute("data-line") : null; };
      true`);
    // every frame for 2 s after the click: the scroll position, where the anchored text is, the copy of the old view
    // laid over the switch (its opacity, -1 when there is none) and the time
    type Frame = [number, number | null, number, number];
    const traced = (file: string, anchor: string) =>
      b.eval(`new Promise(done => {
        const t0 = performance.now();
        const rec = [];
        const f = () => { const y = (() => { ${anchor} })(); const o = document.querySelector(".view-fade"); rec.push([Math.round(__h().scrollTop), y === null || y === undefined ? null : Math.round(y), o ? Math.round(+getComputedStyle(o).opacity * 100) / 100 : -1, Math.round(performance.now() - t0)]); if (performance.now() - t0 < 2000) requestAnimationFrame(f); else done(rec); };
        ${toggleOf(file)}.click();
        requestAnimationFrame(f);
      })`) as Promise<Frame[]>;
    // the copy is there from the first frame, fades for about 200 ms once the new view is placed, and is gone
    const faded = (rec: Frame[]) => {
      const on = rec.filter((r) => r[2] !== -1);
      const start = rec.find((r) => r[2] !== -1 && r[2] < 1)?.[3] ?? null;
      const gone = rec.find((r, i) => i > 0 && r[2] === -1 && rec[i - 1]![2] !== -1)?.[3] ?? null;
      const ok = rec[0]![2] === 1 && start !== null && gone !== null && gone - start >= 150 && gone - start <= 300 && gone <= 700 && on.every((r) => r[3] < gone);
      return { ok, start, gone };
    };
    // after the frame that first shows the text where it was, the page may settle a little, but not shake
    const steady = (rec: Frame[], y: number) => {
      const first = rec.findIndex((r) => r[1] !== null && Math.abs(r[1] - y) <= 4);
      const later = rec.slice(Math.max(first, 0)).flatMap((r, i, a) => (i > 0 && r[0] !== a[i - 1]![0] ? [Math.abs(r[0] - a[i - 1]![0])] : []));
      const end = rec[rec.length - 1]![1];
      return { drift: end === null ? null : Math.round(end - y), ok: first !== -1 && later.length <= 2 && later.every((d) => d <= 16) && end !== null && Math.abs(end - y) <= 4, moves: later.length };
    };
    const places: [string, string, string, number, boolean][] = [
      ["docs/long.md", "the top of a block", "Paragraph 8 ", 0, false],
      ["docs/long.md", "the middle of a tall paragraph", "Tall line 1 ", 0.5, false],
      ["docs/long.md", "a table row", "key5", 0.3, false],
      ["docs/long.md", "the cursor far above", "Paragraph 22 ", 0.05, true],
      ["docs/ui.md", "docs/ui.md: a heading", "Markdown", 0, false],
      ["docs/ui.md", "docs/ui.md: the middle of a paragraph", "In split view the old and the new version", 0.5, false],
      ["docs/ui.md", "docs/ui.md: the cursor far above", "Threads are on lines here too", 0.2, true],
    ];
    const drifts: Record<string, unknown> = {};
    let held = true;
    let fadedAll = true;
    for (const [file, name, text, frac, far] of places) {
      await b.eval(`[...document.querySelectorAll(".side-tabs button")].find(x => x.textContent.startsWith("Files")).click(); true`);
      await sleep(150);
      await b.eval(`[...document.querySelectorAll(".file-row")].find(r => r.querySelector(".file-name")?.textContent === ${JSON.stringify(file.split("/").pop())}).querySelector(".file-link").click(); true`);
      await waitFor(`__md(${JSON.stringify(file)})?.querySelector("[data-stop]")`, 10000);
      await sleep(1200);
      if (far) {
        await b.eval(`(() => { const e = __md(${JSON.stringify(file)}).querySelector('.md-cell[data-side="new"] [data-stop]'); e.scrollIntoView({ block: "center" }); return true; })()`);
        await sleep(300);
        await clickIn(`.md-view[data-file="${file}"] .md-cell[data-side="new"] [data-stop="0"]`);
        await sleep(200);
      }
      const cursorBefore = await b.eval(`__cursorAt(${JSON.stringify(file)})`);
      await b.eval(`(() => { const e = [...__md(${JSON.stringify(file)}).querySelectorAll('.md-cell[data-side="new"] [data-stop]')].find(x => x.textContent.trim().startsWith(${JSON.stringify(text)})); const r = e.getBoundingClientRect(); __h().scrollTop += r.top - __band() + ${frac} * r.height; return true; })()`);
      await sleep(600);
      const a = await b.eval(`__rtop(${JSON.stringify(file)})`);
      const toCodeFrames = await traced(file, `const r = __row(${JSON.stringify(file)}, "${a.side}", ${a.line}); return r ? r.getBoundingClientRect().top - __h().getBoundingClientRect().top : null;`);
      const toCode = { ...steady(toCodeFrames, a.y), fade: faded(toCodeFrames) };
      await sleep(200);
      const cursorCode = await b.eval(`__cursorAt(${JSON.stringify(file)})`);
      const c = await b.eval(`__ctop(${JSON.stringify(file)})`);
      const toRenderedFrames = await traced(file, `return __share(${JSON.stringify(file)}, "${c.side}", ${c.line});`);
      const toRendered = { ...steady(toRenderedFrames, c.y), fade: faded(toRenderedFrames) };
      await sleep(300);
      const cursorAfter = await b.eval(`__cursorAt(${JSON.stringify(file)})`);
      drifts[name] = { toCode, toRendered, ...(far ? { cursor: [cursorBefore, cursorCode, cursorAfter] } : {}) };
      console.log(`drift ${name}: ${JSON.stringify(drifts[name])}`);
      held &&= toCode.ok && toRendered.ok && (!far || (cursorBefore !== null && cursorAfter === cursorBefore && cursorCode !== null));
      fadedAll &&= toCode.fade.ok && toRendered.fade.ok;
    }
    check(
      "switching a long Markdown file between rendered and code keeps the first text in view where it was (a block's top, the middle of a tall paragraph, a table row), without shaking; a cursor far away stays where it is",
      held,
      drifts,
    );
    check(
      "a copy of the old view covers the switch from its first frame and fades out in about 200 ms once the new view is in place, then is gone",
      fadedAll,
      Object.fromEntries(Object.entries(drifts).map(([k, v]) => [k, [(v as { toCode: { fade: unknown } }).toCode.fade, (v as { toRendered: { fade: unknown } }).toRendered.fade]])),
    );
    // input reaches the new view at once and takes the copy away; with reduced motion there is no copy
    const longFile = JSON.stringify("docs/long.md");
    await b.eval(`[...document.querySelectorAll(".file-row")].find(r => r.querySelector(".file-name")?.textContent === "long.md").querySelector(".file-link").click(); true`);
    await waitFor(`__md(${longFile})?.querySelector("[data-stop]")`, 10000);
    await sleep(1000);
    await clickIn(`.md-view[data-file="docs/long.md"] .md-cell[data-side="new"] [data-stop="12"]`);
    await sleep(300);
    await b.eval(`document.activeElement?.blur(); true`);
    const keyFrom = await b.eval(`__cursorAt(${longFile})`);
    await b.eval(`${toggleOf("docs/long.md")}.click(); true`);
    const copyThere = await b.eval(`!!document.querySelector(".view-fade")`);
    await keys("j");
    const afterKey = await b.eval(`({ copy: !!document.querySelector(".view-fade"), cursor: __cursorAt(${longFile}) })`);
    await sleep(600);
    const keySettled = await b.eval(`__cursorAt(${longFile})`);
    await keys("k");
    await sleep(200);
    const keyBack = await b.eval(`__cursorAt(${longFile})`);
    await b.eval(`window.__matchMedia = window.matchMedia; window.matchMedia = (q) => /reduced-motion/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : window.__matchMedia(q); true`);
    const reduced = (await traced("docs/long.md", "return 0;")).filter((r) => r[2] !== -1).length;
    await b.eval(`window.matchMedia = window.__matchMedia; true`);
    await sleep(600);
    check(
      "a key right after the switch moves the cursor in the new view and takes the copy away; with prefers-reduced-motion there is no copy",
      copyThere && !afterKey.copy && keySettled !== null && keyBack !== null && keyBack !== keySettled && /^line /.test(keySettled) && reduced === 0,
      { copyThere, keyFrom, afterKey, keySettled, keyBack, reducedFrames: reduced },
    );
    const long = `document.querySelector('.md-view[data-file="docs/long.md"]')`;
    await b.eval(`[...document.querySelectorAll(".file-row")].find(r => r.querySelector(".file-name")?.textContent === "long.md").querySelector(".file-link").click(); true`);
    await waitFor(`${long}?.querySelector("[data-stop]")`, 10000);
    await sleep(1200);
    await clickIn(`.md-view[data-file="docs/long.md"] .md-cell[data-side="new"] [data-stop="40"]`);
    await sleep(200);
    await b.eval(`document.activeElement?.blur(); true`);
    const docTop = (e: string) => `Math.round(${e}.getBoundingClientRect().top + document.querySelector(".codeview-host").scrollTop)`;
    const halfFrom = await b.eval(`(() => { const e = ${long}.querySelector(".md-cursor"); return e ? ${docTop("e")} : null; })()`);
    const halfStart = await b.eval(`+(${long}.querySelector(".md-cursor")?.dataset.start ?? 0)`);
    await chord([CTRL], "d");
    await sleep(600);
    const halfTo = await b.eval(`(() => { const e = ${long}.querySelector(".md-cursor"); return e ? { top: ${docTop("e")}, start: +e.dataset.start } : null; })()`);
    const screen = await b.eval(`document.querySelector(".codeview-host").clientHeight`);
    check(
      "Ctrl+d in a rendered file moves the cursor about half a screen down, not a fixed number of blocks",
      halfFrom !== null && !!halfTo && halfTo.start > halfStart && halfTo.top - halfFrom >= screen / 2 - 10 && halfTo.top - halfFrom <= screen / 2 + 250,
      { halfFrom, halfTo, screen },
    );

    // A thread on a Markdown file: its page shows the thread's code rendered as well, with the same toggle.
    const mdThread = JSON.parse(run(repo, ["bun", CLI, "comment", "add", "--file", "docs/long.md", "--range", "11-11", "--at", String(longV - 1), "--body", "is paragraph 3 right?", "--as", "reviewer", "--json"])).id as number;
    const tmd = `document.querySelector(".code-area .md-view")`;
    const threadMd = () =>
      b.eval(`(() => { const v = ${tmd}; return {
        toggle: document.querySelector(".code-label .md-toggle")?.textContent ?? null,
        rendered: !!v,
        code: !!document.querySelector(".code-area diffs-container"),
        split: v?.classList.contains("md-split") ?? null,
        focus: v ? [...v.querySelectorAll(".md-thread-focus")].map(e => e.closest(".md-cell").dataset.side + ":" + e.textContent.trim().slice(0, 11)) : [],
        marker: !!v?.querySelector(".md-threads .thread-marker"),
        words: v ? [...v.querySelectorAll(".md-thread-focus :is(del, ins)")].map(e => e.tagName.toLowerCase() + ":" + e.textContent) : [],
        folds: v ? v.querySelectorAll(".md-fold").length : 0,
      }; })()`);
    const stepButton = (state: string) => `[...document.querySelectorAll(".timeline .step:not(.fold)")].find(s => s.querySelector(".step-state")?.textContent === "${state}")?.querySelector("button")`;
    await b.eval(`location.hash = "#/thread/${mdThread}"; true`);
    await waitFor(`${tmd}?.querySelector(".md-thread-focus")`, 10000);
    await sleep(500);
    const threadOpened = await threadMd();
    // the switch here is covered by a fading copy too, gone soon after
    const threadFade = await b.eval(`new Promise(done => {
      document.querySelector(".code-label .md-toggle").click();
      const at = !!document.querySelector(".view-fade");
      setTimeout(() => done({ at, later: !!document.querySelector(".view-fade") }), 500);
    })`);
    await waitFor(`!${tmd} && document.querySelector(".code-area diffs-container")`, 8000);
    const codeThere = { ...(await threadMd()), fade: threadFade };
    await b.eval(`document.querySelector(".code-label .md-toggle").click(); true`);
    await waitFor(`${tmd}?.querySelector(".md-thread-focus")`, 8000);
    await b.eval(`${stepButton("written")}.click(); true`);
    await waitFor(`${tmd}?.querySelector(".md-thread-focus") && !${tmd}.classList.contains("md-split")`, 8000);
    await sleep(300);
    const written = await threadMd();
    await b.eval(`${stepButton("changed")}.click(); true`);
    await waitFor(`${tmd}?.querySelector(".md-thread-focus del")`, 8000);
    await sleep(500);
    const changed = await threadMd();
    await b.screenshot(join(OUT, "shots", "ui-check-thread-markdown.png"));
    check(
      "a thread on a Markdown file shows its code rendered, with the toggle to code and back; its blocks are marked, picking a step keeps the view, and a changed step compares old and new with the changed words marked",
      threadOpened.rendered && (threadOpened.toggle?.includes("code") ?? false) && threadOpened.marker && threadOpened.focus.some((f: string) => f.endsWith("Paragraph 3")) &&
        !codeThere.rendered && codeThere.code && (codeThere.toggle?.includes("rendered") ?? false) && threadFade.at && !threadFade.later &&
        written.rendered && written.folds > 0 && written.words.length === 0 && JSON.stringify(written.focus) === JSON.stringify(["new:Paragraph 3"]) &&
        changed.rendered && changed.split === true && JSON.stringify(changed.focus) === JSON.stringify(["old:Paragraph 3", "new:Paragraph 3"]) &&
        JSON.stringify(changed.words) === JSON.stringify(["del:1", "ins:2"]),
      { threadOpened, codeThere, written, changed },
    );

    // A long Markdown file with two small changes far apart. Rendered, it shows the changes with the lines around them
    // and folds the rest; the bars open it a piece at a time, and what one view opens the other shows too.
    const rd = `document.querySelector('.md-view[data-file="docs/readme.md"]')`;
    const readmeItem = `[...document.querySelectorAll(".codeview-host diffs-container")].find(c => c.shadowRoot?.querySelector("[data-title]")?.textContent === "docs/readme.md")`;
    const toFile = async (name: string) => {
      await b.eval(`[...document.querySelectorAll(".side-tabs button")].find(x => x.textContent.startsWith("Files")).click(); true`);
      await sleep(150);
      await b.eval(`[...document.querySelectorAll(".file-row")].find(r => r.querySelector(".file-name")?.textContent === ${JSON.stringify(name)}).querySelector(".file-link").click(); true`);
    };
    const readmeBars = () => b.eval(`[...(${rd}?.querySelectorAll(".md-fold .md-fold-text") ?? [])].map(e => e.textContent)`) as Promise<string[]>;
    const codeLines = () => b.eval(`(() => { const c = ${readmeItem}; return c ? [...new Set([...c.shadowRoot.querySelectorAll("code[data-additions] > [data-content] > [data-line], code[data-unified] > [data-content] > [data-line]")].map(e => +e.getAttribute("data-line")))] : null; })()`) as Promise<number[] | null>;
    const readmeToggle = async (to: "code" | "rendered") => {
      await b.eval(`${toggleOf("docs/readme.md")}.click(); true`);
      await waitFor(to === "code" ? `!${rd} && (${readmeItem})?.shadowRoot?.querySelector("[data-line]")` : `${rd}?.querySelector("[data-stop]")`, 8000);
      await sleep(700);
    };
    await b.eval(`location.hash = "#/compare/${longV - 1}..${longV}"; true`);
    await sleep(800);
    await toFile("readme.md");
    await waitFor(`${rd}?.querySelector("[data-stop]")`, 10000);
    await sleep(1000);
    const foldedAtFirst = { bars: await readmeBars(), blocks: await b.eval(`[...${rd}.querySelectorAll('.md-cell[data-side="new"] > [data-start]')].map(e => +e.dataset.start)`) };
    // full file on its header: the whole file in both views; off again, both fold back
    const wholeOf = `[...document.querySelectorAll(".md-whole")].find(t => t.closest("diffs-container")?.shadowRoot?.querySelector("[data-title]")?.textContent === "docs/readme.md")`;
    const separators = `(${readmeItem})?.shadowRoot?.querySelectorAll("[data-unmodified-lines]").length`;
    await b.eval(`${wholeOf}.click(); true`);
    await sleep(800);
    const wholeRendered = { bars: (await readmeBars()).length, on: await b.eval(`${wholeOf}.classList.contains("on")`) };
    await readmeToggle("code");
    const wholeCode = await b.eval(separators);
    await b.eval(`${wholeOf}.click(); true`);
    const partCode = await waitFor(`${separators} || null`, 4000);
    await readmeToggle("rendered");
    const beforeBelow = await readmeBars();
    await b.eval(`[...${rd}.querySelectorAll(".md-fold button")].find(x => x.dataset.act === "below").click(); true`);
    await sleep(700);
    const afterBelow = await readmeBars();
    await readmeToggle("code");
    const codeAfterBelow = await codeLines();
    await b.screenshot(join(OUT, "shots", "ui-check-readme-code.png"));
    // a "show more" of the code: the rendered view shows those lines too
    await b.eval(`(${readmeItem}).shadowRoot.querySelector("[data-expand-up]").click(); true`);
    await sleep(900);
    const codeAfterExpand = await codeLines();
    await readmeToggle("rendered");
    const afterCodeExpand = await readmeBars();
    await b.eval(`[...${rd}.querySelectorAll(".md-fold button")].find(x => x.dataset.act === "above").click(); true`);
    await sleep(700);
    const afterAbove = await readmeBars();
    await b.screenshot(join(OUT, "shots", "ui-check-readme-folds.png"));
    const foldedN = (bars: string[]) => (bars.length === 1 ? Number(/(\d+) lines folded/.exec(bars[0]!)?.[1]) : NaN);
    check(
      "a long Markdown file shows its changes rendered with the lines around them and folds the rest; full file shows all of it in both views; show below and show above open it a piece at a time, and what one view opens the other shows too",
      foldedN(foldedAtFirst.bars) === 257 && JSON.stringify(foldedAtFirst.blocks) === JSON.stringify([1, 3, 5, 265, 267]) &&
        wholeRendered.bars === 0 && wholeRendered.on && wholeCode === 0 && (partCode ?? 0) > 0 && foldedN(beforeBelow) < 257 &&
        foldedN(afterBelow) < foldedN(beforeBelow) && foldedN(afterBelow) >= foldedN(beforeBelow) - 30 && !!codeAfterBelow && [243, 250, 264].every((l) => codeAfterBelow.includes(l)) &&
        !!codeAfterExpand && codeAfterExpand.includes(20) && foldedN(afterCodeExpand) < foldedN(afterBelow) && foldedN(afterAbove) < foldedN(afterCodeExpand),
      { foldedAtFirst, wholeRendered, wholeCode, partCode, beforeBelow, afterBelow, codeAfterBelow: codeAfterBelow?.join(" "), codeAfterExpand: codeAfterExpand?.join(" "), afterCodeExpand, afterAbove },
    );

    // reading in the middle of what was folded, the switch keeps that text where it was, both ways, and every time
    await b.eval(`[...${rd}.querySelectorAll(".md-fold button")].find(x => x.dataset.act === "all").click(); true`);
    await sleep(800);
    const shownAll = await readmeBars();
    const middle = {} as Record<string, unknown>;
    let middleHeld = shownAll.length === 0;
    for (const [name, text, frac] of [
      ["a paragraph", "Text of section 30,", 0],
      ["a list item", "item 5 of the list in section 20", 0.2],
      ["a table row", "key4", 0.3],
    ] as const) {
      await b.eval(`(() => { const e = [...${rd}.querySelectorAll('.md-cell[data-side="new"] [data-stop]')].reverse().find(x => x.textContent.trim().startsWith(${JSON.stringify(text)})); const r = e.getBoundingClientRect(); __h().scrollTop += r.top - __band() + ${frac} * r.height; return true; })()`);
      await sleep(600);
      const rounds = [];
      for (let round = 0; round < 2; round++) {
        const a = await b.eval(`__rtop("docs/readme.md")`);
        await readmeToggle("code");
        const toCode = await b.eval(`(() => { const c = ${readmeItem}; const r = [...c.shadowRoot.querySelectorAll("code[data-${a.side}] > [data-content] > [data-line]")].find(x => +x.getAttribute("data-line") === ${a.line}); return r ? Math.round(r.getBoundingClientRect().top - __h().getBoundingClientRect().top - ${a.y}) : null; })()`);
        const c = await b.eval(`__ctop("docs/readme.md")`);
        await readmeToggle("rendered");
        const toRendered = await b.eval(`(() => { const y = __share("docs/readme.md", "${c.side}", ${c.line}); return y === null ? null : Math.round(y - ${c.y}); })()`);
        rounds.push({ line: a.line, toCode, toRendered, bars: (await readmeBars()).length });
        middleHeld &&= toCode !== null && Math.abs(toCode) <= 4 && toRendered !== null && Math.abs(toRendered) <= 4;
      }
      middle[name] = rounds;
      console.log(`drift docs/readme.md, ${name}: ${JSON.stringify(rounds)}`);
    }
    check(
      "reading what was folded between two changes far apart, switching rendered and code keeps the text where it was, both ways and again (nothing folds back)",
      middleHeld,
      middle,
    );

    // on a thread's page the same bars, and what they open shows in the thread's code too
    const readmeThread = JSON.parse(run(repo, ["bun", CLI, "comment", "add", "--file", "docs/readme.md", "--range", "3-3", "--at", String(longV - 1), "--body", "is the intro right?", "--as", "reviewer", "--json"])).id as number;
    await b.eval(`location.hash = "#/thread/${readmeThread}"; true`);
    await waitFor(`document.querySelector(".code-area .md-view .md-thread-focus")`, 10000);
    await sleep(600);
    const threadBars = () => b.eval(`[...document.querySelectorAll(".code-area .md-fold")].map(e => e.querySelector(".md-fold-text").textContent + ":" + [...e.querySelectorAll("button")].map(x => x.dataset.act).join("/"))`) as Promise<string[]>;
    const threadCodeLines = () => b.eval(`(() => { const c = document.querySelector(".code-area diffs-container"); return c ? [...new Set([...c.shadowRoot.querySelectorAll("[data-content] > [data-line]")].map(e => +e.getAttribute("data-line")))].sort((a, b) => a - b) : null; })()`) as Promise<number[] | null>;
    const onPage = await threadBars();
    await b.eval(`[...document.querySelectorAll(".code-area .md-fold button")].find(x => x.dataset.act === "above").click(); true`);
    await sleep(700);
    const openedThere = await threadBars();
    await b.eval(`document.querySelector(".code-label .md-toggle").click(); true`);
    await waitFor(`!document.querySelector(".code-area .md-view") && document.querySelector(".code-area diffs-container")?.shadowRoot?.querySelector("[data-line]")`, 8000);
    await sleep(600);
    const threadCode = await threadCodeLines();
    await b.eval(`document.querySelector(".code-label .md-toggle").click(); true`);
    await waitFor(`document.querySelector(".code-area .md-view [data-stop]")`, 8000);
    check(
      "a thread's page folds its rendered file the same way, with the same bars; what they open shows in the thread's code",
      onPage.length === 1 && onPage[0]!.includes("above/below/all") && openedThere.length === 1 && foldedN(openedThere.map((x) => x.split(":")[0]!)) < foldedN(onPage.map((x) => x.split(":")[0]!)) &&
        !!threadCode && threadCode.includes(20) && threadCode.includes(1),
      { onPage, openedThere, threadCode: threadCode?.join(" ") },
    );

    // a link to lines in the folded middle of a rendered file, opened in a new tab: the lines open, their blocks are marked
    const homeTab = b.context;
    const linkTab = await b.send("browsingContext.create", { type: "tab" });
    b.context = linkTab.context;
    await b.viewport(1400, 900);
    await b.navigate(`${url.split("#")[0]}#/compare/${longV - 1}..${longV}?file=docs%2Freadme.md&line=130-132`);
    const linkedBlocks = `[...(${rd}?.querySelectorAll(".md-linked") ?? [])].map(e => e.closest(".md-cell").dataset.side + ":" + e.dataset.start).sort()`;
    await waitFor(`${linkedBlocks}.length > 0`, 15000);
    await sleep(1500);
    const mdLink = await b.eval(`({ linked: ${linkedBlocks}, cursor: [...(${rd}?.querySelectorAll(".md-cursor") ?? [])].map(e => e.dataset.start), top: Math.round((${rd}?.querySelector(".md-linked")?.getBoundingClientRect().top ?? NaN) - document.querySelector(".codeview-host").getBoundingClientRect().top), text: ${rd}?.querySelector('.md-linked[data-start="132"]')?.textContent.slice(0, 26) ?? null, bars: ${rd}?.querySelectorAll(".md-fold").length ?? -1 })`);
    await b.screenshot(join(OUT, "shots", "ui-check-markdown-link.png"));
    await keys("j");
    await sleep(200);
    const mdInside = await b.eval(`${linkedBlocks}.length`);
    await keys("j");
    await sleep(200);
    const mdLeft = await b.eval(`${linkedBlocks}.length`);
    await b.send("browsingContext.close", { context: linkTab.context });
    b.context = homeTab;
    await b.send("browsingContext.activate", { context: homeTab }).catch(() => null);
    check(
      "a link to lines a rendered Markdown file folds, in a new tab: the lines open, the blocks that hold them are highlighted near the top with the cursor on the first; the highlight goes once the cursor leaves them",
      JSON.stringify(mdLink.linked) === JSON.stringify(["new:130", "new:132", "old:130", "old:132"]) && JSON.stringify(mdLink.cursor) === JSON.stringify(["130", "130"]) && mdLink.top > 20 && mdLink.top < 200 &&
        mdLink.text === "Text of section 30, the sa" && mdLink.bars === 2 && mdInside === 4 && mdLeft === 0,
      { mdLink, mdInside, mdLeft },
    );

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
