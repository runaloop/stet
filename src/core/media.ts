import type { Region } from "./types.ts";

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

export const ext = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";

/** The media type of an image file, by its extension: `/api/raw` serves it to the image diff and to Markdown pictures. */
export function imageType(path: string): string | null {
  return TYPES[ext(path)] ?? null;
}

/** `area w×h`: where a thread on an area is, in a list of threads. */
export const areaText = (r: Region) => `area ${r.w}×${r.h}`;

/** `w×h at x,y of iw×ih`, in pixels. */
export const regionText = (r: Region) => `${r.w}×${r.h} at ${r.x},${r.y} of ${r.iw}×${r.ih}`;
