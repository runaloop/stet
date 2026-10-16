/**
 * What a terminal does to keys. A browser delivers every key the table has; a terminal loses some on the way and keeps
 * some for itself, so each of those has a stand-in the terminal surely delivers (`fallback` in the table).
 */
import type { KeyRow } from "./table.ts";

/**
 * What a key needs to arrive as itself. Without the kitty keyboard protocol a terminal sends Enter with Shift or Ctrl
 * as plain Enter, Ctrl+I as Tab, Ctrl+J as a line feed and Ctrl+Shift+letter as Ctrl+letter; the terminal UI's input
 * reads Shift+F3 there as a reply to its cursor probe; a few old terminals send Shift+Tab as Tab.
 */
export type Need = "mods-on-enter" | "ctrl-apart" | "ctrl-shift" | "f3-mods" | "backtab";

export interface Terminal {
  /** The kitty keyboard protocol is on: every key arrives as itself. */
  kitty: boolean;
  /** Lower case: `orca`, `kitty`, `wezterm`, … ; null when it does not say. */
  name: string | null;
  tmux: boolean;
}

/** Keys a terminal keeps for itself, by its name. */
export const TAKEN: Readonly<Record<string, { keys: readonly string[]; why: string }>> = {
  orca: { keys: ["<C-f>"], why: "Orca opens its terminal search on it" },
};

/** Ctrl+letters a terminal sends as the byte of another key, and the key that byte reads as. */
const CTRL_AS: Record<string, string> = { "<C-i>": "<Tab>", "<C-j>": "<CR>", "<C-m>": "<CR>", "<C-h>": "<BS>" };

/** What a key needs, and what arrives without it (null: nothing arrives). */
export function needOf(key: string): { need: Need; arrives: string | null } | null {
  if (/^<(?:[CSAD]-)+CR>$/.test(key)) return { need: "mods-on-enter", arrives: "<CR>" };
  if (CTRL_AS[key]) return { need: "ctrl-apart", arrives: CTRL_AS[key]! };
  const cs = /^<C-S-([a-z])>$/.exec(key);
  if (cs) return { need: "ctrl-shift", arrives: `<C-${cs[1]}>` };
  if (/^<(?:[CSAD]-)+F3>$/.test(key)) return { need: "f3-mods", arrives: null };
  if (key === "<S-Tab>") return { need: "backtab", arrives: "<Tab>" };
  return null;
}

/** A key some terminal may not deliver as itself: it needs something, or a known terminal keeps it. */
export function risky(key: string): boolean {
  return needOf(key) !== null || Object.values(TAKEN).some((t) => t.keys.includes(key));
}

function has(need: Need, term: Terminal): boolean {
  return term.kitty || need === "backtab";
}

export function takenBy(key: string, term: Terminal): string | null {
  const t = term.name ? TAKEN[term.name] : undefined;
  return t?.keys.includes(key) ? t.why : null;
}

/** Whether a key reaches the UI as itself in this terminal. */
export function arrives(key: string, term: Terminal): boolean {
  const n = needOf(key);
  return (!n || has(n.need, term)) && takenBy(key, term) === null;
}

/** A row's keys that work in this terminal, its stand-ins after them for the keys that do not. */
export function workingKeys(row: KeyRow, term: Terminal): string[] {
  const own = row.keys.filter((k) => arrives(k, term));
  const lost = row.keys.length > own.length;
  const extra = lost ? (row.fallback ?? []).filter((k) => arrives(k, term) && !own.includes(k)) : [];
  return [...own, ...extra];
}

/** The risky keys of these rows that reach this terminal as `token` instead, each with the key to use. */
export function arrivingAs(token: string, rows: readonly KeyRow[], term: Terminal): { key: string; row: KeyRow; use: string | null }[] {
  const out: { key: string; row: KeyRow; use: string | null }[] = [];
  for (const row of rows) {
    for (const key of row.keys) {
      const n = needOf(key);
      if (!n || has(n.need, term) || n.arrives !== token) continue;
      out.push({ key, row, use: workingKeys(row, term)[0] ?? null });
    }
  }
  return out;
}

/** Which terminal this is, from its environment and what it answered at start. */
export function terminalOf(env: Readonly<Record<string, string | undefined>>, kitty: boolean, answered: string | null = null): Terminal {
  const program = env.TERM_PROGRAM && !/^(tmux|screen)$/i.test(env.TERM_PROGRAM) ? env.TERM_PROGRAM.toLowerCase() : null;
  const orca = Object.keys(env).some((k) => k.startsWith("ORCA_"));
  const name = orca ? "orca" : (program ?? answered?.toLowerCase().match(/^[a-z][\w.-]*/)?.[0] ?? null);
  return { kitty, name, tmux: !!env.TMUX };
}
