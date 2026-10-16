/** A key sequence in Vim notation as its keys: `]t` → `]`, `t`; `<Space>ff` → `<Space>`, `f`, `f`. */
export function tokens(keys: string): string[] {
  return keys.match(/<[^>]+>|./g) ?? [];
}

const NAMED: Record<string, string> = {
  "<CR>": "Enter", "<Space>": "Space", "<Esc>": "Esc", "<Down>": "↓", "<Up>": "↑", "<Left>": "←", "<Right>": "→", "<Tab>": "Tab",
  "<lt>": "<", "<BS>": "Backspace", "<PageDown>": "PgDn", "<PageUp>": "PgUp", "<Home>": "Home", "<End>": "End",
};
const MODS: Record<string, string> = { C: "Ctrl", S: "Shift", A: "Alt", D: "Super" };

/** How a key looks in a terminal's footer and help: `<C-d>` as `Ctrl+D`, `<S-CR>` as `Shift+Enter`, `]t` as `] t`. */
export function keyLabel(keys: string): string {
  return tokens(keys)
    .map((t) => {
      if (NAMED[t]) return NAMED[t];
      const m = /^<((?:[CSAD]-)+)(.+)>$/.exec(t);
      if (!m) return t.replace(/^<(.*)>$/, "$1");
      const mods = m[1]!.split("-").filter(Boolean).map((x) => MODS[x]!);
      const key = NAMED[`<${m[2]}>`] ?? (m[2]!.length === 1 ? m[2]!.toUpperCase() : m[2]!);
      return [...mods, key].join("+");
    })
    .join(" ");
}
