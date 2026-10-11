/**
 * Syntax colours for the terminal's diff, off the main thread: Shiki with the JavaScript regex engine pinned to ES2018
 * (the default target costs half a second before the first TypeScript line), the web's dark theme.
 *
 * In: `file` (a file's two sides as lines, its language, the runs of lines to colour in order: one per hunk side, or
 * one per side of a whole file) and `view` (lines on screen and around them, first served). A run is coloured in
 * blocks of at most 50 lines, each from the grammar state the block before ended in; lines on screen far ahead of
 * their run are coloured without a state and redone when the run gets there.
 * Out: `tok`, a block's tokens packed in a transferred Uint32Array, per line [count, (end, style) × count], with the
 * styles new since the last message; `idle` once nothing is left.
 */
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import theme from "@pierre/theme/pierre-dark";

declare const self: Worker;

const BLOCK = 50;
const THEME = "pierre-dark";

interface Chain {
  file: number;
  side: number;
  next: number;
  end: number;
  state: unknown;
}

interface FileJob {
  lang: string;
  sides: [string[], string[]];
  done: [Uint8Array, Uint8Array];
  chainOf: [Int32Array, Int32Array];
}

let hl: HighlighterCore | null = null;
const loading = new Map<string, Promise<boolean>>();
const files = new Map<number, FileJob>();
const chains: Chain[] = [];
let want: [number, number, number, number][] = [];
const styles = new Map<string, number>();
let fresh: [number, string, number][] = [];

async function highlighter(): Promise<HighlighterCore> {
  hl ??= await createHighlighterCore({ themes: [theme as never], langs: [], engine: createJavaScriptRegexEngine({ target: "ES2018" }) });
  return hl;
}

function language(lang: string): Promise<boolean> {
  let p = loading.get(lang);
  if (!p) {
    const load = (bundledLanguages as Record<string, (() => Promise<{ default: unknown }>) | undefined>)[lang];
    p = load
      ? highlighter().then(async (h) => {
          await h.loadLanguage((await load()).default as never);
          return true;
        }).catch(() => false)
      : Promise.resolve(false);
    loading.set(lang, p);
  }
  return p;
}

function styleId(color: string | undefined, fs: number | undefined): number {
  const k = `${color ?? ""}|${fs ?? 0}`;
  let id = styles.get(k);
  if (id === undefined) {
    id = styles.size;
    styles.set(k, id);
    fresh.push([id, color ?? "", fs ?? 0]);
  }
  return id;
}

function tokenize(id: number, f: FileJob, side: number, start: number, end: number, state: unknown, exact: boolean): unknown {
  const res = hl!.codeToTokens(f.sides[side]!.slice(start, end).join("\n"), { lang: f.lang, theme: THEME, grammarState: state as never, tokenizeMaxLineLength: 1000 });
  let size = 0;
  for (const l of res.tokens) size += 1 + 2 * l.length;
  const buf = new Uint32Array(size);
  let p = 0;
  for (const l of res.tokens) {
    buf[p++] = l.length;
    let off = 0;
    for (const t of l) {
      off += t.content.length;
      buf[p++] = off;
      buf[p++] = styleId(t.color, t.fontStyle);
    }
  }
  const pal = fresh;
  fresh = [];
  self.postMessage({ t: "tok", id, side, start, n: end - start, exact, pal, buf }, [buf.buffer]);
  if (exact) f.done[side]!.fill(1, start, end);
  else f.done[side]!.fill(2, start, end);
  return res.grammarState;
}

function step(c: Chain): void {
  const f = files.get(c.file)!;
  const end = Math.min(c.end, c.next + BLOCK);
  c.state = tokenize(c.file, f, c.side, c.next, end, c.state, true);
  c.next = end;
}

/** Lines in view without colours: their run goes on when it is near, else they are coloured on their own. */
function serveView(): boolean {
  for (const [id, side, from, to] of want) {
    const f = files.get(id);
    if (!f) continue;
    for (let i = from; i < to; i++) {
      if (f.done[side]![i]) continue;
      const ci = f.chainOf[side]![i] ?? -1;
      if (ci < 0) continue;
      const c = chains[ci]!;
      if (i - c.next < BLOCK) {
        step(c);
        return true;
      }
      let j = i;
      while (j < to && j < c.end && !f.done[side]![j]) j++;
      tokenize(id, f, side, i, Math.min(j, i + BLOCK), undefined, false);
      return true;
    }
  }
  return false;
}

let turn = 0;
/** The runs of the files in view go on in the background, the one under the view first. */
function background(): boolean {
  for (let k = 0; k < chains.length; k++) {
    const c = chains[(turn + k) % chains.length]!;
    if (c.next < c.end) {
      turn = (turn + k) % chains.length;
      step(c);
      return true;
    }
  }
  return false;
}

let running = false;
async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      if (!(serveView() || background())) break;
      // let `view` messages in between blocks
      await new Promise<void>((r) => setImmediate(r));
    }
    self.postMessage({ t: "idle" });
  } finally {
    running = false;
  }
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.t === "file") {
    if (!(await language(m.lang))) {
      self.postMessage({ t: "plain", id: m.id });
      return;
    }
    const sides = m.sides as [string[], string[]];
    const f: FileJob = {
      lang: m.lang,
      sides,
      done: [new Uint8Array(sides[0].length), new Uint8Array(sides[1].length)],
      chainOf: [new Int32Array(sides[0].length).fill(-1), new Int32Array(sides[1].length).fill(-1)],
    };
    files.set(m.id, f);
    for (const [side, start, end] of m.chains as [number, number, number][]) {
      if (end <= start) continue;
      chains.push({ file: m.id, side, next: start, end, state: undefined });
      f.chainOf[side]!.fill(chains.length - 1, start, end);
    }
    void pump();
  } else if (m.t === "view") {
    want = m.want;
    const w = want[0];
    const ci = w ? (files.get(w[0])?.chainOf[w[1]]![w[2]] ?? -1) : -1;
    if (ci >= 0) turn = ci;
    void pump();
  }
};
