/**
 * Colours as the terminal can show them: 24-bit where it says so, else the nearest of the 256-colour palette, which
 * every terminal that runs the TUI has. `STET_TUI_COLORS=truecolor|256` overrides the guess.
 */
export type ColorMode = "truecolor" | "256";

/** Terminals that take 24-bit colours without saying so in COLORTERM. */
const TRUECOLOR_TERMS = /^(xterm-kitty|xterm-ghostty|wezterm|alacritty|foot|contour|iterm2?)|truecolor|24bit|-direct/;

export function colorMode(env: Record<string, string | undefined> = process.env): ColorMode {
  const forced = env.STET_TUI_COLORS;
  if (forced === "truecolor" || forced === "24bit") return "truecolor";
  if (forced === "256") return "256";
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "truecolor";
  if (env.TERM_PROGRAM === "Apple_Terminal") return "256";
  return TRUECOLOR_TERMS.test(env.TERM ?? "") ? "truecolor" : "256";
}

export function rgbOf(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

export function hexOf(r: number, g: number, b: number): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** `fg` laid over `bg` with opacity `a`, as a theme's translucent colour looks on our background. */
export function blend(fg: string, bg: string, a: number): string {
  const x = rgbOf(fg);
  const y = rgbOf(bg);
  return hexOf(x[0] * a + y[0] * (1 - a), x[1] * a + y[1] * (1 - a), x[2] * a + y[2] * (1 - a));
}

const LEVELS = [0, 95, 135, 175, 215, 255];

const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
const dist = (a: readonly number[], b: readonly number[]) => (a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2;

const indexes = new Map<string, number>();

/** The xterm 256-colour index nearest to `hex`: from the 6×6×6 cube or the 24 greys, whichever is closer. */
export function nearest256(hex: string): number {
  let hit = indexes.get(hex);
  if (hit !== undefined) return hit;
  const c = rgbOf(hex);
  const q = c.map(level);
  const cube = q.map((i) => LEVELS[i]!);
  const avg = (c[0] + c[1] + c[2]) / 3;
  const g = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const grey = 8 + g * 10;
  hit = dist(c, cube) <= dist(c, [grey, grey, grey]) ? 16 + 36 * q[0]! + 6 * q[1]! + q[2]! : 232 + g;
  indexes.set(hex, hit);
  return hit;
}
