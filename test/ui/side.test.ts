import { describe, expect, test } from "bun:test";
import { SIDE_FLOOR, sideCeiling, sideWidth } from "../../src/ui/side.ts";

const compare = (window: number, split = true) => ({ window, page: "compare" as const, split });
const thread = (window: number) => ({ window, page: "thread" as const, split: true });

describe("side panel width", () => {
  test("short rows make the panel only as wide as they need", () => {
    expect(sideWidth(262.4, compare(1920))).toBe(263);
    expect(sideWidth(262.4, compare(2560))).toBe(263);
    expect(sideWidth(262.4, thread(1920))).toBe(263);
  });

  test("very short rows stop at the floor, so the tabs and the thread filters still fit", () => {
    expect(sideWidth(90, compare(1920))).toBe(SIDE_FLOOR);
    expect(sideWidth(0, thread(2560))).toBe(SIDE_FLOOR);
  });

  test("on the Changes page long rows stop at 30% of the window or where two 80-character code columns still fit", () => {
    expect(sideWidth(2000, compare(2560))).toBe(768);
    expect(sideWidth(2000, compare(1920))).toBe(533);
    expect(sideCeiling(compare(1920))).toBe(533);
  });

  test("a unified diff needs one column, so the panel can take its 30%", () => {
    expect(sideWidth(2000, compare(1920, false))).toBe(576);
    expect(sideWidth(2000, compare(1280, false))).toBe(353);
  });

  test("the thread page has three columns: the panel takes a quarter of the window at most", () => {
    expect(sideWidth(2000, thread(1920))).toBe(480);
    expect(sideWidth(2000, thread(2560))).toBe(640);
    expect(sideCeiling(thread(1920))).toBeLessThan(sideCeiling(compare(1920)));
  });

  test("a narrow window still leaves the panel its old minimum", () => {
    expect(sideWidth(2000, compare(1280))).toBe(300);
    expect(sideWidth(2000, thread(1280))).toBe(300);
    expect(sideWidth(2000, { window: 1000, page: "other", split: true })).toBe(300);
  });

  test("before anything is measured the panel takes its ceiling", () => {
    expect(sideWidth(null, compare(2560))).toBe(768);
    expect(sideWidth(null, thread(1920))).toBe(480);
  });
});
