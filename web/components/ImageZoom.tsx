import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useMemo, useRef } from "preact/hooks";
import { wheelZoom, zoomScroll, zoomStep, zoomText, type Point } from "../lib/zoom.ts";

interface View {
  el: HTMLElement;
  /** The width of the view's content in the picture's pixels. */
  w: number;
  zoom: Zoom;
}

const views = new Set<View>();
let hovered: View | null = null;

/** The zoom and scroll of one picture, or of pictures shown together (old and new side by side): they move as one. */
export class Zoom {
  /** null: fit, each picture as big as its place allows. */
  readonly scale = signal<number | null>(null);
  private scroll: Point = { x: 0, y: 0 };
  private expected = new WeakMap<HTMLElement, Point>();

  private views(): View[] {
    return [...views].filter((v) => v.zoom === this);
  }

  /** The scale on screen: the zoom, or the one fit gives the first picture. */
  shown(): number | null {
    if (this.scale.value !== null) return this.scale.value;
    const v = this.views()[0];
    const content = v?.el.firstElementChild;
    return v && content && v.w ? content.getBoundingClientRect().width / v.w : null;
  }

  /** `at`: the point that stays in place, from the top left of `view`; the middle of what is seen by default. */
  set(to: number | null, at?: Point, view?: HTMLElement): void {
    if (to === null) {
      this.scroll = { x: 0, y: 0 };
      this.scale.value = null;
      for (const v of this.views()) this.apply(v.el);
      return;
    }
    const from = this.shown();
    const el = view ?? this.views()[0]?.el;
    if (from === null || !el) return;
    const content = el.firstElementChild?.getBoundingClientRect();
    const middle = { x: Math.min(el.clientWidth, content?.width ?? 0) / 2, y: Math.min(el.clientHeight, content?.height ?? 0) / 2 };
    this.scroll = zoomScroll(this.scale.value === null ? { x: 0, y: 0 } : this.scroll, at ?? middle, from, to);
    if (this.scale.value === to) for (const v of this.views()) this.apply(v.el);
    else this.scale.value = to;
  }

  step(dir: 1 | -1): void {
    const s = this.shown();
    if (s !== null) this.set(zoomStep(s, dir));
  }

  apply(el: HTMLElement): void {
    el.scrollLeft = this.scroll.x;
    el.scrollTop = this.scroll.y;
    this.expected.set(el, { x: el.scrollLeft, y: el.scrollTop });
  }

  /** One view scrolled: the others follow. Their own scroll events, from being moved here, are not echoed back. */
  scrolled(el: HTMLElement): void {
    const e = this.expected.get(el);
    if (e && Math.abs(e.x - el.scrollLeft) < 1 && Math.abs(e.y - el.scrollTop) < 1) return;
    this.expected.delete(el);
    if (this.scale.value === null) return;
    this.scroll = { x: el.scrollLeft, y: el.scrollTop };
    for (const v of this.views()) if (v.el !== el) this.apply(v.el);
  }
}

export function useZoom(): Zoom {
  return useMemo(() => new Zoom(), []);
}

function biggestInSight(): View | null {
  let best: View | null = null;
  let most = 0;
  for (const v of views) {
    const r = v.el.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    if (area > most) [best, most] = [v, area];
  }
  return best;
}

/** `+` / `-` / `0`: the picture under the mouse, or the one that takes the most of the screen. False when none is in sight. */
export function zoomKey(dir: 1 | -1 | 0): boolean {
  const v = hovered && views.has(hovered) ? hovered : biggestInSight();
  if (!v) return false;
  if (dir === 0) v.zoom.set(null);
  else v.zoom.step(dir);
  return true;
}

/**
 * The scrolling frame around a picture: its first child is the picture, `w` its width in the picture's pixels.
 * `pan`: a drag moves the picture when zoomed in (where a drag does not draw a frame or move a divider); a drag with the
 * middle button always does.
 */
export function ZoomView({ zoom, w, pan, children }: { zoom: Zoom; w: number | null; pan?: boolean; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const grab = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const scale = zoom.scale.value;
  useLayoutEffect(() => {
    if (!ref.current || !w) return;
    const v: View = { el: ref.current, w, zoom };
    views.add(v);
    return () => {
      views.delete(v);
      if (hovered === v) hovered = null;
    };
  }, [zoom, w]);
  useLayoutEffect(() => {
    if (ref.current) zoom.apply(ref.current);
  }, [scale]);
  const hover = (on: boolean) => {
    const v = [...views].find((x) => x.el === ref.current) ?? null;
    if (on) hovered = v;
    else if (hovered === v) hovered = null;
  };
  return (
    <div
      ref={ref}
      class={`imgview${scale !== null ? " zoomed" : ""}${pan ? " pan" : ""}`}
      onScroll={(e) => zoom.scrolled(e.currentTarget as HTMLElement)}
      onPointerEnter={() => hover(true)}
      onPointerLeave={() => hover(false)}
      onWheel={(e) => {
        if (!e.ctrlKey) return;
        const s = zoom.shown();
        const el = e.currentTarget as HTMLElement;
        if (s === null) return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
        zoom.set(wheelZoom(s, dy), { x: e.clientX - r.left, y: e.clientY - r.top }, el);
      }}
      onMouseDown={(e) => scale !== null && e.button === 1 && e.preventDefault()}
      onPointerDown={(e) => {
        const el = e.currentTarget as HTMLElement;
        if (scale === null || e.defaultPrevented || (e.target as Element).closest("a.img-frame")) return;
        if (e.button !== 1 && !(e.button === 0 && pan)) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add("panning");
        grab.current = { x: e.clientX, y: e.clientY, sx: el.scrollLeft, sy: el.scrollTop };
      }}
      onPointerMove={(e) => {
        const g = grab.current;
        if (!g) return;
        const el = e.currentTarget as HTMLElement;
        el.scrollLeft = g.sx - (e.clientX - g.x);
        el.scrollTop = g.sy - (e.clientY - g.y);
      }}
      onPointerUp={(e) => {
        grab.current = null;
        (e.currentTarget as HTMLElement).classList.remove("panning");
      }}
      onPointerCancel={(e) => {
        grab.current = null;
        (e.currentTarget as HTMLElement).classList.remove("panning");
      }}
    >
      {children}
    </div>
  );
}

/** fit, 100%, − and +, and the scale when zoomed. */
export function ZoomBar({ zoom }: { zoom: Zoom }) {
  const s = zoom.scale.value;
  return (
    <span class="zoom-bar">
      <span class="seg small">
        <button class={s === null ? "on" : ""} title="fit the picture in its place (0)" onClick={() => zoom.set(null)}>
          fit
        </button>
        <button class={s === 1 ? "on" : ""} title="a pixel of the picture to a pixel of the screen" onClick={() => zoom.set(1)}>
          100%
        </button>
        <button title="zoom out (-, Ctrl+wheel)" aria-label="zoom out" onClick={() => zoom.step(-1)}>
          −
        </button>
        <button title="zoom in (+, Ctrl+wheel)" aria-label="zoom in" onClick={() => zoom.step(1)}>
          +
        </button>
      </span>
      {s !== null ? <span class="zoom-level">{zoomText(s)}</span> : null}
    </span>
  );
}
