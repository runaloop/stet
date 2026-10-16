import { tokens } from "./names.ts";
import { LEADER_GROUPS, PREFIX_TIMEOUT_MS, type KeyRow, type Mode, type Scope } from "./table.ts";

/** An action a UI registers by id; `false` says it did not apply, so a cascade goes on and the key goes back to the UI. */
export type Action = (count: number) => boolean | void;
export type Actions = Readonly<Record<string, Action>>;

/** Which rows a UI reads: its own and the shared ones it has an action for. */
export interface Reader {
  ui: "web" | "tui";
  has(id: string): boolean;
}

export function reads(row: KeyRow, r: Reader): boolean {
  if (row.ui && row.ui !== r.ui) return false;
  return r.has(row.id) || (row.before ?? []).some((s) => r.has(s.run));
}

/** A row's keys as a UI reads them: a terminal reads its stand-ins for keys it may never get too. */
export const keysOf = (row: KeyRow, r: Reader): string[] => (r.ui === "tui" && row.fallback ? [...row.keys, ...row.fallback.filter((k) => !row.keys.includes(k))] : row.keys);

/**
 * The bindings in these places, the first place's first: a key bound twice does what the first row says. With a mode,
 * rows that do not work in it are left out.
 */
export function rowsIn(rows: readonly KeyRow[], scopes: readonly Scope[], r: Reader, mode?: Mode): { row: KeyRow; keys: string }[] {
  const seen = new Set<string>();
  const out: { row: KeyRow; keys: string }[] = [];
  for (const scope of scopes) {
    for (const row of rows) {
      if (row.scope !== scope || !reads(row, r) || (mode && !(row.modes ?? ["normal"]).includes(mode))) continue;
      for (const keys of keysOf(row, r)) {
        if (seen.has(keys)) continue;
        seen.add(keys);
        out.push({ row, keys });
      }
    }
  }
  return out;
}

/** The row these exact keys run here, if any. */
export function rowFor(rows: readonly KeyRow[], keys: string, scopes: readonly Scope[], r: Reader, mode?: Mode): KeyRow | null {
  return rowsIn(rows, scopes, r, mode).find((c) => c.keys === keys)?.row ?? null;
}

/** Runs a row: its steps whose conditions hold, in order, then its own action; true once one of them did something. */
export function runRow(row: KeyRow, count: number, actions: Actions, conditions: Readonly<Record<string, () => boolean>> = {}): boolean {
  for (const step of row.before ?? []) {
    const act = actions[step.run];
    if (!act || (step.if !== undefined && !conditions[step.if]?.())) continue;
    if (act(count) !== false) return true;
  }
  const act = actions[row.id];
  return act ? act(count) !== false : false;
}

export type Match = { fire: KeyRow } | { pending: true } | { none: true };

export interface Next {
  key: string;
  desc: string;
  /** The row the key runs; none for a group. */
  row?: KeyRow;
}

/** What may come after `prefix` here, for which-key: a key and what it runs, or `+group` when more keys follow. */
export function nextAfter(rows: readonly KeyRow[], prefix: readonly string[], scopes: readonly Scope[], r: Reader, mode?: Mode): Next[] {
  const out = new Map<string, Next>();
  for (const c of rowsIn(rows, scopes, r, mode)) {
    const t = tokens(c.keys);
    if (t.length <= prefix.length || prefix.some((k, i) => t[i] !== k)) continue;
    const key = t[prefix.length]!;
    if (out.has(key)) continue;
    out.set(key, t.length === prefix.length + 1 ? { key, desc: c.row.desc, row: c.row } : { key, desc: `+${LEADER_GROUPS[[...prefix, key].join("")] ?? "more"}` });
  }
  return [...out.values()];
}

/**
 * Key sequences as Vim reads them: a key that starts a longer binding waits for the next one; when it is also a binding
 * of its own, it fires after the prefix timeout unless the next key goes on. Esc forgets the keys typed so far.
 */
export class KeyMatcher {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly rows: () => readonly KeyRow[],
    private readonly reader: Reader,
    private readonly onTimeout: (row: KeyRow) => void,
    private readonly timeoutMs = PREFIX_TIMEOUT_MS,
  ) {}

  get prefix(): readonly string[] {
    return this.buffer;
  }

  /** Backspace in the Space menu: one level up. */
  back(): void {
    this.buffer = this.buffer.slice(0, -1);
    this.stop();
  }

  reset(): void {
    this.buffer = [];
    this.stop();
  }

  feed(token: string, scopes: readonly Scope[], mode?: Mode): Match {
    if (token === "<Esc>" && this.buffer.length > 0) {
      this.reset();
      return { pending: true };
    }
    const prefix = [...this.buffer, token];
    const list = this.candidates(prefix, scopes, mode);
    if (list.length === 0) {
      const had = this.buffer.length > 0;
      this.reset();
      return had ? this.feed(token, scopes, mode) : { none: true };
    }
    const exact = list.find((c) => tokens(c.keys).length === prefix.length);
    const longer = list.some((c) => tokens(c.keys).length > prefix.length);
    if (exact && !longer) {
      this.reset();
      return { fire: exact.row };
    }
    this.buffer = prefix;
    this.stop();
    if (exact)
      this.timer = setTimeout(() => {
        this.reset();
        this.onTimeout(exact.row);
      }, this.timeoutMs);
    return { pending: true };
  }

  /** What may come after the keys typed so far, for which-key. */
  next(scopes: readonly Scope[], mode?: Mode): Next[] {
    return nextAfter(this.rows(), this.buffer, scopes, this.reader, mode);
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private candidates(prefix: readonly string[], scopes: readonly Scope[], mode?: Mode): { row: KeyRow; keys: string }[] {
    return rowsIn(this.rows(), scopes, this.reader, mode).filter((c) => {
      const t = tokens(c.keys);
      return t.length >= prefix.length && prefix.every((k, i) => t[i] === k);
    });
  }
}
