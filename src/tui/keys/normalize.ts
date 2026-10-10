/**
 * One key → one Vim-notation token, the same way for a browser KeyboardEvent and a terminal key.
 * Rules: an ASCII key wins; a non-ASCII key goes by `code` (web) or the base-layout key (kitty), else by the layout
 * table; Ctrl/Alt/Super take the physical letter; the base key is never used for an ASCII key (Dvorak, Colemak).
 */
import { LAYOUTS, tableFor, type Layout } from "./layouts.ts";

export const SHIFT = 1;
export const ALT = 2;
export const CTRL = 4;
export const SUPER = 8;

export interface KeyInput {
  key: string;
  /** KeyboardEvent.code (web only) */
  code?: string;
  /** kitty base-layout key */
  base?: string;
  /** SHIFT | ALT | CTRL | SUPER bits */
  mods: number;
  /** terminal only: Shift was held and `key` is the unshifted character */
  shiftPending?: boolean;
}

export interface NormalizeContext {
  /** a layout that types `.`/`,` on the US `/` key is known to be active */
  slashLayout?: boolean;
  table?: Record<string, string>;
}

const NAMED: Record<string, string> = {
  Enter: "CR", Escape: "Esc", Tab: "Tab", Backspace: "BS", Delete: "Del", Insert: "Insert",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", " ": "Space",
};

const US_SHIFT: Record<string, string> = {
  "`": "~", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
  "-": "_", "=": "+", "[": "{", "]": "}", "\\": "|", ";": ":", "'": '"', ",": "<", ".": ">", "/": "?",
};
const CODE_US: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
};

const DEFAULT_TABLE = tableFor();
const isAscii = (s: string) => s.length === 1 && s.charCodeAt(0) < 0x80;
const shifted = (us: string, shift: boolean) => (!shift ? us : /[a-z]/.test(us) ? us.toUpperCase() : (US_SHIFT[us] ?? us));

/** The US character of the physical key, Shift applied; null when nothing tells it. */
function physical(k: KeyInput, table: Record<string, string>): string | null {
  const shift = (k.mods & SHIFT) !== 0;
  const code = k.code ?? "";
  if (/^Key[A-Z]$/.test(code)) return shifted(code.slice(3).toLowerCase(), shift);
  if (/^Digit[0-9]$/.test(code)) return shifted(code.slice(5), shift);
  if (CODE_US[code]) return shifted(CODE_US[code]!, shift);
  if (k.base && isAscii(k.base)) return shifted(k.base, shift);
  return table[k.key] ?? null;
}

export function normalize(k: KeyInput, ctx: NormalizeContext = {}): string | null {
  const table = ctx.table ?? DEFAULT_TABLE;
  const mods = k.mods;
  const named = NAMED[k.key] ?? (/^F\d{1,2}$/.test(k.key) ? k.key : null);
  const pre = (shift: boolean) =>
    (mods & CTRL ? "C-" : "") + (shift ? "S-" : "") + (mods & ALT ? "A-" : "") + (mods & SUPER ? "D-" : "");
  if (named) {
    const p = pre((mods & SHIFT) !== 0);
    return p || named.length > 1 ? `<${p}${named}>` : named;
  }
  if ([...k.key].length !== 1) return null;

  let ch = k.key;
  if (!isAscii(ch)) {
    const phys = physical(k, table);
    if (!phys) return mods & (CTRL | ALT | SUPER) ? null : ch;
    ch = phys;
  } else if (!(mods & (CTRL | ALT | SUPER))) {
    const slashKey = ctx.slashLayout || k.base === "/" || k.code === "Slash";
    if (k.shiftPending && mods & SHIFT) ch = slashKey && ch === "." ? "?" : (US_SHIFT[ch] ?? ch);
    else if (slashKey && (ch === "." || ch === ",")) ch = ch === "." ? "/" : "?";
  }

  if (mods & (CTRL | ALT | SUPER)) {
    const letter = /^[a-zA-Z]$/.test(ch);
    return `<${pre(letter && ((mods & SHIFT) !== 0 || ch !== ch.toLowerCase()))}${letter ? ch.toLowerCase() : ch}>`;
  }
  return ch === "<" ? "<lt>" : ch;
}

/** Tracks whether a layout that types `.`/`,` on the `/` key is active, from the letters the user types. */
export class LayoutGuess {
  slashLayout = false;
  constructor(private layouts?: Layout[]) {}
  see(k: KeyInput): void {
    if (k.mods & (CTRL | ALT | SUPER)) return;
    if (!/^\p{L}$/u.test(k.key)) return;
    this.slashLayout = !isAscii(k.key) && (this.layouts ?? LAYOUTS).some((l) => l.slashKey && k.key in l.keys);
  }
}
