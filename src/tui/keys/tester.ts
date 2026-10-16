import { KeyMatcher, keysOf, reads, type Reader } from "../../ui/keys/match.ts";
import { keyLabel } from "../../ui/keys/names.ts";
import { KEYS, PREFIX_TIMEOUT_MS, TUI_SCOPES, type KeyRow, type Scope } from "../../ui/keys/table.ts";
import { arrivingAs, type Terminal } from "../../ui/keys/terminal.ts";

/** What a key pressed in `?` did: the row it reaches here, if any, and a line about it. */
export interface Tried {
  row: KeyRow | null;
  /** The keys pressed, in table spelling. */
  keys: string;
  text: string;
}

/**
 * `?` as the key tester: keys pressed in it run nothing; each goes through the terminal UI's own decoder and matcher
 * and says which row it reaches in the place under the box, and what this terminal sends instead of the keys it
 * loses (Ctrl+Enter as plain Enter).
 */
export class KeyTester {
  private readonly matcher: KeyMatcher;
  private readonly rows: KeyRow[];
  private typed: string[] = [];

  constructor(
    private readonly reader: Reader,
    private readonly term: Terminal,
    private readonly scopes: readonly Scope[],
    onTimeout: (t: Tried) => void,
    timeoutMs = PREFIX_TIMEOUT_MS,
  ) {
    this.rows = KEYS.filter((r) => TUI_SCOPES.has(r.scope) && reads(r, reader));
    this.matcher = new KeyMatcher(() => KEYS, reader, (row) => onTimeout(this.said(this.typed, row)), timeoutMs);
  }

  press(token: string): Tried {
    const had = [...this.matcher.prefix];
    const m = this.matcher.feed(token, this.scopes);
    if ("pending" in m) {
      this.typed = [...this.matcher.prefix];
      return { row: null, keys: this.typed.join(""), text: `got ${keyLabel(this.typed.join(""))} …: longer keys start so, press the next one` };
    }
    const whole = [...had, token];
    this.typed = "fire" in m && keysOf(m.fire, this.reader).includes(whole.join("")) ? whole : [token];
    return this.said(this.typed, "fire" in m ? m.fire : null);
  }

  reset(): void {
    this.matcher.reset();
  }

  private said(typed: string[], row: KeyRow | null): Tried {
    const keys = typed.join("");
    const last = typed[typed.length - 1]!;
    const lost = arrivingAs(last, this.rows, this.term);
    const names = [...new Set(lost.map((x) => keyLabel(x.key)))];
    const uses = [...new Set(lost.flatMap((x) => (x.use ? [`${keyLabel(x.use)} (${x.row.short ?? x.row.desc})`] : [])))];
    const note = names.length ? ` · ${names.join(", ")} ${names.length > 1 ? "are" : "is"} plain ${keyLabel(last)} in this terminal${uses.length ? `, use ${uses.join(", ")}` : ""}` : "";
    return { row, keys, text: `got ${keyLabel(keys)}: ${row ? (row.short ?? row.desc) : "nothing here"}${note}` };
  }
}
