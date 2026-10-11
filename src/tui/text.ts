/** What the views draw: lines of spans styled by meaning, cut to the screen's width. No OpenTUI here; `screen.ts` paints them. */

/** A style by meaning, as the approved mockups name them; `style.ts` gives each its colours. */
export type Cls =
  | "b" | "dim" | "bd" | "bdt" | "bf" | "bft" | "hdr" | "info" | "state" | "sel" | "seli" | "cur"
  | "add" | "addw" | "del" | "delw" | "addc" | "delc" | "ln" | "mk" | "key" | "tab" | "tabin" | "chip" | "chips" | "seg"
  | "fon" | "mod" | "tchg" | "tyou" | "tag" | "tout" | "tdr" | "tok" | "tq" | "tbad" | "ok" | "bad" | "new" | "acc" | "fh"
  | "rule" | "cf" | "cft" | "wk" | "wg" | "ftr" | "fk" | "you" | "agentc" | "warn" | "hunk" | "void";

export interface Span {
  text: string;
  c?: Cls[];
  /** What a click on it does: `thread:12`, `side:files`, `key:<Space>ur`, `focus:conv`; see `app.ts`. */
  hit?: string;
  /** A syntax colour, over the classes' own: `#rrggbb`. */
  fg?: string;
  /** Its font style: 1 italic, 2 bold, 4 underline. */
  fs?: number;
}

export interface Line {
  spans: Span[];
  /** Styles of the whole row, padding included: a selected row, a diff row, a strip. */
  fill?: Cls[];
  /** What a click on the row does, where its spans say nothing else. */
  hit?: string;
}

export const s = (text: string, ...c: Cls[]): Span => (c.length ? { text, c } : { text });
export const line = (...spans: (Span | string)[]): Line => ({ spans: spans.map((x) => (typeof x === "string" ? { text: x } : x)) });
export const filled = (fill: Cls[], ...spans: (Span | string)[]): Line => ({ ...line(...spans), fill });
export const blank = (): Line => ({ spans: [] });
const NAMED: Record<string, string | null> = {
  Enter: "<CR>", Esc: "<Esc>", Tab: "<Tab>", Space: "<Space>", Backspace: "<BS>", "Ctrl+S": "<C-s>", "Ctrl+G": "<C-g>", "Ctrl+C": null, "j j": null,
};

/** The keys a chip's label stands for, as typed, so a click can run them: `Space u r` → `<Space>ur`, `j k` → `j`. */
export function keysOfLabel(label: string): string | null {
  if (label in NAMED) return NAMED[label]!;
  if (label.startsWith("Space ")) return `<Space>${label.slice(6).replaceAll(" ", "")}`;
  const parts = label.split(" ");
  if (parts.some((p) => [...p].length !== 1)) return null;
  if (parts.length === 1) return label;
  return parts[0] === parts[1] || parts[0] === "[" || parts[0] === "]" ? parts.join("") : parts[0]!;
}

/** A key as a chip: ` Esc `; a click on it runs the key. */
export const key = (k: string): Span => {
  const keys = keysOfLabel(k);
  return { text: ` ${k} `, c: ["key"], ...(keys ? { hit: `key:${keys}` } : {}) };
};

export function width(text: string): number {
  return Bun.stringWidth(text);
}

export function spansWidth(spans: Span[]): number {
  return spans.reduce((n, x) => n + width(x.text), 0);
}

export function plain(l: Line | Span[]): string {
  return ("spans" in l ? l.spans : l).map((x) => x.text).join("");
}

/** Text as one screen line: tabs to spaces, control characters out. */
export function clean(text: string, tab = 4): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\t") out += " ".repeat(tab - (width(out) % tab));
    else if (ch >= " " && ch !== "\x7f") out += ch;
  }
  return out;
}

/** The first `w` cells of `text`; a cut shows as `…`, also when `more` follows a text that fits exactly. */
export function truncate(text: string, w: number, more = false): string {
  if (w <= 0) return "";
  if (width(text) < w || (width(text) === w && !more)) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const cw = width(ch);
    if (used + cw > w - 1) break;
    out += ch;
    used += cw;
  }
  return out + "…";
}

/** The spans cut to `w` cells, the last one ending in `…` when something was left out. */
export function clip(spans: Span[], w: number): Span[] {
  if (spansWidth(spans) <= w) return spans;
  const out: Span[] = [];
  let left = w;
  for (const x of spans) {
    const cw = width(x.text);
    if (cw < left) {
      out.push(x);
      left -= cw;
      continue;
    }
    out.push({ ...x, text: truncate(x.text, left, true) });
    break;
  }
  return out;
}

/** The line as exactly `w` cells: cut with `…`, or padded in the row's own styles. */
export function fit(l: Line, w: number): Span[] {
  const spans = clip(l.spans, w).map((x) => {
    const c = l.fill ? [...l.fill, ...(x.c ?? [])] : x.c;
    const hit = x.hit ?? l.hit;
    return { text: x.text, ...(c ? { c } : {}), ...(hit ? { hit } : {}), ...(x.fg ? { fg: x.fg } : {}), ...(x.fs ? { fs: x.fs } : {}) };
  });
  const used = spansWidth(spans);
  if (used < w) spans.push({ text: " ".repeat(w - used), ...(l.fill ? { c: l.fill } : {}), ...(l.hit ? { hit: l.hit } : {}) });
  return spans;
}


/** Spans on the left, spans on the right, filling `w` cells with at least one space between; the left side gives way. */
export function spread(left: Span[], right: Span[], w: number): Span[] {
  const rw = spansWidth(right);
  if (rw >= w) return clip(right, w);
  const l = clip(left, Math.max(0, w - rw - 1));
  return [...l, { text: " ".repeat(Math.max(1, w - spansWidth(l) - rw)) }, ...right];
}

/** Words of `text` in lines of at most `w` cells; a word longer than a line is broken. Newlines stay. */
export function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  const max = Math.max(1, w);
  for (const para of text.split("\n")) {
    const words = clean(para).split(/(\s+)/);
    let cur = "";
    for (const word of words) {
      if (!word) continue;
      if (width(cur + word) <= max) {
        cur += word;
        continue;
      }
      if (/^\s+$/.test(word)) {
        out.push(cur);
        cur = "";
        continue;
      }
      if (cur.trim()) out.push(cur.trimEnd());
      cur = "";
      let rest = word;
      while (width(rest) > max) {
        let piece = "";
        for (const ch of rest) {
          if (width(piece + ch) > max) break;
          piece += ch;
        }
        out.push(piece);
        rest = rest.slice(piece.length);
      }
      cur = rest;
    }
    out.push(cur.trimEnd());
  }
  return out;
}

/** Text cut into pieces of at most `w` cells, as code wraps: no word breaks, spaces kept. */
export function chop(text: string, w: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (width(cur + ch) > Math.max(1, w)) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function ago(iso: string, now = Date.now()): string {
  const sec = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export function rangeText(r: { start: number; end: number } | null): string {
  if (!r) return "—";
  return r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`;
}
