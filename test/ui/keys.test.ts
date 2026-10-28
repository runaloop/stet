import { describe, expect, test } from "bun:test";
import { LAYOUTS, RU, UK } from "../../src/ui/keys/layouts.ts";
import { KeyMatcher, rowFor, rowsIn, runRow, type Reader } from "../../src/ui/keys/match.ts";
import { keyLabel, tokens } from "../../src/ui/keys/names.ts";
import { CTRL, LayoutGuess, normalize, SHIFT } from "../../src/ui/keys/normalize.ts";
import { KEYS, LEADER_GROUPS, type KeyRow, type Scope } from "../../src/ui/keys/table.ts";
import { arrives, arrivingAs, needOf, risky, terminalOf, workingKeys, type Terminal } from "../../src/ui/keys/terminal.ts";

const SCOPES: Scope[] = ["global", "changes", "drafts", "composer", "choice", "picker", "search", "help", "guide", "thread", "code", "blame", "round.list", "round.files", "round.search", "round.code", "round.conv", "round.thread", "changes.files"];
const NAMED = new Set(["CR", "Esc", "Tab", "BS", "Del", "Insert", "Space", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "lt", ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
const WEB_ONLY = new Set<Scope>(["guide", "thread", "blame"]);
const everything = (ui: "web" | "tui"): Reader => ({ ui, has: () => true });
const legacy: Terminal = { kitty: false, name: null, tmux: false };
const orca: Terminal = { kitty: false, name: "orca", tmux: false };

/** One spelling: modifiers in the order C, S, A, D; a letter with Ctrl in lower case; named keys from Vim's list. */
function spelledRight(token: string): boolean {
  if (!token.startsWith("<")) return [...token].length === 1;
  const m = /^<((?:[CSAD]-)*)([^>]+)>$/.exec(token);
  if (!m) return false;
  const mods = m[1]!.split("-").filter(Boolean);
  const order = "CSAD";
  if (mods.some((x, i) => i > 0 && order.indexOf(x) <= order.indexOf(mods[i - 1]!))) return false;
  if (mods.length === 0) return NAMED.has(m[2]!);
  return NAMED.has(m[2]!) || /^[a-z0-9[\]/\\;',.`=-]$/.test(m[2]!);
}

describe("the key table", () => {
  test("every row has an id, a known scope, a description and keys in one spelling", () => {
    const wrong: string[] = [];
    for (const r of KEYS) {
      if (!/^[a-z]+(\.[a-zA-Z]+)?$/.test(r.id)) wrong.push(`id ${JSON.stringify(r.id)}`);
      if (!SCOPES.includes(r.scope)) wrong.push(`${r.id}: scope ${r.scope}`);
      if (!r.desc.trim()) wrong.push(`${r.id}: no desc`);
      if (r.keys.length === 0) wrong.push(`${r.id}: no keys`);
      for (const k of [...r.keys, ...(r.fallback ?? [])]) for (const t of tokens(k)) if (!spelledRight(t)) wrong.push(`${r.id}: ${k}`);
    }
    expect(wrong).toEqual([]);
  });

  test("within a place each UI binds a key once", () => {
    const twice: string[] = [];
    for (const ui of ["web", "tui"] as const) {
      for (const scope of SCOPES) {
        const seen = new Map<string, string>();
        for (const r of KEYS.filter((x) => x.scope === scope && (!x.ui || x.ui === ui))) {
          for (const k of r.keys) {
            if (seen.has(k)) twice.push(`${ui} ${scope} ${k}: ${seen.get(k)} and ${r.id}`);
            seen.set(k, r.id);
          }
        }
      }
    }
    expect(twice).toEqual([]);
  });

  test("every risky key a terminal reads has a stand-in that is not risky and does the same thing in the same place", () => {
    const wrong: string[] = [];
    for (const r of KEYS.filter((x) => x.ui !== "web" && !WEB_ONLY.has(x.scope))) {
      for (const k of r.keys.filter(risky)) {
        const safe = [...r.keys, ...(r.fallback ?? [])].filter((f) => f !== k && !risky(f));
        const same = safe.filter((f) => {
          const to = rowFor(KEYS, f, [r.scope, "global"], everything(r.ui ?? "tui"));
          return to !== null && (to.id === r.id || (to.before ?? []).some((s) => s.run === r.id));
        });
        if (same.length === 0) wrong.push(`${r.scope} ${k} (${r.id})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("the risky keys are the ones a terminal loses or keeps", () => {
    const bound = [...new Set(KEYS.flatMap((r) => r.keys))].filter(risky).sort();
    expect(bound).toEqual(["<C-CR>", "<C-S-CR>", "<C-f>", "<C-i>", "<C-j>", "<S-CR>", "<S-F3>", "<S-Tab>"]);
    expect(needOf("<C-S-CR>")).toEqual({ need: "mods-on-enter", arrives: "<CR>" });
    expect(needOf("<C-i>")).toEqual({ need: "ctrl-apart", arrives: "<Tab>" });
    expect(needOf("<S-F3>")).toEqual({ need: "f3-mods", arrives: null });
    expect(needOf("<C-d>")).toBeNull();
  });

  test("which key works in this terminal: the row's own where it arrives, its stand-in where it does not", () => {
    const row = (id: string, scope: Scope) => KEYS.find((r) => r.id === id && r.scope === scope)!;
    const kitty: Terminal = { kitty: true, name: "kitty", tmux: false };
    expect(workingKeys(row("composer.now", "composer"), kitty)).toEqual(["<C-S-CR>"]);
    expect(workingKeys(row("composer.now", "composer"), legacy)).toEqual(["<C-g>"]);
    expect(workingKeys(row("composer.draft", "composer"), legacy)).toEqual(["<C-s>"]);
    expect(workingKeys(row("picker.from", "picker"), legacy)).toEqual(["<C-f>", "<C-r>"]);
    expect(workingKeys(row("picker.from", "picker"), orca)).toEqual(["<C-r>"]);
    expect(workingKeys(row("jump.forward", "global"), legacy)).toEqual(["]j"]);
    expect(arrives("<C-f>", orca)).toBe(false);
    expect(arrives("<C-f>", legacy)).toBe(true);
    const enter = arrivingAs("<CR>", KEYS.filter((r) => r.scope === "composer"), legacy);
    expect(enter.map((x) => [x.key, x.row.id, x.use])).toEqual([
      ["<C-CR>", "composer.draft", "<C-s>"],
      ["<C-S-CR>", "composer.now", "<C-g>"],
    ]);
    expect(arrivingAs("<CR>", KEYS, { ...legacy, kitty: true })).toEqual([]);
  });

  test("the Changes tab's search and the version finder where Shift+F3 and Enter with modifiers do not arrive", () => {
    const tui: Reader = { ui: "tui", has: () => true };
    const kitty: Terminal = { kitty: true, name: "kitty", tmux: false };
    const prev = KEYS.find((r) => r.id === "match.prev" && r.keys.includes("<S-F3>"))!;
    expect(workingKeys(prev, kitty)).toEqual(["<S-F3>"]);
    expect(workingKeys(prev, legacy)).toEqual(["N"]);
    expect(rowFor(KEYS, "<Space>sN", ["changes", "global"], tui)?.id).toBe("match.prev");
    expect(rowFor(KEYS, "<Space>sn", ["changes", "global"], tui)?.id).toBe("match.next");
    expect(rowFor(KEYS, "<Space>sN", ["changes", "global"], everything("web"))).toBeNull();
    const ran: string[] = [];
    const actions = { "match.prev": () => void ran.push("match"), "unread.prev": () => void ran.push("unread") };
    runRow(rowFor(KEYS, "N", ["changes"], tui)!, 1, actions, { searching: () => true });
    expect(ran).toEqual(["match"]);
    const picker = (id: string) => KEYS.find((r) => r.id === id && r.scope === "picker")!;
    expect(workingKeys(picker("picker.to"), legacy)).toEqual(["<C-t>"]);
    expect(workingKeys(picker("picker.to"), kitty)).toEqual(["<C-CR>"]);
    expect(workingKeys(picker("picker.down"), legacy)).toEqual(["<Down>", "<C-n>"]);
  });

  test("the terminal's name comes from its environment, else from its answer", () => {
    expect(terminalOf({ TERM_PROGRAM: "Orca", ORCA_IMAGE_PROTOCOL: "kitty" }, true).name).toBe("orca");
    expect(terminalOf({ TERM_PROGRAM: "tmux", TMUX: "/tmp/tmux-1/default,1,0" }, false, "xterm.js(6.1.0)")).toEqual({ kitty: false, name: "xterm.js", tmux: true });
    expect(terminalOf({ TERM_PROGRAM: "WezTerm" }, true).name).toBe("wezterm");
  });

  test("Space groups have names and every group has keys", () => {
    for (const g of Object.keys(LEADER_GROUPS)) expect(KEYS.some((r) => r.keys.some((k) => k.startsWith(g) && tokens(k).length > 2))).toBe(true);
  });

  test("labels", () => {
    expect(keyLabel("<C-d>")).toBe("Ctrl+D");
    expect(keyLabel("<C-S-CR>")).toBe("Ctrl+Shift+Enter");
    expect(keyLabel("<S-F3>")).toBe("Shift+F3");
    expect(keyLabel("<S-Tab>")).toBe("Shift+Tab");
    expect(keyLabel("]t")).toBe("] t");
    expect(keyLabel("<Space>ff")).toBe("Space f f");
  });
});

describe("matching", () => {
  const web: Reader = { ui: "web", has: () => true };

  test("the first place wins, a sequence waits, Esc forgets it", () => {
    const fired: string[] = [];
    const m = new KeyMatcher(() => KEYS, web, (r) => fired.push(r.id), 10_000);
    expect(m.feed("j", ["thread", "global"])).toEqual({ fire: KEYS.find((r) => r.id === "thread.next")! });
    expect(m.feed("g", ["changes", "global"])).toEqual({ pending: true });
    expect("fire" in m.feed("g", ["changes", "global"]) ? "fired" : "no").toBe("fired");
    expect(m.feed("<Space>", ["changes", "global"])).toEqual({ pending: true });
    expect(m.next(["changes", "global"]).find((x) => x.key === "f")?.desc).toBe("+find");
    expect(m.feed("<Esc>", ["changes", "global"])).toEqual({ pending: true });
    expect(m.prefix).toEqual([]);
    m.reset();
    expect(fired).toEqual([]);
  });

  test("a key fires after the timeout when it also starts a longer one", async () => {
    const fired: string[] = [];
    const m = new KeyMatcher(() => KEYS, web, (r) => fired.push(r.id), 5);
    expect(m.feed("g", ["changes", "global"])).toEqual({ pending: true });
    expect(m.feed("c", ["changes", "global"])).toEqual({ pending: true });
    await Bun.sleep(30);
    expect(fired).toEqual(["comment.start"]);
  });

  test("visual mode leaves out the rows that do not work in it", () => {
    const here = rowsIn(KEYS, ["changes", "global"], web, "visual").map((c) => c.keys);
    expect(here).toContain("j");
    expect(here).toContain("o");
    expect(here).not.toContain("]t");
    expect(here).not.toContain("n");
  });

  test("a UI reads only the rows it has an action for, and its own", () => {
    const tui: Reader = { ui: "tui", has: (id) => id === "unread.next" || id === "diff.enter" };
    expect(rowFor(KEYS, "n", ["changes"], tui)?.id).toBe("unread.next");
    expect(rowFor(KEYS, "<CR>", ["changes"], tui)?.ui).toBe("tui");
    expect(rowFor(KEYS, "o", ["changes"], tui)).toBeNull();
    expect(rowFor(KEYS, "V", ["changes"], tui)).toBeNull();
    expect(rowFor(KEYS, "<C-g>", ["composer"], { ui: "tui", has: () => true })?.id).toBe("composer.now");
    expect(rowFor(KEYS, "<C-g>", ["composer"], web)).toBeNull();
  });

  test("a cascade runs the first step whose condition holds, else the row's own action", () => {
    const n = KEYS.find((r) => r.keys.includes("n") && r.scope === "changes")!;
    const ran: string[] = [];
    const actions = { "match.next": () => void ran.push("match"), "unread.next": () => void ran.push("unread") };
    expect(runRow(n, 1, actions, { searching: () => true })).toBe(true);
    expect(runRow(n, 1, actions, { searching: () => false })).toBe(true);
    expect(runRow(n, 1, { "unread.next": () => false })).toBe(false);
    expect(ran).toEqual(["match", "unread"]);
  });
});

describe("normalize and the ЙЦУКЕН tables", () => {
  const usKeys = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
  const usShift = 'QWERTYUIOP{}ASDFGHJKL:"ZXCVBNM<>';
  const token = (us: string) => (us === "<" ? "<lt>" : us);

  for (const layout of [RU, UK]) {
    test(`${layout.id}: every letter key types a character that comes back as its US key, with and without Shift`, () => {
      const back = new Map(Object.entries(layout.keys).map(([ch, us]) => [us, ch]));
      const wrong: string[] = [];
      for (const [i, us] of [...usKeys].entries()) {
        for (const [key, shift] of [[us, false], [usShift[i]!, true]] as const) {
          const ch = back.get(key);
          if (!ch) {
            wrong.push(`${key}: no character`);
            continue;
          }
          const got = normalize({ key: ch, mods: shift ? SHIFT : 0 }, { table: layout.keys });
          if (got !== token(key)) wrong.push(`${ch} → ${got}, want ${token(key)}`);
        }
      }
      expect(wrong).toEqual([]);
    });

    test(`${layout.id}: Ctrl takes the physical letter; / and ? come from . and , while the layout is known`, () => {
      const ch = (us: string) => Object.entries(layout.keys).find(([, u]) => u === us)![0];
      expect(normalize({ key: ch("d"), mods: CTRL }, { table: layout.keys })).toBe("<C-d>");
      expect(normalize({ key: ch("f"), mods: CTRL }, { table: layout.keys })).toBe("<C-f>");
      const guess = new LayoutGuess([layout]);
      expect(normalize({ key: ".", mods: 0 }, { slashLayout: guess.slashLayout })).toBe(".");
      guess.see({ key: ch("j"), mods: 0 });
      expect(normalize({ key: ".", mods: 0 }, { slashLayout: guess.slashLayout })).toBe("/");
      expect(normalize({ key: ",", mods: SHIFT }, { slashLayout: guess.slashLayout })).toBe("?");
      guess.see({ key: "j", mods: 0 });
      expect(normalize({ key: ".", mods: 0 }, { slashLayout: guess.slashLayout })).toBe(".");
    });
  }

  test("the two layouts differ where Ukrainian has its own letters, and agree elsewhere", () => {
    expect(RU.keys["ы"]).toBe("s");
    expect(UK.keys["і"]).toBe("s");
    expect(UK.keys["ї"]).toBe("]");
    expect(RU.keys["ъ"]).toBe("]");
    expect(UK.keys["є"]).toBe("'");
    expect(RU.keys["э"]).toBe("'");
    for (const ch of Object.keys(RU.keys)) if (ch in UK.keys) expect(`${ch} ${UK.keys[ch]}`).toBe(`${ch} ${RU.keys[ch]}`);
    expect(LAYOUTS.map((l) => l.id)).toEqual(["ru", "uk"]);
  });

  test("an ASCII key wins over the table and over the base key, so Dvorak and Shift+7 on ЙЦУКЕН stay what they type", () => {
    expect(normalize({ key: "?", mods: SHIFT })).toBe("?");
    expect(normalize({ key: "'", code: "KeyQ", mods: 0 })).toBe("'");
    expect(normalize({ key: "о", base: "j", mods: 0 }, { table: {} })).toBe("j");
    expect(normalize({ key: "о", code: "KeyJ", mods: 0 }, { table: {} })).toBe("j");
  });

  test("every single-character key the table binds that a Cyrillic layout moves comes back through both layouts", () => {
    const bound = new Set(KEYS.flatMap((r: KeyRow) => r.keys.flatMap(tokens)).filter((t) => t.length === 1));
    for (const layout of [RU, UK]) {
      const back = new Map(Object.entries(layout.keys).map(([ch, us]) => [us, ch]));
      for (const us of bound) {
        const ch = back.get(us);
        if (!ch) continue;
        expect(`${layout.id} ${us} ${normalize({ key: ch, mods: /[A-Z{}:"<>~|]/.test(us) ? SHIFT : 0 }, { table: layout.keys })}`).toBe(`${layout.id} ${us} ${token(us)}`);
      }
    }
  });
});
