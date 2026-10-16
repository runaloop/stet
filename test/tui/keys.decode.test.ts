import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { KeyReader } from "../../src/tui/keys/input.ts";
import { RU } from "../../src/ui/keys/layouts.ts";
import { rowFor, type Reader } from "../../src/ui/keys/match.ts";
import { tokens } from "../../src/ui/keys/names.ts";
import { KEYS, TUI_SCOPES, type KeyRow, type Scope } from "../../src/ui/keys/table.ts";
import { needOf } from "../../src/ui/keys/terminal.ts";

/**
 * Every key a terminal row binds, as the bytes a terminal sends it in: legacy, xterm's modifyOtherKeys 2 and the
 * kitty protocol at the flags the terminal UI asks for (1|4: Enter, Tab and plain text stay as they are). The bytes
 * go through OpenTUI's own parsing and the UI's reader, as typed keys do; the keys a protocol cannot carry must
 * arrive as what terminal.ts says, and the row's stand-in must reach the same action.
 */
type Proto = "legacy" | "mok" | "kitty";
const PROTOS: Proto[] = ["legacy", "mok", "kitty"];

const NAMED: Record<string, { legacy: string; kitty?: string; code: number }> = {
  CR: { legacy: "\r", code: 13 },
  Tab: { legacy: "\t", code: 9 },
  BS: { legacy: "\x7f", code: 127 },
  Space: { legacy: " ", code: 32 },
  Esc: { legacy: "\x1b", kitty: "\x1b[27u", code: 27 },
  Up: { legacy: "\x1b[A", code: 0 },
  Down: { legacy: "\x1b[B", code: 0 },
  Right: { legacy: "\x1b[C", code: 0 },
  Left: { legacy: "\x1b[D", code: 0 },
  Home: { legacy: "\x1b[H", code: 0 },
  End: { legacy: "\x1b[F", code: 0 },
  PageUp: { legacy: "\x1b[5~", code: 0 },
  PageDown: { legacy: "\x1b[6~", code: 0 },
  F3: { legacy: "\x1bOR", kitty: "\x1b[13~", code: 0 },
};

/** The Russian character on the key of each US character, Shift included. */
const RU_OF = new Map(Object.entries(RU.keys).map(([ch, us]) => [us, ch]));

/** The bytes of one key token, by the US layout, or by the Russian one where `ru` and the key types a letter there. */
function encode(token: string, proto: Proto, ru = false): string {
  const m = /^<((?:[CSAD]-)*)([^>]+)>$/.exec(token);
  const mods = m ? m[1]!.split("-").filter(Boolean) : [];
  const key = m ? m[2]! : token;
  const ctrl = mods.includes("C");
  const shift = mods.includes("S");
  const mod = 1 + (shift ? 1 : 0) + (mods.includes("A") ? 2 : 0) + (ctrl ? 4 : 0);
  const named = NAMED[key];
  if (named) {
    if (mod === 1) return proto === "kitty" ? (named.kitty ?? named.legacy) : named.legacy;
    if (key === "Tab" && mod === 2) return proto === "kitty" ? "\x1b[9;2u" : "\x1b[Z";
    if (key === "F3") return proto === "kitty" ? `\x1b[13;${mod}~` : `\x1b[1;${mod}R`;
    if (proto === "legacy") return named.legacy;
    return proto === "mok" ? `\x1b[27;${mod};${named.code}~` : `\x1b[${named.code};${mod}u`;
  }
  if (!ctrl) return (ru && RU_OF.get(key)) || key;
  const cyr = ru ? RU_OF.get(key.toLowerCase()) : undefined;
  const code = key.toLowerCase().charCodeAt(0);
  if (proto === "legacy") return String.fromCharCode(code & 0x1f);
  if (proto === "mok") return `\x1b[27;${mod};${(shift ? key.toUpperCase() : key).charCodeAt(0)}~`;
  const base = cyr ? `${cyr.codePointAt(0)}::${code}` : shift ? `${code}:${key.toUpperCase().charCodeAt(0)}` : `${code}`;
  return `\x1b[${base};${mod}u`;
}

/** Keys a protocol cannot carry: legacy loses what needs anything but Shift+Tab; OpenTUI reads Shift+F3 as a cursor report outside kitty. */
function lost(token: string, proto: Proto): boolean {
  const n = needOf(token);
  if (!n || proto === "kitty") return false;
  return proto === "legacy" ? n.need !== "backtab" : n.need === "f3-mods";
}

let setup: TestRendererSetup;
const reader = new KeyReader();
let got: string[] = [];

beforeAll(async () => {
  setup = await createTestRenderer({ width: 40, height: 6 });
  setup.renderer.keyInput.on("keypress", (k: KeyEvent) => {
    const t = reader.token(k);
    if (t !== null) got.push(t);
  });
});

afterAll(() => setup.renderer.destroy());

async function decode(bytes: string[]): Promise<string[]> {
  got = [];
  for (const b of bytes) {
    setup.renderer.stdin.emit("data", Buffer.from(b));
    // a lone Esc is told from the start of a sequence by a pause
    if (b === "\x1b") await Bun.sleep(40);
  }
  await Bun.sleep(0);
  return got;
}

const BOXES = new Set<Scope>(["composer", "choice", "help", "picker", "search"]);
const everything: Reader = { ui: "tui", has: () => true };
const scopesOf = (r: KeyRow): Scope[] => (BOXES.has(r.scope) || r.scope === "global" ? [r.scope] : [r.scope, "global"]);
const reaches = (keys: string, r: KeyRow): boolean => {
  const to = rowFor(KEYS, keys, scopesOf(r), everything);
  return to !== null && (to.id === r.id || (to.before ?? []).some((s) => s.run === r.id));
};

const rows = KEYS.filter((r) => r.ui !== "web" && TUI_SCOPES.has(r.scope));

describe("keys through the terminal UI's decoder", () => {
  for (const proto of PROTOS) {
    test(`${proto}: every key arrives as itself and reaches its row's action, or arrives as terminal.ts says and its stand-in does`, async () => {
      const wrong: string[] = [];
      let checked = 0;
      for (const r of rows) {
        for (const keys of [...r.keys, ...(r.fallback ?? [])]) {
          const ts = tokens(keys);
          const gone = ts.filter((t) => lost(t, proto));
          const arrived = await decode(ts.map((t) => encode(t, proto)));
          if (gone.length === 0) {
            checked++;
            if (arrived.join("") !== keys) wrong.push(`${r.scope} ${keys}: got ${arrived.join(" ")}`);
            else if (!reaches(keys, r)) wrong.push(`${r.scope} ${keys}: reaches ${rowFor(KEYS, keys, scopesOf(r), everything)?.id}`);
            continue;
          }
          const instead = ts.map((t) => (lost(t, proto) ? needOf(t)!.arrives : t)).filter((t): t is string => t !== null);
          if (arrived.join(" ") !== instead.join(" ")) wrong.push(`${r.scope} ${keys} is lost in ${proto}: got ${arrived.join(" ")}, terminal.ts says ${instead.join(" ")}`);
          const stand = [...r.keys, ...(r.fallback ?? [])].filter((k) => k !== keys && tokens(k).every((t) => !lost(t, proto)) && reaches(k, r));
          if (stand.length === 0) wrong.push(`${r.scope} ${keys}: no stand-in in ${proto}`);
          for (const s of stand) if ((await decode(tokens(s).map((t) => encode(t, proto)))).join("") !== s) wrong.push(`${r.scope} ${keys}: stand-in ${s} does not arrive in ${proto}`);
        }
      }
      expect(wrong).toEqual([]);
      expect(checked).toBeGreaterThan(150);
    });
  }

  test("a Russian layout: plain keys arrive as Cyrillic text in every protocol, Ctrl with the kitty base key, and come back as the US keys", async () => {
    const wrong: string[] = [];
    const single = [...new Set(rows.flatMap((r) => r.keys.flatMap(tokens)))].filter((t) => /^[a-zA-Z[\]{}]$/.test(t));
    for (const proto of PROTOS) {
      for (const t of single) {
        const arrived = await decode([encode(t, proto, true)]);
        if (arrived.join("") !== t) wrong.push(`${proto} ${t}: ${JSON.stringify(encode(t, proto, true))} → ${arrived.join(" ")}`);
      }
    }
    for (const t of ["<C-d>", "<C-u>", "<C-s>", "<C-g>", "<C-w>"]) {
      const arrived = await decode([encode(t, "kitty", true)]);
      if (arrived.join("") !== t) wrong.push(`kitty ru ${t}: ${arrived.join(" ")}`);
    }
    expect(wrong).toEqual([]);
    expect(single.length).toBeGreaterThan(30);
  });
});
