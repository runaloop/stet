import { afterAll, describe, expect, test } from "bun:test";
import { direct, linesAt, trace } from "../src/core/placement.ts";
import { specAt, type Placement } from "../src/core/reanchor.ts";
import { edit, Fixture, lines } from "./helpers/fixture.ts";

const fixtures: Fixture[] = [];
afterAll(() => fixtures.forEach((f) => f.cleanup()));

interface Case {
  v1: Record<string, string>;
  v2: Record<string, string | null>;
  path?: string;
  range: [number, number];
}

async function place(c: Case): Promise<Placement> {
  const f = new Fixture();
  fixtures.push(f);
  for (const [p, content] of Object.entries(c.v1)) f.write(p, content);
  const a = f.commit("v1");
  for (const [p, content] of Object.entries(c.v2)) content === null ? f.rm(p) : f.write(p, content);
  const b = f.commit("v2");
  const path = c.path ?? "f.txt";
  const all = (await linesAt(f.root, a, path))!;
  const spec = specAt(path, all, c.range[0], c.range[1]);
  const point = await direct(f.root, null, spec, a, b, false);
  return { ...point.step, state: point.state };
}

const base = lines(30);

describe("re-anchoring scenarios", () => {
  test("1: edit below the range keeps it in place", async () => {
    const p = await place({ v1: { "f.txt": base }, v2: { "f.txt": edit(base, (l) => (l[19] = "changed 20")) }, range: [10, 14] });
    expect(p).toMatchObject({ state: "ok", start: 10, end: 14 });
  });

  test("2: lines inserted above move the range", async () => {
    const p = await place({ v1: { "f.txt": base }, v2: { "f.txt": edit(base, (l) => l.splice(3, 0, "a", "b", "c")) }, range: [10, 14] });
    expect(p).toMatchObject({ state: "moved", start: 13, end: 17, method: "offset" });
  });

  test("3: lines deleted above move the range", async () => {
    const p = await place({ v1: { "f.txt": base }, v2: { "f.txt": edit(base, (l) => l.splice(1, 2)) }, range: [10, 14] });
    expect(p).toMatchObject({ state: "moved", start: 8, end: 12 });
  });

  test("4: one line edited inside marks it changed in place", async () => {
    const p = await place({ v1: { "f.txt": base }, v2: { "f.txt": edit(base, (l) => (l[11] = "fixed 12")) }, range: [10, 14] });
    expect(p).toMatchObject({ state: "changed", start: 10, end: 14, method: "boundary" });
  });

  test("5: line inserted inside grows the range", async () => {
    const p = await place({ v1: { "f.txt": base }, v2: { "f.txt": edit(base, (l) => l.splice(11, 0, "inserted")) }, range: [10, 14] });
    expect(p).toMatchObject({ state: "changed", start: 10, end: 15 });
  });

  test("6: first two lines deleted shrink the range", async () => {
    const p = await place({ v1: { "f.txt": base }, v2: { "f.txt": edit(base, (l) => l.splice(9, 2)) }, range: [10, 14] });
    expect(p).toMatchObject({ state: "changed", start: 10, end: 12 });
  });

  test("7: whole range deleted is outdated", async () => {
    const p = await place({ v1: { "f.txt": base }, v2: { "f.txt": edit(base, (l) => l.splice(9, 5)) }, range: [10, 14] });
    expect(p).toMatchObject({ state: "outdated", reason: "lines-deleted" });
  });

  test("8: re-indented range is found by whitespace match", async () => {
    const p = await place({
      v1: { "f.txt": base },
      v2: { "f.txt": edit(base, (l) => { for (let i = 9; i < 14; i++) l[i] = "    " + l[i]; }) },
      range: [10, 14],
    });
    expect(p).toMatchObject({ state: "changed", start: 10, end: 14, method: "whitespace" });
  });

  test("9: CRLF to LF is a whitespace change", async () => {
    const crlf = edit(base, (l) => { for (let i = 9; i < 14; i++) l[i] = l[i] + "\r"; });
    const p = await place({ v1: { "f.txt": crlf }, v2: { "f.txt": base }, range: [10, 14] });
    expect(p).toMatchObject({ state: "changed", start: 10, end: 14, method: "whitespace" });
  });

  test("10: single-line anchor rewritten stays on its line", async () => {
    const p = await place({ v1: { "f.txt": base }, v2: { "f.txt": edit(base, (l) => (l[11] = "something else")) }, range: [12, 12] });
    expect(p).toMatchObject({ state: "changed", start: 12, end: 12, method: "boundary" });
  });

  test("11: duplicate elsewhere never captures an edited anchor", async () => {
    const block = ["alpha one()", "beta two()", "gamma three()", "delta four()", "eps five()"];
    const v1 = edit(lines(50), (l) => { l.splice(9, 5, ...block); l.splice(39, 5, ...block); });
    const v2 = edit(v1, (l) => (l[11] = "gamma THREE()"));
    const p = await place({ v1: { "f.txt": v1 }, v2: { "f.txt": v2 }, range: [10, 14] });
    expect(p).toMatchObject({ state: "changed", start: 10, end: 14 });
  });

  test("12: unique block moved far away is followed", async () => {
    const block = ["function uniqueBlock() {", "  const a = computeSomething();", "  return a + 1;", "}", "// end of unique block"];
    const v1 = edit(lines(260), (l) => l.splice(9, 5, ...block));
    const v2 = edit(v1, (l) => { const cut = l.splice(9, 5); l.splice(205, 0, ...cut); });
    const p = await place({ v1: { "f.txt": v1 }, v2: { "f.txt": v2 }, range: [10, 14] });
    expect(p).toMatchObject({ state: "moved", start: 206, end: 210, method: "exact" });
  });

  test("13: moved block that exists twice is ambiguous", async () => {
    const block = ["function twiceBlock() {", "  const a = computeSomething();", "  return a + 1;", "}", "// end of twice block"];
    const v1 = edit(lines(260), (l) => { l.splice(9, 5, ...block); l.splice(99, 5, ...block); });
    const v2 = edit(v1, (l) => { const cut = l.splice(9, 5); l.splice(205, 0, ...cut); });
    const p = await place({ v1: { "f.txt": v1 }, v2: { "f.txt": v2 }, range: [10, 14] });
    expect(p).toMatchObject({ state: "outdated", reason: "ambiguous" });
  });

  test("14: pure rename follows the file", async () => {
    const p = await place({ v1: { "f.txt": base }, v2: { "f.txt": null, "g.txt": base }, range: [10, 14] });
    expect(p).toMatchObject({ state: "moved", path: "g.txt", start: 10, end: 14 });
  });

  test("15: rename with an edit above follows and shifts", async () => {
    const p = await place({
      v1: { "f.txt": base },
      v2: { "f.txt": null, "g.txt": edit(base, (l) => l.splice(0, 0, "new top 1", "new top 2")) },
      range: [10, 14],
    });
    expect(p).toMatchObject({ state: "moved", path: "g.txt", start: 12, end: 16 });
  });

  test("16: deleted file is outdated", async () => {
    const p = await place({ v1: { "f.txt": base, "other.txt": "x\n" }, v2: { "f.txt": null }, range: [10, 14] });
    expect(p).toMatchObject({ state: "outdated", reason: "file-deleted" });
  });

  test("17a: anchor at line 1 uses the virtual line above", async () => {
    const p = await place({ v1: { "f.txt": base }, v2: { "f.txt": edit(base, (l) => (l[0] = "first!")) }, range: [1, 2] });
    expect(p).toMatchObject({ state: "changed", start: 1, end: 2, method: "boundary" });
  });

  test("17b: anchor at EOF uses the virtual line below", async () => {
    const p = await place({ v1: { "f.txt": base }, v2: { "f.txt": edit(base, (l) => (l[29] = "last!")) }, range: [29, 30] });
    expect(p).toMatchObject({ state: "changed", start: 29, end: 30, method: "boundary" });
  });

  test("18: timeline across versions matches each step", async () => {
    const f = new Fixture();
    fixtures.push(f);
    f.write("f.txt", base);
    const v1 = f.commit("v1");
    f.write("f.txt", edit(base, (l) => l.splice(3, 0, "a", "b", "c")));
    const v2 = f.commit("v2");
    f.write("f.txt", edit(base, (l) => { l.splice(3, 0, "a", "b", "c"); l[14] = "fixed"; }));
    const v3 = f.commit("v3");
    const spec = specAt("f.txt", (await linesAt(f.root, v1, "f.txt"))!, 10, 14);
    const points = await trace(f.root, null, spec, v1, [{ sha: v2, persist: false }, { sha: v3, persist: false }]);
    expect(points.map((p) => [p.state, p.spec?.start, p.spec?.end])).toEqual([
      ["moved", 13, 17],
      ["changed", 13, 17],
    ]);
  });

  test("19a: edit crossing the range edge keeps the thread on the rewritten region", async () => {
    const p = await place({
      v1: { "f.txt": base },
      v2: { "f.txt": edit(base, (l) => l.splice(8, 3, "x", "y", "z")) },
      range: [10, 14],
    });
    expect(p).toMatchObject({ state: "changed", start: 9, end: 14, method: "boundary" });
  });

  test("19b: range inside a block that was rewritten to one line follows the block", async () => {
    const p = await place({
      v1: { "f.txt": base },
      v2: { "f.txt": edit(base, (l) => l.splice(14, 8, "one-liner")) },
      range: [15, 21],
    });
    expect(p).toMatchObject({ state: "changed", start: 15, end: 15 });
  });

  test("19c: a rewrite reaching far beyond the range is outdated", async () => {
    const p = await place({
      v1: { "f.txt": base },
      v2: { "f.txt": edit(base, (l) => l.splice(2, 20, ...Array.from({ length: 20 }, (_, i) => `new ${i}`))) },
      range: [10, 12],
    });
    expect(p).toMatchObject({ state: "outdated", reason: "rewritten" });
  });

  test("20: file that became binary is outdated", async () => {
    const p = await place({ v1: { "f.txt": base }, v2: { "f.txt": "bin\0ary\n" }, range: [10, 14] });
    expect(p).toMatchObject({ state: "outdated", reason: "binary" });
  });
});
