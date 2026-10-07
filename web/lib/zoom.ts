export interface Point {
  x: number;
  y: number;
}

/** Zoom levels: screen pixels per pixel of the picture. Fit is whatever scale fits the place, between two of them. */
export const ZOOMS = [0.1, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
const MIN = ZOOMS[0]!;
const MAX = ZOOMS[ZOOMS.length - 1]!;

/** The next level in or out from `scale`; a scale already past the last level stays. */
export function zoomStep(scale: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOMS.find((z) => z > scale * 1.01) ?? Math.max(scale, MAX);
  return ZOOMS.findLast((z) => z < scale / 1.01) ?? Math.min(scale, MIN);
}

/** Ctrl+wheel: smooth rather than a level per event, so that a touchpad pinch does not jump. `deltaY` in CSS pixels. */
export function wheelZoom(scale: number, deltaY: number): number {
  const next = scale * 2 ** (-deltaY / 200);
  return Math.min(Math.max(scale, MAX), Math.max(Math.min(scale, MIN), next));
}

/** The scroll that keeps the picture's point under `at` (from the view's top left) in place when the scale changes. */
export function zoomScroll(scroll: Point, at: Point, from: number, to: number): Point {
  const k = to / from;
  return { x: Math.max(0, (scroll.x + at.x) * k - at.x), y: Math.max(0, (scroll.y + at.y) * k - at.y) };
}

/** A point on the screen in the picture's pixels, for a picture drawn at `scale` from the top left of a scrolled view. */
export function imageAt(client: Point, view: { left: number; top: number; scrollLeft: number; scrollTop: number }, scale: number): Point {
  return { x: (client.x - view.left + view.scrollLeft) / scale, y: (client.y - view.top + view.scrollTop) / scale };
}

export function zoomText(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
