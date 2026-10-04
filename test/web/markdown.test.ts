import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, test } from "bun:test";
import { changesOf, isMarkdown, markBlocks, renderMarkdown, resolveRef, type Block } from "../../web/lib/markdown.ts";

const imageUrl = (path: string) => `/raw/${path}`;
const render = (text: string, more: Partial<Parameters<typeof renderMarkdown>[1]> = {}) => renderMarkdown(text, { path: "docs/guide.md", imageUrl, changes: null, ...more });

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
    const { html } = render("![the card](../res/card.png) ![remote](https://example.com/x.png) ![doc](spec.pdf)");
    expect(html).toContain(`<img src="/raw/res/card.png" alt="the card" data-path="res/card.png">`);
    expect(html).not.toContain("<img src=\"https://");
    expect(html).toMatch(/<span class="md-image-off"[^>]*>▧ remote · <code>https:\/\/example\.com\/x\.png<\/code><\/span>/);
    expect(html).toMatch(/<span class="md-image-off" title="not an image file">▧ doc · <code>spec\.pdf<\/code><\/span>/);
  });

  test("raw HTML stays text, a script link is no link, links do not navigate", () => {
    const { html } = render(`<img src=x onerror="alert(1)"> [run](javascript:alert(1)) [web](https://example.com) [code](../src/Cache.kt#L3)`);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("javascript:alert(1)\"");
    expect(html).not.toContain("href=");
    expect(html).toContain(`<a class="md-outside" title="https://example.com">web</a>`);
    expect(html).toContain(`<a class="md-file" data-path="src/Cache.kt" data-line="3" title="src/Cache.kt: open it in the preview">code</a>`);
  });
});

describe("changed blocks", () => {
  const blocks: Block[] = [
    { start: 1, end: 1, parent: -1 },
    { start: 3, end: 4, parent: -1 },
    { start: 6, end: 9, parent: -1 },
    { start: 6, end: 6, parent: 2 },
    { start: 7, end: 9, parent: 2 },
    { start: 8, end: 9, parent: 4 },
    { start: 8, end: 9, parent: 5 },
  ];
  const marks = (added: number[], removed: { after: number; count: number; old: number }[] = []) => markBlocks(blocks, { added: new Set(added), removed });

  test("the innermost blocks whose lines were added are marked, not the ones around them", () => {
    expect([...marks([8]).changed]).toEqual([6]);
    expect([...marks([7]).changed]).toEqual([4]);
    expect([...marks([1, 4, 6]).changed]).toEqual([0, 1, 3]);
    expect([...marks([2, 5]).changed]).toEqual([]);
  });

  test("lines removed inside a block mark it; between top-level blocks they are counted before the next one", () => {
    expect([...marks([], [{ after: 6, count: 1, old: 7 }]).changed]).toEqual([2]);
    const between = marks([], [{ after: 4, count: 2, old: 5 }, { after: 5, count: 1, old: 8 }, { after: 9, count: 3, old: 12 }]);
    expect(between.changed.size).toBe(0);
    expect([...between.removedBefore]).toEqual([[2, { count: 3, old: 5 }], [7, { count: 3, old: 12 }]]);
  });

  test("a diff of a Markdown file marks the blocks it touched and lists what it removed where it was", () => {
    const after = ["# Guide", "", "Intro, now longer.", "", "## Usage", "", "Run it.", "", "![card](../res/card.png)", ""].join("\n");
    const patch = [
      "diff --git a/docs/guide.md b/docs/guide.md",
      "--- a/docs/guide.md",
      "+++ b/docs/guide.md",
      "@@ -1,9 +1,9 @@",
      " # Guide",
      " ",
      "-Intro.",
      "+Intro, now longer.",
      " ",
      "-Old paragraph.",
      "-",
      " ## Usage",
      " ",
      " Run it.",
      "+",
      "+![card](../res/card.png)",
      "",
    ].join("\n");
    const changes = changesOf(parsePatchFiles(patch, "t")[0]!.files[0]!);
    expect([...changes.added]).toEqual([3, 8, 9]);
    expect(changes.removed).toEqual([{ after: 4, count: 2, old: 5 }]);
    const { html } = render(after, { changes });
    expect(html).toContain(`<h1 data-start="1" data-end="1">Guide</h1>`);
    expect(html).toContain(`<p data-start="3" data-end="3" class="md-changed">Intro, now longer.</p>\n<div class="md-removed" data-old="5">− 2 lines removed here</div>\n<h2 data-start="5" data-end="5">Usage</h2>`);
    expect(html).toContain(`<p data-start="7" data-end="7">Run it.</p>`);
    expect(html).toContain(`<p data-start="9" data-end="9" class="md-changed"><img src="/raw/res/card.png"`);
  });

  test("a tight list marks the item, a code block keeps its lines and goes through the highlighter", () => {
    const text = ["- a", "- b", "", "```ts", "const x = 1;", "```", "", "```", "plain", "```", ""].join("\n");
    const plain = render(text, { changes: { added: new Set([2, 5]), removed: [] } });
    expect(plain.langs).toEqual(["ts"]);
    expect(plain.html).toContain(`<li data-start="2" data-end="2" class="md-changed">b</li>`);
    expect(plain.html).toContain(`<div data-start="4" data-end="6" class="md-changed md-code"><pre><code>const x = 1;\n</code></pre></div>`);
    const lit = render(text, { highlight: (code, lang) => (lang === "ts" ? `<pre class="shiki">${code.trim()}</pre>` : null) });
    expect(lit.html).toContain(`<div data-start="4" data-end="6" class="md-code"><pre class="shiki">const x = 1;</pre></div>`);
    expect(lit.html).toContain(`<div data-start="8" data-end="10" class="md-code"><pre><code>plain\n</code></pre></div>`);
  });
});
