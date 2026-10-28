import type { Next, Reader } from "../../ui/keys/match.ts";
import { KEYS, type KeyRow, type Scope } from "../../ui/keys/table.ts";

/**
 * Rows of the shared table the terminal lists in its menus without running them yet: `browser` opens the same place
 * in the browser, `later` is greyed.
 */
export const OFF: Readonly<Record<string, "browser" | "later">> = {
  "search.keys": "later",
  "git.state": "later",
  "git.link": "later",
  "search.files": "browser",
  "search.word": "browser",
  "git.commits": "browser",
  "git.blame": "browser",
};

/** The terminal's places, by the name of the column or box that has the focus. */
export const SCOPE = {
  list: "round.list",
  files: "round.files",
  search: "round.search",
  code: "round.code",
  conv: "round.conv",
  thread: "round.thread",
  tcode: "code",
  drafts: "drafts",
  changes: "changes",
  cfiles: "changes.files",
  composer: "composer",
  choice: "choice",
  picker: "picker",
  help: "help",
} as const satisfies Record<string, Scope>;

export interface MenuEntry {
  key: string;
  desc: string;
  off?: "browser" | "later";
}

export const tuiReader = (ids: ReadonlySet<string>): Reader => ({ ui: "tui", has: (id) => ids.has(id) });

/** What the Space menu and the footer say about the keys that may come next. */
export function menuEntries(next: readonly Next[]): MenuEntry[] {
  return next.map((n) => {
    const off = n.row ? OFF[n.row.id] : undefined;
    return { key: n.key, desc: n.row ? (n.row.short ?? n.row.desc) : n.desc, ...(off ? { off } : {}) };
  });
}

/** The terminal's own row for an id where it has one, else the shared one: its words. */
export const rowOf = (id: string): KeyRow | undefined => KEYS.find((r) => r.id === id && r.ui === "tui") ?? KEYS.find((r) => r.id === id && r.ui !== "web");
