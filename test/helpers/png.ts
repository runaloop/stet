import { deflateSync } from "node:zlib";

type Rgba = [number, number, number, number];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A small RGBA PNG drawn by `pixel(x, y)`. */
export function png(width: number, height: number, pixel: (x: number, y: number) => Rgba): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 4);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A card: background, a bar at `bar` and a box at `box`, all solid colors. */
export function card(width: number, height: number, opts: { bg?: Rgba; bar?: { y: number; h: number; color: Rgba }; box?: { x: number; y: number; w: number; h: number; color: Rgba } } = {}): Uint8Array {
  const bg = opts.bg ?? [240, 244, 250, 255];
  return png(width, height, (x, y) => {
    const b = opts.box;
    if (b && x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return b.color;
    const r = opts.bar;
    if (r && y >= r.y && y < r.y + r.h) return r.color;
    return bg;
  });
}
