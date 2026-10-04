import { describe, expect, test } from "bun:test";
import { foldRuns, keptSteps, keptTimeline, onlyVersion, rounds, withEnd } from "../../web/lib/versions.ts";

const v = (number: number, createdAt: string) => ({ number, createdAt });

describe("versions", () => {
  test("rounds: the versions after a review are the answer to it; empty rounds are left out", () => {
    const vs = [v(1, "2026-09-23T10:00Z"), v(2, "2026-09-23T11:00Z"), v(3, "2026-09-23T13:00Z"), v(4, "2026-09-23T14:00Z"), v(5, "2026-09-24T09:00Z")];
    const subs = [{ at: "2026-09-23T10:30Z" }, { at: "2026-09-23T12:00Z" }, { at: "2026-09-23T12:30Z" }, { at: "2026-09-24T08:00Z" }];
    expect(rounds(vs, subs)).toEqual([
      { index: 0, at: null, first: 1, last: 1 },
      { index: 1, at: "2026-09-23T10:30Z", first: 2, last: 2 },
      { index: 3, at: "2026-09-23T12:30Z", first: 3, last: 4 },
      { index: 4, at: "2026-09-24T08:00Z", first: 5, last: 5 },
    ]);
    expect(rounds(vs, [])).toEqual([{ index: 0, at: null, first: 1, last: 5 }]);
  });

  test("foldRuns folds runs of three or more, shorter runs stay", () => {
    const keep = new Set([0, 1, 5, 7, 8]);
    expect(foldRuns(9, (i) => keep.has(i))).toEqual([
      { kind: "one", i: 0 },
      { kind: "one", i: 1 },
      { kind: "fold", from: 2, to: 4 },
      { kind: "one", i: 5 },
      { kind: "one", i: 6 },
      { kind: "one", i: 7 },
      { kind: "one", i: 8 },
    ]);
  });

  test("the strip keeps base, now, passes, the newest versions and the marks with their neighbours", () => {
    const steps = [{ kind: "base" }, ...Array.from({ length: 20 }, () => ({ kind: "version" })), { kind: "pass" }, { kind: "now" }];
    const keep = keptSteps(steps, [5, 6]);
    expect([...keep].sort((a, b) => a - b)).toEqual([0, 4, 5, 6, 7, 18, 19, 20, 21, 22]);
  });

  test("the timeline keeps the first, the last, the shown step, messages and every change", () => {
    const at = (start: number, state = "ok", comments: number[] = []) => ({ state, path: "a.kt", range: { start, end: start + 2 }, commentIds: comments });
    const steps = [at(10), at(10), at(10), at(12, "moved"), at(12, "moved"), at(12, "moved", [7]), at(12, "moved"), at(12, "moved"), at(12, "moved"), at(12, "moved")];
    expect([...keptTimeline(steps, 7)].sort((a, b) => a - b)).toEqual([0, 3, 5, 6, 7, 8, 9]);
  });

  test("withEnd moves the other end along when they would cross", () => {
    expect(withEnd("from", "5", "3", "8", 10)).toEqual(["5", "8"]);
    expect(withEnd("from", "8", "3", "8", 10)).toEqual(["8", "9"]);
    expect(withEnd("from", "10", "3", "now", 10)).toEqual(["10", "now"]);
    expect(withEnd("to", "2", "3", "8", 10)).toEqual(["1", "2"]);
    expect(withEnd("to", "1", "1", "8", 10)).toEqual(["base", "1"]);
    expect(withEnd("to", "4", "abc123", "8", 10)).toEqual(["abc123", "4"]);
    expect(onlyVersion(1)).toEqual(["base", "1"]);
    expect(onlyVersion(7)).toEqual(["6", "7"]);
  });
});
