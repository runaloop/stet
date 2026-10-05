import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import type { Span } from "../../web/lib/cursor.ts";

const mine = !GlobalRegistrator.isRegistered;
if (mine) GlobalRegistrator.register();
afterAll(async () => {
  if (mine) await GlobalRegistrator.unregister();
});

const { closeGaps, foldInside, opening } = await import("../../web/lib/mdfold.ts");
const { renderMarkdown } = await import("../../web/lib/markdown.ts");

/** The top-level HTML of a Markdown text, folded to `spans`; a bar shows as [first-last]. */
function folded(text: string, spans: Span[]): HTMLElement {
  const r = renderMarkdown(text, { path: "a.md", imageUrl: (p) => p, changes: null });
  const box = document.createElement("div");
  box.innerHTML = r.tops.map((t) => t.html).join("");
  foldInside(box, spans, (hidden) => {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.textContent = `[${hidden[0]!.start}-${hidden[hidden.length - 1]!.end}]`;
    return bar;
  });
  return box;
}

const shape = (el: Element): string[] =>
  [...el.children].map((c) =>
    c.className === "bar"
      ? c.textContent!
      : c.tagName === "TABLE"
        ? `table${c.classList.contains("md-more") ? "+" : ""}(${c.querySelector("thead")?.classList.contains("md-again") ? "head again" : "head"}: ${[...c.querySelectorAll("tbody tr")].map((r) => r.querySelector("td")!.textContent).join(" ")})`
        : c.tagName === "OL" || c.tagName === "UL"
          ? `${c.tagName.toLowerCase()}${c.getAttribute("start") ? ` from ${c.getAttribute("start")}` : ""}(${[...c.children].map((li) => (li.className === "bar" ? li.textContent : li.firstChild!.textContent!.trim())).join(" ")})`
          : c.tagName.toLowerCase(),
  );

describe("folding rendered Markdown to the lines shown", () => {
  const doc = ["# Title", "", "First.", "", "Second.", "", "Third.", "", "Fourth.", ""].join("\n");

  test("blocks off the lines shown fold into one bar per run, with the lines they stand for", () => {
    expect(shape(folded(doc, [{ start: 5, end: 5 }]))).toEqual(["[1-3]", "p", "[7-9]"]);
    expect(shape(folded(doc, [{ start: 1, end: 1 }, { start: 9, end: 9 }]))).toEqual(["h1", "[3-7]", "p"]);
    expect(shape(folded(doc, [{ start: 1, end: 9 }]))).toEqual(["h1", "p", "p", "p", "p"]);
  });

  test("a long list partly shown folds item by item and goes on from its next number", () => {
    const list = Array.from({ length: 10 }, (_, i) => `${i + 1}. item ${i + 1}`).join("\n") + "\n";
    expect(shape(folded(list, [{ start: 5, end: 6 }]))).toEqual(["[1-4]", "ol from 5(item 5 item 6)", "[7-10]"]);
    expect(shape(folded(list, [{ start: 2, end: 2 }, { start: 9, end: 9 }]))).toEqual(["[1-1]", "ol from 2(item 2)", "[3-8]", "ol from 9(item 9)", "[10-10]"]);
  });

  test("a nested list folds inside the item that holds it", () => {
    const text = ["- a", "  - a1", "  - a2", "  - a3", "  - a4", "- b", ""].join("\n");
    const box = folded(text, [{ start: 4, end: 4 }]);
    const outer = box.querySelector("ul")!;
    expect([...outer.children].map((c) => c.tagName)).toEqual(["LI"]);
    expect(shape(outer.querySelector("li")!)).toEqual(["[2-3]", "ul(a3)", "[5-5]"]);
    expect(shape(box)).toEqual(["ul(a)", "[6-6]"]);
  });

  test("a long table partly shown folds row by row: each part has the header, again after a bar", () => {
    const table = ["| Key | Value |", "|---|---|", ...Array.from({ length: 10 }, (_, i) => `| k${i + 1} | v${i + 1} |`), ""].join("\n");
    expect(shape(folded(table, [{ start: 6, end: 6 }]))).toEqual(["[3-5]", "table(head: k4)", "[7-12]"]);
    expect(shape(folded(table, [{ start: 3, end: 3 }, { start: 10, end: 11 }]))).toEqual(["table(head: k1)", "[4-9]", "table+(head again: k8 k9)", "[12-12]"]);
  });

  test("a gap of one line is shown rather than folded, as the code shows it", () => {
    expect(closeGaps([{ start: 2, end: 6 }, { start: 8, end: 9 }, { start: 20, end: 30 }], 31)).toEqual([{ start: 1, end: 9 }, { start: 20, end: 31 }]);
    expect(closeGaps([{ start: 5, end: 6 }], 40)).toEqual([{ start: 5, end: 6 }]);
  });

  test("the lines opened for the code are the blocks shown rendered: one model for both views", async () => {
    const { parsePatchFiles } = await import("@pierre/diffs");
    const { filePatch } = await import("../../web/lib/region.ts");
    const { revealedPatch, withSpan, NOTHING } = await import("../../web/lib/reveal.ts");
    const page = (v: number) => Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}${i === 0 || i === 29 ? `, version ${v}` : ""}.`).join("\n\n") + "\n";
    const a = { path: "a.md", text: page(1) };
    const b = { path: "a.md", text: page(2) };
    const hunks = parsePatchFiles(filePatch(a, b)!).flatMap((p) => p.files)[0]!.hunks;
    const shownBy = (patch: string) => parsePatchFiles(patch).flatMap((p) => p.files)[0]!.hunks.map((h) => ({ start: h.additionStart, end: h.additionStart + h.additionCount - 1 }));
    const firstLines = (box: HTMLElement) => [...box.children].map((c) => (c.className === "bar" ? c.textContent : c.getAttribute("data-start")));
    expect(firstLines(folded(b.text, hunks.map((h) => ({ start: h.additionStart, end: h.additionStart + h.additionCount - 1 }))))).toEqual(["1", "3", "[5-55]", "57", "59"]);
    const opened = withSpan(NOTHING, { start: 29, end: 31 });
    expect(firstLines(folded(b.text, shownBy(revealedPatch(a, b, hunks, opened)!)))).toEqual(["1", "3", "[5-27]", "29", "31", "[33-55]", "57", "59"]);
  });

  test("a bar opens about 20 lines from its top or its bottom, in whole blocks, or all of them", () => {
    const hidden = Array.from({ length: 12 }, (_, i) => ({ start: 10 + i * 4, end: 11 + i * 4 }));
    expect(opening(hidden, "above")).toEqual({ start: 10, end: 31 });
    expect(opening(hidden, "below")).toEqual({ start: 34, end: 55 });
    expect(opening(hidden, "all")).toEqual({ start: 10, end: 55 });
    expect(opening([{ start: 3, end: 90 }], "above")).toEqual({ start: 3, end: 90 });
  });
});
