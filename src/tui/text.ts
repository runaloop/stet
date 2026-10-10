/** What the pages draw: lines of styled spans, cut to the screen's width. No OpenTUI here; `screen.ts` paints them. */

/** A colour by meaning; the screen maps it to the terminal's own palette, so light and dark themes both read. */
export type Tone = "accent" | "ok" | "bad" | "warn" | "info" | "muted" | "agent" | "add" | "del";

export interface Span {
  text: string;
  tone?: Tone;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface Line {
  spans: Span[];
  /** The cursor's row: drawn inverted across the whole width. */
  selected?: boolean;
}

export type Style = Omit<Span, "text">;

export const s = (text: string, style: Style = {}): Span => ({ text, ...style });
export const line = (...spans: (Span | string)[]): Line => ({ spans: spans.map((x) => (typeof x === "string" ? { text: x } : x)) });
export const blank = (): Line => ({ spans: [] });

export function width(text: string): number {
  return Bun.stringWidth(text);
}

export function plain(l: Line): string {
  return l.spans.map((x) => x.text).join("");
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
  if (spans.reduce((n, x) => n + width(x.text), 0) <= w) return spans;
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

/** Spans on the left, spans on the right, filling `w` cells; the left side gives way first. */
export function spread(left: Span[], right: Span[], w: number): Span[] {
  const rw = right.reduce((n, x) => n + width(x.text), 0);
  if (rw >= w) return clip(right, w);
  const l = clip(left, w - rw - 1);
  const lw = l.reduce((n, x) => n + width(x.text), 0);
  return [...l, { text: " ".repeat(w - lw - rw) }, ...right];
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
