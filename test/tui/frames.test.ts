import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { clientApi, type Api } from "../../src/client/api.ts";
import type { ThreadDetail } from "../../src/core/types.ts";
import { parsePatchFiles } from "@pierre/diffs";
import { createTestRenderer } from "@opentui/core/testing";
import { viewedKey } from "../../src/ui/viewed.ts";
import { searchChanges, syncChanges } from "../../src/tui/changes.ts";
import { colorMode } from "../../src/tui/diff/colors.ts";
import { Screen } from "../../src/tui/screen.ts";
import { fetchWide, scopesOf, wideKey } from "../../src/tui/code.ts";
import { rowText } from "../../src/tui/grid.ts";
import { App } from "../../src/tui/app.ts";
import { menuEntries, tuiReader } from "../../src/tui/keys/menu.ts";
import { KeyTester, type Tried } from "../../src/tui/keys/tester.ts";
import type { Terminal } from "../../src/ui/keys/terminal.ts";
import { KeyMatcher } from "../../src/ui/keys/match.ts";
import { KEYS } from "../../src/ui/keys/table.ts";
import { browserTarget } from "../../src/tui/browser.ts";
import { parseHash, takeToken } from "../../src/ui/route.ts";
import { fileIndex } from "../../src/ui/filerefs.ts";
import { helpFor, initialView, render, type ViewState } from "../../src/tui/render.ts";
import { width } from "../../src/tui/text.ts";
import { seedTui, type Seeded } from "../fixtures/tui-seed.ts";
import { Fixture, GIT_ENV } from "../helpers/fixture.ts";

const reader = tuiReader(App.ids());
const legacy: Terminal = { kitty: false, name: null, tmux: false };
const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
const f = new Fixture();
let server: ReturnType<typeof Bun.spawn> | null = null;
let api: Api;
let review = 0;
let ids: Seeded;
let now = 0;

beforeAll(async () => {
  ids = seedTui(f.root, ["bun", CLI]);
  server = Bun.spawn(["bun", CLI, "serve", "--json", "--foreground"], { cwd: f.root, env: { ...process.env, ...GIT_ENV, STET_ROLE: "reviewer" }, stdout: "pipe", stderr: "pipe" });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const info = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  reader.releaseLock();
  api = clientApi({ port: info.port, token: info.url.split("token=")[1] });
  review = (await api.reviews()).default!;
}, 60_000);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  f.cleanup();
});

/** The seeded review as the app holds it, with the thread `id` selected and shown. */
async function view(id: number): Promise<ViewState> {
  const v = initialView();
  const [status, threads, drafts, git, detail] = await Promise.all([api.review(review), api.threads(review), api.drafts(review), api.git(review), api.thread(review, id)]);
  v.data = { status, threads, drafts, now: null, online: true };
  v.git = git;
  v.selected = id;
  v.detail = detail;
  v.fresh = new Set(detail.comments.filter((c) => c.unread).map((c) => c.id));
  // Every message was written within the seed's few seconds: they all read "just now".
  now = Math.max(...[...detail.comments.map((c) => Date.parse(c.createdAt)), ...detail.events.map((e) => Date.parse(e.at))]) + 30_000;
  v.now = now;
  return v;
}

function frame(v: ViewState, w: number, h: number): string {
  const rows = render(v, w, h).rows;
  expect(rows.length).toBe(h);
  expect(rows.map((r) => width(rowText(r))).filter((n) => n !== w)).toEqual([]);
  return `\n${rows.map(rowText).join("\n")}\n`;
}

test("120×40: the list has the focus and the selected thread shows beside it as a preview", async () => {
  const v = await view(ids.magic);
  v.banner = 2;
  const text = frame(v, 120, 40);
  expect(text).toContain("THREADS");
  expect(text).toContain("preview");
  expect(text).toContain("── Conversation · 2 messages");
  expect(text).toMatchSnapshot();
});

test("180×46: three columns, the code focused, a NEW rule over the agent's unread fix", async () => {
  const v = await view(ids.timing);
  v.banner = 2;
  v.focus = "code";
  const text = frame(v, 180, 46);
  expect(text).toContain("── NEW ──");
  expect(text).toContain("▲ thread #1 · v2");
  expect(text).toContain(" CODE ");
  expect(text).toMatchSnapshot();
});

test("120×40: the reply box at the bottom of the thread's column", async () => {
  const v = await view(ids.magic);
  v.focus = "code";
  v.writing = { kind: "reply", thread: ids.magic };
  v.composerText = "Env vars, please, with these numbers as defaults. And name the second one RATE_WINDOW_MS everywhere, the README says RATE_WINDOW.";
  const f = render(v, 120, 40);
  expect(f.box).not.toBeNull();
  const text = frame(v, 120, 40);
  expect(text).toContain("Reply to #2 · draft");
  expect(text).toContain("REPLY");
  expect(text).toMatchSnapshot();
});

test("120×40: the Space menu lists the groups this UI has", async () => {
  const v = await view(ids.magic);
  const m = new KeyMatcher(() => KEYS, reader, () => {});
  m.feed("<Space>", ["round.list", "global"]);
  v.prefix = [...m.prefix];
  v.next = menuEntries(m.next(["round.list", "global"]));
  m.reset();
  const text = frame(v, 120, 40);
  expect(text).toContain("+review");
  expect(text).toContain("+ui toggles");
  expect(text).toContain("+find");
  expect(text).toContain("+git");
  expect(text).toContain("search all files ↗");
  expect(text).toContain("MENU");
  expect(text).toMatchSnapshot();
});

test("120×40: the Drafts tab with the approve question", async () => {
  const v = await view(ids.magic);
  v.tab = "drafts";
  v.draftSel = v.data.drafts[0]!.id;
  v.draftDetail = (await api.thread(review, v.data.drafts[0]!.threadId)) as ThreadDetail;
  v.choice = {
    title: "Approve with 1 draft?",
    text: "Approving says this version is done. The drafts can go with it as nits, or as a request for changes and a new round.",
    options: [
      { value: "nits", label: "Approve; drafts go as nits (the agent fixes them without a new round)" },
      { value: "changes", label: "Send as Request changes" },
    ],
    at: 0,
  };
  const text = frame(v, 120, 40);
  expect(text).toContain("Your review · 1 draft");
  expect(text).toContain("QUESTION");
  expect(text).toMatchSnapshot();
});

test("80×24: one column, the thread; h slides the list in over it", async () => {
  const v = await view(ids.timing);
  v.focus = "code";
  const thread = frame(v, 80, 24);
  expect(thread).toMatch(/\d+ of \d+/);
  expect(thread).not.toContain(" Threads ");
  v.focus = "list";
  const list = frame(v, 80, 24);
  expect(list).toContain(" Threads ");
  expect(thread).toMatchSnapshot();
  expect(list).toMatchSnapshot();
});

test("120×40: the Files tab lists the changed files with −/+ and their threads, the file's first thread beside it", async () => {
  const v = await view(ids.magic);
  v.side = "files";
  v.files = await api.compare(review, "base", "2");
  v.fileSel = "src/routes.ts";
  const text = frame(v, 120, 40);
  expect(text).toContain("9 files · base → v2");
  expect(text).toContain(" FILES ");
  expect(text).toMatch(/src\/routes\.ts\s+\+\d+ ●4/);
  expect(text).toMatchSnapshot();
});

test("120×40: J lands in another file and its header row is marked", async () => {
  const v = await view(ids.magic);
  v.landed = "src/routes.ts";
  const rows = render(v, 120, 40).rows;
  const header = rows.find((r) => r.map((x) => x.text).join("").includes("src/routes.ts") && r.some((x) => x.c?.includes("info")));
  expect(header).toBeDefined();
  v.landed = null;
  expect(render(v, 120, 40).rows.some((r) => r.map((x) => x.text).join("").includes("src/routes.ts") && r.some((x) => x.c?.includes("info")))).toBe(false);
});

test("120×40: ? lists the column's keys, how to move around and the mouse", async () => {
  const v = await view(ids.magic);
  v.help = helpFor("list", reader, legacy);
  const text = frame(v, 120, 40);
  expect(text).toContain("Moving around");
  expect(text).toContain("Space e  Space s t");
  expect(text).toContain("Shift+drag");
  expect(text).toContain("press any key: its row lights up");
  expect(text).toMatchSnapshot();
});

test("120×40: ? is the key tester: a key lights up its row; Enter says Ctrl+Enter is plain Enter here and which key to use", async () => {
  const v = await view(ids.magic);
  v.help = helpFor("list", reader, legacy);
  const tried: Tried[] = [];
  const tester = new KeyTester(reader, legacy, ["round.list", "global"], (t) => tried.push(t), 10_000);
  const press = (token: string) => {
    const t = tester.press(token);
    v.help!.got = t.text;
    const at = t.row ? v.help!.rows.indexOf(`${t.row.scope} ${t.row.id}`) : -1;
    v.help!.lit = at === -1 ? null : at;
    return t;
  };
  expect(press("J").row?.id).toBe("thread.nextFile");
  expect(press("g").text).toContain("got g …");
  expect(press("g").row?.id).toBe("list.first");
  expect(press("<F5>").text).toBe("got F5: nothing here");
  const enter = press("<CR>");
  expect(enter.row?.id).toBe("list.open");
  expect(enter.text).toBe(
    "got Enter: into the thread · Ctrl+Enter, Ctrl+Shift+Enter, Ctrl+J, Shift+Enter are plain Enter in this terminal, use Ctrl+S (save as a draft), Ctrl+G (send now), ↓ (next), Ctrl+F (make the version “from”), Ctrl+T (make the version “to”)",
  );
  expect(new KeyTester(reader, { ...legacy, kitty: true }, ["round.list", "global"], () => {}).press("<CR>").text).toBe("got Enter: into the thread");
  tester.reset();
  const text = frame(v, 120, 40);
  expect(text).toContain("got Enter: into the thread");
  const lit = render(v, 120, 40).rows.find((r) => r.some((x) => x.c?.includes("sel")) && rowText(r).includes("into the thread"));
  expect(lit).toBeDefined();
  expect(text).toMatchSnapshot();
  expect(tried).toEqual([]);
});

test("180×46: z widens the thread's code to every change of its file, then to the whole file", async () => {
  const v = await view(ids.timing);
  v.focus = "code";
  const d = v.detail!;
  expect(scopesOf(d, "diff")).toEqual(["around", "changes", "file"]);
  v.scope = "changes";
  const loading = frame(v, 180, 46);
  expect(loading).toContain("all changes · loading…");
  v.wide = await fetchWide(api, d, "diff", "changes", wideKey(d, "diff", "changes")!);
  const changes = frame(v, 180, 46);
  expect(changes).toContain("src/auth.ts · every change of the file from v1 to v2");
  expect(changes).toContain("▲ thread #1 · v2");
  v.scope = "file";
  v.wide = await fetchWide(api, d, "diff", "file", wideKey(d, "diff", "file")!);
  const file = frame(v, 180, 46);
  expect(file).toContain("the whole file at v2, changes from v1");
  expect(file).toContain("export function authorized");
  expect(changes).toMatchSnapshot();
  expect(file).toMatchSnapshot();
});

/** The Changes tab on the range `from..to`, loaded as the app loads it. */
async function changes(from: string, to: string): Promise<ViewState> {
  const v = await view(ids.timing);
  v.tab = "changes";
  v.banner = null;
  const c = v.changes;
  c.from = from;
  c.to = to;
  c.data = await api.compare(review, from, to);
  c.base = parsePatchFiles(await api.patch(c.data.from.sha, c.data.to.sha), `${from}-${to}`).flatMap((p) => p.files);
  const cur = await api.cursors(review);
  c.viewed = new Set(cur.viewed);
  c.reviewed = cur.reviewed;
  syncChanges(v.data, c, false);
  c.diff.first();
  return v;
}

test("120×40: the Changes tab: the whole branch in words, the files in reading order with viewed boxes, the diff with cards", async () => {
  const v = await changes("base", "2");
  const text = frame(v, 120, 40);
  expect(text).toContain("The whole branch main → v2 · ");
  expect(text).toMatch(/\[ \] src\/auth\.ts\s+\+8 ●3/);
  expect(text).toContain("CODE (");
  expect(text).toContain("TESTS WITH ONLY NEW CODE (1)");
  expect(text).toContain("▾ src/auth.ts");
  expect(text).toContain("▲ #8");
  expect(text).toContain(" CHANGES ");
  expect(text).toMatchSnapshot();
});

test("120×40: a viewed file folds to its header; a fold group's row folds the tests that only add code", async () => {
  const v = await changes("base", "2");
  const c = v.changes;
  const auth = c.rows.find((r) => r.fd.name === "src/auth.ts")!;
  c.viewed = new Set([viewedKey(auth.fd)]);
  syncChanges(v.data, c, false);
  const text = frame(v, 120, 40);
  expect(text).toContain("▸ src/auth.ts");
  expect(text).toContain("[x] viewed");
  expect(text).toContain("1 of ");
  const last = c.diff.items[c.diff.items.length - 1]!;
  expect(c.diff.items.some((i) => i.kind === "group" && i.key === "group:tests" && !i.open)).toBe(true);
  expect(last.kind === "group" || last.kind === "file").toBe(true);
  c.diff.last();
  expect(frame(v, 120, 40)).toContain("▸ 1 test file with only new code folded · show");
});

test("180×46: the cursor on a card, its card open; the strip lights the range's ends", async () => {
  const v = await changes("1", "2");
  const c = v.changes;
  frame(v, 180, 46);
  c.diff.goTo(c.diff.nextCard(1), "center");
  c.diff.toggleCard(c.diff.info()!.thread!);
  const text = frame(v, 180, 46);
  expect(text).toContain("What changed in v2 v1 → v2");
  expect(text).toContain("Enter  opens the thread");
  expect(text).toMatchSnapshot();
});

test("80×24: one column, the diff; the files slide in over it when they have the focus", async () => {
  const v = await changes("base", "2");
  const diff = frame(v, 80, 24);
  expect(diff).not.toContain("CODE (");
  v.changes.focus = "list";
  const list = frame(v, 80, 24);
  expect(list).toContain("CODE (");
  expect(list).toContain(" FILES ");
  expect(diff).toMatchSnapshot();
  expect(list).toMatchSnapshot();
});

test("? on the Changes tab lists its keys: lines, files, threads, folds, viewed, the range", async () => {
  const v = await changes("base", "2");
  v.help = helpFor("changes", reader, legacy);
  const text = v.help.lines.map((l) => l.spans.map((x) => x.text).join("")).join("\n");
  for (const k of ["] t ", "[ t ", "] b  L", "] c", "z a", "m ", "] v", "{", "p ", "Enter ", "V  v", "i  a  c"]) expect(text).toContain(k);
});

test("256 colours under TERM=screen-256color: the frame paints with palette indexes", async () => {
  const v = await changes("base", "2");
  const { renderer, renderOnce, captureSpans } = await createTestRenderer({ width: 120, height: 40 });
  const screen = new Screen(renderer, (w, h) => render(v, w, h).rows, colorMode({ TERM: "screen-256color" }));
  renderer.root.add(screen);
  await renderOnce();
  const spans = captureSpans().lines.flatMap((l) => l.spans);
  expect(spans.length).toBeGreaterThan(50);
  expect(spans.every((x) => x.fg.intent === "indexed" && x.bg.intent === "indexed")).toBe(true);
  renderer.destroy();
});

test("? waits for the next key of a sequence, and says what the first key did when none comes", async () => {
  const tried: Tried[] = [];
  const tester = new KeyTester(tuiReader(App.ids()), legacy, ["changes", "global"], (t) => tried.push(t), 5);
  expect(tester.press("z").row).toBeNull();
  expect(tester.press("a").row?.id).toBe("diff.toggle");
  expect(tester.press("g").row).toBeNull();
  expect(tester.press("c").text).toBe("got g c …: longer keys start so, press the next one");
  await Bun.sleep(30);
  expect(tried.map((t) => [t.keys, t.row?.id, t.text])).toEqual([["gc", "comment.start", "got g c: comment on the selection"]]);
  expect(tester.press("<C-w>").row).toBeNull();
  expect(tester.press("W").row?.id).toBe("focus.prev");
  expect(tester.press("<S-F3>").row?.id).toBe("match.prev");
});

/** The lines `start..end` of `path` picked with V on a side, as the keys pick them. */
function pick(v: ViewState, path: string, side: 0 | 1, start: number, end: number): void {
  const d = v.changes.diff;
  d.goTo(d.lineRow(path, side, start), "center");
  if (d.split) d.setSide(side);
  expect(d.startSelection()).toBe(true);
  d.goTo(d.lineRow(path, side, end));
}

test("120×40: V on removed lines picks the old side; i opens a new thread's box under the diff, the lines in sight above it", async () => {
  const v = await changes("1", "2");
  frame(v, 120, 40);
  pick(v, "src/auth.ts", 0, 4, 5);
  const sel = v.changes.diff.selection()!;
  expect(sel).toMatchObject({ key: "src/auth.ts", side: 0, start: 4, end: 5 });
  const visual = frame(v, 120, 40);
  expect(visual).toContain(" VISUAL ");
  v.writing = { kind: "thread", path: "src/auth.ts", side: "old", start: 4, end: 5, at: v.changes.data!.from.sha, label: "v1", from: "changes" };
  v.composerText = "Both lines leak the key's length through timing as well.";
  const f = render(v, 120, 40);
  expect(f.box).not.toBeNull();
  const text = frame(v, 120, 40);
  expect(text).toContain("New thread on src/auth.ts:4–5 · removed lines (v1) · draft");
  expect(text).toContain("const given = req.headers.get");
  expect(text).toContain(" NEW THREAD ");
  expect(visual).toMatchSnapshot();
  expect(text).toMatchSnapshot();
});

test("180×46, split: the cursor on the new side, V picks added lines there; Left would pick the old side", async () => {
  const v = await changes("1", "2");
  v.changes.layout = "split";
  v.changes.diff.setLayout("split");
  frame(v, 180, 46);
  expect(v.changes.diff.split).toBe(true);
  pick(v, "src/auth.ts", 1, 6, 7);
  expect(v.changes.diff.selection()).toMatchObject({ side: 1, start: 6, end: 7 });
  const text = frame(v, 180, 46);
  expect(text).toContain(" VISUAL ");
  const rows = render(v, 180, 46).rows;
  const picked = rows.filter((r) => r.some((x) => x.c?.includes("vis")));
  expect(picked.length).toBe(2);
  expect(text).toMatchSnapshot();
});

test("80×24: a new thread's box on one column, over the bottom of the diff", async () => {
  const v = await changes("1", "2");
  frame(v, 80, 24);
  pick(v, "src/auth.ts", 1, 3, 3);
  v.writing = { kind: "thread", path: "src/auth.ts", side: "new", start: 3, end: 3, at: v.changes.data!.to.sha, label: "v2", from: "changes" };
  v.composerText = "";
  const f = render(v, 80, 24);
  expect(f.box).not.toBeNull();
  const text = frame(v, 80, 24);
  expect(text).toContain("New thread on src/auth.ts:3 (v2)");
  expect(text).toContain("const KEY = Buffer.from");
  expect(text).toMatchSnapshot();
});

test("180×46: V in a thread's code picks its removed lines on the old side; the new thread's box sits under the code", async () => {
  const v = await view(ids.timing);
  v.focus = "code";
  frame(v, 180, 46);
  expect(v.code.enter()).toBe(true);
  v.codeCursor = true;
  const d = v.code.diff;
  expect(d.selection()).toMatchObject({ side: 1, start: 6 });
  d.goTo(d.lineRow("src/auth.ts", 0, 5));
  d.startSelection();
  d.goTo(d.lineRow("src/auth.ts", 0, 4));
  expect(d.selection()).toMatchObject({ side: 0, start: 4, end: 5 });
  const visual = frame(v, 180, 46);
  expect(visual).toContain(" VISUAL ");
  v.writing = { kind: "thread", path: "src/auth.ts", side: "old", start: 4, end: 5, at: v.detail!.timeline[0]!.sha, label: "v1", from: "thread" };
  const f = render(v, 180, 46);
  expect(f.box).not.toBeNull();
  const text = frame(v, 180, 46);
  expect(text).toContain("New thread on src/auth.ts:4–5 · removed lines (v1) · draft");
  expect(text).toContain("return given === KEY;");
  expect(visual).toMatchSnapshot();
  expect(text).toMatchSnapshot();
});

test("120×40 and 80×24: the cursor in a thread's code on an added line; the column follows it", async () => {
  const v = await view(ids.timing);
  v.focus = "code";
  frame(v, 120, 40);
  v.code.enter();
  v.codeCursor = true;
  const text = frame(v, 120, 40);
  expect(text).toContain(" LINES ");
  expect(render(v, 120, 40).rows.some((r) => r.some((x) => x.c?.includes("sel") && x.text.includes("6")))).toBe(true);
  expect(text).toMatchSnapshot();
  frame(v, 80, 24);
  const narrow = frame(v, 80, 24);
  expect(narrow).toContain("timingSafeEqual(given, KEY)");
  expect(narrow).toMatchSnapshot();
});

/** A search as `/` and Enter leave it: the query, its matches, the cursor on match `at`. */
function search(v: ViewState, query: string, at: number): void {
  const c = v.changes;
  c.search.query = query;
  searchChanges(c);
  c.search.at = at;
  searchChanges(c);
  const h = c.search.hits[at]!;
  c.diff.goTo(c.diff.lineRow(h.path, h.side === "deletions" ? 0 : 1, h.line), "center");
}

const spansWith = (v: ViewState, w: number, h: number, cls: "hit" | "hitc") => render(v, w, h).rows.flatMap((r) => r.filter((x) => x.c?.includes(cls)).map((x) => x.text));

test("180×46: / opens the search box at the bottom; the matches are marked as it is typed", async () => {
  const v = await changes("1", "2");
  frame(v, 180, 46);
  v.changes.search.typing = true;
  v.changes.search.query = "given";
  searchChanges(v.changes);
  const text = frame(v, 180, 46);
  expect(text).toContain(" SEARCH  /given▏");
  expect(text).toContain("4 matches");
  expect(spansWith(v, 180, 46, "hit").every((t) => t === "given")).toBe(true);
  expect(spansWith(v, 180, 46, "hit").length).toBeGreaterThan(1);
  expect(text).toMatchSnapshot();
});

test("120×40 and 80×24: after Enter the info line counts the matches; the current one is marked stronger", async () => {
  const v = await changes("1", "2");
  frame(v, 120, 40);
  search(v, "KEY", 1);
  const text = frame(v, 120, 40);
  expect(text).toMatch(/\/KEY · match 2 of \d+ ·/);
  expect(new Set(spansWith(v, 120, 40, "hitc"))).toEqual(new Set(["KEY"]));
  expect(text).toMatchSnapshot();
  const narrow = frame(v, 80, 24);
  expect(narrow).toContain("/KEY · match 2 of");
  expect(new Set(spansWith(v, 80, 24, "hitc"))).toEqual(new Set(["KEY"]));
  expect(narrow).toMatchSnapshot();
});

test("120×40: Space f f finds a file of the diff by its letters, the best first, with its threads", async () => {
  const v = await changes("base", "2");
  v.picker = { kind: "files", query: "rts", at: 0, paths: v.changes.rows.map((r) => r.fd.name), threads: new Map([["src/routes.ts", 4]]), verb: "jump", range: { from: "base", to: "2" } };
  const text = frame(v, 120, 40);
  expect(text).toContain("Find a file");
  expect(text).toContain(" > rts▏");
  expect(text).toMatch(/routes\.ts src\/\s+4 threads/);
  expect(text).toContain(" FIND ");
  expect(text).toMatchSnapshot();
});

test("180×46: Space f v lists the versions newest first under their rounds; the range's ends are marked", async () => {
  const v = await changes("1", "2");
  v.picker = { kind: "versions", query: "", at: 0, paths: [], verb: "what changed in it", range: { from: "1", to: "2" } };
  const text = frame(v, 180, 46);
  expect(text).toContain("Find a version");
  expect(text).toContain("after your review 1 · changes requested");
  expect(text).toContain("before your first review");
  expect(text).toMatch(/v2 .*constant-time key check, sweep, docs\s+to /);
  expect(text).toMatch(/v1 .*rate limit and API key\s+from /);
  expect(text).toContain("Shift+Enter  from");
  expect(text).toMatchSnapshot();
  v.picker.query = "sweep";
  expect(frame(v, 180, 46)).not.toContain("rate limit and API key");
  // without the kitty protocol Shift+Enter and Ctrl+Enter arrive as Enter: the hint names their stand-ins
  v.picker.ends = { from: "Ctrl+F", to: "Ctrl+T" };
  expect(frame(v, 180, 46)).toContain("Ctrl+F  from ·  Ctrl+T  to");
});

test("80×24: a name two files share opens the file finder with the name typed in", async () => {
  const v = await view(ids.port);
  v.focus = "code";
  v.picker = { kind: "files", query: "routes.ts", at: 0, paths: ["src/routes.ts", "src/admin/routes.ts"], name: { lines: "12" }, verb: "open it", range: { from: "base", to: "2" } };
  const text = frame(v, 80, 24);
  expect(text).toContain(" > routes.ts▏");
  expect(text).toContain("open it at line 12");
  expect(text).toContain("routes.ts src/admin/");
  expect(text).toMatchSnapshot();
});

test("120×40, 180×46, 80×24: “✓ Done up to v2” beside the strip until you went through it; your last pass is marked on the strip", async () => {
  const v = await changes("1", "2");
  for (const [w, h] of [[120, 40], [180, 46]] as const) expect(frame(v, w, h)).toContain("✓ Done up to v2  Space r m ");
  const before = frame(v, 180, 46);
  v.changes.reviewed = { sha: v.changes.data!.to.sha, label: "v2", version: 2, at: new Date(now).toISOString() };
  const after = frame(v, 180, 46);
  expect(after).toContain("✓ you went through v2");
  expect(after).toContain(" v2 ✓ ");
  expect(frame(v, 80, 24)).toContain(" v2 ✓ ");
  expect(before).toMatchSnapshot();
  expect(after).toMatchSnapshot();
});

test("120×40, 180×46, 80×24: the worktree moved after “now” was read: “↻ N files changed (R)” in the header, R a click away", async () => {
  const v = await changes("base", "now");
  const st = v.data.status!;
  v.data = { ...v.data, now: { sha: "f".repeat(40), pinned: st.pinnedNow!, pinnedAt: st.pinnedNowAt!, files: 2 } };
  for (const [w, h] of [[120, 40], [180, 46], [80, 24]] as const) {
    const rows = render(v, w, h).rows;
    expect(rowText(rows[0]!)).toContain("↻ 2 files changed (R)");
    expect(rows[0]!.some((x) => x.hit === "key:R" && x.text.includes("↻"))).toBe(true);
  }
  expect(frame(v, 120, 40)).toMatchSnapshot();
});

/** The page the browser key opens from `v`: the route of the URL the server's browser.open builds. */
async function opened(v: ViewState): Promise<unknown> {
  const r = await api.action(review, "browser.open", browserTarget(v, null));
  expect(r.launch.kind).toBe("url");
  const url = new URL((r.launch as { url: string }).url);
  const { review: _, ...route } = parseHash(takeToken(url.hash)!.hash) as { review?: number };
  return route;
}

test("g x opens the same lines in the browser: the selection on its side, a picture's or a Markdown file's page, a thread, a file a message named", async () => {
  const v = await changes("1", "2");
  frame(v, 120, 40);
  pick(v, "src/auth.ts", 0, 4, 5);
  expect(await opened(v)).toEqual({ name: "compare", from: "1", to: "2", file: "src/auth.ts", line: 4, end: 5, side: "old" });
  v.changes.diff.clearSelection();
  pick(v, "src/auth.ts", 1, 7, 7);
  expect(await opened(v)).toEqual({ name: "compare", from: "1", to: "2", file: "src/auth.ts", line: 7 });
  v.changes.diff.clearSelection();

  const all = await changes("base", "2");
  frame(all, 120, 40);
  for (const path of ["docs/limits.png", "README.md"]) {
    all.changes.diff.goTo(all.changes.diff.itemRow(all.changes.diff.items.findIndex((x) => x.key === path)));
    expect(await opened(all)).toEqual({ name: "compare", from: "base", to: "2", file: path });
  }

  const t = await view(ids.timing);
  expect(await opened(t)).toEqual({ name: "thread", id: ids.timing });
  t.focus = "code";
  frame(t, 180, 46);
  t.code.enter();
  t.codeCursor = true;
  expect(await opened(t)).toEqual({ name: "compare", from: "1", to: "2", file: "src/auth.ts", line: 6 });
  t.peek = { path: "src/limiter.ts", sha: t.detail!.timeline[1]!.sha, label: "v2", line: 4, end: 5 };
  expect(await opened(t)).toEqual({ name: "compare", from: "base", to: "2", file: "src/limiter.ts", line: 4, end: 5 });
});

/** The thread `id` with the branch's files known, as the app loads them for names in messages. */
async function withFiles(id: number): Promise<ViewState> {
  const v = await view(id);
  const d = await api.compare(review, "base", "2");
  const paths = d.files.filter((f) => f.status !== "D").map((f) => f.path);
  v.branch = { key: "k", ref: "2", sha: d.to.sha, label: d.to.label, paths, index: fileIndex(paths) };
  v.trees = new Map([[d.to.sha, fileIndex((await api.files(d.to.sha)).paths ?? [])]]);
  return v;
}

const linkTexts = (v: ViewState, w: number, h: number) => render(v, w, h).rows.flatMap((r) => r.filter((x) => x.c?.includes("fref")).map((x) => `${x.text}=${x.hit}`));

test("120×40: the files a message names are links, a name two files have too; a name of no file stays text", async () => {
  const v = await withFiles(ids.port);
  v.focus = "code";
  const links = linkTexts(v, 120, 40);
  const reply = v.detail!.comments.find((c) => c.role === "agent")!.id;
  expect(links.join(" ")).toContain(`src/server.ts:3-4=fref:${reply}:0`);
  expect(links.join(" ")).toContain(`routes.ts:12=fref:${reply}:1`);
  expect(links.join(" ")).toContain("src/limiter.ts#L4");
  expect(frame(v, 120, 40)).toMatchSnapshot();
});

test("180×46 and 80×24: a file a message named opens over the thread's code at the message's code, its lines in sight", async () => {
  const v = await withFiles(ids.port);
  v.focus = "code";
  const d = v.detail!;
  const reply = d.comments.find((c) => c.role === "agent")!;
  const blob = await api.blob(reply.snapshot!, "src/server.ts");
  v.peek = { path: "src/server.ts", sha: reply.snapshot!, label: "v2", line: 3, end: 4, note: "as in the agent's reply on #10 (v2)", text: blob.contents };
  v.toPeek = true;
  const wide = frame(v, 180, 46);
  expect(wide).toContain("src/server.ts · as in the agent's reply on #10 (v2) · lines 3–4");
  expect(wide).toContain("Esc  back to the thread's code");
  expect(wide).toContain("const PORT = Number(process.env.PORT ?? 8080);");
  expect(wide).toMatch(/▌\s+3\s+const PORT/);
  expect(wide).toMatchSnapshot();
  v.toPeek = true;
  const narrow = frame(v, 80, 24);
  expect(narrow).toContain("src/server.ts · as in the agent's reply");
  expect(narrow).toContain("export function start()");
  expect(narrow).toMatchSnapshot();
});
