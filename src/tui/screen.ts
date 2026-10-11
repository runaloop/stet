import { Renderable, RGBA, TextAttributes, type OptimizedBuffer, type RenderContext } from "@opentui/core";
import type { Row } from "./grid.ts";
import { look } from "./style.ts";
import { width, type Cls } from "./text.ts";

interface Paint {
  fg: RGBA;
  bg: RGBA;
  attrs: number;
}

const paints = new Map<string, Paint>();

function paintOf(c: readonly Cls[] | undefined): Paint {
  const k = c?.join(" ") ?? "";
  let p = paints.get(k);
  if (!p) {
    const l = look(c);
    p = {
      fg: RGBA.fromHex(l.fg),
      bg: RGBA.fromHex(l.bg),
      attrs: (l.bold ? TextAttributes.BOLD : 0) | (l.italic ? TextAttributes.ITALIC : 0) | (l.underline ? TextAttributes.UNDERLINE : 0),
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

  constructor(
    ctx: RenderContext,
    private readonly rows: (w: number, h: number) => Row[],
  ) {
    super(ctx, { id: "screen", width: "100%", height: "100%", position: "absolute", left: 0, top: 0, zIndex: 0 });
  }

  protected renderSelf(buf: OptimizedBuffer): void {
    this.frames++;
    const w = this.width;
    const h = this.height;
    const rows = this.rows(w, h);
    buf.fillRect(0, 0, w, h, paintOf(undefined).bg);
    rows.slice(0, h).forEach((row, y) => {
      let x = 0;
      for (const span of row) {
        if (x >= w) break;
        x = drawText(buf, span.text, x, y, paintOf(span.c));
      }
    });
  }
}
