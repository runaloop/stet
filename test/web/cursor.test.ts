import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, test } from "bun:test";
import { CursorSpace } from "../../web/lib/cursor.ts";

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
