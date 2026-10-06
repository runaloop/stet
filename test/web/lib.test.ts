import { describe, expect, test } from "bun:test";
import type { ThreadDetail } from "../../src/core/types.ts";
import { thread } from "../helpers/threads.ts";
import { applyFilters, DEFAULT_FILTERS, matchesFile } from "../../web/lib/filters.ts";
import { compareOrder, stepFile, stepThread, stepUnread } from "../../web/lib/nav.ts";
import { threadMarks } from "../../web/lib/marks.ts";
import { filePatch, regionDiff, regionPatch } from "../../web/lib/region.ts";
import { parseHash, routeHash, takeToken } from "../../web/lib/route.ts";
import { diffPair } from "../../web/lib/timeline.ts";
import { flatten, groupByFile } from "../../web/lib/tree.ts";

const list = [
  thread({ id: 3, path: "src/b.kt", range: { start: 30, end: 31 } }),
  thread({ id: 1, path: "src/a.kt", range: { start: 10, end: 12 }, unread: true }),
  thread({ id: 2, path: "src/a.kt", range: { start: 2, end: 2 }, status: "resolved" }),
  thread({ id: 4, path: "README.md", draft: true, status: "open" }),
  thread({ id: 5, path: "src/b.kt", unread: true, version: 2 }),
];

describe("tree", () => {
  test("groups by current file and orders by line", () => {
    const g = groupByFile(list);
    expect(g.map((x) => x.path)).toEqual(["README.md", "src/a.kt", "src/b.kt"]);
    expect(flatten(g).map((t) => t.id)).toEqual([4, 2, 1, 5, 3]);
  });

  test("uses the re-anchored path when a file moved", () => {
    const moved = thread({ id: 9, path: "old.kt" });
    moved.anchor = { ...moved.anchor, path: "new.kt" };
    expect(groupByFile([moved])[0]!.path).toBe("new.kt");
  });
});

describe("filters", () => {
  test("status, new-only, version and glob", () => {
    expect(applyFilters(list, DEFAULT_FILTERS).map((t) => t.id)).toEqual([3, 1, 4, 5]);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, newOnly: true }).map((t) => t.id)).toEqual([1, 4, 5]);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, status: "all", version: 2 }).map((t) => t.id)).toEqual([5]);
    expect(applyFilters(list, { ...DEFAULT_FILTERS, status: "all", file: "src/*.kt" }).map((t) => t.id)).toEqual([3, 1, 2, 5]);
  });

  test("globs and substrings", () => {
    expect(matchesFile("app/src/main/Foo.kt", "**/*.kt")).toBe(true);
    expect(matchesFile("app/src/main/Foo.kt", "*.kt")).toBe(true);
    expect(matchesFile("app/src/main/Foo.kt", "main/foo")).toBe(true);
    expect(matchesFile("app/src/main/Foo.kt", "*.xml")).toBe(false);
  });
});

describe("navigation", () => {
  const ordered = flatten(groupByFile(list));
  test("j/k stop at the ends", () => {
    expect(stepThread(ordered, null, 1)).toBe(4);
    expect(stepThread(ordered, 3, 1)).toBe(3);
    expect(stepThread(ordered, 2, -1)).toBe(4);
  });

  test("n/N visit only unread threads and wrap around", () => {
    const withUnread = ordered.map((t) => (t.id === 4 ? { ...t, unread: false } : t));
    expect(stepUnread(withUnread, null, 1)).toBe(1);
    expect(stepUnread(withUnread, 1, 1)).toBe(5);
    expect(stepUnread(withUnread, 5, 1)).toBe(1);
    expect(stepUnread(withUnread, 1, -1)).toBe(5);
    expect(stepUnread(withUnread.map((t) => ({ ...t, unread: false })), null, 1)).toBeNull();
  });

  test("J/K jump between files", () => {
    const g = groupByFile(list);
    expect(stepFile(g, 4, 1)).toBe(2);
    expect(stepFile(g, 1, 1)).toBe(5);
    expect(stepFile(g, 5, -1)).toBe(2);
  });
});

describe("timeline", () => {
  const step = (index: number, label: string, range: { start: number; end: number } | null) => ({
    index, kind: index === 0 ? ("anchor" as const) : ("version" as const), label, sha: label, version: index + 1,
    state: range ? ("changed" as const) : ("outdated" as const), method: null, path: range ? "a" : null, range, excerpt: null, commentIds: [],
  });
  const d = { timeline: [step(0, "v1", { start: 1, end: 2 }), step(1, "v2", null), step(2, "v3", { start: 4, end: 5 })] } as unknown as ThreadDetail;

  test("diff against then or the previous step that still has the code", () => {
    expect(diffPair(d, 0, "then")).toBeNull();
    expect(diffPair(d, 2, "then")!.from.label).toBe("v1");
    expect(diffPair(d, 2, "prev")!.from.label).toBe("v1");
    expect(diffPair(d, 1, "prev")!.to.label).toBe("v2");
  });
});

describe("region diff of one thread", () => {
  const file = (n: number, edits: Record<number, string> = {}) =>
    Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
  const before = file(200);
  const after = file(200, { 20: "line 20 edited", 150: "line 150 edited" });

  test("each thread gets only the hunks around its own lines", () => {
    const near20 = regionDiff({ path: "a.kt", text: before, range: { start: 20, end: 20 } }, { path: "a.kt", text: after, range: { start: 20, end: 20 } });
    expect(near20.changed).toBe(true);
    expect(near20.patch).toContain("+line 20 edited");
    expect(near20.patch).not.toContain("line 150 edited");

    const near150 = regionDiff({ path: "a.kt", text: before, range: { start: 150, end: 150 } }, { path: "a.kt", text: after, range: { start: 150, end: 150 } });
    expect(near150.patch).toContain("+line 150 edited");
    expect(near150.patch).not.toContain("line 20 edited");
  });

  test("an untouched thread far from any change has no diff; one next to a change shows it but is not changed", () => {
    const far = regionDiff({ path: "a.kt", text: before, range: { start: 90, end: 92 } }, { path: "a.kt", text: after, range: { start: 90, end: 92 } });
    expect(far).toEqual({ changed: false, patch: null, complete: false });
    const near = regionDiff({ path: "a.kt", text: before, range: { start: 23, end: 23 } }, { path: "a.kt", text: after, range: { start: 23, end: 23 } });
    expect(near.changed).toBe(false);
    expect(near.patch).toContain("+line 20 edited");
  });

  test("the patch parses as one file with correct line numbers", async () => {
    const { parsePatchFiles } = await import("@pierre/diffs");
    const r = regionDiff({ path: "a.kt", text: before, range: { start: 150, end: 150 } }, { path: "a.kt", text: after, range: { start: 150, end: 150 } });
    const files = parsePatchFiles(r.patch!).flatMap((p) => p.files);
    expect(files.length).toBe(1);
    expect(files[0]!.hunks.length).toBe(1);
    expect(files[0]!.hunks[0]!.additionStart).toBe(144);
  });
});

describe("compare order", () => {
  test("threads on the diff follow the file order and then the line", () => {
    const p = (threadId: number, path: string, start: number) => ({ threadId, path, side: "additions" as const, range: { start, end: start }, state: "ok" as const });
    const order = compareOrder([p(1, "b.kt", 5), p(2, "a.kt", 30), p(3, "a.kt", 10), p(4, "gone.kt", 1)], ["a.kt", "b.kt"]);
    expect(order.map((x) => x.threadId)).toEqual([3, 2, 1]);
  });
});

describe("the thread's code block", () => {
  const file = (n: number, edits: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
  const before = file(200);
  const after = file(203, { 1: "line 1", 5: "inserted a\ninserted b\ninserted c\nline 5" }).split("\n").slice(0, 203).join("\n") + "\n";

  test("code with no change nearby still shows the lines around the thread, numbered on both sides", async () => {
    const r = regionPatch({ path: "a.kt", text: before, range: { start: 100, end: 101 } }, { path: "a.kt", text: after, range: { start: 103, end: 104 } });
    expect(r.kind).toBe("same");
    const { parsePatchFiles } = await import("@pierre/diffs");
    const h = parsePatchFiles(r.patch).flatMap((p) => p.files)[0]!.hunks[0]!;
    expect([h.additionStart, h.additionCount, h.deletionStart, h.deletionCount]).toEqual([97, 14, 94, 14]);
    expect(r.patch).toContain(" line 100\n");
  });

  test("the region may be expanded in place only when it holds every change of the file", async () => {
    const lines = (n: number, drop: number[] = [], edit: Record<number, string> = {}) =>
      Array.from({ length: n }, (_, i) => i + 1).filter((i) => !drop.includes(i)).map((i) => edit[i] ?? `line ${i}`).join("\n") + "\n";
    const old = lines(300);
    const only = regionPatch({ path: "a.kt", text: old, range: { start: 150, end: 150 } }, { path: "a.kt", text: lines(300, [], { 150: "edited" }), range: { start: 150, end: 150 } });
    const below = regionPatch({ path: "a.kt", text: old, range: { start: 150, end: 150 } }, { path: "a.kt", text: lines(300, [250], { 150: "edited" }), range: { start: 150, end: 150 } });
    const above = regionPatch({ path: "a.kt", text: old, range: { start: 150, end: 150 } }, { path: "a.kt", text: lines(300, [20], { 150: "edited" }), range: { start: 149, end: 149 } });
    const same = regionPatch({ path: "a.kt", text: old, range: { start: 150, end: 150 } }, { path: "a.kt", text: old, range: { start: 150, end: 150 } });
    const sameElsewhere = regionPatch({ path: "a.kt", text: old, range: { start: 150, end: 150 } }, { path: "a.kt", text: lines(300, [250]), range: { start: 150, end: 150 } });
    expect([only.complete, below.complete, above.complete, same.complete, sameElsewhere.complete]).toEqual([true, false, false, true, false]);
    const { hydratePartialDiff, parsePatchFiles } = await import("@pierre/diffs");
    const fd = hydratePartialDiff("clone", parsePatchFiles(only.patch)[0]!.files[0]!, { oldFile: { name: "a.kt", contents: old }, newFile: { name: "a.kt", contents: lines(300, [], { 150: "edited" }) } } as never);
    const last = fd.hunks[fd.hunks.length - 1]!;
    expect(fd.additionLines.length - (last.additionStart + last.additionCount - 1)).toBe(fd.deletionLines.length - (last.deletionStart + last.deletionCount - 1));
  });

  test("a change inside the range is a real diff, and the kind says so", () => {
    const edited = file(200, { 100: "line 100 edited" });
    expect(regionPatch({ path: "a.kt", text: before, range: { start: 100, end: 100 } }, { path: "a.kt", text: edited, range: { start: 100, end: 100 } }).kind).toBe("changed");
    expect(regionPatch({ path: "a.kt", text: before, range: { start: 97, end: 97 } }, { path: "a.kt", text: edited, range: { start: 97, end: 97 } }).kind).toBe("nearby");
  });

  test("the whole file's changes, for a rendered Markdown file, hold every hunk", async () => {
    const edited = file(200, { 20: "line 20 edited", 180: "line 180 edited" });
    expect(filePatch({ path: "a.md", text: before }, { path: "a.md", text: before })).toBeNull();
    const patch = filePatch({ path: "old.md", text: before }, { path: "a.md", text: edited })!;
    const { parsePatchFiles } = await import("@pierre/diffs");
    const fd = parsePatchFiles(patch).flatMap((p) => p.files)[0]!;
    expect(fd.hunks.map((h) => [h.additionStart, h.additionCount])).toEqual([[17, 7], [177, 7]]);
  });
});

describe("routes", () => {
  test("a compare link carries the file, the line and the side; the review only when asked", () => {
    const r = { name: "compare" as const, from: "1", to: "now", file: "src/a b.kt", line: 40, side: "old" as const };
    expect(routeHash(r)).toBe("#/compare/1..now?file=src%2Fa+b.kt&line=40&side=old");
    expect(parseHash(routeHash(r))).toEqual(r);
    expect(routeHash({ name: "thread", id: 8 }, 2)).toBe("#/thread/8?review=2");
    expect(parseHash("#/thread/8?review=2")).toEqual({ name: "thread", id: 8, review: 2 });
    expect(parseHash("#/compare/base..3")).toEqual({ name: "compare", from: "base", to: "3" });
  });

  test("a compare link can carry a range of lines: start-end, one number for one line", () => {
    const r = { name: "compare" as const, from: "1", to: "2", file: "a.md", line: 40, end: 55, side: "old" as const, review: 3 };
    expect(routeHash(r)).toBe("#/compare/1..2?file=a.md&line=40-55&side=old&review=3");
    expect(parseHash(routeHash(r))).toEqual(r);
    expect(routeHash({ name: "compare", from: "1", to: "2", file: "a.md", line: 40, end: 40 })).toBe("#/compare/1..2?file=a.md&line=40");
    expect(routeHash({ name: "compare", from: "1", to: "2", file: "a.md", line: 40, end: 30 })).toBe("#/compare/1..2?file=a.md&line=40");
    expect(parseHash("#/compare/1..2?file=a.md&line=40-40")).toEqual({ name: "compare", from: "1", to: "2", file: "a.md", line: 40 });
  });

  test("a reversed range is turned around, a broken one is dropped and the file still opens", () => {
    const at = (line: string) => {
      const r = parseHash(`#/compare/1..2?file=a.md&line=${line}`);
      return r.name === "compare" ? [r.file, r.line, r.end] : null;
    };
    expect(at("55-40")).toEqual(["a.md", 40, 55]);
    expect(at("0-5")).toEqual(["a.md", undefined, undefined]);
    expect(at("40-")).toEqual(["a.md", undefined, undefined]);
    expect(at("-40")).toEqual(["a.md", undefined, undefined]);
    expect(at("4e1")).toEqual(["a.md", undefined, undefined]);
    expect(at("a-b")).toEqual(["a.md", undefined, undefined]);
    expect(at("40-55-60")).toEqual(["a.md", undefined, undefined]);
  });

  test("the token leaves the URL, the review and the page stay", () => {
    expect(takeToken("#token=ab12")).toEqual({ token: "ab12", hash: "#/" });
    expect(takeToken("#/?review=2&token=ab12")).toEqual({ token: "ab12", hash: "#/?review=2" });
    expect(takeToken("#/overview?token=ab12&review=3")).toEqual({ token: "ab12", hash: "#/overview?review=3" });
    expect(takeToken("#/compare/1..2")).toBeNull();
  });
});

describe("thread marks", () => {
  const ours = { threadId: 1, side: "additions" as const, range: { start: 49, end: 52 } };
  const theirs = { threadId: 2, side: "additions" as const, range: { start: 50, end: 51 } };
  const tags = (marks: ReturnType<typeof threadMarks>) => marks.map((m) => `${m.tag}:${m.start}-${m.end}${m.label ? ` ${m.label}` : ""}`);

  test("the focused thread is marked stronger than the others", () => {
    expect(tags(threadMarks([ours, theirs], 1, null))).toEqual(["focus:49-52", "thread:50-51"]);
    expect(tags(threadMarks([ours, theirs], null, null))).toEqual(["thread:49-52", "thread:50-51"]);
  });

  test("the thread in the spotlight is framed with its number, flashes at first, and the others are dimmed", () => {
    expect(tags(threadMarks([ours, theirs], 1, { id: 1, flash: true }))).toEqual(["spot:49-52 #1", "spot-first:49-49", "spot-last:52-52", "flash:49-52", "dim:50-51"]);
    expect(tags(threadMarks([ours, theirs], 1, { id: 2, flash: false }))).toEqual(["dim:49-52", "spot:50-51 #2", "spot-first:50-50", "spot-last:51-51"]);
  });

  test("a thread in the spotlight in another file dims nothing here", () => {
    expect(tags(threadMarks([ours, theirs], 1, { id: 7, flash: false }))).toEqual(["focus:49-52", "thread:50-51"]);
  });
});
