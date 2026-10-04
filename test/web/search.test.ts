import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, test } from "bun:test";
import { globToRegExp } from "../../web/lib/filters.ts";
import { DEFAULT_COLLAPSE_GLOBS, DEFAULT_SKIP_MARKERS, DEFAULT_TEST_GLOBS, foldOf, parseList } from "../../web/lib/fold.ts";
import { compileQuery, diffRows, flatHits, groupHits, searchDiff, snippet } from "../../web/lib/search.ts";

const patch = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;
const files = (...patches: string[]) => parsePatchFiles(patches.join(""), "t").flatMap((p) => p.files);

const cache = patch(
  "src/Cache.kt",
  "@@ -3,5 +3,6 @@ class Cache {\n     private val map = HashMap<String, String>()\n-    fun get(key: String) = map[key]\n+    fun get(key: String): String? = map[key]\n+    fun size() = map.size\n \n     fun put(key: String, value: String) {\n         map[key] = value\n",
);
const added = (path: string, lines: string[]) =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}\n`).join("")}`;

describe("diff rows", () => {
  test("numbers every row on its side", () => {
    const rows = diffRows(files(cache)[0]!);
    expect(rows.map((r) => [r.kind, r.old, r.new])).toEqual([
      ["context", 3, 3],
      ["del", 4, null],
      ["add", null, 4],
      ["add", null, 5],
      ["context", 5, 6],
      ["context", 6, 7],
      ["context", 7, 8],
    ]);
    expect(rows[2]!.text).toBe("    fun get(key: String): String? = map[key]");
  });
});

describe("search in the diff", () => {
  const fs = files(cache, added("src/Other.kt", ["val map = 1", "fun other() = MAP"]));

  test("finds added, removed and context lines, with every match on the line", () => {
    const r = searchDiff(fs, "map");
    const hits = flatHits(r);
    expect(r.total).toBe(7);
    expect(hits.map((h) => [h.path, h.side, h.line])).toEqual([
      ["src/Cache.kt", "additions", 3],
      ["src/Cache.kt", "deletions", 4],
      ["src/Cache.kt", "additions", 4],
      ["src/Cache.kt", "additions", 5],
      ["src/Cache.kt", "additions", 8],
      ["src/Other.kt", "additions", 1],
      ["src/Other.kt", "additions", 2],
    ]);
    expect(hits[3]!.ranges).toEqual([[17, 20]]);
  });

  test("capital letters make it case-sensitive", () => {
    expect(searchDiff(fs, "MAP").total).toBe(1);
  });

  test("regex mode, bad regex reports an error instead of throwing", () => {
    expect(searchDiff(fs, "fun (get|size)", { regex: true }).total).toBe(3);
    expect(searchDiff(fs, "fun (", { regex: true }).error).toBeTruthy();
    expect(searchDiff(fs, "fun (").total).toBe(0);
    expect(compileQuery("", false)).toBeNull();
  });

  test("stops at the limit and says so", () => {
    const r = searchDiff(fs, "map", { limit: 3 });
    expect(r.total).toBe(3);
    expect(r.truncated).toBe(true);
  });

  test("a snippet is the match with one line around it, inside its hunk", () => {
    const f = searchDiff(fs, "size").files[0]!;
    expect(snippet(f.rows, f.hits[0]!.row).map((s) => s.row.kind)).toEqual(["add", "add", "context"]);
    expect(snippet(f.rows, 0).map((s) => s.index)).toEqual([0, 1]);
  });
});

describe("globs", () => {
  test("**/ matches any directory prefix, including none, but not a partial name", () => {
    const re = globToRegExp("**/src/test/**");
    expect(re.test("app/src/test/Foo.kt")).toBe(true);
    expect(re.test("src/test/Foo.kt")).toBe(true);
    expect(re.test("app/mysrc/test/Foo.kt")).toBe(false);
    expect(globToRegExp("**/*Test.kt").test("FooTest.kt")).toBe(true);
  });
});

describe("folding test files", () => {
  const cfg = { tests: DEFAULT_TEST_GLOBS, skipMarkers: DEFAULT_SKIP_MARKERS, collapse: DEFAULT_COLLAPSE_GLOBS };
  const fold = (p: string) => foldOf(files(p)[0]!, cfg);

  test("a new test file folds; a normal file does not", () => {
    expect(fold(added("app/src/test/java/FooTest.kt", ["@Test fun works() = assertEquals(1, 1)"])).group).toBe("tests");
    expect(fold(added("app/src/main/java/Foo.kt", ["class Foo"])).group).toBeNull();
  });

  test("tests that remove lines, skip tests or get deleted stay expanded, with the reason", () => {
    const changed = fold(patch("app/src/test/FooTest.kt", "@@ -1,2 +1,2 @@\n @Test fun a() {\n-  assertEquals(2, sum(1, 1))\n+  assertEquals(3, sum(1, 1))\n"));
    expect(changed).toEqual({ group: null, keptBecause: "1 test line removed or changed" });
    const skipped = fold(patch("app/src/test/FooTest.kt", "@@ -1,1 +1,2 @@\n+@Ignore\n @Test fun a() {}\n"));
    expect(skipped).toEqual({ group: null, keptBecause: "adds @Ignore" });
    const gone = fold(`diff --git a/src/a.test.ts b/src/a.test.ts\ndeleted file mode 100644\n--- a/src/a.test.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-test("x", () => {})\n`);
    expect(gone).toEqual({ group: null, keptBecause: "test file deleted" });
  });

  test("appending tests to an existing file folds", () => {
    expect(fold(patch("src/a.test.ts", "@@ -1,1 +1,2 @@\n test(\"a\", () => {})\n+test(\"b\", () => {})\n")).group).toBe("tests");
  });

  test("lock files fold as generated; config lists override the defaults", () => {
    expect(fold(added("bun.lock", ["{}"])).group).toBe("generated");
    expect(parseList(null, ["x"])).toEqual(["x"]);
    expect(parseList("**/*.gen.kt, **/fixtures/**\n", [])).toEqual(["**/*.gen.kt", "**/fixtures/**"]);
    expect(parseList("", ["x"])).toEqual([]);
  });
});

describe("grouping matches like grep -C", () => {
  test("matches whose context touches merge into one block; other hunks start a new one", () => {
    const fs = files(
      patch("a.kt", "@@ -1,6 +1,6 @@\n x1\n-x2\n+y2\n x3\n x4\n x5\n x6\n@@ -20,2 +20,2 @@\n x20\n-x21\n+y21\n"),
    );
    const r = searchDiff(fs, "x");
    const f = r.files[0]!;
    const groups = groupHits(f.rows, f.hits);
    expect(groups.map((g) => [g.from, g.to, g.hits.map((h) => h.index)])).toEqual([
      [0, 6, [0, 1, 2, 3, 4, 5]],
      [7, 9, [6, 7]],
    ]);
  });
});
