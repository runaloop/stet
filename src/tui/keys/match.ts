import { LEADER_GROUPS, tokens, type KeyRow, type Scope } from "./table.ts";

export type Match = { fire: KeyRow } | { pending: true } | { none: true };

/** A key bound in two scopes does what the first scope says. */
export function rowsIn(rows: readonly KeyRow[], scopes: readonly Scope[]): { row: KeyRow; keys: string }[] {
  const seen = new Set<string>();
  const out: { row: KeyRow; keys: string }[] = [];
  for (const scope of scopes) {
    for (const row of rows) {
      if (row.scope !== scope) continue;
      for (const keys of row.keys) {
        if (seen.has(keys)) continue;
        seen.add(keys);
        out.push({ row, keys });
      }
    }
  }
  return out;
}

/**
 * Key sequences as Vim reads them: a key that starts a longer binding waits for the next one; when it is also a
 * binding of its own, it fires after `timeoutMs` unless the next key goes on.
 */
export class KeyMatcher {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly rows: readonly KeyRow[],
    private readonly onTimeout: (row: KeyRow) => void,
    private readonly timeoutMs = 600,
  ) {}

  get prefix(): readonly string[] {
    return this.buffer;
  }

  /** Backspace in the Space menu: one level up. */
  back(): void {
    this.buffer = this.buffer.slice(0, -1);
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  reset(): void {
    this.buffer = [];
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  feed(token: string, scopes: readonly Scope[]): Match {
    if (token === "<Esc>" && this.buffer.length > 0) {
      this.reset();
      return { pending: true };
    }
    const prefix = [...this.buffer, token];
    const list = this.candidates(prefix, scopes);
    if (list.length === 0) {
      const had = this.buffer.length > 0;
      this.reset();
      return had ? this.feed(token, scopes) : { none: true };
    }
    const exact = list.find((c) => tokens(c.keys).length === prefix.length);
    const longer = list.some((c) => tokens(c.keys).length > prefix.length);
    if (exact && !longer) {
      this.reset();
      return { fire: exact.row };
    }
    this.buffer = prefix;
    clearTimeout(this.timer);
    this.timer = exact
      ? setTimeout(() => {
          this.reset();
          this.onTimeout(exact.row);
        }, this.timeoutMs)
      : undefined;
    return { pending: true };
  }

  /** What may come after the keys typed so far, for the footer. */
  next(scopes: readonly Scope[]): { key: string; desc: string; off?: KeyRow["off"] }[] {
    const out = new Map<string, { desc: string; off?: KeyRow["off"] }>();
    for (const c of this.candidates(this.buffer, scopes)) {
      const t = tokens(c.keys);
      const key = t[this.buffer.length];
      if (key === undefined || out.has(key)) continue;
      out.set(key, t.length === this.buffer.length + 1 ? { desc: c.row.short ?? c.row.desc, ...(c.row.off ? { off: c.row.off } : {}) } : { desc: `+${LEADER_GROUPS[[...this.buffer, key].join("")] ?? "more"}` });
    }
    return [...out.entries()].map(([key, x]) => ({ key, ...x }));
  }

  private candidates(prefix: readonly string[], scopes: readonly Scope[]): { row: KeyRow; keys: string }[] {
    return rowsIn(this.rows, scopes).filter((c) => {
      const t = tokens(c.keys);
      return t.length >= prefix.length && prefix.every((k, i) => t[i] === k);
    });
  }
}
