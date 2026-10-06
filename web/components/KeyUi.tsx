import type { ComponentChild } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { compareNav, cursorSpace, fileRows, setCursor, type FileRow } from "../compare.ts";
import { BINDINGS, bindingsHere, contexts, nextKeys, picker, tokens, whichKey, type Binding, type Where } from "../keys.ts";
import { fuzzyFilter, wordFilter } from "../lib/fuzzy.ts";
import type { VersionDto } from "../../src/core/types.ts";
import { onlyVersion, withEnd, type Round } from "../lib/versions.ts";
import { defaultCompare, helpOpen, lastCompare, navigate, notify, reviewedCursor, route, versionRounds, versions } from "../state.ts";
import { ago, Kbd, roundTitle } from "./Bits.tsx";

const shown = (k: string) =>
  k === "<Space>" ? "Space" : k === "<CR>" ? "Enter" : k === "<Esc>" ? "Esc" : k.replace(/^<C-(.)>$/, "Ctrl+$1").replace(/^<S-(.+)>$/, "Shift+$1").replace(/^<(.+)>$/, "$1");

export function keyLabel(keys: string): string {
  return tokens(keys).map(shown).join(" ");
}

const WHERE: Record<Where, string> = { compare: "changes", guide: "guide", thread: "thread", code: "code", drafts: "drafts", everywhere: "everywhere" };

export function WhichKey() {
  const prefix = whichKey.value;
  if (!prefix) return null;
  const options = nextKeys(prefix);
  return (
    <div class="which-key">
      <div class="which-head">
        <Kbd>{keyLabel(prefix.join(""))}</Kbd> <span class="subtle">then…  (Esc cancels · Space s k searches all keys)</span>
      </div>
      <div class="which-grid">
        {options.map((o) => (
          <div class={`which-item${o.desc.startsWith("+") ? " group" : ""}`}>
            <Kbd>{shown(o.key)}</Kbd> <span>{o.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Picker<T>(props: {
  placeholder: string;
  items: T[];
  filter: (items: T[], q: string) => T[];
  row: (t: T) => ComponentChild;
  pick: (t: T) => void;
  hint?: ComponentChild;
  shiftPick?: (t: T) => void;
  ctrlPick?: (t: T) => void;
  limit?: number;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => props.filter(props.items, q).slice(0, props.limit ?? 80), [q, props.items]);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus());
  }, []);
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const close = () => (picker.value = null);
  const choose = (i: number, how: "pick" | "shift" | "ctrl" = "pick") => {
    const t = list[i];
    close();
    if (t === undefined) return;
    if (how === "shift" && props.shiftPick) props.shiftPick(t);
    else if (how === "ctrl" && props.ctrlPick) props.ctrlPick(t);
    else props.pick(t);
  };
  return (
    <div class="overlay" onClick={close}>
      <div class="picker" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          placeholder={props.placeholder}
          value={q}
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            const down = e.key === "ArrowDown" || (e.ctrlKey && ["n", "j"].includes(e.key));
            const up = e.key === "ArrowUp" || (e.ctrlKey && ["p", "k"].includes(e.key));
            if (down || up) {
              e.preventDefault();
              setSel((s) => Math.max(0, Math.min(list.length - 1, s + (down ? 1 : -1))));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(sel, e.shiftKey ? "shift" : e.ctrlKey ? "ctrl" : "pick");
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        />
        <ul ref={listRef}>
          {list.map((t, i) => (
            <li class={i === sel ? "on" : ""} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
              {props.row(t)}
            </li>
          ))}
        </ul>
        <div class="hint">
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> or <Kbd>Ctrl+j</Kbd> <Kbd>Ctrl+k</Kbd> · <Kbd>Enter</Kbd> {props.hint ?? "choose"} · <Kbd>Esc</Kbd> close
        </div>
      </div>
    </div>
  );
}

function FilePicker() {
  const rows = fileRows.value;
  return (
    <Picker<FileRow>
      placeholder="find a file of this diff (fuzzy)"
      items={rows}
      filter={(items, q) => fuzzyFilter(items, q, (r) => r.fd.name, 80)}
      hint="jump"
      row={(r) => {
        const cut = r.fd.name.lastIndexOf("/") + 1;
        return (
          <>
            <span class="file-name">{r.fd.name.slice(cut)}</span> <span class="file-dir">{r.fd.name.slice(0, cut)}</span>
            {r.threads ? <span class="file-threads">{r.threads} 💬</span> : null}
          </>
        );
      }}
      pick={(r) => {
        compareNav.current?.scrollToFile(r.fd.name);
        const space = cursorSpace.peek();
        const at = space.fileStart(space.fileIndex(r.fd.name));
        if (at) setCursor(at, false);
      }}
    />
  );
}

export function keysHere(): { b: Binding; here: boolean }[] {
  const where = contexts();
  const seen = new Set<string>();
  const here: { b: Binding; here: boolean }[] = [];
  for (const b of bindingsHere()) {
    if (seen.has(b.keys)) continue;
    seen.add(b.keys);
    here.push({ b, here: true });
  }
  return [...here, ...BINDINGS.filter((b) => !where.includes(b.where)).map((b) => ({ b, here: false }))];
}

const keyText = (b: Binding) => `${b.desc} ${keyLabel(b.keys)} ${b.keys} ${WHERE[b.where]}`;

function KeyPicker() {
  const items = useMemo(keysHere, []);
  return (
    <Picker<{ b: Binding; here: boolean }>
      placeholder="search keys: what you want to do, or the key itself"
      items={items}
      filter={(all, q) => wordFilter(all, q, (x) => keyText(x.b))}
      hint="run it"
      row={({ b, here }) => (
        <span class={`key-row${here ? "" : " elsewhere"}`}>
          <Kbd>{keyLabel(b.keys)}</Kbd>
          <span class="key-desc">{b.desc}</span>
          <span class="key-where">{here ? "" : WHERE[b.where]}</span>
        </span>
      )}
      pick={({ b, here }) => {
        if (here) b.run(1);
        else notify(b.where === "code" ? `${keyLabel(b.keys)} works in a thread's code or the guide's lines: click into them, or press V or i there` : b.where === "guide" ? `${keyLabel(b.keys)} works in the Guide tab of the Changes page` : `${keyLabel(b.keys)} works on the ${WHERE[b.where]} page`);
      }}
    />
  );
}

interface VersionItem {
  v: VersionDto;
  round: Round | null;
  /** The newest version of its round heads the round in the list. */
  head: boolean;
}

function currentRange(): { from: string; to: string } {
  const r = route.value;
  return r.name === "compare" ? { from: r.from, to: r.to } : (lastCompare.value ?? defaultCompare());
}

/** Every version, newest first and headed by the review it answers: Enter shows what changed in it, Shift / Ctrl+Enter make it "from" / "to". */
function VersionPicker() {
  const vs = versions.value;
  const rs = versionRounds.value;
  const pass = reviewedCursor.value?.version ?? null;
  const items = useMemo(
    () =>
      [...vs].reverse().map((v): VersionItem => {
        const round = rs.find((r) => v.number >= r.first && v.number <= r.last) ?? null;
        return { v, round, head: !!round && round.last === v.number };
      }),
    [vs, rs],
  );
  const { from, to } = currentRange();
  const n = vs.length;
  const go = (range: [string, string]) => navigate({ name: "compare", from: range[0], to: range[1] });
  const text = (x: VersionItem) => `v${x.v.number} ${x.v.label ?? ""} ${x.v.author} ${x.round ? roundTitle(x.round) : ""}`;
  return (
    <Picker<VersionItem>
      placeholder="find a version: its number or words of its label"
      items={items}
      limit={1000}
      filter={(all, q) => {
        const query = q.trim().toLowerCase();
        const m = /^v?(\d+)$/.exec(query);
        const exact = m ? all.filter((x) => x.v.number === Number(m[1])) : [];
        const phrase = query.includes(" ") ? all.filter((x) => text(x).toLowerCase().includes(query)) : [];
        const first = [...exact, ...phrase];
        return [...first, ...wordFilter(all, q, text).filter((x) => !first.includes(x))];
      }}
      hint={
        <>
          what changed in it · <Kbd>Shift+Enter</Kbd> make it “from” · <Kbd>Ctrl+Enter</Kbd> make it “to”
        </>
      }
      row={(x) => {
        const ref = String(x.v.number);
        return (
          <span class="ver-pick">
            {x.head && x.round ? <span class="ver-round">{roundTitle(x.round)}</span> : null}
            <span class="ver-line">
              <b class="ver-n">v{x.v.number}</b>
              {pass === x.v.number ? <span class="seen" title="your last pass">✓</span> : null}
              <span class="ver-meta">
                {ago(x.v.createdAt)}
                {x.v.files !== null && x.v.files !== undefined ? ` · ${x.v.files} file${x.v.files === 1 ? "" : "s"}` : ""}
              </span>
              <span class="ver-label">{x.v.label ?? ""}</span>
              {ref === from ? <span class="ver-end">from</span> : ref === to ? <span class="ver-end">to</span> : null}
            </span>
          </span>
        );
      }}
      pick={(x) => go(onlyVersion(x.v.number))}
      shiftPick={(x) => go(withEnd("from", String(x.v.number), from, to, n))}
      ctrlPick={(x) => go(withEnd("to", String(x.v.number), from, to, n))}
    />
  );
}

export function Pickers() {
  const p = picker.value;
  return p === "files" ? <FilePicker /> : p === "keys" ? <KeyPicker /> : p === "versions" ? <VersionPicker /> : null;
}

const SECTIONS: [Where, string][] = [
  ["compare", "Changes (the diff)"],
  ["guide", "Changes: the Guide tab (experimental)"],
  ["thread", "Thread"],
  ["code", "In the code of a thread or of the Guide tab (after a click into it, V or i)"],
  ["drafts", "Drafts"],
  ["everywhere", "Everywhere"],
];

export function Help() {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const open = helpOpen.value;
  useEffect(() => {
    if (!open) return;
    setQ("");
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);
  if (!open) return null;
  const close = () => (helpOpen.value = false);
  const matching = new Set(wordFilter(BINDINGS, q, keyText));
  return (
    <div class="overlay" onClick={close}>
      <div class="help" onClick={(e) => e.stopPropagation()}>
        <div class="help-head">
          <h3>Keys</h3>
          <input
            ref={input}
            type="search"
            placeholder="filter: what you want to do, or the key"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
          />
        </div>
        <p class="hint">
          Vim-style, after LazyVim: counts (<Kbd>5j</Kbd>), <Kbd>Space</Kbd> is the leader and shows what can follow, <Kbd>Space s k</Kbd> searches keys and runs one.
          Keys work in the Russian layout too. In a comment box, <Kbd>Esc</Kbd> or <Kbd>jj</Kbd> leaves it, <Kbd>Ctrl+S</Kbd> saves a draft.
        </p>
        <div class="help-cols">
          {SECTIONS.map(([where, title]) => {
            const seen = new Set<string>();
            const rows = BINDINGS.filter((b) => b.where === where && matching.has(b) && !seen.has(b.desc + b.keys) && seen.add(b.desc + b.keys));
            if (rows.length === 0) return null;
            return (
              <section>
                <h4>{title}</h4>
                <table>
                  {rows.map((b) => (
                    <tr>
                      <td><Kbd>{keyLabel(b.keys)}</Kbd></td>
                      <td>{b.desc}</td>
                    </tr>
                  ))}
                </table>
              </section>
            );
          })}
        </div>
        {matching.size === 0 ? <p class="note">Nothing matches “{q}”.</p> : null}
      </div>
    </div>
  );
}
