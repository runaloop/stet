import { describe, expect, test } from "bun:test";
import { parseHunks, parseRawZ } from "../src/core/diff.ts";
import { isTouched, mapLine, normalizeWs } from "../src/core/reanchor.ts";

describe("hunk parsing", () => {
  test("parses counts, defaulting omitted counts to 1", () => {
    expect(parseHunks("@@ -3 +4 @@\n-a\n+b\n@@ -0,0 +1,2 @@\n+x\n+y\n")).toEqual([
      { oldStart: 3, oldCount: 1, newStart: 4, newCount: 1 },
      { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
    ]);
  });

  test("parses raw -z output with renames", () => {
    const out = ":100644 100644 aaa bbb M\0a.txt\0:100644 100644 ccc ddd R087\0old.txt\0new.txt\0";
    const r = parseRawZ(out);
    expect(r).toHaveLength(2);
    expect(r[1]).toMatchObject({ status: "R", score: 87, oldPath: "old.txt", newPath: "new.txt" });
  });
});

describe("line mapping", () => {
  test("pure insertion after line N shifts N+1 but not N", () => {
    const hunks = [{ oldStart: 5, oldCount: 0, newStart: 6, newCount: 2 }];
    expect(mapLine(5, hunks)).toBe(5);
    expect(mapLine(6, hunks)).toBe(8);
  });

  test("insertion at the top shifts everything", () => {
    const hunks = [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }];
    expect(mapLine(1, hunks)).toBe(2);
    expect(mapLine(0, hunks)).toBe(0);
  });

  test("changed lines have no mapping", () => {
    const hunks = [{ oldStart: 3, oldCount: 2, newStart: 3, newCount: 1 }];
    expect(mapLine(3, hunks)).toBeNull();
    expect(mapLine(4, hunks)).toBeNull();
    expect(mapLine(5, hunks)).toBe(4);
  });

  test("insertion right after the range end does not touch it", () => {
    expect(isTouched(10, 14, [{ oldStart: 14, oldCount: 0, newStart: 15, newCount: 1 }])).toBe(false);
    expect(isTouched(10, 14, [{ oldStart: 9, oldCount: 0, newStart: 10, newCount: 1 }])).toBe(false);
    expect(isTouched(10, 14, [{ oldStart: 12, oldCount: 0, newStart: 13, newCount: 1 }])).toBe(true);
  });

  test("whitespace normalization ignores CR and indentation", () => {
    expect(normalizeWs("  foo(a,  b)\r")).toBe(normalizeWs("foo(a, b)"));
  });
});
