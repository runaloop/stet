import { expect, test } from "bun:test";
import { imageAt, wheelZoom, zoomScroll, zoomStep, zoomText } from "../../web/lib/zoom.ts";

test("+ and - go to the next level, from a level or from wherever fit put the picture", () => {
  expect(zoomStep(1, 1)).toBe(1.5);
  expect(zoomStep(1, -1)).toBe(0.67);
  expect(zoomStep(0.42, 1)).toBe(0.5);
  expect(zoomStep(0.42, -1)).toBe(0.33);
  expect(zoomStep(6.67, 1)).toBe(8);
  expect(zoomStep(1.005, 1)).toBe(1.5);
});

test("zoom stops at the last level, and a fit already past it does not jump back", () => {
  expect(zoomStep(32, 1)).toBe(32);
  expect(zoomStep(0.1, -1)).toBe(0.1);
  expect(zoomStep(0.04, -1)).toBe(0.04);
  expect(zoomStep(0.04, 1)).toBe(0.1);
  expect(zoomStep(40, 1)).toBe(40);
});

test("Ctrl+wheel zooms smoothly: up zooms in, down out, within the levels", () => {
  expect(wheelZoom(1, -200)).toBe(2);
  expect(wheelZoom(1, 200)).toBe(0.5);
  expect(wheelZoom(1, 0)).toBe(1);
  expect(wheelZoom(30, -2000)).toBe(32);
  expect(wheelZoom(0.2, 2000)).toBe(0.1);
});

test("zooming keeps the point under the mouse in place", () => {
  const at = { x: 100, y: 50 };
  const scroll = zoomScroll({ x: 0, y: 0 }, at, 1, 4);
  expect(scroll).toEqual({ x: 300, y: 150 });
  const view = { left: 10, top: 20, scrollLeft: 0, scrollTop: 0 };
  const before = imageAt({ x: 110, y: 70 }, view, 1);
  const after = imageAt({ x: 110, y: 70 }, { ...view, scrollLeft: scroll.x, scrollTop: scroll.y }, 4);
  expect(after).toEqual(before);
  expect(zoomScroll({ x: 300, y: 150 }, at, 4, 1)).toEqual({ x: 0, y: 0 });
  expect(zoomScroll({ x: 0, y: 0 }, at, 4, 1)).toEqual({ x: 0, y: 0 });
});

test("a point on the screen is a point of the picture, whatever the zoom and the scroll", () => {
  expect(imageAt({ x: 150, y: 220 }, { left: 100, top: 200, scrollLeft: 0, scrollTop: 0 }, 1)).toEqual({ x: 50, y: 20 });
  expect(imageAt({ x: 150, y: 220 }, { left: 100, top: 200, scrollLeft: 300, scrollTop: 140 }, 4)).toEqual({ x: 87.5, y: 40 });
  expect(imageAt({ x: 150, y: 220 }, { left: 100, top: 200, scrollLeft: 0, scrollTop: 0 }, 0.5)).toEqual({ x: 100, y: 40 });
});

test("the scale reads as a percentage", () => {
  expect(zoomText(1)).toBe("100%");
  expect(zoomText(0.333)).toBe("33%");
  expect(zoomText(2.5)).toBe("250%");
});
