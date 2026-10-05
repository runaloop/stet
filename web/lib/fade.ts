/** A copy of what a view shows on screen, laid over it while the view changes underneath, then faded out. */
export interface Fade {
  /** The view under it is in place: fade the copy out. */
  go(): void;
  drop(): void;
}

const NONE: Fade = { go() {}, drop() {} };
/** How long the fade takes; the stylesheet's `.view-fade` transition says the same. */
export const FADE_MS = 200;
/** The longest the copy waits for `go` (the new view's texts loading, its first layout). */
const HOLD = 700;

// a copy must not pass for the view: the page finds files, blocks and lines by these
const STRIP = ["data-file", "data-stop", "data-b", "data-start", "data-end", "data-threads", "id"];

let current: Fade | null = null;

function copy(node: Node): Node {
  if (!(node instanceof Element)) return node.cloneNode(false);
  // a custom element would run its own setup again: a plain host takes its attributes and its shadow root's content
  const custom = node.tagName.includes("-");
  const el = custom ? document.createElement("div") : (node.cloneNode(false) as Element);
  if (custom) for (const a of node.attributes) el.setAttribute(a.name, a.value);
  for (const a of STRIP) el.removeAttribute(a);
  if (node.shadowRoot) {
    const root = el.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = node.shadowRoot.adoptedStyleSheets;
    for (const c of node.shadowRoot.childNodes) root.append(c.cloneNode(true));
  }
  for (const c of node.childNodes) el.append(copy(c));
  return el;
}

/** The colour behind an element: its own background or the first one around it that is not transparent. */
function backdrop(el: Element): string {
  for (let at: Element | null = el; at; at = at.parentElement) {
    const bg = getComputedStyle(at).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return getComputedStyle(document.body).backgroundColor;
}

export const reducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Lays a copy of `parts` (where they are on screen, within `clip`) over the page. It takes no input: keys, the wheel
 * and clicks reach the view under it, and the first of them removes it. With reduced motion there is none.
 */
export function snapshot(clip: DOMRect, parts: readonly Element[]): Fade {
  current?.drop();
  if (reducedMotion() || clip.width <= 0 || clip.height <= 0) return NONE;
  const layer = document.createElement("div");
  layer.className = "view-fade";
  layer.inert = true;
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, { left: `${clip.left}px`, top: `${clip.top}px`, width: `${clip.width}px`, height: `${clip.height}px`, background: backdrop(parts[0] ?? document.body) });
  for (const p of parts) {
    const r = p.getBoundingClientRect();
    if (!r.width || r.bottom <= clip.top || r.top >= clip.bottom) continue;
    const c = copy(p) as HTMLElement;
    Object.assign(c.style, { position: "absolute", left: `${r.left - clip.left}px`, top: `${r.top - clip.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: "0", boxSizing: "border-box" });
    layer.append(c);
  }
  document.body.append(layer);
  const events = ["wheel", "pointerdown", "keydown"] as const;
  let started = false;
  let timer = 0;
  const fade: Fade = {
    go() {
      if (started || !layer.isConnected) return;
      started = true;
      clearTimeout(timer);
      layer.getBoundingClientRect();
      layer.style.opacity = "0";
      timer = window.setTimeout(fade.drop, FADE_MS + 40);
    },
    drop() {
      clearTimeout(timer);
      layer.remove();
      for (const ev of events) window.removeEventListener(ev, fade.drop, { capture: true });
      if (current === fade) current = null;
    },
  };
  timer = window.setTimeout(fade.go, HOLD);
  for (const ev of events) window.addEventListener(ev, fade.drop, { capture: true, passive: true });
  current = fade;
  return fade;
}

/** The part of `el` on screen: inside the viewport and inside every box that clips it (its own scrolling box too). */
export function visibleBox(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  let top = Math.max(0, r.top);
  let left = Math.max(0, r.left);
  let bottom = Math.min(innerHeight, r.bottom);
  let right = Math.min(innerWidth, r.right);
  for (let at: Element | null = el; at && at !== document.body; at = at.parentElement) {
    const s = getComputedStyle(at);
    if (!/(auto|scroll|hidden|clip)/.test(`${s.overflowX} ${s.overflowY}`)) continue;
    const b = at.getBoundingClientRect();
    top = Math.max(top, b.top + at.clientTop);
    left = Math.max(left, b.left + at.clientLeft);
    bottom = Math.min(bottom, b.top + at.clientTop + at.clientHeight);
    right = Math.min(right, b.left + at.clientLeft + at.clientWidth);
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
