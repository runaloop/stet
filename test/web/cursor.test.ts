import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, test } from "bun:test";
import { CursorSpace, moveStart, selectionLines } from "../../web/lib/cursor.ts";

const patch = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;
const fs = parsePatchFiles(
  patch("a.kt", "@@ -1,4 +1,4 @@\n c1\n-d2\n+a2\n c3\n c4\n@@ -20,2 +20,4 @@\n c20\n+a21\n+a22\n c21\n") + patch("b.kt", "@@ -1,2 +1,2 @@\n-x\n+y\n z\n") + patch("c.kt", "@@ -1 +1 @@\n-p\n+q\n"),
  "t",
).flatMap((p) => p.files);
const space = (collapsed: string[] = []) => new CursorSpace(fs.map((fd) => ({ fd, collapsed: collapsed.includes(fd.name) })));

describe("cursor over the diff", () => {
  test("j/k walk rows across files and stop at the ends", () => {
    const s = space();
    expect(s.total).toBe(9 + 3 + 2);
    expect(s.move({ path: "a.kt", row: 8 }, 1)).toEqual({ path: "b.kt", row: 0 });
    expect(s.move({ path: "b.kt", row: 0 }, -1)).toEqual({ path: "a.kt", row: 8 });
    expect(s.move({ path: "c.kt", row: 1 }, 5)).toEqual({ path: "c.kt", row: 1 });
    expect(s.move(null, 1)).toEqual({ path: "a.kt", row: 0 });
  });

  test("one file in two places goes by the id each gives it", () => {
    const b = fs[1]!;
    const s = new CursorSpace([{ fd: b, collapsed: false, id: "1.0" }, { fd: b, collapsed: true, id: "3.0" }, { fd: b, collapsed: false, id: "3.1" }]);
    expect(s.move({ path: "1.0", row: 2 }, 1)).toEqual({ path: "3.0", row: -1 });
    expect(s.move({ path: "3.0", row: -1 }, 1)).toEqual({ path: "3.1", row: 0 });
    expect(s.locate("3.1", "deletions", 1)).toEqual({ path: "3.1", row: 0 });
    expect(s.locate("3.0", "additions", 1)).toBeNull();
    expect(s.range({ path: "3.1", row: 1 }, { path: "3.1", row: 2 })).toEqual({ path: "3.1", side: "additions", start: 1, end: 2 });
  });

  test("a collapsed file is one stop on its header", () => {
    const s = space(["b.kt"]);
    expect(s.move({ path: "a.kt", row: 8 }, 1)).toEqual({ path: "b.kt", row: -1 });
    expect(s.move({ path: "b.kt", row: -1 }, 1)).toEqual({ path: "c.kt", row: 0 });
  });

  test("]c and [c jump between change blocks, ]h between hunks, ]b between files", () => {
    const s = space();
    const a = (row: number) => ({ path: "a.kt", row });
    expect(s.nextChange(a(0), 1)).toEqual(a(1));
    expect(s.nextChange(a(1), 1)).toEqual(a(6));
    expect(s.nextChange(a(6), 1)).toEqual({ path: "b.kt", row: 0 });
    expect(s.nextChange(a(6), -1)).toEqual(a(1));
    expect(s.nextHunk(a(0), 1)).toEqual(a(5));
    expect(s.nextFile(a(3), 1)).toEqual({ path: "b.kt", row: 0 });
    expect(s.nextFile({ path: "c.kt", row: 0 }, 1)).toBeNull();
  });

  test("locate finds a line on either side, range turns a visual selection into line numbers", () => {
    const s = space();
    expect(s.locate("a.kt", "additions", 22)).toEqual({ path: "a.kt", row: 7 });
    expect(s.locate("a.kt", "deletions", 2)).toEqual({ path: "a.kt", row: 1 });
    expect(s.range({ path: "a.kt", row: 0 }, { path: "a.kt", row: 3 })).toEqual({ path: "a.kt", side: "additions", start: 1, end: 3 });
    expect(s.range({ path: "a.kt", row: 1 }, { path: "a.kt", row: 3 })).toEqual({ path: "a.kt", side: "deletions", start: 2, end: 3 });
    expect(s.range({ path: "a.kt", row: 6 }, { path: "b.kt", row: 1 })).toEqual({ path: "a.kt", side: "additions", start: 21, end: 21 });
  });

  test("holds says whether the cursor is on linked lines, on their side, or on a rendered block with lines among them", () => {
    const s = space();
    const a = (row: number) => ({ path: "a.kt", row });
    const added = { path: "a.kt", side: "additions" as const, start: 20, end: 21 };
    expect([5, 6, 7, 8].map((r) => s.holds(a(r), added))).toEqual([true, true, false, false]);
    expect(s.holds({ path: "b.kt", row: 0 }, added)).toBe(false);
    const removed = { path: "a.kt", side: "deletions" as const, start: 2, end: 3 };
    expect([0, 1, 2, 3].map((r) => s.holds(a(r), removed))).toEqual([false, true, false, true]);
    const md = new CursorSpace([
      { fd: fs[0]!, collapsed: false, blocks: [{ old: { start: 1, end: 4 }, new: { start: 1, end: 4 }, changed: false, group: 0 }, { old: null, new: { start: 6, end: 9 }, changed: true, group: 1 }] },
    ]);
    expect([0, 1].map((r) => md.holds(a(r), { path: "a.kt", side: "additions", start: 4, end: 6 }))).toEqual([true, true]);
    expect([0, 1].map((r) => md.holds(a(r), { path: "a.kt", side: "deletions", start: 5, end: 9 }))).toEqual([false, false]);
  });

  test("position names the line under the cursor, or the first line of its block, so another layout of the file finds it again", () => {
    const s = space();
    expect(s.position({ path: "a.kt", row: 1 })).toEqual({ side: "deletions", line: 2 });
    expect(s.position({ path: "a.kt", row: 7 })).toEqual({ side: "additions", line: 22 });
    expect(s.position({ path: "a.kt", row: -1 })).toBeNull();
    const md = new CursorSpace([
      { fd: fs[0]!, collapsed: false, blocks: [{ old: { start: 1, end: 4 }, new: { start: 1, end: 4 }, changed: false, group: 0 }, { old: { start: 6, end: 7 }, new: null, changed: true, group: 1 }] },
    ]);
    expect(md.position({ path: "a.kt", row: 1 })).toEqual({ side: "deletions", line: 6 });
    expect(s.locate("a.kt", "additions", md.position({ path: "a.kt", row: 0 })!.line)).toEqual({ path: "a.kt", row: 0 });
  });
});

describe("the cursor after a scroll with the mouse", () => {
  const s = space();
  const a = (row: number) => ({ path: "a.kt", row });
  const seen = (rows: number[], share = 1) => rows.map((row) => ({ at: a(row), share }));

  test("off screen, a move down starts from the first place on screen and a move up from the last, in reading order", () => {
    const shown = [...seen([7, 5, 6]), { at: { path: "b.kt", row: 0 }, share: 1 }];
    expect(moveStart(s, a(0), shown, 1)).toEqual(a(5));
    expect(moveStart(s, a(0), shown, -1)).toEqual({ path: "b.kt", row: 0 });
  });

  test("the cursor stays where it is while some of it shows, or when nothing is on screen", () => {
    expect(moveStart(s, a(5), [...seen([5], 0.2), ...seen([6, 7])], 1)).toEqual(a(5));
    expect(moveStart(s, a(0), [], 1)).toEqual(a(0));
  });

  test("a place less than half on screen is not where a move starts", () => {
    expect(moveStart(s, a(0), [...seen([5], 0.3), ...seen([6, 7]), ...seen([8], 0.4)], 1)).toEqual(a(6));
    expect(moveStart(s, a(0), [...seen([5], 0.3), ...seen([6, 7]), ...seen([8], 0.4)], -1)).toEqual(a(7));
  });
});

describe("a text selection as lines", () => {
  const line = (side: "additions" | "deletions", n: number) => ({ [side]: { start: n, end: n } });
  const context = (n: number, old: number) => ({ additions: { start: n, end: n }, deletions: { start: old, end: old } });

  test("every line it touches, on the new side when each has one there", () => {
    expect(selectionLines([line("additions", 10), line("additions", 11), line("additions", 12)])).toEqual({ side: "additions", start: 10, end: 12 });
    expect(selectionLines([context(4, 4), line("additions", 5)])).toEqual({ side: "additions", start: 4, end: 5 });
    expect(selectionLines([context(9, 8)])).toEqual({ side: "additions", start: 9, end: 9 });
  });

  test("removed lines with the unchanged lines around them go on the old side", () => {
    expect(selectionLines([context(3, 3), line("deletions", 4), line("deletions", 5)])).toEqual({ side: "deletions", start: 3, end: 5 });
  });

  test("rendered blocks give their spans of lines", () => {
    expect(selectionLines([{ additions: { start: 7, end: 9 }, deletions: { start: 5, end: 7 } }, { additions: { start: 11, end: 14 } }])).toEqual({ side: "additions", start: 7, end: 14 });
  });

  test("removed and added lines together have no one side; nothing touched is no selection", () => {
    expect(selectionLines([line("deletions", 2), line("additions", 2)])).toBe("both");
    expect(selectionLines([])).toBeNull();
  });
});

describe("fuzzy file finder", () => {
  test("matches subsequences, prefers the file name and word starts", async () => {
    const { fuzzyFilter, fuzzyScore } = await import("../../web/lib/fuzzy.ts");
    const paths = ["app/src/main/java/store/PriceHistoryQueue.kt", "app/src/main/java/store/Queue.kt", "docs/guide/README.md", "app/src/test/PriceHistoryQueueTest.kt"];
    expect(fuzzyScore("zzz", paths[0]!)).toBeNull();
    expect(fuzzyFilter(paths, "phq", (p) => p)[0]).toBe("app/src/main/java/store/PriceHistoryQueue.kt");
    expect(fuzzyFilter(paths, "queue", (p) => p)[0]).toBe("app/src/main/java/store/Queue.kt");
    expect(fuzzyFilter(paths, "readme", (p) => p)).toEqual(["docs/guide/README.md"]);
    expect(fuzzyFilter(paths, "", (p) => p).length).toBe(4);
  });
});

describe("key search", () => {
  test("every word must match; earlier matches rank first", async () => {
    const { wordFilter } = await import("../../web/lib/fuzzy.ts");
    const keys = ["next change ]c", "previous change [c", "change nothing", "next file ]b"];
    expect(wordFilter(keys, "change next", (k) => k)).toEqual(["next change ]c"]);
    expect(wordFilter(keys, "]b", (k) => k)).toEqual(["next file ]b"]);
    expect(wordFilter(keys, "CHANGE", (k) => k)).toEqual(["change nothing", "next change ]c", "previous change [c"]);
    expect(wordFilter(keys, "", (k) => k)).toEqual(keys);
  });
});
