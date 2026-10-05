import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ThreadDetail } from "../../src/core/types.ts";
import { thread } from "../helpers/threads.ts";

const realFetch = globalThis.fetch;
GlobalRegistrator.register({ url: "http://127.0.0.1:4000/" });
(globalThis as { __STET_NO_WORKERS?: boolean }).__STET_NO_WORKERS = true;
const calls: string[] = [];
let respond: ((url: string, init?: RequestInit) => Response | null) | null = null;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push(`${init?.method ?? "GET"} ${url}`);
  const own = respond?.(url, init);
  if (own) return own;
  if (url.includes("/resolve")) return new Promise<Response>(() => {});
  if (url.startsWith("/api/blob")) {
    const sha = new URL(url, "http://x").searchParams.get("sha");
    return Response.json({ sha, path: "src/a.kt", exists: true, binary: false, contents: sha === "s0" ? "a\nb\nc\nd\n" : "a\nB!\nc\nd\n" });
  }
  return Response.json({ ok: true });
}) as typeof fetch;

const { render } = await import("preact");
const state = await import("../../web/state.ts");
const { ThreadTree } = await import("../../web/views/ThreadTree.tsx");
const { ThreadDetailView } = await import("../../web/views/ThreadDetail.tsx");
const { handleKey } = await import("../../web/keys.ts");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  state.reviewId.value = 1;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

function key(k: string): boolean {
  return handleKey(new KeyboardEvent("keydown", { key: k }));
}

describe("thread tree", () => {
  test("lists threads grouped by file with badges, and opens one on click", async () => {
    state.threads.value = [
      thread({ id: 1, path: "src/a.kt", range: { start: 10, end: 12 }, unread: true, needsReply: "reviewer", title: "Bug here" }),
      thread({ id: 2, path: "src/b.kt", title: "Rename", draft: true }),
    ];
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<ThreadTree />, host);
    const groups = [...host.querySelectorAll(".file-group h3 .file-name")].map((e) => e.textContent);
    expect(groups).toEqual(["a.kt", "b.kt"]);
    const first = host.querySelector(".thread-row")!;
    expect(first.classList.contains("unread")).toBe(true);
    expect(first.textContent).toContain("your turn");
    expect(host.textContent).toContain("draft");
    (first.querySelector("a") as HTMLAnchorElement).click();
    expect(location.hash).toBe("#/thread/1");
    render(null, host);
  });
});

describe("thread detail", () => {
  const detail: ThreadDetail = {
    thread: thread({ id: 7, path: "src/a.kt", range: { start: 2, end: 2 }, title: "Why?" }),
    comments: [
      { id: 1, threadId: 7, parentId: null, role: "reviewer", author: "alice", body: "Why `B`?", intent: null, draft: false, snapshot: "s0", version: 1, createdAt: "2026-09-23T00:00:00Z", updatedAt: null, step: 0, unread: false },
      { id: 2, threadId: 7, parentId: 1, role: "agent", author: "claude", body: "Fixed.", intent: "fixed", draft: false, snapshot: "s1", version: 1, createdAt: "2026-09-23T00:01:00Z", updatedAt: null, step: 1, unread: false },
      { id: 3, threadId: 7, parentId: 2, role: "reviewer", author: "alice", body: "Thanks", intent: null, draft: true, snapshot: "s1", version: 2, createdAt: "2026-09-23T00:02:00Z", updatedAt: null, step: 1, unread: false },
    ],
    events: [],
    timeline: [
      { index: 0, kind: "anchor", label: "v1", sha: "s0", version: 1, state: "ok", method: "identity", path: "src/a.kt", range: { start: 2, end: 2 }, excerpt: null, commentIds: [1] },
      { index: 1, kind: "version", label: "v2", sha: "s1", version: 2, state: "changed", method: "boundary", path: "src/a.kt", range: { start: 2, end: 2 }, excerpt: null, commentIds: [2, 3] },
    ],
    code: { then: { sha: "s0", path: "src/a.kt", start: 2, end: 2, firstLine: 1, lines: ["a", "b", "c"] }, now: null, interdiff: null },
  };

  test("renders the timeline and the nested conversation, and keys drive it", async () => {
    state.route.value = { name: "thread", id: 7 };
    state.detail.value = detail;
    state.selectedStep.value = null;
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<ThreadDetailView id={7} />, host);
    await tick();
    const steps = [...host.querySelectorAll(".timeline .step")];
    expect(steps.map((s) => s.querySelector(".step-label")!.textContent)).toEqual(["v1", "v2"]);
    expect(steps[1]!.classList.contains("selected")).toBe(true);
    const depth = [...host.querySelectorAll(".comment")].map((c) => [c.querySelector(".author")!.textContent, c.className.match(/depth-(\d)/)![1]]);
    expect(depth).toEqual([["alice", "0"], ["claude", "1"], ["alice", "2"]]);
    expect(host.querySelector(".body code")!.textContent).toBe("B");
    expect(host.textContent).toContain("discard");

    expect(key("[")).toBe(true);
    await tick();
    expect(host.querySelectorAll(".timeline .step")[0]!.classList.contains("selected")).toBe(true);
    expect(key("t")).toBe(true);
    expect(state.codeMode.value).toBe("then");
    calls.length = 0;
    expect(key("x")).toBe(true);
    expect(calls).toEqual(["POST /api/threads/7/resolve?review=1"]);
    render(null, host);
  });

  test("the conversation goes left of the code and back, remembered with its width; Space u L resets both", async () => {
    const { setWidth } = await import("../../web/components/Splitter.tsx");
    state.route.value = { name: "thread", id: 7 };
    state.detail.value = detail;
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<ThreadDetailView id={7} />, host);
    await tick();
    const swappedNow = () => host.querySelector(".detail")!.classList.contains("msgs-left");
    expect(swappedNow()).toBe(false);
    setWidth("msgs", 500);
    (host.querySelector(".msgs-splitter .splitter-swap") as HTMLButtonElement).click();
    await tick();
    expect(swappedNow()).toBe(true);
    expect(localStorage.getItem("stet.swap.thread")).toBe("1");
    expect((host.querySelector(".detail") as HTMLElement).style.getPropertyValue("--msgs-w")).toBe("500px");
    for (const k of [" ", "u", "l"]) key(k);
    await tick();
    expect(swappedNow()).toBe(false);
    expect(localStorage.getItem("stet.swap.thread")).toBe(null);
    for (const k of [" ", "u", "l", " ", "u", "L"]) key(k);
    await tick();
    expect(swappedNow()).toBe(false);
    expect(localStorage.getItem("stet.swap.thread")).toBe(null);
    expect(localStorage.getItem("stet.w.msgs")).toBe(null);
    render(null, host);
  });

  test("marks the thread read after it has been on screen", async () => {
    calls.length = 0;
    state.detail.value = { ...detail, thread: { ...detail.thread, unread: true } };
    state.threads.value = [state.detail.value.thread];
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<ThreadDetailView id={7} />, host);
    await tick(900);
    expect(calls.some((c) => c.startsWith("POST /api/read"))).toBe(true);
    expect(state.threads.value[0]!.unread).toBe(false);
    render(null, host);
  });
});

describe("code rendering", () => {
  test("pierre renders the diff and slots the thread marker next to the line", async () => {
    const { DiffView } = await import("../../web/components/Code.tsx");
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      <DiffView
        diffStyle="split"
        oldFile={{ name: "a.kt", contents: "fun a() {\n  val x = 1\n}\n" }}
        newFile={{ name: "a.kt", contents: "fun a() {\n  val x = 2\n}\n" }}
        annotations={[{ side: "additions", lineNumber: 2, metadata: 1 }]}
        renderAnnotation={() => <div class="anno-focus">thread #1</div>}
      />,
      host,
    );
    await tick(300);
    const container = host.querySelector("diffs-container");
    expect(container?.shadowRoot?.textContent).toContain("a.kt");
    expect(container?.shadowRoot?.textContent).toContain("-1+1");
    expect(host.querySelector(".anno-focus")?.textContent).toBe("thread #1");
    render(null, host);
  });
});

describe("review regressions", () => {
  const base = (id: number, unread: boolean): ThreadDetail => ({
    thread: thread({ id, path: "src/a.kt", range: { start: 2, end: 2 }, unread }),
    comments: [{ id: id * 10, threadId: id, parentId: null, role: "reviewer", author: "alice", body: "x", intent: null, draft: false, snapshot: "s0", version: 1, createdAt: "2026-09-23T00:00:00Z", updatedAt: null, step: 0, unread: false }],
    events: [],
    timeline: [{ index: 0, kind: "anchor", label: "v1", sha: "s0", version: 1, state: "ok", method: "identity", path: "src/a.kt", range: { start: 2, end: 2 }, excerpt: null, commentIds: [id * 10] }],
    code: { then: { sha: "s0", path: "src/a.kt", start: 2, end: 2, firstLine: 1, lines: ["a", "b"] }, now: null, interdiff: null },
  });

  test("a reply arriving while the thread is open is marked read too", async () => {
    calls.length = 0;
    state.route.value = { name: "thread", id: 8 };
    state.detail.value = base(8, true);
    state.threads.value = [state.detail.value.thread];
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<ThreadDetailView id={8} />, host);
    await tick(900);
    state.detail.value = base(8, true);
    state.threads.value = [state.detail.value.thread];
    await tick(900);
    expect(calls.filter((c) => c.startsWith("POST /api/read")).length).toBe(2);
    expect(state.threads.value[0]!.unread).toBe(false);
    render(null, host);
  });

  test("x resolves the thread on screen in one keypress, never a previous one", async () => {
    state.route.value = { name: "thread", id: 3 };
    state.detail.value = base(3, false);
    state.navigate({ name: "thread", id: 9 });
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    state.route.value = { name: "thread", id: 9 };
    state.detail.value = base(9, false);
    calls.length = 0;
    expect(key("x")).toBe(true);
    await tick();
    expect(calls.filter((c) => c.includes("/resolve"))).toEqual(["POST /api/threads/9/resolve?review=1"]);
  });
});

describe("landing and unsent text", () => {
  test("the landing page opens the compare of the latest version", async () => {
    state.status.value = { versions: 1, versionsList: [{ number: 1 }], now: { changedSinceLatest: false } } as never;
    state.loading.value = false;
    state.route.value = { name: "home" };
    await tick();
    expect(state.route.value as unknown).toEqual({ name: "compare", from: "base", to: "1" });
    expect(location.hash).toBe("#/compare/base..1");
  });

  test("a review with no threads opens the side panel on its files, without remembering that", async () => {
    const { landTab, sideTab } = await import("../../web/compare.ts");
    state.route.value = { name: "compare", from: "base", to: "1" };
    sideTab.value = "threads";
    expect(localStorage.getItem("stet.sideTab")).toBe("threads");
    state.threads.value = [thread({ id: 1, path: "src/a.kt" })];
    landTab();
    expect(sideTab.value).toBe("threads");
    state.threads.value = [];
    landTab();
    expect(sideTab.value as string).toBe("files");
    expect(localStorage.getItem("stet.sideTab")).toBe("threads");
    sideTab.value = "files";
    expect(localStorage.getItem("stet.sideTab")).toBe("files");
    sideTab.value = "threads";
  });

  test("text typed into a comment box survives a reload until it is sent", async () => {
    const { Composer } = await import("../../web/components/Composer.tsx");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sent: string[] = [];
    const box = () => <Composer storageKey="reply:1:7" onSubmit={async (b) => { sent.push(b); }} />;
    render(box(), host);
    const ta = host.querySelector("textarea")!;
    ta.value = "half-written thought";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    render(null, host);
    render(box(), host);
    expect(host.querySelector("textarea")!.value).toBe("half-written thought");
    (host.querySelector(".btn.primary") as HTMLButtonElement).click();
    await tick();
    expect(sent).toEqual(["half-written thought"]);
    render(null, host);
    render(box(), host);
    expect(host.querySelector("textarea")!.value).toBe("");
    render(null, host);
  });
});

describe("keys", () => {
  test("hotkeys work in the Russian layout by physical key", async () => {
    const { keyToken } = await import("../../web/keys.ts");
    const ev = (key: string, code: string, shiftKey = false) => new KeyboardEvent("keydown", { key, code, shiftKey });
    expect(keyToken(ev("о", "KeyJ"))).toBe("j");
    expect(keyToken(ev("О", "KeyJ", true))).toBe("J");
    expect(keyToken(ev("х", "BracketLeft"))).toBe("[");
    expect(keyToken(ev("Ъ", "BracketRight", true))).toBe("}");
    expect(keyToken(ev(" ", "Space"))).toBe("<Space>");
    expect(keyToken(new KeyboardEvent("keydown", { key: "в", code: "KeyD", ctrlKey: true }))).toBe("<C-d>");
  });

  test("the / key works in the Russian layout, where it types a dot, and ? with Shift; other layouts keep their own punctuation", async () => {
    const { keyToken } = await import("../../web/keys.ts");
    const ev = (key: string, code: string, shiftKey = false) => new KeyboardEvent("keydown", { key, code, shiftKey });
    expect(keyToken(ev(".", "Slash"))).toBe("/");
    expect(keyToken(ev(",", "Slash", true))).toBe("?");
    expect(keyToken(ev("/", "Slash"))).toBe("/");
    expect(keyToken(ev("-", "Slash"))).toBe("-");
    expect(keyToken(ev(".", "Period"))).toBe(".");
  });

  test("only text fields swallow keys: a focused checkbox, select or button does not", async () => {
    const { typing } = await import("../../web/keys.ts");
    const el = (html: string) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      return host.firstElementChild!;
    };
    expect(typing(el(`<input type="checkbox">`))).toBe(false);
    expect(typing(el(`<select><option>a</option></select>`))).toBe(false);
    expect(typing(el(`<button>b</button>`))).toBe(false);
    expect(typing(el(`<input>`))).toBe(true);
    expect(typing(el(`<input type="search">`))).toBe(true);
    expect(typing(el(`<textarea></textarea>`))).toBe(true);
  });
});

describe("which range opens by default", () => {
  const v = (number: number) => ({ number, snapshot: `s${number}`, createdAt: "2026-09-24T10:00:00Z", author: "claude", role: "agent" });
  const setup = (n: number, dirty: boolean, reviewed: { version: number | null; sha: string } | null) => {
    state.status.value = { versions: n, versionsList: Array.from({ length: n }, (_, i) => v(i + 1)), now: { sha: "nowsha", changedSinceLatest: dirty } } as never;
    state.reviewedCursor.value = reviewed ? { ...reviewed, label: reviewed.version ? `v${reviewed.version}` : reviewed.sha.slice(0, 8), at: "2026-09-24T09:00:00Z" } : null;
  };

  test("the latest version against the one before, or “now” when the agent changed code after it", () => {
    setup(3, false, null);
    expect(state.defaultCompare()).toEqual({ from: "2", to: "3" });
    setup(3, true, null);
    expect(state.defaultCompare()).toEqual({ from: "3", to: "now" });
  });

  test("since the reviewer's last pass when there is one", () => {
    setup(3, false, { version: 1, sha: "s1" });
    expect(state.defaultCompare()).toEqual({ from: "1", to: "3" });
    setup(3, true, { version: 3, sha: "s3" });
    expect(state.defaultCompare()).toEqual({ from: "3", to: "now" });
    setup(3, true, { version: null, sha: "0123456789abcdef" });
    expect(state.defaultCompare()).toEqual({ from: "0123456789abcdef", to: "now" });
    setup(3, false, { version: 3, sha: "s3" });
    expect(state.defaultCompare()).toEqual({ from: "2", to: "3" });
    expect(state.presets().map((p) => p.id)).toEqual(["round", "branch"]);
    state.reviewedCursor.value = null;
  });
});

describe("request changes or approve", () => {
  const submits: { body: string; verdict?: string; open?: string }[] = [];
  let serverDrafts: unknown[] = [];
  const review = {
    versions: 2,
    versionsList: [1, 2].map((number) => ({ number, snapshot: `s${number}`, createdAt: "2026-09-24T10:00:00Z", author: "claude", role: "agent" })),
    now: { sha: "s2", changedSinceLatest: false },
    lastSubmission: null,
  };
  const draft = (threadId: number) => ({ id: 50 + threadId, threadId, parentId: threadId * 10, role: "reviewer", author: "alice", body: "nit", intent: null, draft: true, snapshot: "s2", version: 2, createdAt: "2026-09-24T11:00:00Z", updatedAt: null, step: 1, unread: false });
  const host = document.createElement("div");
  let views: typeof import("../../web/views/Drafts.tsx");
  let choice: typeof import("../../web/components/Choice.tsx");

  beforeAll(async () => {
    views = await import("../../web/views/Drafts.tsx");
    choice = await import("../../web/components/Choice.tsx");
    document.body.appendChild(host);
    respond = (url, init) => {
      if (url.startsWith("/api/review/submit")) {
        const b = JSON.parse(String(init?.body));
        submits.push(b);
        serverDrafts = [];
        return Response.json({ submission: submits.length, verdict: b.verdict ?? "changes", version: 2, threads: [], comments: 0, resolved: b.open === "resolve" ? [4] : [] });
      }
      if (url.startsWith("/api/review?")) return Response.json(review);
      if (url.startsWith("/api/threads?")) return Response.json(state.threads.value);
      if (url.startsWith("/api/drafts")) return Response.json(serverDrafts);
      if (url.startsWith("/api/cursors")) return Response.json({ reviewed: null, viewed: [] });
      return null;
    };
  });

  afterAll(() => {
    render(null, host);
    respond = null;
  });

  const show = async (open: ReturnType<typeof thread>[], mine: ReturnType<typeof draft>[]) => {
    serverDrafts = mine;
    state.status.value = review as never;
    state.threads.value = open;
    state.drafts.value = mine as never;
    state.route.value = { name: "drafts" };
    submits.length = 0;
    render(<><views.DraftsView /><choice.ChoiceDialog /></>, host);
    await tick();
  };
  const dialog = () => host.querySelector(".choice h3")?.textContent ?? null;
  const pick = async (label: string) => {
    [...host.querySelectorAll<HTMLButtonElement>(".choice button")].find((b) => b.textContent === label)!.click();
    await tick(60);
  };

  test("with no drafts only Approve is on, and S approves; open threads ask first, Esc cancels", async () => {
    await show([thread({ id: 4, path: "src/a.kt", title: "Still open" })], []);
    const [changes, approve] = [...host.querySelectorAll<HTMLButtonElement>(".submit-actions button")];
    expect(changes!.disabled).toBe(true);
    expect(approve!.textContent).toContain("Approve v2");
    expect(approve!.querySelector("kbd")?.textContent).toBe("S");

    expect(key("S")).toBe(true);
    await tick();
    expect(dialog()).toBe("1 thread still open");
    expect(host.querySelector(".choice-body")!.textContent).toContain("#4 Still open");
    expect(key("S")).toBe(false);
    host.querySelector(".choice")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    expect(dialog()).toBeNull();
    expect(submits).toEqual([]);

    expect(key("S")).toBe(true);
    await tick(60);
    const options = () => [...host.querySelectorAll<HTMLButtonElement>(".choice button")].map((b) => b.textContent);
    expect(options()).toEqual(["Approve anyway", "Resolve all and approve", "Cancel"]);
    expect(document.activeElement?.textContent).toBe("Approve anyway");
    host.querySelector(".choice")!.dispatchEvent(new KeyboardEvent("keydown", { key: "j", code: "KeyJ", bubbles: true }));
    await tick();
    expect(document.activeElement?.textContent).toBe("Resolve all and approve");
    expect(host.querySelector(".choice .btn.on")?.textContent).toBe("Resolve all and approve");
    host.querySelector(".choice")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick(60);
    expect(submits).toEqual([{ body: "", verdict: "approved", open: "resolve" }]);
    expect(dialog()).toBeNull();
  });

  test("with drafts S requests changes; Approve asks whether the drafts go as nits", async () => {
    await show([thread({ id: 5, path: "src/a.kt", needsReply: "reviewer" })], [draft(5)]);
    const [changes, approve] = [...host.querySelectorAll<HTMLButtonElement>(".submit-actions button")];
    expect(changes!.disabled).toBe(false);
    expect(changes!.querySelector("kbd")?.textContent).toBe("S");
    expect(approve!.querySelector("kbd")).toBeNull();

    approve!.click();
    await tick();
    expect(dialog()).toBe("Approve with 1 draft?");
    await pick("Approve; drafts go as nits (the agent fixes them without a new round)");
    expect(submits).toEqual([{ body: "", verdict: "approved" }]);

    await show([thread({ id: 5, path: "src/a.kt", needsReply: "reviewer" })], [draft(5)]);
    (host.querySelectorAll<HTMLButtonElement>(".submit-actions button")[1]!).click();
    await tick();
    await pick("Send as Request changes");
    expect(submits).toEqual([{ body: "" }]);

    await show([], [draft(5)]);
    expect(key("S")).toBe(true);
    await tick(60);
    expect(dialog()).toBeNull();
    expect(submits).toEqual([{ body: "" }]);
  });
});

describe("links to lines", () => {
  const path = "src/a.kt";
  let compare: typeof import("../../web/compare.ts");
  const copied: string[] = [];

  beforeAll(async () => {
    const { parsePatchFiles } = await import("@pierre/diffs");
    compare = await import("../../web/compare.ts");
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true });
    state.route.value = { name: "compare", from: "1", to: "2" };
    compare.compareData.value = { from: { ref: "1", sha: "s1", label: "v1" }, to: { ref: "2", sha: "s2", label: "v2" }, files: [], placements: [], outside: [] };
    compare.baseFiles.value = parsePatchFiles(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,4 +1,4 @@\n a\n-b\n+B!\n c\n d\n`, "t").flatMap((p) => p.files);
  });

  afterAll(() => {
    compare.baseFiles.value = null;
    compare.compareData.value = null;
    compare.cursor.value = null;
  });

  test("Space g Y copies a link to the cursor line, in visual mode to the selection; removed lines say side=old; no token", async () => {
    const copy = async () => {
      for (const k of [" ", "g", "Y"]) key(k);
      await tick();
      return copied.pop();
    };
    compare.cursor.value = { path, row: 2 };
    expect(await copy()).toBe("http://127.0.0.1:4000/#/compare/1..2?file=src%2Fa.kt&line=2&review=1");
    compare.visualAnchor.value = { path, row: 4 };
    compare.cursor.value = { path, row: 2 };
    expect(await copy()).toBe("http://127.0.0.1:4000/#/compare/1..2?file=src%2Fa.kt&line=2-4&review=1");
    expect(compare.visualAnchor.value).toBeNull();
    compare.cursor.value = { path, row: 1 };
    expect(await copy()).toBe("http://127.0.0.1:4000/#/compare/1..2?file=src%2Fa.kt&line=2&side=old&review=1");
    expect(state.toast.value?.text).toBe("copied a link to src/a.kt:2 (removed lines)");
  });

  test("linked lines are highlighted until the cursor leaves them", () => {
    compare.cursor.value = { path, row: 2 };
    compare.linkedLines.value = { path, side: "additions", start: 2, end: 3 };
    expect(compare.marksByPath.value.get(path)?.find((m) => m.tag === "linked")).toEqual({ side: "additions", start: 2, end: 3, tag: "linked" });
    compare.cursor.value = { path, row: 3 };
    expect(compare.linkedLines.value).not.toBeNull();
    compare.cursor.value = { path, row: 4 };
    expect(compare.linkedLines.value).toBeNull();
    expect(compare.marksByPath.value.get(path)?.some((m) => m.tag === "linked") ?? false).toBe(false);
  });
});
