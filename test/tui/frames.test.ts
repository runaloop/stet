import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { clientApi, type Api } from "../../src/client/api.ts";
import type { ThreadDetail } from "../../src/core/types.ts";
import { rowText } from "../../src/tui/grid.ts";
import { KeyMatcher } from "../../src/tui/keys/match.ts";
import { KEYS } from "../../src/tui/keys/table.ts";
import { initialView, render, type ViewState } from "../../src/tui/render.ts";
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
  expect(text).not.toContain("+find");
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
  expect(thread).toContain("1 of 6");
  expect(thread).not.toContain("Threads Files Search");
  v.listOpen = true;
  v.focus = "list";
  const list = frame(v, 80, 24);
  expect(list).toContain("Threads Files Search");
  expect(thread).toMatchSnapshot();
  expect(list).toMatchSnapshot();
});
