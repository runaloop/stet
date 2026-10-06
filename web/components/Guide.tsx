import { parsePatchFiles, type DiffLineAnnotation, type FileDiffMetadata, type SelectedLineRange, type SelectionSide } from "@pierre/diffs";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CompareDto, GuideDto, GuideRefDto, GuideStepDto } from "../../src/core/types.ts";
import { api } from "../api.ts";
import {
  baseFiles,
  codeFocus,
  compareData,
  cursor,
  cursorLayer,
  cursorSpace,
  guideFiles,
  guideKeys,
  guideNav,
  leaveCode,
  pendingLines,
  setCursor,
  shownPlacements,
  visualAnchor,
  type CodeHandle,
} from "../compare.ts";
import { fetchGuide, foldRef, guideAt, guideFolds, guideOpen, guideShown, guideStep, guideVersion, isFolded, openInDiff, refKey } from "../guide.ts";
import { guideHtml, notInGuide, refLabel, refPatch, threadsOn } from "../lib/guide.ts";
import type { Cursor, LineRange, Seen, Span } from "../lib/cursor.ts";
import { drawnLines, type LineMark } from "../lib/marks.ts";
import { CHUNK, expansionOf, hydrateSubset, textLines } from "../lib/reveal.ts";
import { plainClick } from "../lib/route.ts";
import { diffRows, type Side } from "../lib/search.ts";
import { diffStyle, guard, navigate, notify, reloadAll, reviewId, routeHash, threads, wrap, type Route } from "../state.ts";
import { Badge, Kbd, rangeText } from "./Bits.tsx";
import { DiffView } from "./Code.tsx";
import { hi, lo, PendingBox } from "./NewThread.tsx";
import { askRestore, restorable } from "./Restore.tsx";
import { ThreadMini } from "./ThreadMini.tsx";
import { useBlob } from "./useBlob.ts";
import { linesInSight } from "../views/anchor.ts";

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
type Anno = { kind: "thread"; id: number; state: string } | { kind: "new" };

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

function RefBlock({ d, from, to, r, k }: { d: CompareDto; from: string; to: string; r: GuideRefDto; k: string }) {
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
    let out = fd ?? null;
    const patch = refPatch(r, { path: oldPath, text: oldText }, { path: r.path, text: newText }, fd?.hunks ?? [], more);
    if (patch) out = parsePatchFiles(patch, `guide:${d.from.sha}:${d.to.sha}:${refLabel(r)}:${JSON.stringify(more)}`)[0]?.files[0] ?? null;
    if (!out) return null;
    return hydrateSubset(out, { name: oldPath, contents: oldText }, { name: fd?.name ?? r.path, contents: newText });
  }, [fd, oldText, newText, r, more]);
  const rows = useMemo(() => (diff ? diffRows(diff) : null), [diff]);
  const folded = !!rows && isFolded(k, rows.length);
  const path = fd?.name ?? r.path;
  useEffect(() => {
    guideFiles.value = new Map(guideFiles.peek()).set(k, { fd: diff, path, oldPath, folded, start: r.range?.start ?? null });
  }, [diff, path, folded]);
  useEffect(
    () => () => {
      const m = new Map(guideFiles.peek());
      m.delete(k);
      guideFiles.value = m;
    },
    [k],
  );
  const expand = (hunk: number, direction: "up" | "down" | "both", count: number | undefined) => {
    if (!diff || typeof newText !== "string") return;
    const span = expansionOf(diff.hunks, textLines(newText).lines.length, hunk, direction, count ?? CHUNK);
    if (span) setMore((m) => [...m, span]);
  };
  const placed = shownPlacements.value;
  const p = pendingLines.value;
  const mine = p?.guide === k && p.path === path ? p : null;
  const mineSide: Side = mine?.range.side === "deletions" ? "deletions" : "additions";
  const annotations = useMemo((): DiffLineAnnotation<Anno>[] => {
    if (!diff || !rows) return [];
    const shown = { old: rows.flatMap((x) => (x.old === null ? [] : [x.old])), new: rows.flatMap((x) => (x.new === null ? [] : [x.new])) };
    return [
      ...threadsOn(placed, diff.name, shown).map(({ placement: p, line }) => ({ side: p.side, lineNumber: line, metadata: { kind: "thread" as const, id: p.threadId, state: p.state } })),
      ...(mine ? [{ side: mineSide, lineNumber: hi(mine.range), metadata: { kind: "new" as const } }] : []),
    ];
  }, [diff, rows, placed, mine]);
  const selected = useMemo(() => (mine ? { start: lo(mine.range), end: hi(mine.range), side: mineSide } : null), [mine]);
  const marks = useMemo((): LineMark[] => {
    const own: LineMark[] = r.range ? [{ side: "additions", start: r.range.start, end: r.range.end, tag: "linked" }] : [];
    return [...own, ...placed.filter((p) => p.path === (fd?.name ?? r.path)).map((p) => ({ side: p.side, start: p.range.start, end: p.range.end, tag: "thread" }))];
  }, [placed, r, fd]);
  const layer = codeFocus.value ? cursorLayer.value.get(k) : undefined;
  const shownMarks = useMemo(() => (layer ? [...marks, ...layer] : marks), [marks, layer]);
  const onSelect = (sel: SelectedLineRange | null) => {
    if (!sel) return;
    if (sel.endSide && sel.side && sel.endSide !== sel.side) return notify("select lines on one side of the diff: removed or added lines", "error");
    const side: Side = sel.side === "deletions" ? "deletions" : "additions";
    const at = cursorSpace.peek().locate(k, side, hi(sel));
    if (at) cursor.value = at;
    visualAnchor.value = null;
    guideNav.current?.startComment({ path: k, side, start: lo(sel), end: hi(sel) });
  };
  const onLineClick = (line: number, side: SelectionSide) => {
    const c = cursorSpace.peek().locate(k, side, line);
    if (c) setCursor(c, false);
  };
  const where = r.range ? `line${r.range.end > r.range.start ? "s" : ""} ${r.range.start === r.range.end ? r.range.start : `${r.range.start}–${r.range.end}`}` : "its whole change";
  const note = !fd && !r.range ? `no change between ${d.from.label} and ${d.to.label}` : fd && fd.hunks.length === 0 ? "no lines to show here (a binary file or only its mode changed)" : null;
  const added = rows?.filter((x) => x.kind === "add").length ?? 0;
  const removed = rows?.filter((x) => x.kind === "del").length ?? 0;
  return (
    <div class={`guide-ref${folded ? " folded" : ""}`} data-ref={refLabel(r)} data-key={k}>
      <div class="guide-ref-head">
        <button class="guide-fold" title={folded ? "show these lines · z a" : "fold these lines · z a"} aria-expanded={!folded} onClick={() => rows && foldRef(k, !folded)}>
          <span class="chev">{folded ? "▸" : "▾"}</span>
          <b class="path">{r.path}</b>
        </button>
        <span class="subtle">
          {where}
          {fd ? null : r.range ? ` · unchanged between ${d.from.label} and ${d.to.label}` : null}
        </span>
        {rows && (added || removed) ? (
          <span class="stat">
            <span class="add">+{added}</span> <span class="del">−{removed}</span>
          </span>
        ) : null}
        <span class="spacer" />
        <a class="guide-open" title="the normal diff at exactly these lines" {...diffLink(refRoute(d, from, to, r, fd))}>
          open in Diff
        </a>
      </div>
      {note ? (
        <div class="note subtle">{note}</div>
      ) : diff && folded ? (
        <button class="guide-unfold" onClick={() => foldRef(k, false)}>
          ▸ show {rows!.length} line{rows!.length === 1 ? "" : "s"}
        </button>
      ) : diff ? (
        <div class="guide-code">
          <DiffView<Anno>
            fileDiff={diff}
            diffStyle={diffStyle.value}
            wrap={wrap.value}
            annotations={annotations}
            renderAnnotation={(a) => (a.metadata.kind === "thread" ? <ThreadMini id={a.metadata.id} state={a.metadata.state} /> : mine ? <PendingBox p={mine} /> : null)}
            marks={shownMarks}
            selected={selected}
            onSelect={onSelect}
            onLineClick={onLineClick}
            onExpand={expand}
          />
        </div>
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
      {s.refs.map((r, j) => (
        <RefBlock key={refLabel(r)} d={d} from={from} to={to} r={r} k={refKey(s.index, j)} />
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
  const frame = useRef(0);
  // the file diff at the top of the view, unless the one gone to is still on screen
  const spy = () => {
    frame.current = 0;
    const el = box.current;
    const refs = [...(el?.querySelectorAll<HTMLElement>(".guide-ref") ?? [])];
    if (!el || !refs.length) return;
    const view = el.getBoundingClientRect();
    const top = view.top + (el.querySelector(".guide-head")?.getBoundingClientRect().height ?? 0) + 8;
    const was = guideAt.peek();
    const kept = was ? refs.find((x) => x.dataset.key === was)?.getBoundingClientRect() : null;
    if (kept && kept.bottom > top && kept.top < view.bottom) return;
    const at = (refs.find((x) => x.getBoundingClientRect().bottom > top) ?? refs[refs.length - 1]!).dataset.key ?? null;
    if (at !== was) guideAt.value = at;
  };
  const spyLater = () => {
    if (!frame.current) frame.current = requestAnimationFrame(spy);
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!ready || !el) return;
    el.scrollTop = scrolls.get(key) ?? 0;
    spyLater();
  }, [ready, key]);

  useEffect(() => {
    const i = guideStep.value;
    if (i !== null && shown) box.current?.querySelector(`.guide-step[data-step="${i}"]`)?.scrollIntoView({ block: "start", behavior: "instant" as ScrollBehavior });
  }, [guideStep.value, shown]);

  // the drawn line under the cursor, or the head of its file diff when that is folded
  const lineElement = (c: Cursor): Element | null => {
    const ref = box.current?.querySelector(`.guide-ref[data-key="${c.path}"]`);
    const at = cursorSpace.peek().position(c);
    const host = ref?.querySelector("diffs-container");
    return (at && host ? drawnLines(host).find((x) => x.at.some(([side, n]) => side === at.side && n === at.line))?.el : null) ?? ref ?? null;
  };
  const revealCursor = (c: Cursor, align: "nearest" | "center" = "nearest") => {
    const el = box.current;
    const line = lineElement(c);
    if (!el || !line) return;
    const view = el.getBoundingClientRect();
    const top = view.top + (el.querySelector(".guide-head")?.getBoundingClientRect().height ?? 0);
    const r = line.getBoundingClientRect();
    if (align === "center") el.scrollTop += r.top + r.height / 2 - (top + view.bottom) / 2;
    else if (r.top < top) el.scrollTop -= top - r.top + 8;
    else if (r.bottom > view.bottom) el.scrollTop += r.bottom - view.bottom + 8;
  };
  const inSight = (): Seen[] => {
    const el = box.current;
    if (!el) return [];
    const head = el.querySelector(".guide-head")?.getBoundingClientRect().height ?? 0;
    return [...el.querySelectorAll<HTMLElement>(".guide-ref[data-key]")].flatMap((ref) => {
      const host = ref.querySelector("diffs-container");
      return host ? linesInSight(el, host, ref.dataset.key!, cursorSpace.peek(), head) : [];
    });
  };
  const startComment = (range: LineRange) => {
    const f = guideFiles.peek().get(range.path);
    if (!f) return;
    pendingLines.value = { path: f.path, oldPath: f.oldPath, range: { start: range.start, end: range.end, side: range.side }, guide: range.path };
    codeFocus.value = true;
  };
  const submitComment = async (body: string, mode: "draft" | "now") => {
    const p = pendingLines.peek();
    const at = compareData.peek();
    const id = reviewId.peek();
    if (!p?.guide || !at || id === null) return false;
    const old = p.range.side === "deletions";
    const lines = { start: lo(p.range), end: hi(p.range) };
    const path = old ? p.oldPath : p.path;
    const t = await guard(api.addThread(id, { path, ...lines, side: old ? "old" : "new", at: old ? at.from.sha : at.to.sha, body, draft: mode === "draft" }));
    if (!t) return false;
    pendingLines.value = null;
    notify(
      mode === "draft" ? `draft #${t.id} saved on ${path}:${rangeText(lines)} · the agent sees it after you submit the review` : `thread #${t.id} sent to the agent`,
      "info",
      { label: `open #${t.id}`, route: { name: "thread", id: t.id } },
    );
    await reloadAll();
  };
  const restoreLines = async (body: string) => {
    const p = pendingLines.peek();
    const at = compareData.peek();
    const label = restorable(at?.from.label);
    if (!p?.guide || !at || !label || p.range.side !== "deletions") return false;
    if (!(await askRestore({ from: label, path: p.oldPath, start: lo(p.range), end: hi(p.range), at: at.to.sha, body }))) return false;
    pendingLines.value = null;
    return true;
  };
  const latest = useRef({ lineElement, revealCursor, inSight, startComment, submitComment, restoreLines });
  latest.current = { lineElement, revealCursor, inSight, startComment, submitComment, restoreLines };
  useEffect(() => {
    if (!shown) return;
    const nav: CodeHandle = {
      revealCursor: (c, align) => latest.current.revealCursor(c, align),
      cursorElement: (c) => latest.current.lineElement(c),
      inSight: () => latest.current.inSight(),
      startComment: (range) => latest.current.startComment(range),
      submitComment: (body, mode) => latest.current.submitComment(body, mode),
      restoreLines: (body) => latest.current.restoreLines(body),
      cancelComment: () => void (pendingLines.value = null),
      pageRows: () => Math.max(4, Math.floor((box.current?.clientHeight ?? 600) / 40)),
      pageFrom: () => null,
      showCode: () => undefined,
    };
    guideNav.current = nav;
    // A click or a focused field in a step's lines puts the keys on the code; one elsewhere takes them back, but the
    // heads above the lines leave them where they are.
    const follow = (e: Event) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest(".guide .guide-code")) codeFocus.value = true;
      else if (!el?.closest(".guide-ref-head, .guide-head")) leaveCode();
    };
    window.addEventListener("pointerdown", follow, true);
    window.addEventListener("focusin", follow, true);
    return () => {
      if (guideNav.current === nav) guideNav.current = null;
      window.removeEventListener("pointerdown", follow, true);
      window.removeEventListener("focusin", follow, true);
    };
  }, [shown]);

  if (!shown || !d) return null;
  const onPointerDown = (e: PointerEvent) => {
    const el = e.target as Element;
    const at = el.closest?.<HTMLElement>(".guide-ref")?.dataset.key ?? el.closest?.<HTMLElement>(".guide-step")?.querySelector<HTMLElement>(".guide-ref")?.dataset.key;
    if (at) guideAt.value = at;
  };
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element).closest?.("a.guide-thread");
    if (!a || !plainClick(e)) return;
    e.preventDefault();
    navigate({ name: "thread", id: Number(a.getAttribute("data-thread")) });
  };
  return (
    <div
      class={`guide${codeFocus.value ? " code-focus" : ""}`}
      ref={box}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onScroll={(e) => {
        if (ready) scrolls.set(key, (e.currentTarget as HTMLElement).scrollTop);
        spyLater();
      }}
    >
      <div class="guide-head">
        <b>Guide to v{n}</b> <Badge tone="info" title="an experiment: it may change or go">experimental</Badge>
        <span class="subtle">
          {g ? `${g.steps.length} step${g.steps.length === 1 ? "" : "s"} by the agent · ` : ""}
          {codeFocus.value ? (
            <>
              in the code: <Kbd>j</Kbd> <Kbd>k</Kbd> · <Kbd>V</Kbd> select · <Kbd>i</Kbd> comment · <Kbd>Esc</Kbd> leaves
            </>
          ) : (
            <>
              click a line or + to comment, or <Kbd>V</Kbd> <Kbd>i</Kbd> · <Kbd>{"}"}</Kbd> <Kbd>{"{"}</Kbd> steps · <Kbd>za</Kbd> fold · <Kbd>Enter</Kbd> open the step in the Diff · <Kbd>Esc</Kbd>{" "}
              back to the Diff
            </>
          )}
        </span>
      </div>
      {error ? <div class="note error">{error}</div> : !ready ? <div class="note">loading…</div> : (
        <>
          {g.title ? <h2 class="guide-title">{g.title}</h2> : null}
          {g.intro ? <div class="md guide-intro" dangerouslySetInnerHTML={{ __html: guideHtml(g.intro, threadHref) }} /> : null}
          {g.steps.map((s) => (
            <Step key={`${d.from.sha}:${d.to.sha}:${s.index}`} d={d} from={from} to={to} s={s} />
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
  const step = Math.max(1, Math.min(steps, at + dir * count));
  guideStep.value = step;
  guideAt.value = refKey(step, 0);
  if (codeFocus.value) cursor.value = guideCursor(guideAt.value);
  return true;
}

/** Where the cursor starts in a file diff of the guide: the step's first line, or the first line it shows. */
export function guideCursor(k: string | null | undefined): Cursor | null {
  const space = cursorSpace.peek();
  const f = k ? guideFiles.peek().get(k) : undefined;
  if (!k || !f) return space.normalize(null);
  return (f.start !== null ? space.locate(k, "additions", f.start) : null) ?? space.fileStart(space.fileIndex(k)) ?? space.normalize(null);
}

/** A file picked in the Files panel: its first step's lines in the guide, or the diff when no step names it. */
export function showFileInGuide(path: string): void {
  const k = guideKeys.value.find((x) => guideFiles.value.get(x)?.path === path);
  const d = compareData.value;
  if (!k) {
    if (d) openInDiff({ name: "compare", from: d.from.ref, to: d.to.ref, file: path });
    return;
  }
  guideAt.value = k;
  document.querySelector(`.guide .guide-ref[data-key="${k}"]`)?.scrollIntoView({ block: "start", behavior: "instant" as ScrollBehavior });
}

/** Folds or opens the file diff the reader is at (`za` `zo` `zc`), keeping its head in view. */
export function foldGuide(open: boolean | "toggle"): boolean {
  const k = guideAt.value ?? guideKeys.value[0];
  const f = k ? guideFiles.value.get(k) : null;
  if (!k || !f?.fd) return true;
  foldRef(k, open === "toggle" ? !f.folded : !open);
  requestAnimationFrame(() => document.querySelector(`.guide .guide-ref[data-key="${k}"]`)?.scrollIntoView({ block: "nearest", behavior: "instant" as ScrollBehavior }));
  return true;
}

/** Folds or opens every file diff of the guide (`zM` `zR`). */
export function foldAllGuide(open: boolean): boolean {
  guideFolds.value = new Map(guideKeys.value.map((k) => [k, !open]));
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
