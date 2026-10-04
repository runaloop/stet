const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const ext = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";

/** The media type of an image file, by its extension. */
export function imageType(path: string): string | null {
  return TYPES[ext(path)] ?? null;
}

/** Pixel images: shown as pictures in a diff. SVG stays a text diff. */
export function isPixelImage(path: string): boolean {
  return imageType(path) !== null && ext(path) !== "svg";
}

export interface ImageSize {
  w: number;
  h: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const i32le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function jpegSize(b: Uint8Array): ImageSize | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: u16be(b, i + 7), h: u16be(b, i + 5) };
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30) return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
  if (chunk === "VP8L" && b.length >= 25) {
    const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!];
    return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (chunk === "VP8X" && b.length >= 30) return { w: 1 + u24le(b, 24), h: 1 + u24le(b, 27) };
  return null;
}

function avifSize(b: Uint8Array): ImageSize | null {
  const end = Math.min(b.length - 16, 4096);
  for (let i = 4; i < end; i++) {
    if (b[i] === 0x69 && ascii(b, i, 4) === "ispe") return { w: u32be(b, i + 8), h: u32be(b, i + 12) };
  }
  return null;
}

/** Width and height from the file header, without decoding the image. */
export function imageSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24) return null;
  let size: ImageSize | null = null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") size = { w: u32be(b, 16), h: u32be(b, 20) };
  else if (ascii(b, 0, 4) === "GIF8") size = { w: u16le(b, 6), h: u16le(b, 8) };
  else if (b[0] === 0xff && b[1] === 0xd8) size = jpegSize(b);
  else if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") size = webpSize(b);
  else if (ascii(b, 0, 2) === "BM" && b.length >= 26) size = { w: Math.abs(i32le(b, 18)), h: Math.abs(i32le(b, 22)) };
  else if (ascii(b, 4, 4) === "ftyp") size = avifSize(b);
  return size && size.w > 0 && size.h > 0 ? size : null;
}

export function isPng(b: Uint8Array): boolean {
  return b.length > 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG";
}

export function isSvg(path: string): boolean {
  return ext(path) === "svg";
}

const SVG_TAG = /<svg\b[^>]*>/i;
const SVG_W = /\swidth\s*=\s*["']\s*([\d.]+)\s*(?:px)?\s*["']/i;
const SVG_H = /\sheight\s*=\s*["']\s*([\d.]+)\s*(?:px)?\s*["']/i;
const SVG_VIEWBOX = /\sviewBox\s*=\s*["']([^"']*)["']/i;

/** Size of an SVG in CSS pixels: its width and height, or its viewBox; a percent or em size falls back to the viewBox. */
export function svgSize(text: string): ImageSize | null {
  const tag = SVG_TAG.exec(text.slice(0, 64 * 1024))?.[0];
  if (!tag) return null;
  const w = Number(SVG_W.exec(tag)?.[1] ?? NaN);
  const h = Number(SVG_H.exec(tag)?.[1] ?? NaN);
  const box = (SVG_VIEWBOX.exec(tag)?.[1] ?? "").trim().split(/[\s,]+/).map(Number);
  const [vw, vh] = box.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 ? [box[2]!, box[3]!] : [NaN, NaN];
  let size: ImageSize | null = null;
  if (w > 0 && h > 0) size = { w, h };
  else if (w > 0 && vw) size = { w, h: (w * vh) / vw };
  else if (h > 0 && vw) size = { w: (h * vw) / vh, h };
  else if (vw) size = { w: vw, h: vh };
  return size ? { w: Math.max(1, Math.round(size.w)), h: Math.max(1, Math.round(size.h)) } : null;
}

/** Size of any image the diff shows as a picture: from the header, or from the SVG's own attributes. */
export function sizeOf(path: string, bytes: Uint8Array): ImageSize | null {
  return isSvg(path) ? svgSize(new TextDecoder().decode(bytes.subarray(0, 64 * 1024))) : imageSize(bytes);
}
