import { expect, test } from "bun:test";
import { cropRect, dragRegion, framePercent, imageCaption, pixelDiff, scaleRegion, shotScale } from "../../web/lib/image.ts";

test("a drag becomes a region in image pixels, either direction, clamped to the image", () => {
  expect(dragRegion({ fx: 0.1, fy: 0.2 }, { fx: 0.5, fy: 0.6 }, 200, 100)).toEqual({ x: 20, y: 20, w: 80, h: 40 });
  expect(dragRegion({ fx: 0.5, fy: 0.6 }, { fx: 0.1, fy: 0.2 }, 200, 100)).toEqual({ x: 20, y: 20, w: 80, h: 40 });
  expect(dragRegion({ fx: -0.5, fy: 0.9 }, { fx: 0.25, fy: 1.7 }, 200, 100)).toEqual({ x: 0, y: 90, w: 50, h: 10 });
  expect(dragRegion({ fx: 0.3, fy: 0.3 }, { fx: 0.3, fy: 0.3 }, 200, 100)).toBeNull();
});

test("frames are percentages, so a region keeps its place on a bigger export", () => {
  expect(framePercent({ x: 30, y: 10, w: 60, h: 20, iw: 120, ih: 40 })).toEqual({ left: "25%", top: "25%", width: "50%", height: "50%" });
  expect(scaleRegion({ x: 30, y: 10, w: 60, h: 20, iw: 120, ih: 40 }, 240, 80)).toEqual({ x: 60, y: 20, w: 120, h: 40, iw: 240, ih: 80 });
});

test("a crop keeps a margin around the region and stays inside the image", () => {
  expect(cropRect({ x: 100, y: 100, w: 200, h: 100, iw: 1000, ih: 1000 })).toEqual({ x: 70, y: 70, w: 260, h: 160 });
  expect(cropRect({ x: 0, y: 5, w: 10, h: 10, iw: 20, ih: 20 })).toEqual({ x: 0, y: 0, w: 20, h: 20 });
});

test("shots shrink big images and grow small ones by whole steps", () => {
  expect(shotScale(3200, 1000)).toBe(0.5);
  expect(shotScale(800, 600)).toBe(1);
  expect(shotScale(40, 20, 1600, 320)).toBe(8);
  expect(shotScale(100, 50, 1600, 320)).toBe(3);
});

test("pixel diff counts changed pixels and boxes them", () => {
  const w = 4;
  const h = 3;
  const a = new Uint8ClampedArray(w * h * 4).fill(255);
  const b = a.slice();
  for (const [x, y] of [[1, 0], [2, 2]] as const) b.set([0, 0, 0, 255], (y * w + x) * 4);
  b.set([250, 250, 250, 255], (1 * w + 3) * 4);
  const out = new Uint8ClampedArray(w * h * 4);
  const r = pixelDiff(a, b, w, h, out);
  expect(r.changed).toBe(2);
  expect(r.total).toBe(12);
  expect(r.box).toEqual({ x: 1, y: 0, w: 2, h: 3 });
  expect([...out.slice(4, 8)]).toEqual([255, 0, 170, 255]);
  expect(pixelDiff(a, a, w, h, out).box).toBeNull();
});

test("caption says size and bytes, and how they changed", () => {
  expect(imageCaption("res/a.png", { old: { w: 120, h: 80, bytes: 1000 }, new: { w: 120, h: 80, bytes: 1500 } })).toBe("PNG · 120×80 · 1000 B → 1.5 KB (+50%)");
  expect(imageCaption("b.webp", { old: { w: 10, h: 10, bytes: 50 }, new: { w: 20, h: 20, bytes: 50 } })).toBe("WEBP · 10×10 → 20×20 · 50 B");
  expect(imageCaption("c.jpg", { old: null, new: { w: null, h: null, bytes: 2048 } })).toBe("JPG · ?×? · 2.0 KB");
  expect(imageCaption("d.png", { old: { w: 1, h: 1, bytes: 1 }, new: null })).toBe("PNG · 1×1 · 1 B · deleted");
});
