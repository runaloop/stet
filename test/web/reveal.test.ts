import { describe, expect, test } from "bun:test";
import { getSharedHighlighter, hydratePartialDiff, parsePatchFiles, renderDiffWithHighlighter, type FileDiffMetadata } from "@pierre/diffs";
import { filePatch } from "../../web/lib/region.ts";
import { expansionOf, fileLines, gapsOf, hydrateSubset, mergeSpans, NOTHING, revealedPatch, withSpan } from "../../web/lib/reveal.ts";

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

  test("a patch that leaves out changes adding lines above, between and below its hunks is drawn with each line where it is", async () => {
    // a long line changed by one word, so the word diff marks a place in it on both sides
    const long = (w: string) => `.guide-num { flex: none; display: inline-flex; align-items: center; font: 600 12px/1 var(--sans); color: ${w}; }`;
    const a = file(80, { 20: long("red"), 50: long("blue") });
    const b = file(80, { 3: "added 1\nadded 2\nadded 3\nline 3", 20: long("green"), 35: "added 4\nadded 5\nline 35", 50: long("teal"), 65: "added 6\nadded 7\nadded 8\nadded 9\nline 65" });
    const all = hunksOf(filePatch({ path: "s.css", text: a }, { path: "s.css", text: b })!);
    // lines 23 and 55 of the new version: lines 20 and 50 of the old
    const patch = revealedPatch({ path: "s.css", text: a }, { path: "s.css", text: b }, all, { spans: [{ start: 20, end: 26 }, { start: 52, end: 58 }], full: false }, { old: [], new: [{ start: 23, end: 23 }, { start: 55, end: 55 }] })!;
    const fd = parsePatchFiles(patch, "subset")[0]!.files[0]!;
    expect(fd.hunks.map((h) => [h.deletionStart, h.deletionCount, h.additionStart, h.additionCount])).toEqual([[17, 7, 20, 7], [47, 7, 52, 7]]);

    const highlighter = await getSharedHighlighter({ themes: ["pierre-dark"], langs: ["css"] });
    const options = { theme: "pierre-dark", useTokenTransformer: false, tokenizeMaxLineLength: 1000, lineDiffType: "word", maxLineDiffLength: 1000 };
    const draw = (d: FileDiffMetadata) => renderDiffWithHighlighter(d, highlighter as never, options as never);
    const files = [{ name: "s.css", contents: a }, { name: "s.css", contents: b }] as const;
    expect(() => draw(hydratePartialDiff("clone", fd, { oldFile: files[0], newFile: files[1] } as never))).toThrow("trailing context mismatch");

    const d = hydrateSubset(fd, files[0], files[1]);
    const { code } = draw(d);
    // as the viewer draws a hunk's lines: each side's highlighted line at the index the hunk gives it
    type Node = { type: string; value?: string; children?: Node[]; properties?: Record<string, unknown> };
    const text = (n: Node): string => (n.type === "text" ? n.value! : (n.children ?? []).map(text).join(""));
    const drawn = (lines: unknown[], source: string, index: number, number: number) => {
      const node = lines[index] as Node;
      return node.properties?.["data-line"] === number && text(node) === source.split("\n")[number - 1];
    };
    const rows: [number, number][] = [];
    for (const h of d.hunks) {
      let o = 0;
      let n = 0;
      for (const c of h.hunkContent) {
        const dels = c.type === "context" ? c.lines : c.deletions;
        const adds = c.type === "context" ? c.lines : c.additions;
        for (let i = 0; i < dels; i++) expect(drawn(code.deletionLines, a, c.deletionLineIndex + i, h.deletionStart + o + i)).toBe(true);
        for (let i = 0; i < adds; i++) expect(drawn(code.additionLines, b, c.additionLineIndex + i, h.additionStart + n + i)).toBe(true);
        if (dels) rows.push([h.deletionStart + o, h.deletionStart + o + dels - 1]);
        o += dels;
        n += adds;
      }
    }
    expect(rows.flat()).toContain(50);
    // the numbers stay each version's; the bars count what both versions have between the hunks
    expect(d.hunks.map((h) => [h.deletionStart, h.additionStart, h.collapsedBefore])).toEqual([[17, 20, 16], [47, 52, 23]]);
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
