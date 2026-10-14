import { describe, expect, test } from "bun:test";
import { fileIndex, fileRefs, linesText, matchFile, movedLines, resolveFile } from "../../src/ui/filerefs.ts";

const refs = (text: string) => fileRefs(text).map((r) => ({ text: r.text, path: r.path, start: r.start, end: r.end }));
const one = (text: string) => {
  const all = fileRefs(text);
  expect(all.length).toBe(1);
  return all[0]!;
};

describe("file references in a message", () => {
  test("the agent's reply the reviewer could not follow", () => {
    const text = "Сделал по месту реализации: двухстрочный комментарий над firedActions (StorageReactionActions.kt:14-15).";
    expect(refs(text)).toEqual([{ text: "StorageReactionActions.kt:14-15", path: "StorageReactionActions.kt", start: 14, end: 15 }]);
    const r = one(text);
    expect(text.slice(r.index, r.index + r.text.length)).toBe(r.text);
  });

  test("a path from the root, a range with an en dash, a single line", () => {
    expect(refs("Moved the null check before the cache lookup (src/app/Foo.kt:42).")).toEqual([{ text: "src/app/Foo.kt:42", path: "src/app/Foo.kt", start: 42, end: 42 }]);
    expect(refs("See src/app/Foo.kt:14–15, then Bar.ts:3 – 9; done")).toEqual([
      { text: "src/app/Foo.kt:14–15", path: "src/app/Foo.kt", start: 14, end: 15 },
      { text: "Bar.ts:3 – 9", path: "Bar.ts", start: 3, end: 9 },
    ]);
  });

  test("GitHub's #L form and words for the line, in English and Russian", () => {
    expect(refs("look at Foo.kt#L14-L15 and Bar.kt#L7")).toEqual([
      { text: "Foo.kt#L14-L15", path: "Foo.kt", start: 14, end: 15 },
      { text: "Bar.kt#L7", path: "Bar.kt", start: 7, end: 7 },
    ]);
    expect(refs("changed Foo.kt line 14 and Bar.kt, lines 3-5")).toEqual([
      { text: "Foo.kt line 14", path: "Foo.kt", start: 14, end: 14 },
      { text: "Bar.kt, lines 3-5", path: "Bar.kt", start: 3, end: 5 },
    ]);
    expect(refs("поправил в Foo.kt строка 14 и в Bar.kt, строки 3–5")).toEqual([
      { text: "Foo.kt строка 14", path: "Foo.kt", start: 14, end: 14 },
      { text: "Bar.kt, строки 3–5", path: "Bar.kt", start: 3, end: 5 },
    ]);
  });

  test("a column is kept apart from the line, and the range is read in order", () => {
    const r = one("crash at src/Main.kt:88:12 on start");
    expect([r.text, r.start, r.end, r.column]).toEqual(["src/Main.kt:88:12", 88, 88, 12]);
    expect(refs("Foo.kt:20-14")).toEqual([{ text: "Foo.kt:20-14", path: "Foo.kt", start: 14, end: 20 }]);
  });

  test("punctuation, quotes and Markdown around the reference stay outside it", () => {
    for (const text of ["(Foo.kt:14)", "«Foo.kt:14».", "**Foo.kt:14**", "Foo.kt:14,", "[Foo.kt:14]", "\"Foo.kt:14\"", "Foo.kt:14;"]) {
      expect(refs(text)).toEqual([{ text: "Foo.kt:14", path: "Foo.kt", start: 14, end: 14 }]);
    }
    expect(refs("Updated README.md.")).toEqual([{ text: "README.md", path: "README.md", start: null, end: null }]);
  });

  test("dotfiles, folders with dots and names without an extension before a line", () => {
    expect(refs(".github/workflows/ci.yml:12")).toEqual([{ text: ".github/workflows/ci.yml:12", path: ".github/workflows/ci.yml", start: 12, end: 12 }]);
    expect(refs("the .env file")).toEqual([{ text: ".env", path: ".env", start: null, end: null }]);
    expect(refs("Makefile:3 and scripts/run:7")).toEqual([
      { text: "Makefile:3", path: "Makefile", start: 3, end: 3 },
      { text: "scripts/run:7", path: "scripts/run", start: 7, end: 7 },
    ]);
  });

  test("URLs, versions, times, ports, numbers and e-mail addresses are not references", () => {
    for (const text of [
      "bumped to v1.2:3",
      "served at http://host:8080 now",
      "https://example.com/src/Foo.kt:14",
      "see www.example.com/a.html",
      "the call at 12:30 took 1.5s",
      "listens on localhost:8080",
      "version 1.2.3 is out",
      "write to a.pikalov@example.com",
      "Makefile line 3",
      "the ratio is 3:4",
    ]) {
      expect(refs(text)).toEqual([]);
    }
  });

  test("Windows-style and absolute paths keep their end, and say they are loose", () => {
    const win = one(String.raw`C:\Users\me\proj\src\app\Foo.kt:14`);
    expect([win.path, win.loose, win.start]).toEqual(["Users/me/proj/src/app/Foo.kt", true, 14]);
    expect(one(String.raw`src\app\Foo.kt:3`).path).toBe("src/app/Foo.kt");
    expect(one(String.raw`src\app\Foo.kt:3`).loose).toBe(false);
    const abs = one("/home/me/proj/src/app/Foo.kt:14-15");
    expect([abs.path, abs.loose, abs.start, abs.end]).toEqual(["home/me/proj/src/app/Foo.kt", true, 14, 15]);
    expect([one("./src/Foo.kt").path, one("./src/Foo.kt").loose]).toEqual(["src/Foo.kt", false]);
    expect(one("../lib/Foo.kt").loose).toBe(true);
  });

  test("references in inline code and in a code block read the same", () => {
    expect(refs("`Foo.kt:14-15`")).toEqual([{ text: "Foo.kt:14-15", path: "Foo.kt", start: 14, end: 15 }]);
    expect(refs("    at demo.Cache.get(Cache.kt:6)\n    at demo.Main.main(Main.kt:12)").map((r) => r.text)).toEqual(["demo.Cache.get", "Cache.kt:6", "demo.Main.main", "Main.kt:12"]);
  });

  test("linesText", () => {
    expect(linesText({ start: 14, end: 15 })).toBe("14–15");
    expect(linesText({ start: 14, end: 14 })).toBe("14");
    expect(linesText({ start: null, end: null })).toBe("");
  });
});

describe("resolving a reference to the review's files", () => {
  const diff = fileIndex(["src/app/Foo.kt", "src/app/Bar.kt", "src/lib/Bar.kt", "README.md"]);
  const tree = fileIndex(["src/app/Foo.kt", "src/app/Bar.kt", "src/lib/Bar.kt", "README.md", "build.gradle", "src/util/Strings.kt", "test/Strings.kt"]);
  const ref = (path: string, loose = false) => ({ path, loose });

  test("a full path, a name or the end of a path that one file has", () => {
    expect(matchFile(ref("src/app/Foo.kt"), diff)).toEqual(["src/app/Foo.kt"]);
    expect(matchFile(ref("Foo.kt"), diff)).toEqual(["src/app/Foo.kt"]);
    expect(matchFile(ref("app/Foo.kt"), diff)).toEqual(["src/app/Foo.kt"]);
    expect(matchFile(ref("lib/Bar.kt"), diff)).toEqual(["src/lib/Bar.kt"]);
  });

  test("a name two files have is a choice; a name none has is nothing", () => {
    expect(matchFile(ref("Bar.kt"), diff)).toEqual(["src/app/Bar.kt", "src/lib/Bar.kt"]);
    expect(matchFile(ref("Baz.kt"), diff)).toEqual([]);
    expect(matchFile(ref("pp/Foo.kt"), diff)).toEqual([]);
  });

  test("a loose path matches the longest file that ends it; a path from the root does not", () => {
    expect(matchFile(ref("home/me/proj/src/app/Foo.kt", true), diff)).toEqual(["src/app/Foo.kt"]);
    expect(matchFile(ref("other/src/app/Foo.kt"), diff)).toEqual([]);
    const withRoot = fileIndex(["Foo.kt", "src/app/Foo.kt"]);
    expect(matchFile(ref("home/me/src/app/Foo.kt", true), withRoot)).toEqual(["src/app/Foo.kt"]);
  });

  test("the diff's files first, the repository's after, nothing while one is not loaded", () => {
    expect(resolveFile(ref("Foo.kt"), [diff, tree])).toEqual(["src/app/Foo.kt"]);
    expect(resolveFile(ref("build.gradle"), [diff, tree])).toEqual(["build.gradle"]);
    expect(resolveFile(ref("Strings.kt"), [diff, tree])).toEqual(["src/util/Strings.kt", "test/Strings.kt"]);
    expect(resolveFile(ref("Nope.kt"), [diff, tree])).toEqual([]);
    expect(resolveFile(ref("Foo.kt"), [diff, null])).toEqual(["src/app/Foo.kt"]);
    expect(resolveFile(ref("build.gradle"), [diff, null])).toBeNull();
    expect(resolveFile(ref("Foo.kt"), [null])).toBeNull();
  });
});

describe("the same lines in a later text", () => {
  const text = (...lines: string[]) => lines.join("\n") + "\n";
  const before = text("a", "b", "c", "d", "e", "f");

  test("lines that did not change follow what was added or removed above them", () => {
    expect(movedLines(before, before, { start: 3, end: 4 })).toEqual({ start: 3, end: 4, changed: false });
    expect(movedLines(before, text("new1", "new2", "a", "b", "c", "d", "e", "f"), { start: 3, end: 4 })).toEqual({ start: 5, end: 6, changed: false });
    expect(movedLines(before, text("b", "c", "d", "e", "f"), { start: 3, end: 4 })).toEqual({ start: 2, end: 3, changed: false });
    expect(movedLines(before, text("a", "b", "c", "d", "x", "e", "f"), { start: 3, end: 4 })).toEqual({ start: 3, end: 4, changed: false });
  });

  test("an edited line lands on what replaced it, and says it changed", () => {
    expect(movedLines(before, text("a", "b", "C", "d", "e", "f"), { start: 3, end: 4 })).toEqual({ start: 3, end: 4, changed: true });
    expect(movedLines(before, text("a", "b", "e", "f"), { start: 3, end: 4 })).toEqual({ start: 3, end: 3, changed: true });
    expect(movedLines(before, text("x", "a", "b", "C1", "C2", "C3", "d", "e", "f"), { start: 5, end: 6 })).toEqual({ start: 8, end: 9, changed: false });
  });
});
