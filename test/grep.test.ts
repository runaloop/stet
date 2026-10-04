import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { grepTree, parseGrep } from "../src/core/grep.ts";
import { Fixture } from "./helpers/fixture.ts";

const f = new Fixture();
afterAll(() => f.cleanup());
f.write("src/a.kt", "val one = 1\nval two = 2\nval Three = 3\n").write("b.txt", "nothing\n-e dash line\n").write("bin.dat", "\0binary one\0");
const sha = f.commit("init");

test("parses headings, match and context lines, and group breaks", () => {
  const out = "abc:src/a.kt\n1:val one = 1\n2-val two = 2\n--\n9-\n10:x-y:z\n\nabc:b.txt\n3:one\n";
  expect(parseGrep(out, "abc", 100)).toEqual({
    files: [
      { path: "src/a.kt", matches: 2, groups: [[{ line: 1, text: "val one = 1", match: true }, { line: 2, text: "val two = 2", match: false }], [{ line: 9, text: "", match: false }, { line: 10, text: "x-y:z", match: true }]] },
      { path: "b.txt", matches: 1, groups: [[{ line: 3, text: "one", match: true }]] },
    ],
    total: 3,
    truncated: false,
    error: null,
  });
  expect(parseGrep(out, "abc", 2).truncated).toBe(true);
});

test("searches a snapshot tree with context, smart case, and skips binary files", async () => {
  const r = await grepTree(f.root, sha, "one", { regex: false });
  expect(r.files.map((x) => [x.path, x.matches])).toEqual([["src/a.kt", 1]]);
  expect(r.files[0]!.groups[0]!.map((l) => l.line)).toEqual([1, 2]);
  expect((await grepTree(f.root, sha, "three", { regex: false })).total).toBe(1);
  expect((await grepTree(f.root, sha, "three", { regex: false })).files[0]!.path).toBe("src/a.kt");
  expect((await grepTree(f.root, sha, "Three", { regex: false })).total).toBe(1);
  expect((await grepTree(f.root, sha, "THREE", { regex: false })).total).toBe(0);
});

test("a query is never an option, and a bad regex is an error message", async () => {
  expect((await grepTree(f.root, sha, "-e dash", { regex: false })).files.map((x) => x.path)).toEqual(["b.txt"]);
  expect((await grepTree(f.root, sha, `--output=${f.path("x")}`, { regex: false })).total).toBe(0);
  expect(existsSync(f.path("x"))).toBe(false);
  expect((await grepTree(f.root, sha, "val (", { regex: true })).error).toContain("parenthes");
  await expect(grepTree(f.root, "--help", "one", { regex: false })).rejects.toThrow("bad sha");
});
