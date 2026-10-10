import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import type { CommentDto, ComparePlacement, ThreadDetail, VersionDto } from "../../src/core/types.ts";
import { thread } from "../helpers/threads.ts";
import { commitOf, commitRef, isSha } from "../../src/ui/commits.ts";
import { fileRows, foldLabel, grepSorted, linesUrl, marksByPath, viewedCount } from "../../src/ui/compare.ts";
import { DEFAULT_TEST_GLOBS } from "../../src/ui/fold.ts";
import { foldedByDefault, isLong, readingOrder } from "../../src/ui/msgs.ts";
import { FileOrder, parseOrder } from "../../src/ui/order.ts";
import { quote } from "../../src/ui/quote.ts";
import { searchDiff } from "../../src/ui/search.ts";
import { defaultCompare, groups, nowMoved, presets, refOptions, reviewedRef, shiftRef, tipRef, type Refs } from "../../src/ui/state.ts";
import { viewedIndex, viewedKey } from "../../src/ui/viewed.ts";

const version = (number: number, label: string | null = null): VersionDto => ({ number, snapshot: `s${number}`, baseSha: null, label, role: "agent", author: "claude", createdAt: "2026-09-24T10:00:00Z" });
const refs = (n: number, dirty: boolean): Refs => ({ versions: Array.from({ length: n }, (_, i) => version(i + 1)), now: { sha: "nowsha", changedSinceLatest: dirty, excluded: [] } });
const reviewed = (v: number | null, sha: string) => ({ version: v, sha, label: v ? `v${v}` : sha.slice(0, 8), at: "2026-09-24T09:00:00Z" });
const order = new FileOrder(parseOrder(null));

const PATCH = (path: string) => `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -1,2 +1,2 @@
 one
-two
+TWO
`;
const files = (...paths: string[]) => paths.map((p) => parsePatchFiles(PATCH(p), p)[0]!.files[0]!);

describe("state", () => {
  test("the refs of a compare: tip, options, shift and the reviewer's last pass", () => {
    expect(tipRef(refs(2, false))).toBe("2");
    expect(tipRef(refs(2, true))).toBe("now");
    expect(tipRef(refs(0, false))).toBe("now");
    expect(refOptions(refs(2, false)).map((o) => o.label)).toEqual(["base", "v1", "v2", "now (= latest)"]);
    expect(shiftRef(refs(2, false), "1", 1)).toBe("2");
    expect(shiftRef(refs(2, false), "base", -1)).toBe("base");
    expect(shiftRef(refs(2, false), "abcdef0", -1)).toBe("2");
    expect(reviewedRef(refs(2, false), reviewed(2, "s2"))).toBeNull();
    expect(reviewedRef(refs(2, true), reviewed(2, "s2"))).toBe("2");
    expect(reviewedRef(refs(2, true), reviewed(null, "nowsha"))).toBeNull();
  });

  test("presets and the range that opens by default", () => {
    expect(presets(refs(3, true), reviewed(1, "s1")).map((p) => [p.id, p.from, p.to])).toEqual([
      ["since", "1", "now"],
      ["after", "3", "now"],
      ["round", "2", "3"],
      ["branch", "base", "now"],
    ]);
    expect(defaultCompare(refs(3, false), null)).toEqual({ from: "2", to: "3" });
    expect(defaultCompare(refs(1, false), null)).toEqual({ from: "base", to: "1" });
    expect(defaultCompare(refs(0, true), null)).toEqual({ from: "base", to: "now" });
  });

  test("now moved: files that differ from the pin shown, 0 when only the pin moved", () => {
    expect(nowMoved({ sha: "b", pinned: "a", files: 3 }, "a")).toBe(3);
    expect(nowMoved({ sha: "b", pinned: "c", files: 3 }, "a")).toBe(0);
    expect(nowMoved({ sha: "a", pinned: "a", files: 0 }, "a")).toBeNull();
    expect(nowMoved(null, "a")).toBeNull();
  });

  test("threads by file, tests after code", () => {
    const g = groups([thread({ id: 1, path: "src/a.test.ts" }), thread({ id: 2, path: "src/b.ts" })], order, DEFAULT_TEST_GLOBS);
    expect(g.map((x) => x.path)).toEqual(["src/b.ts", "src/a.test.ts"]);
  });
});

describe("compare", () => {
  const cfg = { folds: new Map(), open: { tests: false, generated: false }, placements: [] as ComparePlacement[], order, tests: DEFAULT_TEST_GLOBS };

  test("file rows in sections, a file with a thread never folded, and the viewed count of the files shown", () => {
    const fds = files("README.md", "src/a.test.ts", "src/b.ts");
    const folded = new Map([["src/a.test.ts", { group: "tests" as const, keptBecause: null }]]);
    const rows = fileRows(fds, { ...cfg, folds: folded });
    expect(rows.map((r) => [r.fd.name, r.hidden, r.section])).toEqual([
      ["src/b.ts", false, "Code"],
      ["README.md", false, "Docs"],
      ["src/a.test.ts", true, "Tests with only new code"],
    ]);
    const placed: ComparePlacement = { threadId: 1, side: "additions", path: "src/a.test.ts", range: { start: 2, end: 2 }, state: "ok" };
    expect(fileRows(fds, { ...cfg, folds: folded, placements: [placed] }).find((r) => r.fd.name === "src/a.test.ts")).toMatchObject({ group: null, hidden: false, threads: 1 });
    expect(viewedCount(rows, viewedIndex([viewedKey(fds[2]!)]))).toEqual({ shown: 2, seen: 1, hidden: 1 });
  });

  test("a folded group's button says why it is folded: tests for only adding code, generated and lock files for what they are", () => {
    expect(foldLabel("tests", 1, false)).toBe("▸ 1 test file with only new code folded · show");
    expect(foldLabel("tests", 2, true)).toBe("▾ 2 test files shown · hide");
    expect(foldLabel("generated", 1, false)).toBe("▸ 1 generated / lock file folded · show");
    expect(foldLabel("generated", 3, false)).toBe("▸ 3 generated / lock files folded · show");
    expect(foldLabel("generated", 1, true)).toBe("▾ 1 generated / lock file shown · hide");
  });

  test("grep results in the order of the Changes page", () => {
    const r = { files: ["README.md", "src/a.ts"].map((path) => ({ path, matches: 1, groups: [] })), total: 2, truncated: false, error: null };
    expect(grepSorted(r, order, DEFAULT_TEST_GLOBS).files.map((f) => f.path)).toEqual(["src/a.ts", "README.md"]);
  });

  test("marks: linked lines, threads and the hits of a search", () => {
    const placed: ComparePlacement = { threadId: 7, side: "additions", path: "src/b.ts", range: { start: 1, end: 2 }, state: "ok" };
    const search = searchDiff(files("src/b.ts"), "TWO");
    const m = marksByPath({ linked: { path: "src/b.ts", side: "deletions", start: 2, end: 2 }, placements: [placed], focus: 7, spot: null, grepHits: [], grepCurrent: null, search, current: null });
    expect(m.get("src/b.ts")!.map((x) => [x.tag, x.side, x.start])).toEqual([
      ["linked", "deletions", 2],
      ["focus", "additions", 1],
      ["hit", "additions", 2],
    ]);
  });

  test("the address of lines: the compare's refs, or a thread's two sides", () => {
    const lines = { path: "src/b.ts", side: "deletions" as const, start: 3, end: 5 };
    const page = "http://127.0.0.1:4000/";
    expect(linesUrl(page, lines, { route: { name: "compare", from: "1", to: "now" }, compare: null, thread: null }, 2)).toBe(`${page}#/compare/1..now?file=src%2Fb.ts&line=3-5&side=old&review=2`);
    const thread = { old: { ref: "1" }, now: { ref: "3" } };
    expect(linesUrl(page, lines, { route: { name: "thread", id: 4 }, compare: null, thread }, null)).toBe(`${page}#/compare/1..3?file=src%2Fb.ts&line=3-5&side=old`);
    expect(linesUrl(page, lines, { route: { name: "drafts" }, compare: null, thread }, null)).toBeNull();
  });
});

describe("msgs", () => {
  const msg = (id: number, p: Partial<CommentDto> = {}) => ({ id, parentId: null, body: "hi", draft: false, unread: false, createdAt: `2026-09-24T10:0${id}:00Z`, ...p }) as CommentDto;

  test("long messages you have read fold, except the last and the new ones", () => {
    const long = "x\n".repeat(13);
    const d = { comments: [msg(3, { parentId: 1, body: long }), msg(1, { body: long }), msg(2, { body: long }), msg(4, { body: "x".repeat(901), unread: true })] } as ThreadDetail;
    expect(readingOrder(d).map((c) => c.id)).toEqual([1, 3, 2, 4]);
    expect(isLong(d.comments[0]!)).toBe(true);
    expect(isLong(msg(5))).toBe(false);
    expect(d.comments.map((c) => foldedByDefault(c, d, undefined))).toEqual([true, true, true, false]);
    expect(foldedByDefault(d.comments[1]!, d, new Set([1]))).toBe(false);
  });
});

describe("commits", () => {
  test("a sha, the commit it names, and the ref a compare link puts for it", () => {
    expect(isSha("abcdef0")).toBe(true);
    expect(isSha("12")).toBe(false);
    const list = { tip: null, forkPoint: null, forkRef: null, more: false, commits: [{ sha: "abcdef0123", parent: null, author: "a", date: "", subject: "s", versions: [], onBranch: true }] };
    expect(commitOf(list, "abcdef0")?.sha).toBe("abcdef0123");
    expect(commitOf(list, "v2")).toBeNull();
    expect(commitOf(null, "abcdef0")).toBeNull();
    expect(commitRef([version(2)], "s2")).toBe("2");
    expect(commitRef([version(2)], "0123456789abcdef")).toBe("0123456789ab");
  });
});

describe("quote", () => {
  test("lines of a file as a fenced block with where they are", () => {
    expect(quote({ path: "src/a.kt", start: 2, end: 3, sha: "s", label: "v2" }, "one\ntwo\nthree\nfour\n")).toEqual({ where: "src/a.kt:2-3", text: "`src/a.kt:2-3` at v2:\n```kt\ntwo\nthree\n```\n" });
    expect(quote({ path: "Makefile", start: 1, end: 1, sha: "s", label: "now" }, "all:\n").where).toBe("Makefile:1");
  });
});
