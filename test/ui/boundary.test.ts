import { describe, expect, test } from "bun:test";
import { dirname, join, relative, resolve } from "node:path";

// src/ui is shared by the web and a terminal UI: it may not reach for the browser, Preact or the web's files.
const ROOT = join(import.meta.dir, "../..");
const UI = join(ROOT, "src/ui");
const PACKAGES = new Set(["@pierre/diffs", "diff"]);
const BROWSER =
  /(?<![\w$.])(document|window|location|history|navigator|localStorage|sessionStorage|HTMLElement|Element|Node|Range|Event|MouseEvent|KeyboardEvent|getComputedStyle|requestAnimationFrame|ResizeObserver|IntersectionObserver|MutationObserver|CSS|Highlight)\b/;

const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(UI)].map((f) => join(UI, f));

function specifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(?\s*"([^"]+)"/g)].map((m) => (m[1] ?? m[2])!);
}

describe("src/ui", () => {
  test("has the shared files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  test("imports only src/ui, src/core and its listed packages", async () => {
    const wrong: string[] = [];
    for (const file of files) {
      for (const spec of specifiers(await Bun.file(file).text())) {
        const ok = spec.startsWith(".") ? ["src/ui/", "src/core/"].some((dir) => relative(ROOT, resolve(dirname(file), spec)).startsWith(dir)) : PACKAGES.has(spec);
        if (!ok) wrong.push(`${relative(ROOT, file)}: ${spec}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("uses no DOM, browser history or storage", async () => {
    const js = new Bun.Transpiler({ loader: "ts" });
    const wrong: string[] = [];
    for (const file of files) {
      const code = js.transformSync(await Bun.file(file).text()).replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
      const m = BROWSER.exec(code);
      if (m) wrong.push(`${relative(ROOT, file)}: ${m[1]}`);
    }
    expect(wrong).toEqual([]);
  });
});
