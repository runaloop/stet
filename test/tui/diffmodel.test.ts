import { hydratePartialDiff, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { expect, test } from "bun:test";
import { Layout } from "../../src/tui/diff/layout.ts";
import { ADD, buildRows, CARD, CTX, DEL, FILE, GAP, GROUP, NOTE, PAIR, rowOfLine, type Item, type Rows } from "../../src/tui/diff/model.ts";
import { markRuns, wordMarks } from "../../src/tui/diff/words.ts";

const OLD = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const NEW = OLD.replace("line 10\n", "line 10 changed\nextra\n").replace("line 25\n", "");
const PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -7,7 +7,8 @@
 line 7
 line 8
 line 9
-line 10
+line 10 changed
+extra
 line 11
 line 12
 line 13
@@ -22,7 +23,6 @@
 line 22
 line 23
 line 24
-line 25
 line 26
 line 27
 line 28
`;

const partial = () => parsePatchFiles(PATCH, `k${Math.random()}`)[0]!.files[0]!;
const whole = (): FileDiffMetadata => hydratePartialDiff("clone", partial(), { oldFile: { name: "a.ts", contents: OLD }, newFile: { name: "a.ts", contents: NEW } } as never);

const kinds = (r: Rows) => Array.from(r.kind.slice(0, r.len));

test("a file from a patch: its header, a bar for the lines before each hunk, the hunks' rows in unified", () => {
  const rows = buildRows([{ kind: "file", key: "a.ts", fd: partial(), collapsed: false }], false);
  expect(kinds(rows)).toEqual([FILE, GAP, CTX, CTX, CTX, DEL, ADD, ADD, CTX, CTX, CTX, GAP, CTX, CTX, CTX, DEL, CTX, CTX, CTX]);
  expect([rows.n[1], rows.oldNo[1], rows.newNo[1]]).toEqual([6, 1, 1]);
  expect([rows.n[11], rows.oldNo[11], rows.newNo[11]]).toEqual([8, 14, 15]);
  expect([rows.oldNo[5], rows.newNo[6], rows.newNo[7]]).toEqual([10, 10, 11]);
});

test("split pairs a removed line with the added line beside it; a collapsed file is its header", () => {
  const rows = buildRows([{ kind: "file", key: "a.ts", fd: partial(), collapsed: false }, { kind: "file", key: "b.ts", fd: partial(), collapsed: true }], true);
  const k = kinds(rows);
  expect(k.slice(0, 11)).toEqual([FILE, GAP, PAIR, PAIR, PAIR, PAIR, PAIR, PAIR, PAIR, PAIR, GAP]);
  expect([rows.a[5]! >= 0, rows.b[5]! >= 0, rows.n[5]]).toEqual([true, true, 2]);
  expect([rows.a[6], rows.b[6]! >= 0, rows.n[6]]).toEqual([-1, true, 1]);
  expect(rows.n[2]).toBe(0);
  expect(k.at(-1)).toBe(FILE);
  expect(rows.first[1]).toBe(rows.len - 1);
});

test("with both files' text the bars fold what is not revealed, the end of the file too, and revealed lines are context", () => {
  const fd = whole();
  const shut = buildRows([{ kind: "file", key: "a.ts", fd, collapsed: false }], false);
  expect(kinds(shut).at(-1)).toBe(GAP);
  expect(shut.n[shut.len - 1]).toBe(2);
  const open = buildRows([{ kind: "file", key: "a.ts", fd, collapsed: false, reveal: { spans: [{ start: 1, end: 3 }], full: false } }], false);
  expect(kinds(open).slice(0, 6)).toEqual([FILE, CTX, CTX, CTX, GAP, CTX]);
  expect(open.n[4]).toBe(3);
  const all = buildRows([{ kind: "file", key: "a.ts", fd, collapsed: false, reveal: { spans: [], full: true } }], false);
  expect(kinds(all).filter((k) => k === GAP)).toEqual([]);
  expect(kinds(all).filter((k) => k === CTX || k === DEL || k === ADD).length).toBe(32);
});

test("a thread's card follows its last line, on its side; one whose line is folded follows the bar", () => {
  const items: Item[] = [
    {
      kind: "file",
      key: "a.ts",
      fd: partial(),
      collapsed: false,
      placed: [
        { threadId: 1, side: "additions", range: { start: 10, end: 11 } },
        { threadId: 2, side: "deletions", range: { start: 25, end: 25 } },
        { threadId: 3, side: "additions", range: { start: 3, end: 3 } },
      ],
    },
  ];
  const rows = buildRows(items, false);
  const k = kinds(rows);
  const cards = k.flatMap((x, r) => (x === CARD ? [r] : []));
  expect(cards.length).toBe(3);
  expect(rows.x[cards[0]!]).toBe(2);
  expect(k[cards[0]! - 1]).toBe(GAP);
  expect(rows.x[cards[1]!]).toBe(0);
  expect(rows.newNo[cards[1]! - 1]).toBe(11);
  expect(rows.x[cards[2]!]).toBe(1);
  expect(rows.oldNo[cards[2]! - 1]).toBe(25);
  expect(rowOfLine(rows, 0, "deletions", 25)).toBe(cards[2]! - 1);
});

test("a group row and a note in place of the code", () => {
  const rows = buildRows([{ kind: "group", key: "tests", open: false }, { kind: "file", key: "x.png", fd: partial(), collapsed: false, note: "an image" }], false);
  expect(kinds(rows)).toEqual([GROUP, FILE, NOTE]);
});

test("the layout finds the row on a screen line and moves what follows when a row grows", () => {
  const h = [1, 3, 1, 2];
  const l = new Layout(4, (r) => h[r]!);
  expect(l.total).toBe(7);
  expect([l.rowAt(0), l.rowAt(1), l.rowAt(3), l.rowAt(4), l.rowAt(6), l.rowAt(99)]).toEqual([0, 1, 1, 2, 3, 3]);
  h[1] = 1;
  l.from(1);
  expect(l.total).toBe(5);
  expect(l.top(3)).toBe(3);
});

test("word marks: the words that changed, none when nothing is alike", () => {
  const m = wordMarks("const given = req.headers.get(key);", "const given = Buffer.from(req.headers.get(key));")!;
  expect(m.old).toEqual([]);
  expect(m.new).toEqual([[14, 26], [46, 47]]);
  expect(wordMarks("abc", "xyz")).toBeNull();
  const runs = markRuns([{ text: "const ", c: 1 }, { text: "given", c: 2 }], [[4, 8]], (r) => ({ ...r, c: 9 }));
  expect(runs).toEqual([{ text: "cons", c: 1 }, { text: "t ", c: 9 }, { text: "gi", c: 9 }, { text: "ven", c: 2 }]);
});
