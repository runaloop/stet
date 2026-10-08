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
/** Frames the boxes that scroll keep their place and size before a changed view counts as in place. */
const STILL = 4;

/** The copy on screen: it fades once every part of the change that holds it says its view is in place. */
interface Cover {
  holds: number;
  started: boolean;
  go(): void;
  drop(): void;
}

let current: Cover | null = null;

/** What copying needs besides the node: the part of the screen copied, and the boxes found scrolled (to scroll alike). */
interface Copying {
  clip: DOMRect;
  scrolled: [Element, number, number][];
}

function copy(node: Node, at: Copying): Node {
  if (!(node instanceof Element)) return node.cloneNode(false);
  // a custom element would run its own setup again: a plain host takes its attributes and its shadow root's content
  const custom = node.tagName.includes("-");
  const el = custom ? document.createElement("div") : (node.cloneNode(false) as Element);
  if (custom) for (const a of node.attributes) el.setAttribute(a.name, a.value);
  // off screen it keeps its place but not its content: a long diff or conversation costs a screen to copy, not all of it
  const r = node.getBoundingClientRect();
  if (r.height > 0 && (r.bottom <= at.clip.top || r.top >= at.clip.bottom) && getComputedStyle(node).display !== "inline") {
    Object.assign((el as HTMLElement).style, { height: `${r.height}px`, boxSizing: "border-box" });
    return el;
  }
  if (node.shadowRoot) {
    const root = el.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = node.shadowRoot.adoptedStyleSheets;
    for (const c of node.shadowRoot.childNodes) root.append(c.cloneNode(true));
  }
  for (const c of node.childNodes) el.append(copy(c, at));
  if (node.scrollTop || node.scrollLeft) at.scrolled.push([el, node.scrollTop, node.scrollLeft]);
  return el;
}

let sheet: CSSStyleSheet | null = null;

const cssomText = (s: CSSStyleSheet): string => {
  try {
    return [...s.cssRules].map((r) => r.cssText).join("\n");
  } catch {
    return "";
  }
};

/**
 * The page's style rules, for the copies: they sit in a shadow root of their own. Read back from the CSSOM at first;
 * that loses a shorthand with var() that a longhand overrides (`kbd`'s border in Firefox), so the style files' own
 * text replaces them once fetched. Called once early, it has them before the first copy.
 */
export function pageSheet(): CSSStyleSheet {
  // a sheet made for another window (tests put up a new DOM per file) cannot be adopted here
  if (sheet instanceof CSSStyleSheet) return sheet;
  const own = (sheet = new CSSStyleSheet());
  own.replaceSync([...document.styleSheets].map(cssomText).join("\n"));
  const text = (el: Element) => (el instanceof HTMLLinkElement ? fetch(el.href).then((r) => (r.ok ? r.text() : Promise.reject())) : (el.textContent ?? ""));
  void Promise.all([...document.querySelectorAll('link[rel="stylesheet"], style')].map(text)).then(
    (texts) => own.replace(texts.join("\n")),
    () => undefined,
  );
  return own;
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

function hold(cover: Cover): Fade {
  cover.holds++;
  let done = false;
  return {
    go() {
      if (done) return;
      done = true;
      if (--cover.holds === 0) cover.go();
    },
    drop: () => cover.drop(),
  };
}

/**
 * Lays a copy of `parts` (where they are on screen, within `clip`) over the page. It takes no input: keys, the wheel
 * and clicks reach the view under it, and the first of them removes it. With reduced motion there is none. A copy that
 * still waits for its view is not made again: the change that asks joins it, and it fades once all have said `go`.
 */
export function snapshot(clip: DOMRect, parts: readonly Element[]): Fade {
  if (current && !current.started) return hold(current);
  current?.drop();
  if (reducedMotion() || clip.width <= 0 || clip.height <= 0) return NONE;
  const layer = document.createElement("div");
  layer.className = "view-fade";
  layer.inert = true;
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, { left: `${clip.left}px`, top: `${clip.top}px`, width: `${clip.width}px`, height: `${clip.height}px`, background: backdrop(parts[0] ?? document.body) });
  // in a shadow root the page's queries (".guide .guide-step", ".commit-row.in") do not find the copy
  const shadow = layer.attachShadow({ mode: "open" });
  shadow.adoptedStyleSheets = [pageSheet(), ...document.adoptedStyleSheets];
  const at: Copying = { clip, scrolled: [] };
  for (const p of parts) {
    const r = p.getBoundingClientRect();
    if (!r.width || r.bottom <= clip.top || r.top >= clip.bottom) continue;
    const c = copy(p, at) as HTMLElement;
    Object.assign(c.style, { position: "absolute", left: `${r.left - clip.left}px`, top: `${r.top - clip.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: "0", boxSizing: "border-box" });
    shadow.append(c);
  }
  document.body.append(layer);
  for (const [el, top, left] of at.scrolled) el.scrollTo(left, top);
  const events = ["wheel", "pointerdown", "keydown"] as const;
  let timer = 0;
  const cover: Cover = {
    holds: 0,
    started: false,
    go() {
      if (cover.started || !layer.isConnected) return;
      cover.started = true;
      clearTimeout(timer);
      layer.getBoundingClientRect();
      layer.style.opacity = "0";
      timer = window.setTimeout(cover.drop, FADE_MS + 40);
    },
    drop() {
      clearTimeout(timer);
      layer.remove();
      for (const ev of events) window.removeEventListener(ev, cover.drop, { capture: true });
      if (current === cover) current = null;
    },
  };
  timer = window.setTimeout(cover.go, HOLD);
  for (const ev of events) window.addEventListener(ev, cover.drop, { capture: true, passive: true });
  current = cover;
  return hold(cover);
}

/**
 * Keeps a copy that waits for its view from fading until the returned function is called (or the wait runs out):
 * a placement the change set off is not done yet. Without such a copy it does nothing.
 */
export function holdFade(): () => void {
  return current && !current.started ? hold(current).go : () => {};
}

/** Counts the frames a view's `state` stays the same: true once it held for `frames` of them. */
export function stillness(frames = STILL): (state: string) => boolean {
  let last: string | null = null;
  let still = 0;
  return (state) => {
    still = state === last ? still + 1 : 0;
    last = state;
    return still >= frames;
  };
}

/**
 * Covers `root` with a copy of what it shows, for a change of view about to happen, and fades the copy out once the
 * new view is there (`ready`) and holds still: `root` and the boxes that scroll in it (`scrollers`) keep their place and
 * size for a few frames.
 */
export function crossfade(root: Element | null, scrollers: string, ready: () => boolean = () => true): void {
  if (!root) return;
  const fade = snapshot(visibleBox(root), [root]);
  if (fade === NONE) return;
  const still = stillness();
  const end = performance.now() + HOLD;
  const tick = () => {
    if (performance.now() > end) return fade.go();
    if (ready() && still([root, ...root.querySelectorAll(scrollers)].map((e) => `${e.scrollTop}:${e.scrollHeight}`).join())) return fade.go();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
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
