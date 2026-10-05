import { hydratePartialDiff, parsePatchFiles, type DiffLineAnnotation, type FileDiffMetadata } from "@pierre/diffs";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CompareDto, GuideDto, GuideRefDto, GuideStepDto } from "../../src/core/types.ts";
import { baseFiles, compareData, shownPlacements } from "../compare.ts";
import { fetchGuide, guideOpen, guideShown, guideStep, guideVersion, openInDiff } from "../guide.ts";
import { guideHtml, notInGuide, refLabel, refPatch, threadsOn } from "../lib/guide.ts";
import type { Span } from "../lib/cursor.ts";
import type { LineMark } from "../lib/marks.ts";
import { CHUNK, expansionOf, textLines } from "../lib/reveal.ts";
import { plainClick } from "../lib/route.ts";
import { diffRows } from "../lib/search.ts";
import { diffStyle, navigate, reviewId, routeHash, threads, wrap, type Route } from "../state.ts";
import { Badge, Kbd } from "./Bits.tsx";
import { DiffView } from "./Code.tsx";
import { ThreadMini } from "./ThreadMini.tsx";
import { useBlob } from "./useBlob.ts";

export function GuideToggle() {
  const n = guideVersion.value;
  if (n === null) return null;
  const on = guideOpen.value;
  return (
    <span class="guide-tabs">
      <button class={`btn ghost small${on ? "" : " on"}`} title="the diff · Space u g switches" onClick={() => (guideOpen.value = false)}>
        Diff
      </button>
      <button class={`btn ghost small guide-tab${on ? " on" : ""}`} title={`the agent's guide to v${n}: its change in steps, each with its lines (experimental) · Space u g`} onClick={() => (guideOpen.value = true)}>
        Guide
      </button>
    </span>
  );
}

type CompareRoute = Extract<Route, { name: "compare" }>;
type Anno = { id: number; state: string };

function diffLink(r: CompareRoute) {
  return {
    href: routeHash(r),
    onClick: (e: MouseEvent) => {
      if (!plainClick(e)) return;
      e.preventDefault();
      openInDiff(r);
    },
  };
}

/** Where "open in Diff" goes for a reference: its lines, or its file. */
export function refRoute(d: CompareDto, from: string, to: string, ref: GuideRefDto, fd: FileDiffMetadata | undefined): CompareRoute {
  const r: CompareRoute = { name: "compare", from, to, file: fd?.name ?? ref.path };
  if (ref.range) {
    r.line = ref.range.start;
    if (ref.range.end > ref.range.start) r.end = ref.range.end;
  }
  return r;
}

const fileOf = (path: string) => baseFiles.value?.find((f) => f.name === path || (f.type === "deleted" && f.prevName === path));

function RefBlock({ d, from, to, r }: { d: CompareDto; from: string; to: string; r: GuideRefDto }) {
  const fd = fileOf(r.path);
  const oldPath = fd?.prevName ?? r.path;
  const deleted = fd?.type === "deleted";
  const newBlob = useBlob(deleted ? null : d.to.sha, deleted ? null : r.path);
  const oldBlob = useBlob(fd && fd.type !== "new" ? d.from.sha : null, fd && fd.type !== "new" ? oldPath : null);
  const text = (b: typeof newBlob, none: boolean) => (none ? "" : b && b !== "loading" ? b.contents : undefined);
  const newText = text(newBlob, deleted);
  // a file this compare does not change is the same on both sides
  const oldText = fd ? text(oldBlob, fd.type === "new") : newText;
  // lines the reader opened with the bars: they keep what they are (added, removed, unchanged) in the patch
  const [more, setMore] = useState<Span[]>([]);
  const diff = useMemo((): FileDiffMetadata | null => {
    if (typeof newText !== "string" || typeof oldText !== "string") return r.range ? null : (fd ?? null);
    const files = { oldFile: { name: oldPath, contents: oldText }, newFile: { name: fd?.name ?? r.path, contents: newText } };
    let out = fd ?? null;
    const patch = refPatch(r, { path: oldPath, text: oldText }, { path: r.path, text: newText }, fd?.hunks ?? [], more);
    if (patch) out = parsePatchFiles(patch, `guide:${d.from.sha}:${d.to.sha}:${refLabel(r)}:${JSON.stringify(more)}`)[0]?.files[0] ?? null;
    if (!out) return null;
    try {
      return hydratePartialDiff("clone", out, files as never);
    } catch {
      return out;
    }
  }, [fd, oldText, newText, r, more]);
  const expand = (hunk: number, direction: "up" | "down" | "both", count: number | undefined) => {
    if (!diff || typeof newText !== "string") return;
    const span = expansionOf(diff.hunks, textLines(newText).lines.length, hunk, direction, count ?? CHUNK);
    if (span) setMore((m) => [...m, span]);
  };
  const placed = shownPlacements.value;
  const annotations = useMemo((): DiffLineAnnotation<Anno>[] => {
    if (!diff) return [];
    const rows = diffRows(diff);
    const shown = { old: rows.flatMap((x) => (x.old === null ? [] : [x.old])), new: rows.flatMap((x) => (x.new === null ? [] : [x.new])) };
    return threadsOn(placed, diff.name, shown).map(({ placement: p, line }) => ({ side: p.side, lineNumber: line, metadata: { id: p.threadId, state: p.state } }));
  }, [diff, placed]);
  const marks = useMemo((): LineMark[] => {
    const own: LineMark[] = r.range ? [{ side: "additions", start: r.range.start, end: r.range.end, tag: "linked" }] : [];
    return [...own, ...placed.filter((p) => p.path === (fd?.name ?? r.path)).map((p) => ({ side: p.side, start: p.range.start, end: p.range.end, tag: "thread" }))];
  }, [placed, r, fd]);
  const where = r.range ? `line${r.range.end > r.range.start ? "s" : ""} ${r.range.start === r.range.end ? r.range.start : `${r.range.start}–${r.range.end}`}` : "its whole change";
  const note = !fd && !r.range ? `no change between ${d.from.label} and ${d.to.label}` : fd && fd.hunks.length === 0 ? "no lines to show here (a binary file or only its mode changed)" : null;
  return (
    <div class="guide-ref" data-ref={refLabel(r)}>
      <div class="guide-ref-head">
        <b class="path">{r.path}</b>
        <span class="subtle">
          {where}
          {fd ? null : r.range ? ` · unchanged between ${d.from.label} and ${d.to.label}` : null}
        </span>
        <span class="spacer" />
        <a class="guide-open" title="the normal diff at exactly these lines, where you can comment on them" {...diffLink(refRoute(d, from, to, r, fd))}>
          open in Diff
        </a>
      </div>
      {note ? (
        <div class="note subtle">{note}</div>
      ) : diff ? (
        <DiffView<Anno>
          fileDiff={diff}
          diffStyle={diffStyle.value}
          wrap={wrap.value}
          annotations={annotations}
          renderAnnotation={(a) => <ThreadMini id={a.metadata.id} state={a.metadata.state} />}
          marks={marks}
          onExpand={expand}
        />
      ) : (
        <div class="note">loading…</div>
      )}
    </div>
  );
}

function threadHref(id: number): string | null {
  return threads.value.some((t) => t.id === id) ? routeHash({ name: "thread", id }) : null;
}

function Step({ d, from, to, s }: { d: CompareDto; from: string; to: string; s: GuideStepDto }) {
  const html = useMemo(() => guideHtml(s.text, threadHref), [s.text, threads.value]);
  return (
    <section class={`guide-step${guideStep.value === s.index ? " focused" : ""}`} data-step={s.index}>
      <div class="guide-step-text">
        <span class="guide-num">{s.index}</span>
        <div class="md" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      {s.refs.map((r) => (
        <RefBlock d={d} from={from} to={to} r={r} />
      ))}
    </section>
  );
}

function Rest({ d, from, to, g }: { d: CompareDto; from: string; to: string; g: GuideDto }) {
  const rest = notInGuide(d.files, g);
  return (
    <section class="guide-rest">
      <h3>Not in the guide</h3>
      {rest.length === 0 ? (
        <p class="note subtle">Every file this compare changes is in a step.</p>
      ) : (
        <>
          <p class="note subtle">
            {rest.length} file{rest.length === 1 ? "" : "s"} of {d.from.label} → {d.to.label} that no step names:
          </p>
          <ul class="guide-rest-list">
            {rest.map((f) => (
              <li>
                <span class={`guide-status st-${f.status}`}>{f.status}</span>{" "}
                <a {...diffLink({ name: "compare", from, to, file: f.path })}>{f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path}</a>{" "}
                <span class="stat">{f.binary ? "binary" : <><span class="add">+{f.additions ?? 0}</span> <span class="del">−{f.deletions ?? 0}</span></>}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const scrolls = new Map<string, number>();

export function GuideView({ from, to }: { from: string; to: string }) {
  const shown = guideShown.value;
  const n = guideVersion.value;
  const rid = reviewId.value;
  const d = compareData.value;
  const [g, setG] = useState<GuideDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const key = `${rid}:${from}..${to}`;

  useEffect(() => {
    if (!shown || rid === null || n === null) return;
    let live = true;
    setError(null);
    fetchGuide(rid, n).then(
      (x) => live && setG(x),
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [shown, rid, n]);

  const ready = shown && !!g && g.version === n;
  useLayoutEffect(() => {
    const el = box.current;
    if (!ready || !el) return;
    el.scrollTop = scrolls.get(key) ?? 0;
  }, [ready, key]);

  useEffect(() => {
    const i = guideStep.value;
    if (i !== null && shown) box.current?.querySelector(`.guide-step[data-step="${i}"]`)?.scrollIntoView({ block: "start", behavior: "instant" as ScrollBehavior });
  }, [guideStep.value, shown]);

  if (!shown || !d) return null;
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest?.("a.guide-thread");
    if (!a || !plainClick(e)) return;
    e.preventDefault();
    navigate({ name: "thread", id: Number(a.getAttribute("data-thread")) });
  };
  return (
    <div class="guide" ref={box} onClick={onClick} onScroll={(e) => ready && scrolls.set(key, (e.currentTarget as HTMLElement).scrollTop)}>
      <div class="guide-head">
        <b>Guide to v{n}</b> <Badge tone="info" title="an experiment: it may change or go">experimental</Badge>
        <span class="subtle">
          {g ? `${g.steps.length} step${g.steps.length === 1 ? "" : "s"} by the agent · ` : ""}comment in the Diff · <Kbd>{"}"}</Kbd> <Kbd>{"{"}</Kbd> steps · <Kbd>Enter</Kbd> open the step in the Diff · <Kbd>Esc</Kbd> back to the Diff
        </span>
      </div>
      {error ? <div class="note error">{error}</div> : !ready ? <div class="note">loading…</div> : (
        <>
          {g.title ? <h2 class="guide-title">{g.title}</h2> : null}
          {g.intro ? <div class="md guide-intro" dangerouslySetInnerHTML={{ __html: guideHtml(g.intro, threadHref) }} /> : null}
          {g.steps.map((s) => (
            <Step d={d} from={from} to={to} s={s} />
          ))}
          <Rest d={d} from={from} to={to} g={g} />
        </>
      )}
    </div>
  );
}

/** The step after or before the one gone to, by `}` and `{`. */
export function stepGuide(dir: 1 | -1, count: number): boolean {
  const steps = document.querySelectorAll(".guide .guide-step").length;
  if (!steps) return true;
  const at = guideStep.value ?? (dir === 1 ? 0 : steps + 1);
  guideStep.value = Math.max(1, Math.min(steps, at + dir * count));
  return true;
}

/** "open in Diff" of the step gone to, or of the first step: its first lines. */
export function openGuideStep(): boolean {
  const i = guideStep.value ?? 1;
  document.querySelector<HTMLAnchorElement>(`.guide .guide-step[data-step="${i}"] a.guide-open`)?.click();
  return true;
}

export function scrollGuide(rows: number | "half", dir: 1 | -1): boolean {
  const el = document.querySelector<HTMLElement>(".guide");
  if (el) el.scrollTop += dir * (rows === "half" ? el.clientHeight / 2 : rows * 20);
  return true;
}
