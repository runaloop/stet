import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import type { Pair } from "../../web/lib/markdown.ts";

const mine = !GlobalRegistrator.isRegistered;
if (mine) GlobalRegistrator.register();
afterAll(async () => {
  if (mine) await GlobalRegistrator.unregister();
});

const { isSimple, markInline, markPairs, markWords, REWRITTEN, rewritten, textOf, unitsOf } = await import("../../web/lib/richdiff.ts");
const { breakAfter, unitOf } = await import("../../web/lib/breaks.ts");

const box = (html: string) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d;
};
const leaf = (o: number, n: number): Pair => ({ old: [o], new: [n], children: null });
const tags = (a: HTMLElement, b: HTMLElement) => (side: "old" | "new", i: number) => (side === "old" ? a : b).querySelector(`[data-b="${i}"]`)!.tagName.toLowerCase();

describe("the text a reader sees", () => {
  test("text nodes in order, a line break between blocks and between table cells", () => {
    const d = box(`<ul data-b="0"><li data-b="1">one <b>bold</b></li><li data-b="2">two</li></ul><table data-b="3"><tr data-b="4"><td>a</td><td>b</td></tr></table>`);
    expect(textOf([d.firstElementChild!, d.lastElementChild!]).text).toBe("one bold\ntwo\na\nb");
  });

  test("a list item's own text leaves out the list inside it", () => {
    const d = box(`<li data-b="0">top <i>item</i><ul data-b="1"><li data-b="2">inner</li></ul></li>`);
    expect(textOf([d.firstElementChild!], true).text).toBe("top item");
  });
});

describe("words that changed", () => {
  test("a changed word is struck through on the old side and green on the new one; inline markup stays", () => {
    const a = box(`<p data-b="0">It keeps the <b>cart</b> in memory.</p>`);
    const b = box(`<p data-b="0">It keeps the <b>cart</b> in SQLite.</p>`);
    markWords(unitsOf(a, b, [leaf(0, 0)]));
    expect(a.innerHTML).toBe(`<p data-b="0" class="md-words">It keeps the <b>cart</b> in <del>memory</del>.</p>`);
    expect(b.innerHTML).toBe(`<p data-b="0" class="md-words">It keeps the <b>cart</b> in <ins>SQLite</ins>.</p>`);
  });

  test("a range that crosses inline elements is marked inside each of them", () => {
    const a = box(`<p data-b="0">alpha gamma</p>`);
    const b = box(`<p data-b="0">alpha <b>new</b> words gamma</p>`);
    markWords(unitsOf(a, b, [leaf(0, 0)]));
    expect(b.innerHTML).toBe(`<p data-b="0" class="md-words">alpha <b><ins>new</ins></b> <ins>words</ins> gamma</p>`);
    const c = box(`<p data-b="0">see <a data-href="x.md">the old docs</a> today</p>`);
    const e = box(`<p data-b="0">see <a data-href="x.md">the docs</a> today</p>`);
    markWords(unitsOf(c, e, [leaf(0, 0)]));
    expect(c.innerHTML).toBe(`<p data-b="0" class="md-words">see <a data-href="x.md">the <del>old</del> docs</a> today</p>`);
  });

  test("a changed picture or link address is marked, with the old address on hover", () => {
    const a = box(`<p data-b="0"><img data-src="a.png" alt="x"> and <a data-href="old.md" title="old">docs</a></p>`);
    const b = box(`<p data-b="0"><img data-src="b.png" alt="x"> and <a data-href="new.md" title="new">docs</a></p>`);
    const units = unitsOf(a, b, [leaf(0, 0)]);
    markWords(units);
    expect(b.querySelector("img")!.className).toBe("md-target-new");
    expect(b.querySelector("img")!.getAttribute("title")).toBe("was a.png");
    expect(b.querySelector("a")!.getAttribute("title")).toBe("new · was old.md");
    expect(a.querySelector("img")!.className).toBe("md-target-old");
    expect(isSimple([leaf(0, 0)], units, tags(a, b))).toBe(true);
  });

  test(`a pair with more than ${REWRITTEN * 100}% of its words changed keeps the whole-block mark`, () => {
    const a = box(`<p data-b="0">Everything here was written for the first release.</p>`);
    const b = box(`<p data-b="0">Rewritten from scratch: install, run, deploy.</p>`);
    const units = unitsOf(a, b, [leaf(0, 0)]);
    expect(rewritten(units[0]!)).toBe(true);
    markWords(units);
    expect(a.querySelector("del, ins")).toBeNull();
    expect(isSimple([leaf(0, 0)], units, tags(a, b))).toBe(false);
  });
});

describe("one version with the changes in it", () => {
  test("what was removed is struck through where it was, before what replaced it", () => {
    const a = box(`<p data-b="0">keep the cart in memory for now</p>`);
    const b = box(`<p data-b="0">keep the cart in SQLite for now</p>`);
    const pairs = [leaf(0, 0)];
    const units = unitsOf(a, b, pairs);
    expect(isSimple(pairs, units, tags(a, b))).toBe(true);
    const fresh = box(b.innerHTML);
    markInline(fresh, pairs, units);
    expect(fresh.innerHTML).toBe(`<p data-b="0" class="md-words">keep the cart in <del>memory</del><ins>SQLite</ins> for now</p>`);
  });

  test("removed text keeps its formatting: bold, code and a link, but not what the place it goes to already has", () => {
    const a = box(`<p data-b="0">keep the <b>whole</b> cart in <code>memory</code> for now</p>`);
    const b = box(`<p data-b="0">keep the cart in SQLite for now</p>`);
    const pairs = [leaf(0, 0)];
    markInline(b, pairs, unitsOf(a, b, pairs));
    expect(b.innerHTML).toBe(`<p data-b="0" class="md-words">keep the <del><b>whole</b> </del>cart in <del><code>memory</code></del><ins>SQLite</ins> for now</p>`);
    const c = box(`<p data-b="0">see <a class="md-file" data-href="x.md">the old docs</a> today</p>`);
    const e = box(`<p data-b="0">see <a class="md-file" data-href="x.md">the docs</a> today</p>`);
    markInline(e, pairs, unitsOf(c, e, pairs));
    expect(e.innerHTML).toBe(`<p data-b="0" class="md-words">see <a class="md-file" data-href="x.md">the <del>old </del>docs</a> today</p>`);
    const t = box(`<table data-b="0"><tbody data-b="1"><tr data-b="2"><td><em>a</em></td><td><strong>1</strong></td></tr></tbody></table>`);
    const u = box(`<table data-b="0"><tbody data-b="1"><tr data-b="2"><td><em>a</em></td><td>2</td></tr></tbody></table>`);
    const rows: Pair[] = [{ old: [0], new: [0], children: [{ old: [1], new: [1], children: [leaf(2, 2)] }] }];
    markInline(u, rows, unitsOf(t, u, rows));
    expect(u.querySelector("tr")!.innerHTML).toBe(`<td><em>a</em></td><td><del><strong>1</strong></del><ins>2</ins></td>`);
  });

  test("a different kind of block, an added item or a code block keeps the old and the new version", () => {
    const a = box(`<p data-b="0">Install it</p>`);
    const b = box(`<h2 data-b="0">Install it now</h2>`);
    expect(isSimple([leaf(0, 0)], unitsOf(a, b, [leaf(0, 0)]), tags(a, b))).toBe(false);
    const c = box(`<ul data-b="0"><li data-b="1">one</li></ul>`);
    const e = box(`<ul data-b="0"><li data-b="1">one!</li><li data-b="2">two</li></ul>`);
    const list: Pair[] = [{ old: [0], new: [0], children: [leaf(1, 1), { old: [], new: [2], children: null }] }];
    expect(isSimple(list, unitsOf(c, e, list), tags(c, e))).toBe(false);
  });
});

describe("a thread under its row or item", () => {

  test("a table ends after the row, a slot follows, and the rest goes on with the header again", () => {
    const d = box(
      `<table data-b="0"><thead data-b="1"><tr data-b="2"><th>k</th><th>v</th></tr></thead><tbody data-b="3"><tr data-b="4"><td>a</td><td>1</td></tr><tr data-b="5"><td>b</td><td>2</td></tr><tr data-b="6"><td>c</td><td>3</td></tr></tbody></table>`,
    );
    breakAfter(d.querySelector('[data-b="4"]')!, "0");
    breakAfter(d.querySelector('[data-b="5"]')!, "1");
    expect([...d.children].map((e) => (e.tagName === "TABLE" ? [...e.querySelectorAll("tr")].map((r) => r.textContent).join("|") : `${e.className}@${e.getAttribute("data-after")}`))).toEqual([
      "kv|a1",
      "md-slot@4",
      "kv|b2",
      "md-slot@5",
      "kv|c3",
    ]);
    expect(d.querySelectorAll('[data-b="2"]').length).toBe(1);
    expect(d.querySelectorAll("thead.md-again").length).toBe(2);
    expect(d.lastElementChild!.getAttribute("data-pair")).toBe("more-1");
  });

  test("the last row of a table needs no rest; an ordered list goes on from the next number", () => {
    const t = box(`<table data-b="0"><tbody data-b="1"><tr data-b="2"><td>a</td></tr></tbody></table>`);
    breakAfter(t.querySelector("tr")!, "0");
    expect([...t.children].map((e) => e.tagName)).toEqual(["TABLE", "DIV"]);
    const l = box(`<ol data-b="0" start="3"><li data-b="1">c</li><li class="md-gap"></li><li data-b="2">d</li><li data-b="3">e</li></ol>`);
    breakAfter(l.querySelector('[data-b="2"]')!, "0");
    expect(l.innerHTML).toBe(`<ol data-b="0" start="3"><li data-b="1">c</li><li class="md-gap"></li><li data-b="2">d</li></ol><div class="md-slot" data-after="2" data-pair="slot-0"></div><ol start="5" class="md-more" data-pair="more-0"><li data-b="3">e</li></ol>`);
  });

  test("a nested item breaks its own list, inside the item around it; a paragraph of a loose item stands for the item", () => {
    const d = box(`<ul data-b="0"><li data-b="1">a<ul data-b="2"><li data-b="3">a1</li><li data-b="4">a2</li></ul></li><li data-b="5"><p data-b="6">b</p></li></ul>`);
    breakAfter(unitOf(d.querySelector('[data-b="3"]')!)!, "0");
    expect(d.querySelector('[data-b="1"]')!.innerHTML).toBe(`a<ul data-b="2"><li data-b="3">a1</li></ul><div class="md-slot" data-after="3" data-pair="slot-0"></div><ul class="md-more" data-pair="more-0"><li data-b="4">a2</li></ul>`);
    expect(unitOf(d.querySelector('[data-b="6"]')!)!.getAttribute("data-b")).toBe("5");
  });
});

describe("pairs lined up", () => {
  test("pairs are numbered on both sides and an added item gets an empty slot where it would be", () => {
    const a = box(`<ul data-b="0"><li data-b="1">one</li><li data-b="2">three</li></ul>`);
    const b = box(`<ul data-b="0"><li data-b="1">one</li><li data-b="2">two</li><li data-b="3">three</li></ul>`);
    markPairs(a, b, [{ old: [0], new: [0], children: [leaf(1, 1), { old: [], new: [2], children: null }, leaf(2, 3)] }]);
    expect(a.innerHTML).toBe(
      `<ul data-b="0" data-pair="0"><li data-b="1" data-pair="1">one</li><li class="md-gap" aria-hidden="true" data-pair="2"></li><li data-b="2" data-pair="3">three</li></ul>`,
    );
    expect([...b.querySelectorAll("[data-pair]")].map((el) => el.getAttribute("data-pair"))).toEqual(["0", "1", "2", "3"]);
  });

  test("a table row with nothing facing it gets an empty row as wide as it", () => {
    const a = box(`<table data-b="0"><tbody data-b="1"><tr data-b="2"><td>a</td><td>1</td></tr></tbody></table>`);
    const b = box(`<table data-b="0"><tbody data-b="1"><tr data-b="2"><td>a</td><td>1</td></tr><tr data-b="3"><td>b</td><td>2</td></tr></tbody></table>`);
    markPairs(a, b, [{ old: [0], new: [0], children: [{ old: [1], new: [1], children: [leaf(2, 2), { old: [], new: [3], children: null }] }] }]);
    expect(a.querySelector("tr.md-gap")!.outerHTML).toBe(`<tr class="md-gap" aria-hidden="true" data-pair="3"><td colspan="2"></td></tr>`);
  });
});
