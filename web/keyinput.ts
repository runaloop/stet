import { rowFor, runRow, type Actions } from "../src/ui/keys/match.ts";
import { CTRL, normalize, SHIFT } from "../src/ui/keys/normalize.ts";
import { KEYS, type Scope } from "../src/ui/keys/table.ts";

/** Keys that read the same with Shift held. */
const SHIFT_IGNORED = new Set([" ", "Escape", "ArrowDown", "ArrowUp"]);

/** A browser key as a token of the key table, by the physical key (a Russian layout works); Cmd counts as Ctrl. */
export function keyToken(e: KeyboardEvent): string | null {
  if (e.altKey) return null;
  const mods = (e.shiftKey && !SHIFT_IGNORED.has(e.key) ? SHIFT : 0) | (e.ctrlKey || e.metaKey ? CTRL : 0);
  return normalize({ key: e.key, code: e.code || undefined, mods });
}

/**
 * A key in a box with its own place in the table (the reply box, a finder, the search box, a question, blame): runs
 * what that place binds it to, with the box's own actions. In a text field a key that types a character types it.
 */
export function boxKey(e: KeyboardEvent, scope: Scope, own: Actions, field: boolean, conditions: Readonly<Record<string, () => boolean>> = {}): boolean {
  const t = keyToken(e);
  if (t === null || (field && ([...t].length === 1 || t === "<Space>" || t === "<lt>"))) return false;
  const row = rowFor(KEYS, t, [scope], { ui: "web", has: (id) => id in own });
  if (!row || !runRow(row, 1, own, conditions)) return false;
  e.preventDefault();
  return true;
}
