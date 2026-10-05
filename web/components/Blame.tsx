import { effect, signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { BlameDto, BlameRunDto } from "../../src/core/types.ts";
import { api } from "../api.ts";
import { cursor } from "../compare.ts";
import type { Cursor } from "../lib/cursor.ts";
import type { Route } from "../lib/route.ts";
import { codeMode, link, navigate, reviewId, route, selectedStep, versions } from "../state.ts";
import { Kbd, rangeText } from "./Bits.tsx";

export interface BlameAsk {
  path: string;
  start: number;
  end: number;
  /** The ref blamed: a version number, `latest` or `now`; `base` answers itself. */
  at: string;
  label: string;
  /** Where the popover hangs: the line or block it is about, as it is on screen now. */
  place: () => DOMRect | null;
}

interface Opened {
  ask: BlameAsk;
  data: BlameDto | null;
  error: string | null;
  /** What the page showed when it opened: the popover closes once the cursor, the page or the step shown moves on. */
  at: unknown[];
}

export const blamePop = signal<Opened | null>(null);

const where = (): unknown[] => [cursor.value, route.value, selectedStep.value, codeMode.value];

effect(() => {
  const now = where();
  const s = blamePop.peek();
  if (s && now.some((x, i) => x !== s.at[i])) blamePop.value = null;
});

export function openBlame(ask: BlameAsk): void {
  const at = [cursor.peek(), route.peek(), selectedStep.peek(), codeMode.peek()];
  if (ask.at === "base") {
    const run: BlameRunDto = { start: ask.start, end: ask.end, origin: { kind: "base", version: null, label: null, createdAt: null }, round: null, threads: [], source: null };
    blamePop.value = { ask, at, error: null, data: { path: ask.path, at: { ref: "base", sha: "", label: "base" }, range: { start: ask.start, end: ask.end }, runs: [run] } };
    return;
  }
  blamePop.value = { ask, at, data: null, error: null };
  const rid = reviewId.peek();
  if (rid === null) return;
  const settle = (patch: Partial<Opened>) => {
    const s = blamePop.peek();
    if (s?.ask === ask) blamePop.value = { ...s, ...patch };
  };
  api.blame(rid, { path: ask.path, from: ask.start, to: ask.end, at: ask.at }).then(
    (data) => settle({ data }),
    (e) => settle({ error: (e as Error).message }),
  );
}

interface Target {
  kind: "version" | "thread";
  route: Route;
}

/** The compare that brought a run's lines, on those lines: what changed in its version, or since the latest one for "now". */
function versionRoute(run: BlameRunDto, latest: number | null): Route | null {
  const o = run.origin;
  const lines = run.source ? { file: run.source.path, line: run.source.start, ...(run.source.end > run.source.start ? { end: run.source.end } : {}) } : {};
  if (o.kind === "version" && o.version !== null) return { name: "compare", from: o.version > 1 ? String(o.version - 1) : "base", to: String(o.version), ...lines };
  if (o.kind === "now") return { name: "compare", from: latest ? String(latest) : "base", to: "now", ...lines };
  return null;
}

/** Every link of the popover in reading order: a run's version, then its threads. */
export function blameTargets(data: BlameDto, latest: number | null): Target[][] {
  return data.runs.map((run) => {
    const v = versionRoute(run, latest);
    return [...(v ? [{ kind: "version" as const, route: v }] : []), ...run.threads.map((t) => ({ kind: "thread" as const, route: { name: "thread" as const, id: t.id } }))];
  });
}

const MATCH = { anchor: "", named: " (named)", file: " (same file)" } as const;

function Run({ run, targets, first, on }: { run: BlameRunDto; targets: Target[]; first: number; on: number }) {
  const o = run.origin;
  const cls = (i: number) => (first + i === on ? "on" : "");
  const v = targets[0]?.kind === "version" ? targets[0] : null;
  const shift = v ? 1 : 0;
  const what =
    o.kind === "base" ? (
      <span class="subtle">base</span>
    ) : (
      <>
        <a class={`blame-ver ${cls(0)}`} {...link(v!.route)} title={o.kind === "now" ? "what changed since the latest version" : `what changed in v${o.version}${o.label ? `: ${o.label}` : ""}`}>
          {o.kind === "now" ? "now" : `v${o.version}`}
        </a>
        {o.kind === "now" ? <span class="subtle"> (not in a version yet)</span> : null}
      </>
    );
  return (
    <li>
      <span class="blame-lines">{rangeText(run)}</span>
      <span class="blame-what">
        {what}
        {run.round ? <span class="subtle"> · round {run.round.index}</span> : null}
        {run.threads.map((t, i) => (
          <>
            {" · "}
            {t.reply.intent}{" "}
            <a class={`blame-thread ${cls(i + shift)}`} {...link({ name: "thread", id: t.id })} title={t.reply.body}>
              #{t.id} <span class="blame-title">“{t.title}”</span>
            </a>
            {MATCH[t.match] ? <span class="subtle">{MATCH[t.match]}</span> : null}
          </>
        ))}
      </span>
    </li>
  );
}

const WIDTH = 560;

function position(rect: DOMRect | null): string {
  if (!rect) return "top: 56px; right: 16px";
  const left = Math.round(Math.max(8, Math.min(rect.left + 24, window.innerWidth - Math.min(WIDTH, window.innerWidth - 16) - 8)));
  const room = window.innerHeight - rect.bottom;
  if (room < 180 && rect.top > room) return `bottom: ${Math.round(Math.min(window.innerHeight - 8, window.innerHeight - rect.top + 4))}px; left: ${left}px`;
  return `top: ${Math.round(Math.max(8, rect.bottom + 4))}px; left: ${left}px`;
}

/** Where the lines under the cursor came from: the version that brought them, its round, and the threads it answered there. */
export function BlamePop() {
  const s = blamePop.value;
  const ref = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [, redraw] = useState(0);
  const latest = versions.value[versions.value.length - 1]?.number ?? null;
  const groups = s?.data ? blameTargets(s.data, latest) : [];
  const flat = groups.flat();
  const firstThread = flat.findIndex((t) => t.kind === "thread");
  const start = firstThread === -1 ? 0 : firstThread;
  const on = sel ?? start;
  useEffect(() => setSel(null), [s?.ask]);
  useEffect(() => {
    if (!s) return;
    const close = () => (blamePop.value = null);
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.tagName === "TEXTAREA" || el?.tagName === "INPUT" || e.ctrlKey || e.metaKey || e.altKey) return;
      const down = e.key === "ArrowDown" || e.code === "KeyJ";
      const up = e.key === "ArrowUp" || e.code === "KeyK";
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Escape") {
        stop();
        close();
      } else if ((down || up) && flat.length > 1) {
        stop();
        setSel((was) => ((was ?? start) + (down ? 1 : -1) + flat.length) % flat.length);
      } else if (e.key === "Enter" && flat[on]) {
        stop();
        close();
        navigate(flat[on]!.route);
      }
    };
    const click = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const move = () => redraw((n) => n + 1);
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", click, true);
    window.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("mousedown", click, true);
      window.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
    };
  }, [s, flat.length, on, start]);
  if (!s) return null;
  let first = 0;
  return (
    <div class="blame-pop" ref={ref} style={position(s.ask.place())} role="dialog" aria-label="where these lines came from">
      <div class="blame-head">
        <b>{s.ask.path}:{rangeText(s.ask)}</b> <span class="subtle">at {s.ask.label}</span>
      </div>
      {s.error ? (
        <p class="note">{s.error}</p>
      ) : !s.data ? (
        <p class="subtle">loading…</p>
      ) : (
        <ul>
          {s.data.runs.map((run, i) => {
            const at = first;
            first += groups[i]!.length;
            return <Run run={run} targets={groups[i]!} first={at} on={on} />;
          })}
        </ul>
      )}
      <div class="hint">
        {flat.length ? (
          <>
            <Kbd>Enter</Kbd> opens the {flat[on]?.kind === "thread" ? "thread" : "change"}
            {flat.length > 1 ? (
              <>
                {" "}· <Kbd>j</Kbd> <Kbd>k</Kbd> pick
              </>
            ) : null}{" "}
            ·{" "}
          </>
        ) : null}
        <Kbd>Esc</Kbd> close
      </div>
    </div>
  );
}
