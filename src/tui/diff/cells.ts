/**
 * Text as terminal cells: tabs to the next stop, control characters out, graphemes never cut, wide characters taking
 * two cells. Works on runs of text with a style each, so syntax colours survive a wrap or a cut.
 */

export interface Run {
  text: string;
}

const ASCII = /^[\x20-\x7e]*$/;
const segmenter = new Intl.Segmenter();

/** The graphemes of `text`: what the terminal draws as one character. */
export function graphemes(text: string): string[] {
  if (ASCII.test(text)) return text.split("");
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

export function cellsOf(text: string): number {
  return ASCII.test(text) ? text.length : Bun.stringWidth(text);
}

/** Tabs to spaces up to the next stop of `tab` cells, counted across the runs; control characters dropped. */
export function expandRuns<T extends Run>(runs: readonly T[], tab = 4): T[] {
  if (runs.every((r) => ASCII.test(r.text))) return runs as T[];
  let col = 0;
  return runs.map((r) => {
    if (ASCII.test(r.text)) {
      col += r.text.length;
      return r;
    }
    let out = "";
    for (const g of graphemes(r.text)) {
      if (g === "\t") {
        const n = tab - (col % tab);
        out += " ".repeat(n);
        col += n;
      } else if (g >= " " && g !== "\x7f" && !/^[\x80-\x9f]$/.test(g)) {
        out += g;
        col += cellsOf(g);
      }
    }
    return { ...r, text: out };
  });
}

/** One line's text, expanded: for the width of a line. */
export function lineCells(text: string, tab = 4): number {
  if (ASCII.test(text)) return text.length;
  return cellsOf(expandRuns([{ text }], tab)[0]!.text);
}

/**
 * The runs as display lines of at most `w` cells, no more than `cap` of them (the last one then ends where the text
 * is cut). A wide character that does not fit at the end of a line starts the next one.
 */
export function wrapRuns<T extends Run>(runs: readonly T[], w: number, cap = 50): T[][] {
  const out: T[][] = [[]];
  let col = 0;
  const width = Math.max(1, w);
  for (const r of runs) {
    let rest = r.text;
    while (rest.length) {
      if (col >= width) {
        if (out.length >= cap) return out;
        out.push([]);
        col = 0;
      }
      const [piece, used] = cut(rest, width - col);
      if (!piece) {
        if (col === 0) {
          // a character wider than the whole line: it takes the line alone
          const g = graphemes(rest)[0]!;
          out[out.length - 1]!.push({ ...r, text: g });
          rest = rest.slice(g.length);
          col = width;
          continue;
        }
        col = width;
        continue;
      }
      out[out.length - 1]!.push({ ...r, text: piece });
      col += used;
      rest = rest.slice(piece.length);
    }
  }
  return out;
}

/** The longest start of `text` that takes at most `w` cells, and how many it takes. */
export function cut(text: string, w: number): [string, number] {
  if (w <= 0) return ["", 0];
  if (ASCII.test(text)) return text.length <= w ? [text, text.length] : [text.slice(0, w), w];
  let used = 0;
  let end = 0;
  for (const g of graphemes(text)) {
    const cw = cellsOf(g);
    if (used + cw > w) break;
    used += cw;
    end += g.length;
  }
  return [text.slice(0, end), used];
}

/**
 * The cells `off` to `off + w` of the runs, for a line scrolled sideways; a wide character cut by either edge shows as
 * a space. `more`: text goes on past the right edge.
 */
export function clipRuns<T extends Run>(runs: readonly T[], off: number, w: number): { runs: T[]; more: boolean } {
  const out: T[] = [];
  let col = 0;
  const end = off + w;
  for (const [i, r] of runs.entries()) {
    const n = cellsOf(r.text);
    if (col >= end) return { runs: out, more: col > end || runs.slice(i).some((x) => x.text.length > 0) };
    if (col + n <= off) {
      col += n;
      continue;
    }
    if (ASCII.test(r.text)) {
      out.push({ ...r, text: r.text.slice(Math.max(0, off - col), Math.max(0, end - col)) });
      col += n;
      continue;
    }
    let text = "";
    for (const g of graphemes(r.text)) {
      const cw = cellsOf(g);
      if (col + cw <= off || col >= end) {
        col += cw;
        continue;
      }
      if (col < off) text += " ".repeat(col + cw - off);
      else if (col + cw > end) text += " ".repeat(end - col);
      else text += g;
      col += cw;
    }
    out.push({ ...r, text });
  }
  return { runs: out, more: col > end };
}
