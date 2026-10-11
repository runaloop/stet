import { expect, test } from "bun:test";
import { clipRuns, cut, expandRuns, graphemes, lineCells, wrapRuns } from "../../src/tui/diff/cells.ts";

const text = (runs: { text: string }[]) => runs.map((r) => r.text).join("");

test("tabs go to the next stop across runs, control characters go", () => {
  const runs = expandRuns([{ text: "a\t", s: 1 }, { text: "b\tc\x07", s: 2 }]);
  expect(text(runs)).toBe("a   b   c");
  expect(runs.map((r) => r.s)).toEqual([1, 2]);
  expect(lineCells("\tx")).toBe(5);
  expect(lineCells("日本")).toBe(4);
});

test("graphemes stay whole: a flag, a family, a letter with a combining mark", () => {
  expect(graphemes("🇺🇦👨‍👩‍👧é")).toEqual(["🇺🇦", "👨‍👩‍👧", "é"]);
  expect(cut("👨‍👩‍👧abc", 3)).toEqual(["👨‍👩‍👧a", 3]);
  expect(cut("日本語", 3)).toEqual(["日", 2]);
});

test("wrap cuts at the width, keeps each run's style, and puts a wide character that does not fit on the next line", () => {
  const lines = wrapRuns([{ text: "abcd", s: 1 }, { text: "ef日本", s: 2 }], 5);
  expect(lines.map(text)).toEqual(["abcde", "f日本"]);
  expect(lines[1]!.map((r) => r.s)).toEqual([2]);
  expect(wrapRuns([{ text: "ab日" }], 3).map(text)).toEqual(["ab", "日"]);
  expect(wrapRuns([{ text: "x".repeat(100) }], 10, 3).length).toBe(3);
  expect(wrapRuns([{ text: "" }], 10)).toEqual([[]]);
});

test("a sideways scroll shows the cells from an offset; a wide character cut by an edge becomes a space", () => {
  expect(text(clipRuns([{ text: "abcdef" }], 2, 3).runs)).toBe("cde");
  expect(clipRuns([{ text: "abcdef" }], 2, 3).more).toBe(true);
  expect(clipRuns([{ text: "abcdef" }], 2, 4).more).toBe(false);
  expect(text(clipRuns([{ text: "a日本b" }], 2, 3).runs)).toBe(" 本");
  expect(text(clipRuns([{ text: "a日本b" }], 0, 2).runs)).toBe("a ");
  const two = clipRuns([{ text: "ab", s: 1 }, { text: "cd", s: 2 }], 1, 2);
  expect(two.runs).toEqual([{ text: "b", s: 1 }, { text: "c", s: 2 }]);
  expect(two.more).toBe(true);
});
