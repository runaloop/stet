import { describe, expect, test } from "bun:test";
import type { ThreadSummary } from "../../src/core/types.ts";
import { DEFAULT_TEST_GLOBS, isTestPath } from "../../web/lib/fold.ts";
import { FileOrder, groupTitle, parseOrder } from "../../web/lib/order.ts";
import { groupByFile } from "../../web/lib/tree.ts";

describe("file order by kind", () => {
  const order = new FileOrder(parseOrder(null));
  const kind = (path: string) => order.name(order.rank(path, isTestPath(path, DEFAULT_TEST_GLOBS)));

  test("the default puts code first, then resources, build and config, changed tests, docs", () => {
    expect(order.groups.map((g) => g.name)).toEqual(["code", "config", "tests", "docs"]);
    expect(kind("app/src/main/java/com/x/Foo.kt")).toBe("code");
    expect(kind("web/views/Compare.tsx")).toBe("code");
    expect(kind("package.json")).toBe("config");
    expect(kind(".github/workflows/ci.yml")).toBe("config");
    expect(kind("app/src/main/AndroidManifest.xml")).toBe("config");
    expect(kind("app/src/main/res/drawable/ic_star.png")).toBe("config");
    expect(kind("app/src/debug/res/values/strings.xml")).toBe("config");
    expect(kind("app/build.gradle.kts")).toBe("config");
    expect(kind("gradle/libs.versions.toml")).toBe("config");
    expect(kind("gradle.properties")).toBe("config");
    expect(kind("app/src/test/java/com/x/FooTest.kt")).toBe("tests");
    expect(kind("app/src/test/resources/fixture.json")).toBe("tests");
    expect(kind("README.md")).toBe("docs");
    expect(kind("docs/guide/tests-1.png")).toBe("docs");
  });

  test("a Kotlin package named res is code, not an Android resource", () => {
    expect(kind("app/src/main/java/com/x/res/Loader.kt")).toBe("code");
  });

  test("groups are ranked top to bottom as listed", () => {
    const ranks = ["Foo.kt", "a.json", "src/test/ATest.kt", "b.md"].map((p) => order.rank(p, isTestPath(p, DEFAULT_TEST_GLOBS)));
    expect(ranks).toEqual([0, 1, 2, 3]);
  });

  test("a custom order: first match wins, anything unmatched goes to the group without globs", () => {
    const custom = new FileOrder(parseOrder("docs: **/*.md\nmain; tests; build: **/*.gradle.kts, **/*.md"));
    expect(custom.groups.map((g) => g.name)).toEqual(["docs", "main", "tests", "build"]);
    expect(custom.name(custom.rank("README.md", false))).toBe("docs");
    expect(custom.name(custom.rank("app/build.gradle.kts", false))).toBe("build");
    expect(custom.name(custom.rank("Foo.kt", false))).toBe("main");
    expect(custom.name(custom.rank("FooTest.kt", true))).toBe("tests");
  });

  test("without a group for the rest, code is added on top; without tests, tests go with the rest", () => {
    const custom = new FileOrder(parseOrder("docs: **/*.md"));
    expect(custom.groups.map((g) => g.name)).toEqual(["code", "docs"]);
    expect(custom.name(custom.rank("FooTest.kt", true))).toBe("code");
    expect(groupTitle("config")).toBe("Resources, build and config");
    expect(groupTitle("build")).toBe("build");
  });

  test("the thread tree follows the same order", () => {
    const t = (id: number, path: string) => ({ id, path, anchor: { path, range: { start: 1, end: 1 } }, range: { start: 1, end: 1 } }) as unknown as ThreadSummary;
    const list = [t(1, "README.md"), t(2, "app/build.gradle.kts"), t(3, "app/src/main/Foo.kt"), t(4, "app/src/test/FooTest.kt"), t(5, "a/Bar.kt")];
    const tree = groupByFile(list, (p) => order.rank(p, isTestPath(p, DEFAULT_TEST_GLOBS)));
    expect(tree.map((g) => g.path)).toEqual(["a/Bar.kt", "app/src/main/Foo.kt", "app/build.gradle.kts", "app/src/test/FooTest.kt", "README.md"]);
  });
});
