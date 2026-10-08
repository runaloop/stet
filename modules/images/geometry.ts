import type { ImageInfo, Region } from "../../src/core/types.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A drag between two points given as fractions of the shown image, in the image's pixels. */
export function dragRegion(a: { fx: number; fy: number }, b: { fx: number; fy: number }, iw: number, ih: number): Rect | null {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = Math.floor(clamp(Math.min(a.fx, b.fx)) * iw);
  const y0 = Math.floor(clamp(Math.min(a.fy, b.fy)) * ih);
  const x1 = Math.ceil(clamp(Math.max(a.fx, b.fx)) * iw);
  const y1 = Math.ceil(clamp(Math.max(a.fy, b.fy)) * ih);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** CSS position of a region over an image of any size, as percentages: a region keeps its place when the image is re-exported bigger. */
export function framePercent(r: Region): { left: string; top: string; width: string; height: string } {
  const p = (v: number, of: number) => `${(v / of) * 100}%`;
  return { left: p(r.x, r.iw), top: p(r.y, r.ih), width: p(r.w, r.iw), height: p(r.h, r.ih) };
}

/** The region moved onto an image of another size. */
export function scaleRegion(r: Region, iw: number, ih: number): Region {
  if (r.iw === iw && r.ih === ih) return r;
  const sx = iw / r.iw;
  const sy = ih / r.ih;
  return { x: Math.round(r.x * sx), y: Math.round(r.y * sy), w: Math.max(1, Math.round(r.w * sx)), h: Math.max(1, Math.round(r.h * sy)), iw, ih };
}

/** The area around a region shown in a crop: the region plus a margin, inside the image. */
export function cropRect(r: Region, margin = 0.15, min = 16): Rect {
  const m = Math.max(min, Math.round(Math.max(r.w, r.h) * margin));
  const x = Math.max(0, r.x - m);
  const y = Math.max(0, r.y - m);
  return { x, y, w: Math.min(r.iw, r.x + r.w + m) - x, h: Math.min(r.ih, r.y + r.h + m) - y };
}

/** Scale for a picture of `w`×`h`: never past `max` on the long side; small pictures grow to `atLeast` (pixelated). */
export function shotScale(w: number, h: number, max = 1600, atLeast = 0): number {
  const long = Math.max(w, h);
  if (long > max) return max / long;
  if (atLeast && long < atLeast) return Math.min(8, Math.floor(atLeast / long) || 1);
  return 1;
}

export interface PixelDiff {
  changed: number;
  total: number;
  /** Bounding box of the changed pixels. */
  box: Rect | null;
}

/**
 * Compares two RGBA buffers of the same `w`×`h` and writes into `out` the new image faded, with changed pixels in magenta.
 * A pixel counts as changed when any channel moves by more than `tolerance`.
 */
export function pixelDiff(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number, out: Uint8ClampedArray, tolerance = 8): PixelDiff {
  let changed = 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!), Math.abs(a[i + 3]! - b[i + 3]!));
      if (d > tolerance) {
        changed++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
        out[i] = 255;
        out[i + 1] = 0;
        out[i + 2] = 170;
        out[i + 3] = 255;
      } else {
        const g = (b[i]! * 0.3 + b[i + 1]! * 0.59 + b[i + 2]! * 0.11) * (b[i + 3]! / 255);
        const v = 255 - (255 - g) * 0.25;
        out[i] = v;
        out[i + 1] = v;
        out[i + 2] = v;
        out[i + 3] = 255;
      }
    }
  }
  return { changed, total: w * h, box: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
}

export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const sizeText = (i: ImageInfo) => (i.w && i.h ? `${i.w}×${i.h}` : "?×?");

/** `PNG · 120×80 → 160×80 · 1.2 KB → 1.6 KB (+33%)` */
export function imageCaption(path: string, info: { old: ImageInfo | null; new: ImageInfo | null }): string {
  const kind = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "image").toUpperCase();
  const { old: a, new: b } = info;
  if (a && b) {
    const size = sizeText(a) === sizeText(b) ? sizeText(b) : `${sizeText(a)} → ${sizeText(b)}`;
    const pct = a.bytes ? Math.round(((b.bytes - a.bytes) / a.bytes) * 100) : 0;
    const bytes = a.bytes === b.bytes ? bytesText(b.bytes) : `${bytesText(a.bytes)} → ${bytesText(b.bytes)} (${pct >= 0 ? "+" : ""}${pct}%)`;
    return `${kind} · ${size} · ${bytes}`;
  }
  const one = b ?? a;
  return one ? `${kind} · ${sizeText(one)} · ${bytesText(one.bytes)}${b ? "" : " · deleted"}` : kind;
}

export function regionLabel(r: Region): string {
  return `${r.w}×${r.h} at ${r.x},${r.y}`;
}
