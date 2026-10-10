import type { KeyEvent } from "@opentui/core";
import { ALT, CTRL, LayoutGuess, normalize, SHIFT, SUPER, type KeyInput } from "./normalize.ts";

const NAMES: Record<string, string> = {
  return: "Enter", enter: "Enter", linefeed: "Enter", escape: "Escape", tab: "Tab", backspace: "Backspace", delete: "Delete",
  space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", insert: "Insert",
};

/** OpenTUI's key as `normalize` takes it: the kitty base-layout key, when the terminal sends one, becomes `base`. */
export function keyInput(k: KeyEvent): KeyInput {
  const key =
    NAMES[k.name] ??
    (/^f\d{1,2}$/.test(k.name) ? k.name.toUpperCase() : k.shift && [...k.sequence].length === 1 ? k.sequence : [...k.name].length === 1 ? k.name : k.sequence);
  const mods = (k.shift ? SHIFT : 0) | (k.ctrl ? CTRL : 0) | (k.option || k.meta ? ALT : 0) | (k.super ? SUPER : 0);
  return { key, base: k.baseCode ? String.fromCodePoint(k.baseCode) : undefined, mods };
}

/**
 * Keys as tokens by the physical key, so a Russian layout works: OpenTUI's key events go through `normalize`, which
 * takes the base-layout key from kitty-protocol terminals and the layout table everywhere else. OpenTUI's parser
 * loses Shift+F3 and Alt+Cyrillic in legacy terminals; no key here needs them.
 */
export class KeyReader {
  private readonly guess = new LayoutGuess();

  token(k: KeyEvent): string | null {
    const input = keyInput(k);
    const t = normalize(input, { slashLayout: this.guess.slashLayout });
    this.guess.see(input);
    return t;
  }
}
