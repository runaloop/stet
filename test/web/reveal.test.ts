import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { filePatch } from "../../web/lib/region.ts";
import { evenTail, expansionOf, fileLines, gapsOf, mergeSpans, NOTHING, revealedPatch, withSpan } from "../../web/lib/reveal.ts";

const file = (n: number, edits: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
const hunksOf = (patch: string) => parsePatchFiles(patch).flatMap((p) => p.files)[0]!.hunks;
const ranges = (patch: string) => hunksOf(patch).map((h) => [h.additionStart, h.additionStart + h.additionCount - 1]);

describe("revealed lines", () => {
  const before = file(200);
  const after = file(200, { 20: "line 20 edited", 180: "line 180 edited" });
  const base = hunksOf(filePatch({ path: "a.md", text: before }, { path: "a.md", text: after })!);
  const old = { path: "a.md", text: before };
  const now = { path: "a.md", text: after };

  test("spans merge when they touch or overlap", () => {
    expect(mergeSpans([{ start: 10, end: 12 }, { start: 1, end: 3 }, { start: 4, end: 5 }, { start: 11, end: 20 }])).toEqual([{ start: 1, end: 5 }, { start: 10, end: 20 }]);
    expect(withSpan(withSpan(NOTHING, { start: 50, end: 60 }), { start: 61, end: 61 }).spans).toEqual([{ start: 50, end: 61 }]);
  });

  test("the gaps are the unchanged lines between the hunks, and a show-more takes them from either end", () => {
    expect(gapsOf(base, 200)).toEqual([{ start: 1, end: 16 }, { start: 24, end: 176 }, { start: 184, end: 200 }]);
    expect(expansionOf(base, 200, 1, "up", 20)).toEqual({ start: 24, end: 43 });
    expect(expansionOf(base, 200, 1, "down", 20)).toEqual({ start: 157, end: 176 });
    expect(expansionOf(base, 200, 1, "both", Number.POSITIVE_INFINITY)).toEqual({ start: 24, end: 176 });
    expect(expansionOf(base, 200, 2, "up", 100)).toEqual({ start: 184, end: 200 });
  });

  test("the whole file in diff order: each unchanged line once, a changed one removed then added", () => {
    const rows = fileLines(base, 200, 200);
    expect(rows.length).toBe(202);
    expect(rows.filter((r) => r.hunk).length).toBe(16);
    expect(rows[19]).toEqual({ kind: "del", old: 20, new: null, hunk: true });
    expect(rows[20]).toEqual({ kind: "add", old: null, new: 20, hunk: true });
  });

  test("revealed lines become context: an island between hunks, a hunk grown to them, all of it for the whole file", () => {
    expect(revealedPatch(old, now, base, NOTHING)).toBeNull();
    expect(ranges(revealedPatch(old, now, base, { spans: [{ start: 100, end: 110 }], full: false })!)).toEqual([[17, 23], [100, 110], [177, 183]]);
    expect(ranges(revealedPatch(old, now, base, { spans: [{ start: 24, end: 30 }], full: false })!)).toEqual([[17, 30], [177, 183]]);
    expect(ranges(revealedPatch(old, now, base, { spans: [], full: true })!)).toEqual([[1, 200]]);
    const grown = hunksOf(revealedPatch(old, now, base, { spans: [{ start: 24, end: 30 }], full: false })!)[0]!;
    expect([grown.deletionStart, grown.deletionCount, grown.additionLines, grown.deletionLines]).toEqual([17, 14, 1, 1]);
  });

  test("around a thread the lines shown start from its region, not from every change, and grow the same way", () => {
    const region = { old: [{ start: 14, end: 26 }], new: [{ start: 14, end: 26 }] };
    expect(ranges(revealedPatch(old, now, base, NOTHING, region)!)).toEqual([[14, 26]]);
    expect(ranges(revealedPatch(old, now, base, { spans: [{ start: 27, end: 46 }], full: false }, region)!)).toEqual([[14, 46]]);
    const far = hunksOf(revealedPatch(old, now, base, { spans: [{ start: 170, end: 190 }], full: false }, region)!);
    expect(far.map((h) => [h.additionStart, h.additionCount, h.additionLines])).toEqual([[14, 13, 1], [170, 21, 1]]);
  });

  test("a patch that leaves out a later change that adds lines is drawn with an old version as long as the new one past it", () => {
    const a = file(40);
    const b = file(40, { 10: "line 10 edited", 15: "added 1\nadded 2\nadded 3\nline 15" });
    const all = hunksOf(filePatch({ path: "c.css", text: a }, { path: "c.css", text: b })!);
    const patch = revealedPatch({ path: "c.css", text: a }, { path: "c.css", text: b }, all, { spans: [{ start: 8, end: 12 }], full: false }, { old: [], new: [{ start: 10, end: 10 }] })!;
    const last = hunksOf(patch).at(-1)!;
    expect([last.deletionStart, last.deletionCount, last.additionStart, last.additionCount]).toEqual([8, 5, 8, 5]);
    const even = evenTail(a, b, last);
    expect(even.split("\n").length - 12).toBe(b.split("\n").length - 12);
    expect(even.split("\n").slice(0, 12)).toEqual(a.split("\n").slice(0, 12));
    expect(even.split("\n").slice(12)).toEqual(b.split("\n").slice(12));
    expect(evenTail(a, b, hunksOf(filePatch({ path: "c.css", text: a }, { path: "c.css", text: b })!).at(-1))).toBe(a);
  });

  test("a file without a newline at its end keeps that in the revealed diff", () => {
    const a = "x\n".repeat(30) + "end";
    const b = "y\n" + "x\n".repeat(29) + "end";
    const h = hunksOf(filePatch({ path: "b.md", text: a }, { path: "b.md", text: b })!);
    const patch = revealedPatch({ path: "b.md", text: a }, { path: "b.md", text: b }, h, { spans: [], full: true })!;
    expect(patch.endsWith(" end\n\\ No newline at end of file\n")).toBe(true);
    expect(ranges(patch)).toEqual([[1, 31]]);
  });
});
