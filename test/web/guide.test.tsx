import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CompareDto, GuideDto } from "../../src/core/types.ts";
import { thread } from "../helpers/threads.ts";

const realFetch = globalThis.fetch;
GlobalRegistrator.register({ url: "http://127.0.0.1:4000/" });
(globalThis as { __STET_NO_WORKERS?: boolean }).__STET_NO_WORKERS = true;

const lines = (n: number, edits: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
const TEXTS: Record<string, string> = {
  "s1:src/a.kt": lines(20),
  "s2:src/a.kt": lines(20, { 4: "line 4, changed" }),
  "s2:src/b.kt": "fun b() = 1\n",
};

const GUIDE: GuideDto = {
  version: 2,
  title: "Keep x",
  intro: "",
  steps: [
    { index: 1, text: "Keeps **x** <b>raw</b>, as #5 asked; #77 is no thread.", refs: [{ path: "src/a.kt", range: { start: 4, end: 5 } }], threads: [5, 77] },
    { index: 2, text: "A new file.", refs: [{ path: "src/b.kt", range: null }], threads: [] },
  ],
};

const asked: string[] = [];
const posted: unknown[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  asked.push(url);
  if (url.startsWith("/api/threads") && init?.method === "POST") {
    posted.push(JSON.parse(String(init.body)));
    return Response.json({ id: 99 });
  }
  if (url.startsWith("/api/review?")) return Response.json(state.status.value);
  if (url.startsWith("/api/threads?")) return Response.json(state.threads.value);
  if (url.startsWith("/api/drafts")) return Response.json([]);
  if (url.startsWith("/api/cursors")) return Response.json({ reviewed: null, viewed: [] });
  if (url.startsWith("/api/guide")) return Response.json(GUIDE);
  if (url.startsWith("/api/blob")) {
    const q = new URL(url, "http://x").searchParams;
    const contents = TEXTS[`${q.get("sha")}:${q.get("path")}`] ?? null;
    return Response.json({ sha: q.get("sha"), path: q.get("path"), exists: contents !== null, binary: false, contents });
  }
  return Response.json({ ok: true });
}) as typeof fetch;

const { parsePatchFiles } = await import("@pierre/diffs");
const { render } = await import("preact");
const state = await import("../../web/state.ts");
const compare = await import("../../web/compare.ts");
const guide = await import("../../web/guide.ts");
const lib = await import("../../web/lib/guide.ts");
const { GuideToggle, GuideView } = await import("../../web/components/Guide.tsx");
const { handleKey } = await import("../../web/keys.ts");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const press = (...keys: string[]) => keys.forEach((k) => handleKey(new KeyboardEvent("keydown", { key: k })));

const PATCH = `diff --git a/src/a.kt b/src/a.kt
--- a/src/a.kt
+++ b/src/a.kt
@@ -1,7 +1,7 @@
 line 1
 line 2
 line 3
-line 4
+line 4, changed
 line 5
 line 6
 line 7
diff --git a/src/b.kt b/src/b.kt
new file mode 100644
--- /dev/null
+++ b/src/b.kt
@@ -0,0 +1 @@
+fun b() = 1
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;

const DATA: CompareDto = {
  from: { ref: "1", sha: "s1", label: "v1" },
  to: { ref: "2", sha: "s2", label: "v2" },
  files: [
    { path: "src/a.kt", oldPath: "src/a.kt", status: "M", additions: 1, deletions: 1, binary: false },
    { path: "src/b.kt", oldPath: null, status: "A", additions: 1, deletions: 0, binary: false },
    { path: "README.md", oldPath: "README.md", status: "M", additions: 1, deletions: 1, binary: false },
  ],
  placements: [{ threadId: 5, side: "additions", path: "src/a.kt", range: { start: 4, end: 4 }, state: "ok" }],
  outside: [],
};

beforeAll(() => {
  state.reviewId.value = 1;
  state.status.value = { review: { source: "worktree" }, versionsList: [{ number: 1 }, { number: 2, guide: true }] } as never;
  state.threads.value = [thread({ id: 5, path: "src/a.kt", range: { start: 4, end: 4 }, title: "Why 4?" })];
  state.route.value = { name: "compare", from: "1", to: "2" };
  compare.compareData.value = DATA;
  compare.baseFiles.value = parsePatchFiles(PATCH, "guide-test").flatMap((p) => p.files);
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

describe("the guide's pieces", () => {
  test("a step's lines with three lines around them, and the lines removed among them", () => {
    const a = { path: "src/a.kt", text: TEXTS["s1:src/a.kt"]! };
    const b = { path: "src/a.kt", text: TEXTS["s2:src/a.kt"]! };
    const hunks = compare.baseFiles.value![0]!.hunks;
    const patch = lib.refPatch({ path: "src/a.kt", range: { start: 4, end: 5 } }, a, b, hunks)!;
    expect(patch.split("\n").slice(3, -1)).toEqual(["@@ -1,8 +1,8 @@", " line 1", " line 2", " line 3", "-line 4", "+line 4, changed", " line 5", " line 6", " line 7", " line 8"]);
    expect(lib.refPatch({ path: "src/a.kt", range: { start: 15, end: 15 } }, a, b, hunks, [], 1)!.split("\n").slice(3, -1)).toEqual(["@@ -14,3 +14,3 @@", " line 14", " line 15", " line 16"]);
    expect(lib.refPatch({ path: "src/a.kt", range: null }, a, b, hunks)).toBeNull();
    expect(lib.refPatch({ path: "src/a.kt", range: null }, a, b, hunks, [{ start: 8, end: 9 }])!.split("\n").slice(-4, -1)).toEqual([" line 7", " line 8", " line 9"]);
  });

  test("rendered, a step shows its own lines and those opened, not the lines around them; a whole-file step its file's diff", () => {
    const a = { path: "src/a.kt", text: TEXTS["s1:src/a.kt"]! };
    const b = { path: "src/a.kt", text: TEXTS["s2:src/a.kt"]! };
    const hunks = compare.baseFiles.value![0]!.hunks;
    expect(lib.refShown({ path: "src/a.kt", range: { start: 4, end: 5 } }, a, b, hunks)).toEqual({ old: [{ start: 4, end: 5 }], new: [{ start: 4, end: 5 }] });
    expect(lib.refShown({ path: "src/a.kt", range: { start: 4, end: 5 } }, a, b, hunks, [{ start: 12, end: 13 }])).toEqual({
      old: [{ start: 4, end: 5 }, { start: 12, end: 13 }],
      new: [{ start: 4, end: 5 }, { start: 12, end: 13 }],
    });
    expect(lib.refShown({ path: "src/a.kt", range: null }, a, b, hunks)).toEqual({ old: [{ start: 1, end: 7 }], new: [{ start: 1, end: 7 }] });
    expect(lib.refShown({ path: "src/a.kt", range: null }, a, b, hunks, [{ start: 9, end: 9 }])).toEqual({ old: [{ start: 1, end: 7 }, { start: 9, end: 9 }], new: [{ start: 1, end: 7 }, { start: 9, end: 9 }] });
  });

  test("lines opened around a step's lines in a new file stay added lines", () => {
    const hunks = compare.baseFiles.value![1]!.hunks;
    const b = { path: "src/b.kt", text: lines(6) };
    const body = (more: { start: number; end: number }[]) => lib.refPatch({ path: "src/b.kt", range: { start: 4, end: 4 } }, { path: "src/b.kt", text: "" }, b, [{ ...hunks[0]!, additionCount: 6, hunkContent: [{ type: "change", deletions: 0, additions: 6 }] }], more, 0)!.split("\n").slice(3, -1);
    expect(body([])).toEqual(["@@ -0,0 +4,1 @@", "+line 4"]);
    expect(body([{ start: 1, end: 2 }])).toEqual(["@@ -0,0 +1,2 @@", "+line 1", "+line 2", "@@ -0,0 +4,1 @@", "+line 4"]);
  });

  test("files no step names, by their path or their old path", () => {
    expect(lib.notInGuide(DATA.files, GUIDE).map((f) => f.path)).toEqual(["README.md"]);
    const renamed = { ...DATA.files[2]!, path: "docs/README.md", oldPath: "README.md", status: "R" as const };
    expect(lib.notInGuide([renamed], { ...GUIDE, steps: [{ index: 1, text: "x", refs: [{ path: "README.md", range: null }], threads: [] }] })).toEqual([]);
  });

  test("threads on the lines a step shows, at the last of their lines it shows", () => {
    const p = (threadId: number, side: "additions" | "deletions", start: number, end: number) => ({ threadId, side, path: "a.kt", range: { start, end }, state: "ok" as const });
    const on = lib.threadsOn([p(1, "additions", 2, 9), p(2, "deletions", 3, 3), p(3, "additions", 20, 22), { ...p(4, "additions", 2, 2), path: "b.kt" }], "a.kt", { old: [1, 2, 3], new: [1, 2, 3, 4] });
    expect(on.map((x) => [x.placement.threadId, x.line])).toEqual([[1, 4], [2, 3]]);
  });

  test("Markdown with raw HTML as text, links that stay on the page, and #N linking the threads there are", () => {
    const html = lib.guideHtml("**Why** <script>x</script> [docs](https://example.com) for #5, `#5` and #6", (id) => (id === 5 ? "#/thread/5" : null));
    expect(html).toContain("<strong>Why</strong>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("href=\"https://");
    expect(html).toContain('<a class="guide-thread" href="#/thread/5" data-thread="5">#5</a>');
    expect(html).toContain("<code>#5</code>");
    expect(html).toContain("and #6");
  });
});

describe("the Guide tab", () => {
  test("shows next to the diff for a version with a guide; Space u g opens it, Esc goes back to the diff", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<><GuideToggle /><GuideView from="1" to="2" /></>, host);
    expect([...host.querySelectorAll(".guide-tabs button")].map((b) => b.textContent)).toEqual(["Diff", "Guide"]);
    expect(host.querySelector(".guide")).toBeNull();

    press(" ", "u", "g");
    await tick(300);
    expect(guide.guideOpen.value).toBe(true);
    expect(asked.some((u) => u.startsWith("/api/guide?") && u.includes("version=2"))).toBe(true);
    expect(host.querySelector(".guide-title")?.textContent).toBe("Keep x");
    const steps = [...host.querySelectorAll(".guide-step")];
    expect(steps.map((s) => s.getAttribute("data-step"))).toEqual(["1", "2"]);
    const text = steps[0]!.querySelector(".md")!;
    expect(text.querySelector("strong")?.textContent).toBe("x");
    expect(text.querySelector("b")).toBeNull();
    expect([...text.querySelectorAll("a.guide-thread")].map((a) => a.getAttribute("href"))).toEqual(["#/thread/5"]);
    expect(steps[0]!.querySelector(".guide-ref-head")?.textContent).toContain("lines 4–5");
    expect(steps[0]!.querySelector(".guide-ref .thread-mini")?.getAttribute("data-thread")).toBe("5");
    expect(steps[1]!.querySelector(".guide-ref-head")?.textContent).toContain("its whole change");
    expect([...host.querySelectorAll(".guide-rest li")].map((l) => l.textContent)).toEqual(["M README.md +1 −1"]);

    press("}", "}");
    await tick();
    expect(host.querySelector(".guide-step.focused")?.getAttribute("data-step")).toBe("2");
    press("j");
    expect(state.route.value).toEqual({ name: "compare", from: "1", to: "2" });

    press("Escape");
    await tick();
    expect(guide.guideOpen.value).toBe(false);
    expect(host.querySelector(".guide")).toBeNull();
    render(null, host);
  });

  test("open in Diff goes to the step's lines in the diff and closes the tab", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<GuideView from="1" to="2" />, host);
    guide.guideOpen.value = true;
    await tick(100);
    (host.querySelector(".guide-step[data-step='1'] a.guide-open") as HTMLAnchorElement).click();
    expect(location.hash).toBe("#/compare/1..2?file=src%2Fa.kt&line=4-5");
    expect(guide.guideOpen.value).toBe(false);
    render(null, host);
  });

  test("a step's file diff folds from its head, its bar or z a; zR opens them all; a long one starts folded", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<GuideView from="1" to="2" />, host);
    guide.guideOpen.value = true;
    await tick(150);
    const ref = () => host.querySelector(".guide-ref[data-key='1.0']")!;
    expect(ref().classList.contains("folded")).toBe(false);
    expect(ref().querySelector(".guide-ref-head .stat")?.textContent).toBe("+1 −1");
    (ref().querySelector(".guide-fold") as HTMLButtonElement).click();
    await tick();
    expect(ref().classList.contains("folded")).toBe(true);
    expect(ref().querySelector(".guide-fold .chev")?.textContent).toBe("▸");
    expect(ref().querySelector(".guide-unfold")?.textContent).toBe("▸ show 9 lines");
    expect(host.querySelector(".guide-step[data-step='1'] .md")).not.toBeNull();
    (ref().querySelector(".guide-unfold") as HTMLButtonElement).click();
    await tick();
    expect(ref().classList.contains("folded")).toBe(false);
    guide.guideAt.value = "1.0";
    press("z", "a");
    await tick();
    expect(ref().classList.contains("folded")).toBe(true);
    press("z", "R");
    await tick();
    expect(host.querySelectorAll(".guide-ref.folded").length).toBe(0);
    press("z", "M");
    await tick();
    expect(host.querySelectorAll(".guide-ref.folded").length).toBe(2);
    expect([guide.isFolded("other", guide.LONG), guide.isFolded("other", guide.LONG + 1)]).toEqual([false, true]);
    guide.guideFolds.value = new Map();
    guide.guideOpen.value = false;
    render(null, host);
  });

  test("the Files panel marks the file of the step in view; a file there goes to its step, or to the diff when no step names it", async () => {
    const { SidePanel } = await import("../../web/views/CompareSide.tsx");
    const host = document.createElement("div");
    document.body.appendChild(host);
    compare.sideTab.value = "files";
    guide.guideStep.value = null;
    render(<><GuideView from="1" to="2" /><SidePanel /></>, host);
    guide.guideOpen.value = true;
    await tick(150);
    const active = () => [...host.querySelectorAll(".file-row.active .file-name")].map((x) => x.textContent);
    press("}");
    await tick();
    expect(guide.guideAt.value).toBe("1.0");
    expect(active()).toEqual(["a.kt"]);
    press("}");
    await tick();
    expect(active()).toEqual(["b.kt"]);
    const row = (name: string) => [...host.querySelectorAll<HTMLAnchorElement>(".file-row .file-link")].find((a) => a.querySelector(".file-name")?.textContent === name)!;
    row("a.kt").click();
    await tick();
    expect(guide.guideAt.value).toBe("1.0");
    expect(active()).toEqual(["a.kt"]);
    expect(guide.guideOpen.value).toBe(true);
    row("README.md").click();
    await tick();
    expect(guide.guideOpen.value).toBe(false);
    expect(location.hash).toBe("#/compare/1..2?file=README.md");
    render(null, host);
    state.route.value = { name: "compare", from: "1", to: "2" };
  });

  test("a step's lines take comments as the diff does: i opens the box on the step's first line in the code, Esc leaves the code, then the guide", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<GuideView from="1" to="2" />, host);
    guide.guideOpen.value = true;
    await tick(150);
    guide.guideStep.value = null;
    compare.cursor.value = null;
    guide.guideAt.value = null;
    expect(compare.cursorSpace.value.files.map((f) => f.id)).toEqual(["1.0", "2.0"]);
    press("i");
    await tick();
    expect(compare.codeFocus.value).toBe(true);
    expect(compare.cursor.peek()).toEqual({ path: "1.0", row: compare.cursorSpace.value.locate("1.0", "additions", 4)!.row });
    expect(compare.pendingLines.value).toEqual({ path: "src/a.kt", oldPath: "src/a.kt", range: { start: 4, end: 4, side: "additions" }, guide: "1.0" });
    expect(host.querySelector(".guide")!.classList.contains("code-focus")).toBe(true);
    expect(host.querySelector(".guide-ref[data-key='1.0'] .new-thread .note")?.textContent).toContain("New thread on src/a.kt (v2) · lines 4");
    await compare.guideNav.current!.submitComment("why four?", "draft");
    expect(posted.pop()).toEqual({ path: "src/a.kt", start: 4, end: 4, side: "new", at: "s2", body: "why four?", draft: true });
    expect(compare.pendingLines.value).toBeNull();

    press("j");
    press("V", "k");
    expect(compare.visualAnchor.value).not.toBeNull();
    press("Escape");
    expect(compare.visualAnchor.value).toBeNull();
    press("Escape");
    expect(compare.codeFocus.value).toBe(false);
    expect(guide.guideOpen.value).toBe(true);
    press("Escape");
    expect(guide.guideOpen.value).toBe(false);
    await tick();
    render(null, host);
  });

  test("the diff and the Guide tab keep a cursor and a comment box each", () => {
    compare.guideOpen.value = true;
    compare.cursor.value = { path: "1.0", row: 1 };
    compare.pendingLines.value = null;
    compare.guideOpen.value = false;
    compare.cursor.value = { path: "src/a.kt", row: 2 };
    compare.pendingLines.value = { path: "src/a.kt", oldPath: "src/a.kt", range: { start: 3, end: 3, side: "additions" } };
    compare.guideOpen.value = true;
    expect(compare.cursor.value).toEqual({ path: "1.0", row: 1 });
    expect(compare.pendingLines.value).toBeNull();
    compare.guideOpen.value = false;
    expect(compare.cursor.value).toEqual({ path: "src/a.kt", row: 2 });
    expect(compare.pendingLines.value?.range.start).toBe(3);
    compare.guideOpen.value = true;
    expect(compare.cursor.value).toEqual({ path: "1.0", row: 1 });
    compare.guideOpen.value = false;
    compare.pendingLines.value = null;
  });

  test("a version without a guide has no tab, and Space u g says so", () => {
    compare.compareData.value = { ...DATA, to: { ref: "1", sha: "s1", label: "v1" }, from: { ref: "base", sha: "s0", label: "base" } };
    state.route.value = { name: "compare", from: "base", to: "1" };
    expect(guide.guideVersion.value).toBeNull();
    press(" ", "u", "g");
    expect(guide.guideOpen.value).toBe(false);
    expect(state.toast.value?.text).toContain("has no guide");
  });

  test("a version whose guide the review asked for opens on the Guide tab the first time; one nobody asked for, on the diff", async () => {
    guide.guideOpen.value = false;
    state.status.value = { versionsList: [{ number: 1 }, { number: 2, guide: true }, { number: 3, guide: true, guideRequested: true }] } as never;
    const to = (n: number) => {
      compare.compareData.value = { ...DATA, from: { ref: String(n - 1), sha: "s1", label: `v${n - 1}` }, to: { ref: String(n), sha: "s2", label: `v${n}` } };
      state.route.value = { name: "compare", from: String(n - 1), to: String(n) };
    };
    to(2);
    expect(guide.guideOpen.value).toBe(false);
    to(3);
    expect(guide.guideOpen.value).toBe(true);
    guide.guideOpen.value = false;
    to(2);
    to(3);
    expect(guide.guideOpen.value).toBe(false);
  });
});
