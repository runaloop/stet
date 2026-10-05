import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, test } from "bun:test";
import { createTwoFilesPatch } from "diff";
import { CursorSpace } from "../../web/lib/cursor.ts";
import { changedBlocks, changesOf, hitBlocks, isMarkdown, layoutOf, likeness, renderMarkdown, resolveRef, slotsOf, stopsOn, type Block } from "../../web/lib/markdown.ts";

const imageUrl = (path: string) => `/raw/${path}`;
const render = (text: string, more: Partial<Parameters<typeof renderMarkdown>[1]> = {}) => renderMarkdown(text, { path: "docs/guide.md", imageUrl, changes: null, ...more });
const html = (text: string, more: Partial<Parameters<typeof renderMarkdown>[1]> = {}) => render(text, more).tops.map((t) => t.html).join("");
const lines = (...l: string[]) => [...l, ""].join("\n");

function diffOf(before: string, after: string): FileDiffMetadata {
  const body = createTwoFilesPatch("a/doc.md", "b/doc.md", before, after, "", "", { context: 3 }).split("\n").slice(1).join("\n");
  return parsePatchFiles(`diff --git a/doc.md b/doc.md\n${body}`, "t")[0]!.files[0]!;
}

/** Both sides rendered and laid out next to each other, as the rendered view does it. */
function laidOut(before: string | null, after: string | null, fd = diffOf(before ?? "", after ?? ""), split = true, merged = new Set<number>()) {
  const ch = changesOf(fd);
  const old = before === null ? null : render(before, { changes: ch.old });
  const nw = after === null ? null : render(after, { changes: ch.new });
  const count = (t: string | null) => (t === null ? 0 : t.split("\n").length);
  return { old, nw, fd, ...layoutOf(old, nw, slotsOf(fd, count(before), count(after)), split, merged) };
}

describe("references in a Markdown file", () => {
  test("relative ones resolve against the file's folder, a leading slash against the repository root", () => {
    expect(resolveRef("img/a.png", "docs/guide.md")).toEqual({ path: "docs/img/a.png", line: null });
    expect(resolveRef("./img/../shot.png", "docs/guide.md")).toEqual({ path: "docs/shot.png", line: null });
    expect(resolveRef("../res/card.png", "docs/guide.md")).toEqual({ path: "res/card.png", line: null });
    expect(resolveRef("/assets/logo.png", "docs/guide.md")).toEqual({ path: "assets/logo.png", line: null });
    expect(resolveRef("img/a%20b.png?raw=true", "README.md")).toEqual({ path: "img/a b.png", line: null });
    expect(resolveRef("src/Cache.kt#L12-L14", "README.md")).toEqual({ path: "src/Cache.kt", line: 12 });
  });

  test("web addresses, anchors, other schemes and paths above the root point outside the repository", () => {
    for (const ref of ["https://example.com/a.png", "//cdn.example.com/a.png", "data:image/png;base64,AAAA", "mailto:a@b.c", "#usage", "../../a.png", ""]) {
      expect(resolveRef(ref, "docs/guide.md")).toEqual({ outside: ref });
    }
  });

  test("only .md and .markdown files render", () => {
    expect([isMarkdown("README.md"), isMarkdown("docs/A.MARKDOWN"), isMarkdown("notes.mdx"), isMarkdown("md")]).toEqual([true, true, false, false]);
  });
});

describe("images", () => {
  test("a repository image loads from the snapshot; a remote one and a non-image file are a placeholder with the link", () => {
    const out = html("![the card](../res/card.png) ![remote](https://example.com/x.png) ![doc](spec.pdf)");
    expect(out).toContain(`<img src="/raw/res/card.png" alt="the card" data-path="res/card.png" data-src="../res/card.png">`);
    expect(out).not.toContain("<img src=\"https://");
    expect(out).toMatch(/<span class="md-image-off"[^>]*>▧ remote · <code>https:\/\/example\.com\/x\.png<\/code><\/span>/);
    expect(out).toMatch(/<span class="md-image-off" title="not an image file">▧ doc · <code>spec\.pdf<\/code><\/span>/);
  });

  test("raw HTML stays text, a script link is no link, links do not navigate", () => {
    const out = html(`<img src=x onerror="alert(1)"> [run](javascript:alert(1)) [web](https://example.com) [code](../src/Cache.kt#L3)`);
    expect(out).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(out).not.toContain("javascript:alert(1)\"");
    expect(out).not.toMatch(/\shref=/);
    expect(out).toContain(`<a class="md-outside" data-href="https://example.com" title="https://example.com">web</a>`);
    expect(out).toContain(`<a class="md-file" data-path="src/Cache.kt" data-line="3" data-href="../src/Cache.kt#L3" title="src/Cache.kt: open it in the preview">code</a>`);
  });
});

describe("changed blocks", () => {
  const blocks: Block[] = [
    { start: 1, end: 1, parent: -1, tag: "p" },
    { start: 3, end: 4, parent: -1, tag: "p" },
    { start: 6, end: 9, parent: -1, tag: "p" },
    { start: 6, end: 6, parent: 2, tag: "p" },
    { start: 7, end: 9, parent: 2, tag: "p" },
    { start: 8, end: 9, parent: 4, tag: "p" },
    { start: 8, end: 9, parent: 5, tag: "p" },
  ];
  const changed = (lines: number[], gaps: number[] = []) => [...changedBlocks(blocks, hitBlocks(blocks, { lines: new Set(lines), gaps }))];

  test("the innermost blocks whose lines changed are marked, not the ones around them", () => {
    expect(changed([8])).toEqual([6]);
    expect(changed([7])).toEqual([4]);
    expect(changed([1, 4, 6])).toEqual([0, 1, 3]);
    expect(changed([2, 5])).toEqual([]);
  });

  test("lines the other side has inside a block mark it; between blocks they mark none", () => {
    expect(changed([], [6])).toEqual([2]);
    expect(changed([], [4, 5, 9])).toEqual([]);
  });

  test("a diff marks what it added on the new side and what it removed on the old side", () => {
    const before = lines("# Guide", "", "Intro.", "", "Old paragraph.", "", "## Usage", "", "Run it.");
    const after = lines("# Guide", "", "Intro, now longer.", "", "## Usage", "", "Run it.", "", "![card](../res/card.png)");
    const ch = changesOf(diffOf(before, after));
    expect([...ch.new.lines]).toEqual([3, 8, 9]);
    expect(ch.new.gaps).toEqual([4]);
    expect([...ch.old.lines]).toEqual([3, 5, 6]);
    expect(ch.old.gaps).toEqual([9]);
    const nw = html(after, { changes: ch.new });
    expect(nw).toContain(`<h1 data-b="0" data-start="1" data-end="1">Guide</h1>`);
    expect(nw).toContain(`<p data-b="1" data-start="3" data-end="3" class="md-changed">Intro, now longer.</p>`);
    expect(nw).toContain(`<p data-b="3" data-start="7" data-end="7">Run it.</p>`);
    expect(nw).toContain(`<p data-b="4" data-start="9" data-end="9" class="md-changed"><img src="/raw/res/card.png"`);
    const old = html(before, { changes: ch.old });
    expect(old).toContain(`<p data-b="2" data-start="5" data-end="5" class="md-changed">Old paragraph.</p>`);
    expect(old).toContain(`<p data-b="4" data-start="9" data-end="9">Run it.</p>`);
  });

  test("a tight list marks the item, a code block keeps its lines and goes through the highlighter", () => {
    const text = lines("- a", "- b", "", "```ts", "const x = 1;", "```", "", "```", "plain", "```");
    const plain = render(text, { changes: { lines: new Set([2, 5]), gaps: [] } });
    expect(plain.langs).toEqual(["ts"]);
    const out = plain.tops.map((t) => t.html).join("");
    expect(out).toContain(`<li data-b="2" data-start="2" data-end="2" class="md-changed">b</li>`);
    expect(out).toContain(`<div data-b="3" data-start="4" data-end="6" class="md-changed md-code"><pre><code>const x = 1;\n</code></pre></div>`);
    const lit = html(text, { highlight: (code, lang) => (lang === "ts" ? `<pre class="shiki">${code.trim()}</pre>` : null) });
    expect(lit).toContain(`<div data-b="3" data-start="4" data-end="6" class="md-code"><pre class="shiki">const x = 1;</pre></div>`);
    expect(lit).toContain(`<div data-b="4" data-start="8" data-end="10" class="md-code"><pre><code>plain\n</code></pre></div>`);
  });
});

describe("old and new side by side", () => {
  test("every line has its place in the diff: an unchanged line shares it with its twin, one change is one place", () => {
    const fd = diffOf(lines("a", "b", "c", "d"), lines("a", "B", "B2", "c", "d", "e"));
    const s = slotsOf(fd, 5, 7);
    expect(s.old.slice(1)).toEqual([0, 1, 2, 3, 5]);
    expect(s.new.slice(1)).toEqual([0, 1, 1, 2, 3, 4, 5]);
  });

  test("a hunk with no lines on one side, as in a new or a deleted file, starts after the line it names", () => {
    const added = parsePatchFiles(["diff --git a/n.md b/n.md", "new file mode 100644", "--- /dev/null", "+++ b/n.md", "@@ -0,0 +1,2 @@", "+a", "+b", ""].join("\n"), "t")[0]!.files[0]!;
    expect(slotsOf(added, 0, 3)).toEqual({ old: [], new: [undefined as unknown as number, 0, 0, 1] });
    const u0 = parsePatchFiles(["diff --git a/x.md b/x.md", "--- a/x.md", "+++ b/x.md", "@@ -2,0 +3 @@", "+new", ""].join("\n"), "t")[0]!.files[0]!;
    const s = slotsOf(u0, 3, 4);
    expect(s.old.slice(1)).toEqual([0, 1, 3]);
    expect(s.new.slice(1)).toEqual([0, 1, 2, 3]);
    expect(changesOf(u0).old.gaps).toEqual([2]);
  });

  test("unchanged blocks face each other, a changed one faces its old version, a removed or added one stands alone", () => {
    const before = lines("# Guide", "", "Intro.", "", "Old paragraph.", "", "## Usage", "", "Run it.");
    const after = lines("# Guide", "", "Intro, now longer.", "", "## Usage", "", "Run it.", "", "New paragraph.");
    const { rows } = laidOut(before, after);
    expect(rows).toEqual([
      { kind: "same", old: [0], new: [0] },
      { kind: "changed", old: [1], new: [1] },
      { kind: "removed", old: [2], new: [] },
      { kind: "same", old: [3], new: [2] },
      { kind: "same", old: [4], new: [3] },
      { kind: "added", old: [], new: [4] },
    ]);
  });

  test("blocks that the diff joins or splits face each other in one row", () => {
    const { rows } = laidOut(lines("One.", "", "Two.", "", "Tail."), lines("One.", "Two.", "", "Tail."));
    expect(rows.map((r) => [r.kind, r.old, r.new])).toEqual([
      ["changed", [0, 1], [0]],
      ["same", [2], [1]],
    ]);
  });

  test("a list with one item changed is one changed row; its items face each other and stop once unless they changed", () => {
    const { rows, pairs, stops } = laidOut(lines("- a", "- b", "- c", "", "End."), lines("- a", "- B", "- c", "", "End."));
    expect(rows.map((r) => r.kind)).toEqual(["changed", "same"]);
    expect(pairs[0]).toEqual([{ old: [0], new: [0], children: [{ old: [1], new: [1], children: null }, { old: [2], new: [2], children: null }, { old: [3], new: [3], children: null }] }]);
    expect(stops.map((s) => [s.side, s.nav.old, s.nav.new, s.nav.changed, s.nav.group])).toEqual([
      ["new", { start: 1, end: 1 }, { start: 1, end: 1 }, false, 0],
      ["old", { start: 2, end: 2 }, null, true, 0],
      ["new", null, { start: 2, end: 2 }, true, 0],
      ["new", { start: 3, end: 3 }, { start: 3, end: 3 }, false, 0],
      ["new", { start: 5, end: 5 }, { start: 5, end: 5 }, false, 1],
    ]);
  });

  test("in unified view a changed row stops on its old blocks, then its new ones; drawn once, it stops pair by pair", () => {
    const before = lines("- a", "- b", "- c");
    const after = lines("- a", "- B", "- c");
    const fd = diffOf(before, after);
    const unified = laidOut(before, after, fd, false);
    expect(unified.stops.map((s) => s.side)).toEqual(["old", "old", "old", "new", "new", "new"]);
    const once = laidOut(before, after, fd, false, new Set([0]));
    expect(once.stops.map((s) => [s.side, s.twin, s.nav.changed])).toEqual([
      ["new", 1, false],
      ["new", 2, true],
      ["new", 3, false],
    ]);
  });

  test("items and rows added or removed inside a changed list or table face an empty slot; nested items pair too", () => {
    const before = lines("- one", "- two", "  - two.a", "- three", "", "| k | v |", "|---|---|", "| a | 1 |", "| b | 2 |");
    const after = lines("- one", "- two", "  - two.a", "  - two.b", "- three, now longer", "- four", "", "| k | v |", "|---|---|", "| a | 1 |", "| b | 20 |", "| c | 3 |");
    const { rows, pairs, old, nw } = laidOut(before, after);
    expect(rows.map((r) => r.kind)).toEqual(["changed", "changed"]);
    const tagged = (list: typeof pairs[0]): unknown =>
      list.map((p) => [p.old.map((i) => old!.blocks[i]!.tag + old!.blocks[i]!.start), p.new.map((i) => nw!.blocks[i]!.tag + nw!.blocks[i]!.start), p.children ? tagged(p.children) : null]);
    expect(tagged(pairs[0]!)).toEqual([
      [["ul1"], ["ul1"], [
        [["li1"], ["li1"], null],
        [["li2"], ["li2"], [[["ul3"], ["ul3"], [[["li3"], ["li3"], null], [[], ["li4"], null]]]]],
        [["li4"], ["li5"], null],
        [[], ["li6"], null],
      ]],
    ]);
    expect(tagged(pairs[1]!)).toEqual([
      [["table6"], ["table8"], [
        [["thead6"], ["thead8"], [[["tr6"], ["tr8"], null]]],
        [["tbody8"], ["tbody10"], [[["tr8"], ["tr10"], null], [["tr9"], ["tr11"], null], [[], ["tr12"], null]]],
      ]],
    ]);
  });

  test("blocks one change rewrote together pair by likeness, in order; what is left over stands alone", () => {
    expect(likeness("Pay by card", "Pay by card or by invoice")).toBeCloseTo(2 / 3);
    expect(likeness("alpha beta", "gamma delta")).toBe(0);
    const { pairs, old, nw } = laidOut(lines("- Gone item", "- Pay by card"), lines("- Pay by card or by invoice", "- Promo codes"));
    expect(pairs[0]![0]!.children!.map((p) => [p.old.map((i) => old!.blocks[i]!.start), p.new.map((i) => nw!.blocks[i]!.start)])).toEqual([
      [[1], []],
      [[2], [1]],
      [[], [2]],
    ]);
  });

  test("an unchanged block stops once, on the new side, with its old lines and its old twin", () => {
    const { stops, rows } = laidOut(lines("Gone.", "", "| a | b |", "|---|---|", "| 1 | 2 |"), lines("| a | b |", "|---|---|", "| 1 | 2 |"));
    expect(rows.map((r) => r.kind)).toEqual(["removed", "same"]);
    expect(stops.map((s) => [s.side, s.block, s.twin, s.nav.old, s.nav.new])).toEqual([
      ["old", 0, null, { start: 1, end: 1 }, null],
      ["new", 2, 3, { start: 3, end: 3 }, { start: 1, end: 1 }],
      ["new", 4, 5, { start: 5, end: 5 }, { start: 3, end: 3 }],
    ]);
  });

  test("a new file is all added blocks, a deleted one all removed", () => {
    const text = lines("# New", "", "Text.");
    const added = parsePatchFiles(["diff --git a/n.md b/n.md", "new file mode 100644", "--- /dev/null", "+++ b/n.md", "@@ -0,0 +1,3 @@", "+# New", "+", "+Text.", ""].join("\n"), "t")[0]!.files[0]!;
    const a = laidOut(null, text, added);
    expect(a.rows.map((r) => r.kind)).toEqual(["added", "added"]);
    expect(a.stops.every((s) => s.side === "new" && s.nav.changed)).toBe(true);
    const deleted = parsePatchFiles(["diff --git a/n.md b/n.md", "deleted file mode 100644", "--- a/n.md", "+++ /dev/null", "@@ -1,3 +0,0 @@", "-# New", "-", "-Text.", ""].join("\n"), "t")[0]!.files[0]!;
    const d = laidOut(text, null, deleted);
    expect(d.rows.map((r) => r.kind)).toEqual(["removed", "removed"]);
    expect(d.stops.map((s) => s.nav.old)).toEqual([{ start: 1, end: 1 }, { start: 3, end: 3 }]);
  });
});

describe("threads on rendered blocks", () => {
  const text = lines("Intro line one", "and line two.", "", "- a", "- b", "  - c", "", "", "End.");
  const { stops } = laidOut(text, text);

  test("a block maps to its source lines, and a thread on lines maps back to the blocks it covers", () => {
    expect(stops.map((s) => s.nav.new)).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 4 },
      { start: 5, end: 6 },
      { start: 6, end: 6 },
      { start: 9, end: 9 },
    ]);
    expect(stopsOn(stops, "new", 1, 2)).toEqual({ stops: [0], partial: false });
    expect(stopsOn(stops, "new", 2, 2)).toEqual({ stops: [0], partial: true });
    expect(stopsOn(stops, "new", 1, 4)).toEqual({ stops: [0, 1], partial: false });
  });

  test("an item inside another takes a thread on its own lines; the outer one only for lines of its own", () => {
    expect(stopsOn(stops, "new", 6, 6)).toEqual({ stops: [3], partial: false });
    expect(stopsOn(stops, "new", 5, 6)).toEqual({ stops: [2, 3], partial: false });
  });

  test("a thread on blank lines shows on the block before them; one on the old side finds the unchanged block by its old lines", () => {
    expect(stopsOn(stops, "new", 7, 8)).toEqual({ stops: [3], partial: true });
    expect(stopsOn(stops, "old", 9, 9)).toEqual({ stops: [4], partial: false });
  });
});

describe("the cursor over rendered blocks", () => {
  const before = lines("Same.", "", "Old text.", "", "Gone.", "", "Tail.");
  const after = lines("Same.", "", "New text.", "", "Tail.", "", "Added.");
  const { fd, stops } = laidOut(before, after);
  const other = parsePatchFiles(["diff --git a/b.kt b/b.kt", "--- a/b.kt", "+++ b/b.kt", "@@ -1,2 +1,2 @@", "-x", "+y", " z", ""].join("\n"), "t")[0]!.files[0]!;
  const picture = parsePatchFiles(["diff --git a/c.svg b/c.svg", "--- a/c.svg", "+++ b/c.svg", "@@ -1 +1 @@", "-<svg/>", "+<svg />", ""].join("\n"), "t")[0]!.files[0]!;
  const space = new CursorSpace([
    { fd, collapsed: false, blocks: stops.map((s) => s.nav) },
    { fd: picture, collapsed: false, blocks: [] },
    { fd: other, collapsed: false },
  ]);
  const at = (row: number) => ({ path: "doc.md", row });

  test("j and k step over the blocks, a picture is one stop, then the lines of the next file", () => {
    expect(stops.map((s) => [s.side, s.nav.changed])).toEqual([
      ["new", false],
      ["old", true],
      ["new", true],
      ["old", true],
      ["new", false],
      ["new", true],
    ]);
    expect(space.total).toBe(6 + 1 + 3);
    expect(space.move(at(5), 1)).toEqual({ path: "c.svg", row: -1 });
    expect(space.move({ path: "c.svg", row: -1 }, 1)).toEqual({ path: "b.kt", row: 0 });
  });

  test("]c stops once at each changed row, not at each block of it", () => {
    expect(space.nextChange(at(0), 1)).toEqual(at(1));
    expect(space.nextChange(at(1), 1)).toEqual(at(3));
    expect(space.nextChange(at(3), 1)).toEqual(at(5));
    expect(space.nextChange(at(5), -1)).toEqual(at(3));
  });

  test("a line finds its block on either side; a selection of blocks comments on all their lines", () => {
    expect(space.locate("doc.md", "additions", 3)).toEqual(at(2));
    expect(space.locate("doc.md", "deletions", 5)).toEqual(at(3));
    expect(space.locate("doc.md", "deletions", 7)).toEqual(at(4));
    expect(space.range(at(0), at(2))).toEqual({ path: "doc.md", side: "additions", start: 1, end: 3 });
    expect(space.range(at(1), at(1))).toEqual({ path: "doc.md", side: "deletions", start: 3, end: 3 });
    expect(space.block(at(4))).toEqual({ old: { start: 7, end: 7 }, new: { start: 5, end: 5 }, changed: false, group: 3 });
  });
});
