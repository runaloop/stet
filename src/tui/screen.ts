import { Renderable, RGBA, TextAttributes, type OptimizedBuffer, type RenderContext } from "@opentui/core";
import { truncate, width, type Line, type Span, type Tone } from "./text.ts";

export interface Overlay {
  title: string;
  lines: Line[];
  /** The first line shown, when they do not fit. */
  top: number;
}

export interface Frame {
  header: Line;
  /** The lines the body shows, from its top. */
  body: Line[];
  footer: Line;
  overlay: Overlay | null;
}

// The terminal's own 16 colours, so its theme decides how they look, light or dark.
const TONES: Record<Tone, number> = { accent: 6, ok: 2, bad: 1, warn: 3, info: 4, muted: 8, agent: 5, add: 2, del: 1 };
const FG = RGBA.defaultForeground();
const BG = RGBA.defaultBackground();
const tones = new Map<Tone, RGBA>();
const color = (t: Tone | undefined) => (t ? (tones.get(t) ?? tones.set(t, RGBA.fromIndex(TONES[t])).get(t)!) : FG);
const ASCII = /^[\x20-\x7e]*$/;

function attrs(x: Span, selected: boolean): number {
  return (
    (x.bold ? TextAttributes.BOLD : 0) |
    (x.dim ? TextAttributes.DIM : 0) |
    (x.italic ? TextAttributes.ITALIC : 0) |
    (x.underline ? TextAttributes.UNDERLINE : 0) |
    (selected ? TextAttributes.INVERSE : 0)
  );
}

// OpenTUI's drawText is ~100× slower once a string holds a non-ASCII character (phase 0), so those cells of width 1
// go through drawChar.
function drawText(buf: OptimizedBuffer, text: string, x: number, y: number, fg: RGBA, a: number): number {
  if (ASCII.test(text)) {
    buf.drawText(text, x, y, fg, BG, a);
    return x + text.length;
  }
  let run = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && cp < 0x7f) {
      run += ch;
      continue;
    }
    if (run) {
      buf.drawText(run, x, y, fg, BG, a);
      x += run.length;
      run = "";
    }
    const cw = width(ch);
    if (cw === 1) buf.drawChar(cp, x, y, fg, BG, a);
    else if (cw > 1) buf.drawText(ch, x, y, fg, BG, a);
    x += cw;
  }
  if (run) buf.drawText(run, x, y, fg, BG, a);
  return x + run.length;
}

function paintLine(buf: OptimizedBuffer, l: Line, x0: number, y: number, w: number): void {
  let x = x0;
  const end = x0 + w;
  for (const span of l.spans) {
    if (x >= end) break;
    const text = truncate(span.text, end - x);
    x = drawText(buf, text, x, y, color(span.tone), attrs(span, !!l.selected));
  }
  if (l.selected && x < end) buf.drawText(" ".repeat(end - x), x, y, FG, BG, TextAttributes.INVERSE);
}

const BORDER = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

function paintOverlay(buf: OptimizedBuffer, o: Overlay, top: number, bottom: number, w: number): void {
  const inner = Math.min(w - 4, Math.max(width(o.title) + 4, ...o.lines.map((l) => l.spans.reduce((n, x) => n + width(x.text), 0))) + 2);
  const rows = Math.min(bottom - top - 2, o.lines.length);
  const x0 = Math.floor((w - inner - 2) / 2);
  const y0 = top + Math.max(0, Math.floor((bottom - top - rows - 2) / 3));
  const fg = color("accent");
  buf.fillRect(x0, y0, inner + 2, rows + 2, BG);
  const title = truncate(` ${o.title} `, inner - 2);
  drawText(buf, `${BORDER.tl}${BORDER.h}${title}${BORDER.h.repeat(Math.max(0, inner - 1 - width(title)))}${BORDER.tr}`, x0, y0, fg, TextAttributes.BOLD);
  for (let i = 0; i < rows; i++) {
    drawText(buf, BORDER.v, x0, y0 + 1 + i, fg, 0);
    paintLine(buf, o.lines[o.top + i] ?? { spans: [] }, x0 + 2, y0 + 1 + i, inner - 2);
    drawText(buf, BORDER.v, x0 + inner + 1, y0 + 1 + i, fg, 0);
  }
  const more = o.lines.length > o.top + rows ? ` ${o.lines.length - o.top - rows} more ↓ ` : "";
  drawText(buf, `${BORDER.bl}${BORDER.h.repeat(Math.max(0, inner - width(more)))}${more}${BORDER.br}`, x0, y0 + rows + 1, fg, 0);
}

/** The whole screen as one renderable: the header, the page's lines, the footer, and a dialog over them. */
export class Screen extends Renderable {
  constructor(
    ctx: RenderContext,
    private readonly frame: (w: number, h: number) => Frame,
  ) {
    super(ctx, { id: "screen", width: "100%", height: "100%", position: "absolute", left: 0, top: 0, zIndex: 0 });
  }

  protected renderSelf(buf: OptimizedBuffer): void {
    const w = this.width;
    const h = this.height;
    const f = this.frame(w, h);
    buf.fillRect(0, 0, w, h, BG);
    paintLine(buf, f.header, 0, 0, w);
    f.body.forEach((l, i) => i + 1 < h - 1 && paintLine(buf, l, 0, i + 1, w));
    if (h > 1) paintLine(buf, f.footer, 0, h - 1, w);
    if (f.overlay) paintOverlay(buf, f.overlay, 1, h - 1, w);
  }
}
