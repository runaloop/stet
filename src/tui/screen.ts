import { Renderable, RGBA, TextAttributes, type OptimizedBuffer, type RenderContext } from "@opentui/core";
import { colorMode, nearest256, type ColorMode } from "./diff/colors.ts";
import type { Row } from "./grid.ts";
import { look } from "./style.ts";
import { width, type Span } from "./text.ts";

interface Paint {
  fg: RGBA;
  bg: RGBA;
  attrs: number;
}

const colors = new Map<string, RGBA>();

/** A colour of ours as the terminal takes it. */
export function color(hex: string, mode: ColorMode = colorMode()): RGBA {
  const k = `${mode}${hex}`;
  let c = colors.get(k);
  if (!c) colors.set(k, (c = mode === "256" ? RGBA.fromIndex(nearest256(hex)) : RGBA.fromHex(hex)));
  return c;
}

const paints = new Map<string, Paint>();

/** How a span is painted: its classes' look, its syntax colour over it, in the colours the terminal has. */
export function paintOf(x: Pick<Span, "c" | "fg" | "fs">, mode: ColorMode): Paint {
  const k = `${mode} ${x.c?.join(" ") ?? ""} ${x.fg ?? ""} ${x.fs ?? 0}`;
  let p = paints.get(k);
  if (!p) {
    const l = look(x.c);
    const fs = x.fs ?? 0;
    p = {
      fg: color(x.fg ?? l.fg, mode),
      bg: color(l.bg, mode),
      attrs:
        (l.bold || fs & 2 ? TextAttributes.BOLD : 0) | (l.italic || fs & 1 ? TextAttributes.ITALIC : 0) | (l.underline || fs & 4 ? TextAttributes.UNDERLINE : 0),
    };
    paints.set(k, p);
  }
  return p;
}

const ASCII = /^[\x20-\x7e]*$/;

// OpenTUI's drawText is ~100× slower once a string holds a non-ASCII character (phase 0), so those cells of width 1
// go through drawChar.
function drawText(buf: OptimizedBuffer, text: string, x: number, y: number, p: Paint): number {
  if (ASCII.test(text)) {
    buf.drawText(text, x, y, p.fg, p.bg, p.attrs);
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
      buf.drawText(run, x, y, p.fg, p.bg, p.attrs);
      x += run.length;
      run = "";
    }
    const cw = width(ch);
    if (cw === 1) buf.drawChar(cp, x, y, p.fg, p.bg, p.attrs);
    else if (cw > 1) buf.drawText(ch, x, y, p.fg, p.bg, p.attrs);
    x += cw;
  }
  if (run) buf.drawText(run, x, y, p.fg, p.bg, p.attrs);
  return x + run.length;
}

/** The whole screen as one renderable: rows the app builds for the size it is given. */
export class Screen extends Renderable {
  /** Frames painted, for the idle check. */
  frames = 0;
  readonly mode: ColorMode;

  constructor(
    ctx: RenderContext,
    private readonly rows: (w: number, h: number) => Row[],
    mode: ColorMode = colorMode(),
  ) {
    super(ctx, { id: "screen", width: "100%", height: "100%", position: "absolute", left: 0, top: 0, zIndex: 0 });
    this.mode = mode;
  }

  protected renderSelf(buf: OptimizedBuffer): void {
    this.frames++;
    const w = this.width;
    const h = this.height;
    const rows = this.rows(w, h);
    buf.fillRect(0, 0, w, h, paintOf({}, this.mode).bg);
    rows.slice(0, h).forEach((row, y) => {
      let x = 0;
      for (const span of row) {
        if (x >= w) break;
        x = drawText(buf, span.text, x, y, paintOf(span, this.mode));
      }
    });
  }
}
