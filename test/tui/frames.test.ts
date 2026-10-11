import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { clientApi, type Api } from "../../src/client/api.ts";
import type { ThreadDetail } from "../../src/core/types.ts";
import { parsePatchFiles } from "@pierre/diffs";
import { createTestRenderer } from "@opentui/core/testing";
import { viewedKey } from "../../src/ui/viewed.ts";
import { syncChanges } from "../../src/tui/changes.ts";
import { colorMode } from "../../src/tui/diff/colors.ts";
import { Screen } from "../../src/tui/screen.ts";
import { fetchWide, scopesOf, wideKey } from "../../src/tui/code.ts";
import { rowText } from "../../src/tui/grid.ts";
import { KeyMatcher } from "../../src/tui/keys/match.ts";
import { KEYS } from "../../src/tui/keys/table.ts";
import { helpFor, initialView, render, type ViewState } from "../../src/tui/render.ts";
import { width } from "../../src/tui/text.ts";
import { seedTui, type Seeded } from "../fixtures/tui-seed.ts";
import { Fixture, GIT_ENV } from "../helpers/fixture.ts";

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
  const m = new KeyMatcher(KEYS, () => {});
  m.feed("<Space>", ["list", "global"]);
  v.prefix = [...m.prefix];
  v.next = m.next(["list", "global"]);
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
  expect(text).toContain("7 files · base → v2");
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
  v.help = helpFor("list");
  const text = frame(v, 120, 40);
  expect(text).toContain("Moving around");
  expect(text).toContain("Space e  Space s t");
  expect(text).toContain("Shift+drag");
  expect(text).toMatchSnapshot();
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
  v.help = helpFor("changes");
  const text = v.help.map((l) => l.spans.map((x) => x.text).join("")).join("\n");
  for (const k of ["] t ", "[ t ", "] b  L", "] c", "z a", "m ", "] v", "{", "p ", "Enter  o"]) expect(text).toContain(k);
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
