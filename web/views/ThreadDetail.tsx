import { hydratePartialDiff, parsePatchFiles, type FileDiffMetadata, type SelectedLineRange, type SelectionSide } from "@pierre/diffs";
import { signal } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CommentDto, ThreadDetail as Detail, TimelineStepDto } from "../../src/core/types.ts";
import { api } from "../api.ts";
import { useBlob } from "../components/useBlob.ts";
import { ago, Badge, Kbd, rangeText, ThreadBadges, threadRefs, ThreadRef, StateBadge, whereText } from "../components/Bits.tsx";
import { DiffView } from "../components/Code.tsx";
import { ImageArea } from "../components/ImageView.tsx";
import { RenderedMarkdown, spansOf, type MdThread } from "../components/MarkdownView.tsx";
import {
  codeFocus,
  cursor,
  cursorLayer,
  cursorSpace,
  leaveCode,
  markdownView,
  pendingLines,
  setCursor,
  threadCode,
  threadNav,
  visualAnchor,
  type CodeHandle,
  type CodeSide,
  type FileView,
} from "../compare.ts";
import { Composer } from "../components/Composer.tsx";
import { Conversation, unchangedSince } from "../components/Conversation.tsx";
import { hi, lo, PendingBox } from "../components/NewThread.tsx";
import { askRestore, RESTORE_TITLE, restorable } from "../components/Restore.tsx";
import { Splitter, widthOf } from "../components/Splitter.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { ThreadMini } from "../components/ThreadMini.tsx";
import { usePlacements } from "../components/usePlacements.ts";
import { apply, takeSpot } from "../jumps.ts";
import { swapped, toggleSwap } from "../layout.ts";
import { latchNew, openAtNews } from "../msgs.ts";
import { stepThread, stepUnread } from "../lib/nav.ts";
import { isMarkdown } from "../lib/markdown.ts";
import { contextPatch, filePatch, regionPatch } from "../lib/region.ts";
import { snapshot, visibleBox, type Fade } from "../lib/fade.ts";
import { drawnLines } from "../lib/marks.ts";
import { CHUNK, expansionOf, NOTHING, revealedPatch, textLines, withSpan, type Reveal } from "../lib/reveal.ts";
import type { Cursor, CursorFile, LineRange, NavBlock, Span } from "../lib/cursor.ts";
import type { Side } from "../lib/search.ts";
import { stopElement } from "./anchor.ts";
import { clampStep, diffPair } from "../lib/timeline.ts";
import {
  codeMode,
  compareFocus,
  composerFocus,
  detail,
  diffBase,
  diffStyle,
  guard,
  lastCompare,
  link,
  notify,
  ordered,
  reloadAll,
  replyQuote,
  reviewId,
  selectedStep,
  threads,
  wrap,
} from "../state.ts";
import { PeekView } from "./Peek.tsx";

function Marker({ id, step }: { id: number; step: TimelineStepDto }) {
  return (
    <div class="anno-focus thread-marker">
      ▲ thread #{id} · {step.label} · <StateBadge state={step.state} label={step.index === 0 ? "written here" : step.state} />
    </div>
  );
}

type Scope = "region" | "changes" | "file";

/** A Markdown file's code rendered or as code, kept while you step through the timeline and go from thread to thread. */
const mdView = signal<FileView | null>(null);

type Anno = { kind: "marker" | "new" | "thread"; id: number; state: string };

function hydrated(patch: string, key: string, oldFile: { name: string; contents: string }, newFile: { name: string; contents: string }): FileDiffMetadata | null {
  const fd = parsePatchFiles(patch, key)[0]?.files[0];
  if (!fd) return null;
  try {
    return hydratePartialDiff("clone", fd, { oldFile, newFile } as never);
  } catch {
    return fd;
  }
}

/** Brings the thread's blocks to the middle of the code, when asked or when they are out of sight. */
function reveal(host: HTMLElement | null, always: boolean): void {
  const el = host?.querySelector(".md-thread-focus");
  if (!host || !el) return;
  let box = host.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  const view = box?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
  const r = el.getBoundingClientRect();
  if (always || r.top < view.top || r.bottom > view.bottom) el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
}

const refOf = (s: TimelineStepDto) => (s.kind === "now" ? "now" : /^v\d+$/.test(s.label) ? s.label.slice(1) : s.sha);
const sideOf = (s: TimelineStepDto): CodeSide => ({ sha: s.sha, label: s.label, path: s.path!, ref: refOf(s) });

/** As many lines of context as a file can have: the whole file in one hunk. */
const ALL = Number.MAX_SAFE_INTEGER;

/** Half the code column on screen, for Ctrl+d / Ctrl+u. */
const halfScreen = (el: Element | null) => Math.min(innerHeight, el?.closest(".thread-code")?.clientHeight ?? innerHeight) / 2;

/**
 * The thread's code between two steps, with the Changes page's layer for comments: the cursor and its keys while the
 * code has the focus, a click or + on a line, a selection, and the same box under the lines.
 */
function CodeBlock({ d, from, to }: { d: Detail; from: TimelineStepDto; to: TimelineStepDto }) {
  const single = from.index === to.index;
  const [scope, setScope] = useState<Scope>("region");
  const [more, setMore] = useState(0);
  const oldBlob = useBlob(from.range && !single ? from.sha : null, from.path);
  const newBlob = useBlob(to.range ? to.sha : null, to.path);
  const newText = newBlob === "loading" ? null : (newBlob?.contents ?? null);
  const oldText = single ? newText : oldBlob === "loading" ? null : (oldBlob?.contents ?? null);
  const region = useMemo(
    () =>
      oldText !== null && newText !== null && from.path && to.path && to.range
        ? regionPatch({ path: from.path, text: oldText, range: from.range }, { path: to.path, text: newText, range: to.range }, 6 + more)
        : null,
    [oldText, newText, from.path, to.path, from.range?.start, from.range?.end, to.range?.start, to.range?.end, more],
  );
  const oldFile = useMemo(() => (oldText !== null && from.path ? { name: from.path, contents: oldText } : null), [oldText, from.path]);
  const newFile = useMemo(() => (newText !== null && to.path ? { name: to.path, contents: newText } : null), [newText, to.path]);
  const fileDiff = useMemo(
    () => {
      if (!region || !oldFile || !newFile) return null;
      const key = `region-${d.thread.id}-${from.sha}-${to.sha}-${more}`;
      return region.complete ? hydrated(region.patch, key, oldFile, newFile) : (parsePatchFiles(region.patch, key)[0]?.files[0] ?? null);
    },
    [region, oldFile, newFile],
  );
  // the wider scopes as a diff of their own, so the cursor walks every line they show
  const changes = useMemo(() => {
    if (scope !== "changes" || !oldFile || !newFile) return null;
    const patch = filePatch({ path: oldFile.name, text: oldFile.contents }, { path: newFile.name, text: newFile.contents });
    return patch ? hydrated(patch, `changes-${d.thread.id}-${from.sha}-${to.sha}`, oldFile, newFile) : null;
  }, [scope, oldFile, newFile]);
  const wholeFile = useMemo(() => {
    if (scope !== "file" || !oldFile || !newFile || !to.range) return null;
    const o = { path: oldFile.name, text: oldFile.contents };
    const n = { path: newFile.name, text: newFile.contents };
    const patch = (single ? null : filePatch(o, n, ALL)) ?? contextPatch(o, { ...n, range: to.range }, ALL);
    return hydrated(patch, `file-${d.thread.id}-${from.sha}-${to.sha}`, oldFile, newFile);
  }, [scope, oldFile, newFile, to.range?.start, to.range?.end]);

  const md = !!to.path && isMarkdown(to.path);
  const rendered = md && (mdView.value ?? markdownView.value) === "rendered";
  // a Markdown file: every change of it, and the lines its code and its rendered text show alike, the scope's and
  // those opened on the bars between them
  const [opened, setOpened] = useState<Reveal>(NOTHING);
  const whole = useMemo(() => {
    if (!md || oldText === null || newText === null || !from.path || !to.path) return null;
    const patch = single ? null : filePatch({ path: from.path, text: oldText }, { path: to.path, text: newText });
    return (patch ? parsePatchFiles(patch, `md-${d.thread.id}-${from.sha}-${to.sha}`)[0]?.files[0] : null) ?? { hunks: [] };
  }, [md, oldText, newText, from.path, to.path, single]);
  const shared = useMemo(() => {
    if (!whole || !oldFile || !newFile || !from.path || !to.path || scope === "file") return null;
    const base = scope === "region" ? (fileDiff ? spansOf(fileDiff.hunks) : null) : undefined;
    if (base === null) return null;
    const o = { path: from.path, text: oldFile.contents };
    const n = { path: to.path, text: newFile.contents };
    const patch = revealedPatch(o, n, whole.hunks, opened, base) ?? filePatch(o, n);
    return patch ? hydrated(patch, `md-${d.thread.id}-${from.sha}-${to.sha}-${scope}-${JSON.stringify(base)}-${JSON.stringify(opened)}`, oldFile, newFile) : null;
  }, [whole, oldFile, newFile, scope, fileDiff, opened]);
  const open = (span: Span | null) => span && setOpened((r) => withSpan(r, span));
  const mdHost = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // a copy of the old view covers the switch and fades out once the new one is drawn
  const fade = useRef<Fade | null>(null);
  const toggle = () => {
    fade.current = body.current ? snapshot(visibleBox(body.current), [body.current]) : null;
    mdView.value = rendered ? "code" : "rendered";
  };
  useEffect(() => {
    const f = fade.current;
    fade.current = null;
    if (!f) return;
    const frame = requestAnimationFrame(() => requestAnimationFrame(f.go));
    return () => cancelAnimationFrame(frame);
  }, [rendered]);
  useEffect(() => {
    if (!rendered) return;
    const frame = requestAnimationFrame(() => reveal(mdHost.current, scope !== "region"));
    return () => cancelAnimationFrame(frame);
  }, [rendered, scope, !!whole]);

  const newest = d.timeline[d.timeline.length - 1]!;
  const drawn = shared ?? (scope === "region" ? fileDiff : scope === "changes" ? changes : wholeFile);
  const [stops, setStops] = useState<readonly NavBlock[] | null>(null);
  const file = useMemo((): CursorFile | null => (drawn ? { fd: drawn, collapsed: false, ...(rendered ? { blocks: stops ?? [] } : {}) } : null), [drawn, rendered, stops]);
  const toCode = useRef(false);

  // The cursor stays on its block, or its line, when the code is drawn anew: another scope or step, more lines, rendered or not.
  useEffect(() => {
    if (!file || !to.range || !from.path) return;
    const was = cursorSpace.peek();
    const c = cursor.peek();
    const a = visualAnchor.peek();
    const at = { c: c && was.position(c), a: a && was.position(a), cb: c && was.block(c), ab: a && was.block(a) };
    threadCode.value = { file, old: sideOf(from), now: sideOf(to), thread: d.thread.id, newest: newest.sha, start: to.range.start };
    const space = cursorSpace.peek();
    const follow = (x: Cursor | null, block: NavBlock | null, pos: { side: Side; line: number } | null) => {
      const same = block && file.blocks ? file.blocks.findIndex((b) => JSON.stringify([b.old, b.new]) === JSON.stringify([block.old, block.new])) : -1;
      if (same !== -1) return { path: file.fd.name, row: same };
      return pos ? (space.locate(file.fd.name, pos.side, pos.line) ?? x) : x;
    };
    if (c) cursor.value = follow(c, at.cb, at.c);
    if (a) visualAnchor.value = follow(a, at.ab, at.a);
    if (toCode.current && !rendered) {
      toCode.current = false;
      const frame = requestAnimationFrame(() => cursor.peek() && revealCursor(cursor.peek()!, "center"));
      return () => cancelAnimationFrame(frame);
    }
  }, [file, newest.sha]);

  const lineElement = (c: Cursor): Element | null => {
    const space = cursorSpace.peek();
    const block = c.row >= 0 ? space.block(c) : null;
    if (block) return stopElement(c.path, c.row, block.new ? "additions" : "deletions");
    const at = space.position(c);
    const host = body.current?.querySelector("diffs-container");
    return at && host ? (drawnLines(host).find((r) => r.at.some(([s, n]) => s === at.side && n === at.line))?.el ?? null) : null;
  };
  const revealCursor = (c: Cursor, align: "nearest" | "center" = "nearest") => lineElement(c)?.scrollIntoView({ block: align, behavior: "instant" as ScrollBehavior });
  const stepOf = (side: SelectionSide | undefined) => (side === "deletions" ? from : to);
  const startComment = (range: LineRange) => {
    pendingLines.value = { path: range.path, oldPath: from.path ?? range.path, range: { start: range.start, end: range.end, side: range.side } };
    codeFocus.value = true;
  };
  const submitComment = async (text: string, mode: "draft" | "now") => {
    const p = pendingLines.peek();
    const rid = reviewId.peek();
    const step = stepOf(p?.range.side);
    if (!p || rid === null || !step.path) return false;
    const lines = { start: lo(p.range), end: hi(p.range) };
    const t = await guard(api.addThread(rid, { path: step.path, ...lines, side: p.range.side === "deletions" ? "old" : "new", at: step.sha, body: text, draft: mode === "draft" }));
    if (!t) return false;
    pendingLines.value = null;
    notify(
      mode === "draft" ? `draft #${t.id} saved on ${step.path}:${rangeText(lines)} · the agent sees it after you submit the review` : `thread #${t.id} sent to the agent`,
      "info",
      { label: `open #${t.id}`, route: { name: "thread", id: t.id } },
    );
    await reloadAll();
  };
  const restoreLines = async (text: string) => {
    const p = pendingLines.peek();
    const step = stepOf(p?.range.side);
    const label = step.sha !== newest.sha ? restorable(step.label) : null;
    if (!p || !label || !step.path) return false;
    if (!(await askRestore({ from: label, path: step.path, start: lo(p.range), end: hi(p.range), thread: d.thread.id, body: text }))) return false;
    pendingLines.value = null;
    return true;
  };
  // half a screen from the cursor's block, by where the blocks are drawn
  const pageFrom = (c: Cursor, dir: 1 | -1): Cursor | null => {
    const start = c.row >= 0 && cursorSpace.peek().block(c) ? stopElement(c.path, c.row) : null;
    if (!start) return null;
    const goal = start.getBoundingClientRect().top + dir * halfScreen(body.current);
    const count = cursorSpace.peek().rows(0).length;
    let at = c.row;
    for (let k = c.row + dir; k >= 0 && k < count; k += dir) {
      const el = stopElement(c.path, k);
      if (!el) break;
      at = k;
      const top = el.getBoundingClientRect().top;
      if (dir === 1 ? top >= goal : top <= goal) break;
    }
    return at === c.row ? null : { path: c.path, row: at };
  };
  const showCode = (path: string, stop: number) => {
    cursor.value = { path, row: stop };
    codeFocus.value = true;
    toCode.current = true;
    if (rendered) toggle();
  };
  const latest = useRef({ revealCursor, lineElement, startComment, submitComment, restoreLines, pageFrom, showCode });
  latest.current = { revealCursor, lineElement, startComment, submitComment, restoreLines, pageFrom, showCode };
  useEffect(() => {
    if (!to.range || !to.path) return;
    const nav: CodeHandle = {
      revealCursor: (c, align) => latest.current.revealCursor(c, align),
      cursorElement: (c) => latest.current.lineElement(c),
      startComment: (range) => latest.current.startComment(range),
      submitComment: (text, mode) => latest.current.submitComment(text, mode),
      restoreLines: (text) => latest.current.restoreLines(text),
      cancelComment: () => void (pendingLines.value = null),
      pageRows: () => Math.max(4, Math.floor(halfScreen(body.current) / 20)),
      pageFrom: (c, dir) => latest.current.pageFrom(c, dir),
      showCode: (path, stop) => latest.current.showCode(path, stop),
    };
    threadNav.current = nav;
    return () => {
      if (threadNav.current === nav) threadNav.current = null;
      pendingLines.value = null;
    };
  }, []);

  const p = pendingLines.value;
  const mine = p && p.path === to.path ? p : null;
  const mineSide: Side = mine?.range.side === "deletions" ? "deletions" : "additions";
  const toEnd = to.range?.end ?? 0;
  const shownHunks = shared ?? (scope === "region" ? fileDiff : null);
  const shownNew = shownHunks ? shownHunks.hunks.map((h) => [h.additionStart, h.additionStart + h.additionCount - 1] as const) : null;
  const others = usePlacements(to.range ? to.sha : null, to.path).filter(
    (x) => x.threadId !== d.thread.id && (!shownNew || shownNew.some(([a, b]) => x.range.end >= a && x.range.end <= b)),
  );
  const othersKey = others.map((x) => `${x.threadId}:${x.range.start}-${x.range.end}`).join(",");
  const annotations = useMemo(
    (): { side: "additions" | "deletions"; lineNumber: number; metadata: Anno }[] => [
      { side: "additions", lineNumber: toEnd, metadata: { kind: "marker", id: d.thread.id, state: "" } },
      ...others.map((x) => ({ side: "additions" as const, lineNumber: x.range.end, metadata: { kind: "thread" as const, id: x.threadId, state: x.state as string } })),
      ...(mine ? [{ side: mineSide, lineNumber: hi(mine.range), metadata: { kind: "new" as const, id: 0, state: "" } }] : []),
    ],
    [toEnd, mine, othersKey],
  );
  const selected = useMemo(() => (mine ? { start: lo(mine.range), end: hi(mine.range), side: mineSide } : null), [mine]);
  const marks = useMemo(
    () => [
      ...others.map((x) => ({ side: "additions" as const, start: x.range.start, end: x.range.end, tag: "thread" })),
      ...(to.range ? [{ side: "additions" as const, start: to.range.start, end: to.range.end, tag: "focus" }] : []),
      ...(!single && from.range ? [{ side: "deletions" as const, start: from.range.start, end: from.range.end, tag: "thread" }] : []),
    ],
    [to.range?.start, to.range?.end, from.range?.start, from.range?.end, single, othersKey],
  );
  const layer = codeFocus.value && to.path ? cursorLayer.value.get(to.path) : undefined;
  const shownMarks = useMemo(() => (layer ? [...marks, ...layer] : marks), [marks, layer]);

  if (!to.range || !to.path) {
    return (
      <>
        <div class="code-label">At {to.label} this code is gone ({to.reason ?? "outdated"}). Below: as it was at {from.label}.</div>
        {from.range ? <CodeBlock d={d} from={from} to={from} /> : null}
      </>
    );
  }
  if (newBlob === "loading" || (!single && oldBlob === "loading")) return <div class="note">loading…</div>;
  if (newText === null) return <div class="note">{to.path} is not a text file at {to.label}.</div>;

  const restoreFrom = single && to.sha !== newest.sha ? restorable(to.label) : null;
  const lines = `lines ${rangeText(to.range)}`;
  const label =
    scope === "file"
      ? single
        ? `The whole of ${to.path} at ${to.label}`
        : `The whole of ${to.path}, with ${region?.complete ? "the" : "every"} change${region?.complete ? "s" : ""} from ${from.label} to ${to.label}`
      : scope === "changes"
        ? `Every change in ${to.path} from ${from.label} to ${to.label}`
        : single
          ? to.index === 0
            ? `The commented ${lines} as they were at ${to.label}, when the thread started`
            : `The commented ${lines} at ${to.label}`
          : region?.kind === "changed"
            ? `How the commented ${lines} changed from ${from.label} to ${to.label}`
            : region?.kind === "nearby"
              ? `The commented ${lines} did not change from ${from.label} to ${to.label}; code next to them did`
              : `No change in or near the commented ${lines} from ${from.label} to ${to.label}`;
  const onSelect = (r: SelectedLineRange | null) => {
    if (!r) return;
    if (r.endSide && r.side && r.endSide !== r.side) {
      notify("select lines on one side of the diff: removed or added lines", "error");
      return;
    }
    const side = !single && r.side === "deletions" ? "deletions" : "additions";
    const at = cursorSpace.peek().locate(to.path!, side, hi(r));
    if (at) cursor.value = at;
    visualAnchor.value = null;
    startComment({ path: to.path!, side, start: lo(r), end: hi(r) });
  };
  const onLineClick = (line: number, side: SelectionSide) => {
    const c = cursorSpace.peek().locate(to.path!, single ? "additions" : side, line);
    if (c) setCursor(c, false);
  };
  const common = {
    diffStyle: single ? ("unified" as const) : diffStyle.value,
    wrap: wrap.value,
    selected,
    marks: shownMarks,
    annotations,
    renderAnnotation: (a: { metadata: Anno }) =>
      a.metadata.kind === "thread" ? <ThreadMini id={a.metadata.id} state={a.metadata.state} /> : a.metadata.kind === "new" && mine ? <PendingBox p={mine} /> : <Marker id={d.thread.id} step={to} />,
    onSelect,
    onLineClick,
  };
  const mdThreads: MdThread[] = [
    { threadId: d.thread.id, side: "additions", range: to.range, state: to.state },
    ...(!single && from.range ? [{ threadId: d.thread.id, side: "deletions" as const, range: from.range, state: from.state }] : []),
    ...others.map((x) => ({ threadId: x.threadId, side: "additions" as const, range: x.range, state: x.state })),
  ];
  const cardOf = (x: MdThread) => (x.threadId !== d.thread.id ? <ThreadMini id={x.threadId} state={x.state} /> : x.side === "additions" ? <Marker id={d.thread.id} step={to} /> : null);
  const expand = (hunk: number, direction: "up" | "down" | "both", count: number | undefined) =>
    open(shared ? expansionOf(shared.hunks, textLines(newText).lines.length, hunk, direction, count ?? CHUNK) : null);
  const scopes: [Scope, string][] = [
    ["region", "around the thread"],
    ...(!single && oldText !== newText ? ([["changes", "all changes in this file"]] as [Scope, string][]) : []),
    ["file", "whole file"],
  ];
  return (
    <>
      <div class="code-label">
        <span>{label}</span>
        <span class="spacer" />
        {restoreFrom ? (
          <button
            class="btn small restore-lines"
            title={`the thread's lines as they were in ${restoreFrom}: ${RESTORE_TITLE}`}
            onClick={() => void askRestore({ from: restoreFrom, path: to.path!, start: to.range!.start, end: to.range!.end, thread: d.thread.id })}
          >
            ↺ Restore as in {restoreFrom}
          </button>
        ) : null}
        {scope !== "region" ? null : region?.complete || md ? (
          <span class="hint">the ⋯ bars above and below show more lines</span>
        ) : (
          <button class="btn ghost small" title="other changes in this file are left out; this shows more of the code around the thread" onClick={() => setMore(more + 20)}>
            ↕ 20 more lines around
          </button>
        )}
        <span class="seg small">
          {scopes.map(([s, text]) => (
            <button class={scope === s ? "on" : ""} onClick={() => setScope(s)}>{text}</button>
          ))}
        </span>
        {isMarkdown(to.path) ? (
          <button class="btn ghost small md-toggle" title="Markdown: show it rendered or as code" onClick={toggle}>
            {rendered ? "‹/› code" : "¶ rendered"}
          </button>
        ) : null}
      </div>
      <div class="code-body" ref={body}>
      {rendered ? (
        whole && (scope === "file" || shared) ? (
          <div class="md-anno" ref={mdHost}>
            <RenderedMarkdown
              file={to.path}
              fd={whole}
              old={single ? { sha: to.sha, path: to.path, label: to.label } : { sha: from.sha, path: from.path!, label: from.label }}
              now={{ sha: to.sha, path: to.path, label: to.label }}
              split={!single && diffStyle.value === "split"}
              threads={mdThreads}
              shown={shared ? spansOf(shared.hunks) : null}
              onReveal={open}
              cardOf={cardOf}
              live
              onStops={setStops}
            />
          </div>
        ) : (
          <div class="note">loading…</div>
        )
      ) : drawn ? (
        <DiffView {...common} fileDiff={drawn} onExpand={shared ? expand : undefined} focus={scope === "file" ? { line: to.range.start, side: "additions" } : undefined} />
      ) : (
        <div class="note">loading…</div>
      )}
      </div>
    </>
  );
}

function CodeArea({ d }: { d: Detail }) {
  const sel = clampStep(d, selectedStep.value);
  const mode = codeMode.value;
  const step = d.timeline[sel]!;
  const pair = diffPair(d, sel, diffBase.value);
  const first = d.timeline[0]!;
  const [from, to] = mode === "diff" && pair ? [pair.from, pair.to] : mode === "now" ? [step, step] : [first, first];
  const area = useRef<HTMLDivElement>(null);
  // A click or a focused field in the lines or the rendered text puts the keys on the code, one outside the code
  // column takes them back; the tabs and the line above the code leave them where they are.
  useEffect(() => {
    const follow = (e: Event) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el || !area.current?.contains(el)) leaveCode();
      else if (el.closest(".code-body")) codeFocus.value = true;
    };
    window.addEventListener("pointerdown", follow, true);
    window.addEventListener("focusin", follow, true);
    return () => {
      window.removeEventListener("pointerdown", follow, true);
      window.removeEventListener("focusin", follow, true);
    };
  }, []);
  const focused = codeFocus.value;
  return (
    <div class={`code-area${focused ? " code-focus" : ""}`} ref={area}>
      <div class="code-tabs">
        <div class="seg">
          {(["diff", "then", "now"] as const).map((m) => (
            <button class={mode === m ? "on" : ""} onClick={() => (codeMode.value = m)} title="t cycles">
              {m === "diff" ? "Diff" : m === "then" ? `Then (${first.label})` : `At ${step.label}`}
            </button>
          ))}
        </div>
        {mode === "diff" && sel > 1 ? (
          <div class="seg" title="p toggles">
            <button class={diffBase.value === "then" ? "on" : ""} onClick={() => (diffBase.value = "then")}>vs then</button>
            <button class={diffBase.value === "prev" ? "on" : ""} onClick={() => (diffBase.value = "prev")}>vs previous step</button>
          </div>
        ) : null}
        {d.thread.region ? (
          <span class="hint">a thread on an area of an image: the frame marks it · new areas are drawn on the Changes page</span>
        ) : (
          <>
            <span class="hint">
              {focused ? (
                <>
                  in the code: <Kbd>j</Kbd> <Kbd>k</Kbd> · <Kbd>V</Kbd> select · <Kbd>i</Kbd> comment · <Kbd>Esc</Kbd> leaves
                </>
              ) : (
                <>
                  click a line or + to comment, or <Kbd>V</Kbd> <Kbd>i</Kbd> · double-click a name: find usages
                </>
              )}
            </span>
            <span class="spacer" />
            <button class={`btn ghost small${wrap.value ? " on" : ""}`} title="w" onClick={() => (wrap.value = !wrap.value)}>wrap</button>
            <button class="btn ghost small" onClick={() => (diffStyle.value = diffStyle.value === "split" ? "unified" : "split")}>
              {diffStyle.value === "split" ? "unified" : "split"}
            </button>
          </>
        )}
      </div>
      {d.thread.region ? <ImageArea key={`${from.index}-${to.index}`} d={d} from={from} to={to} /> : <CodeBlock key={`${from.index}-${to.index}`} d={d} from={from} to={to} />}
    </div>
  );
}

export async function resolveCurrent(reason: "fixed" | "wontfix" | "answered" | null): Promise<void> {
  const d = detail.value;
  const rid = reviewId.value;
  if (!d || rid === null || d.thread.draft) return;
  if (await guard(api.resolve(rid, d.thread.id, reason))) {
    notify(d.thread.status === "resolved" ? `#${d.thread.id}: reason ${reason ?? "cleared"}` : `resolved #${d.thread.id} · X reopens it`);
    await reloadAll();
  }
}

export async function reopenCurrent(): Promise<void> {
  const d = detail.value;
  const rid = reviewId.value;
  if (!d || rid === null) return;
  if (await guard(api.reopen(rid, d.thread.id))) await reloadAll();
}

export async function openExternal(): Promise<void> {
  const d = detail.value;
  const rid = reviewId.value;
  if (!d || rid === null) return;
  const r = await guard(api.open(rid, d.thread.id));
  if (!r) return;
  if (r.launched) {
    notify("opened in the editor");
    return;
  }
  try {
    await navigator.clipboard.writeText(r.command);
    notify(`copied: ${r.command}`);
  } catch {
    notify(r.command);
  }
}

const WAITS: Record<string, string> = {
  question: "The agent asked you a question and waits for your answer.",
  fixed: "The agent says it fixed this. Check the code, then resolve (x) or reply (r).",
  disagree: "The agent disagrees. Read why, then resolve (x) or answer (r).",
  answered: "The agent answered. Resolve (x) if that settles it, or reply (r).",
};

function lastPublished(d: Detail): CommentDto | null {
  const pub = d.comments.filter((c) => !c.draft);
  return pub[pub.length - 1] ?? null;
}

function StateStrip({ d }: { d: Detail }) {
  const t = d.thread;
  const myDraft = d.comments.some((c) => c.draft && c.role === "reviewer");
  if (t.draft) return <div class="state-strip draft">Draft thread: the agent sees it after you submit the review (<Kbd>S</Kbd>).</div>;
  if (t.status === "resolved") {
    return (
      <div class="state-strip resolved">
        <b>✓ Resolved</b>
        {t.resolveReason ? <> · {t.resolveReason === "wontfix" ? "won't fix" : t.resolveReason}</> : null}
        {t.resolvedBy ? <> · by {t.resolvedBy === "reviewer" ? "you" : t.resolvedBy}</> : null}
        {t.resolvedAt ? <span title={t.resolvedAt}> · {ago(t.resolvedAt)}</span> : null}
        <span class="spacer" />
        <button class="btn small" onClick={() => void reopenCurrent()}>Reopen <Kbd>X</Kbd></button>
      </div>
    );
  }
  const last = lastPublished(d);
  if (!last) return null;
  if (last.role === "reviewer") {
    return (
      <div class="state-strip waiting">
        Waiting for the agent: it has your last message.
        {myDraft ? <> Your newer reply is a draft: it goes out when you submit the review (<Kbd>S</Kbd>).</> : null}
      </div>
    );
  }
  const refs = threadRefs(last.body).filter((id) => id !== t.id);
  const since = last.intent === "fixed" ? unchangedSince(d, last) : null;
  return (
    <div class={`state-strip turn intent-${last.intent ?? "none"}`}>
      <b>Your turn.</b> {WAITS[last.intent ?? ""] ?? "The agent replied."}
      {refs.length ? (
        <>
          {" "}It refers to{" "}
          {refs.map((id, i) => (
            <>
              {i ? ", " : ""}
              <ThreadRef id={id}>#{id}</ThreadRef>
            </>
          ))}.
        </>
      ) : null}
      {since ? <span class="warn-text"> ⚠ The commented lines are the same as at {since}: the fix may be elsewhere, or not made yet.</span> : null}
      {myDraft ? <> Your reply is a draft: submit the review (<Kbd>S</Kbd>) to send it.</> : null}
    </div>
  );
}

export function ThreadDetailView({ id }: { id: number }) {
  const d = detail.value;
  const rid = reviewId.value;
  const root = useRef<HTMLDivElement>(null);
  const msgs = useRef<HTMLDivElement>(null);

  useEffect(() => {
    compareFocus.value = id;
  }, [id]);

  useEffect(() => {
    if (!d || d.thread.id !== id) return;
    latchNew(d);
    const spot = takeSpot(location.hash);
    if (spot) apply(spot);
    if (!spot || d.comments.some((c) => c.unread)) requestAnimationFrame(() => requestAnimationFrame(openAtNews));
  }, [d?.thread.id]);

  useEffect(() => {
    if (!d || d.thread.id !== id || !d.thread.unread || rid === null) return;
    const timer = setTimeout(async () => {
      await guard(api.read(rid, id));
      threads.value = threads.value.map((t) => (t.id === id ? { ...t, unread: false } : t));
      const cur = detail.value;
      if (cur && cur.thread.id === id) detail.value = { ...cur, thread: { ...cur.thread, unread: false } };
    }, 800);
    return () => clearTimeout(timer);
  }, [d?.thread.id, d?.thread.unread]);

  if (!d || d.thread.id !== id) return <div class="empty">loading thread #{id}…</div>;
  const t = d.thread;
  const sel = clampStep(d, selectedStep.value);
  const prev = stepThread(ordered.value, t.id, -1);
  const next = stepThread(ordered.value, t.id, 1);
  const unread = stepUnread(ordered.value, t.id, 1);
  const back = lastCompare.value ? { name: "compare" as const, ...lastCompare.value } : { name: "home" as const };
  const msgsW = widthOf("msgs");
  const left = swapped("thread");

  return (
    <div class={`detail${t.status === "resolved" ? " resolved" : ""}${left ? " msgs-left" : ""}`} ref={root} style={msgsW ? `--msgs-w: ${msgsW}px` : ""}>
      <div class="detail-head">
        <h2>
          <span class="tid">#{t.id}</span> <span class="path">{t.anchor.path ?? t.path}</span>
          <span class="line">{t.region ? ` · ${whereText(t)}` : `:${rangeText(t.anchor.range ?? t.range)}`}</span>
        </h2>
        <div class="head-badges">
          <ThreadBadges t={t} />
          {t.anchor.path && t.anchor.path !== t.path ? <Badge tone="info">was {t.path}</Badge> : null}
          <Badge tone="muted">written on {d.timeline[0]!.label}</Badge>
        </div>
        <div class="head-actions">
          {t.status === "open" ? (
            <button class="btn small" disabled={t.draft} onClick={() => void resolveCurrent(null)} title="x">Resolve</button>
          ) : (
            <>
              <select
                title="optional: why it was closed (shown as a badge, and in `stet threads list` for the agent)"
                value={t.resolveReason ?? ""}
                onChange={(e) => {
                  (e.target as HTMLElement).blur();
                  void resolveCurrent(((e.target as HTMLSelectElement).value || null) as "fixed" | "wontfix" | "answered" | null);
                }}
              >
                <option value="">no reason</option>
                <option value="fixed">fixed</option>
                <option value="wontfix">won't fix</option>
                <option value="answered">answered</option>
              </select>
              <button class="btn small" onClick={() => void reopenCurrent()} title="X">Reopen</button>
            </>
          )}
          <button class="btn ghost small" onClick={() => void openExternal()} title="e">Editor</button>
          <a class="btn ghost small" title="Esc" {...link(back)}>Back to the changes</a>
        </div>
        <div class="thread-nav">
          {prev !== null && prev !== t.id ? <a class="btn ghost small" {...link({ name: "thread", id: prev })}>‹ prev <Kbd>k</Kbd></a> : <button class="btn ghost small" disabled>‹ prev <Kbd>k</Kbd></button>}
          {next !== null && next !== t.id ? <a class="btn ghost small" {...link({ name: "thread", id: next })}>next <Kbd>j</Kbd> ›</a> : <button class="btn ghost small" disabled>next <Kbd>j</Kbd> ›</button>}
          {unread !== null ? <a class="btn ghost small" {...link({ name: "thread", id: unread })}>next unread <Kbd>n</Kbd></a> : <button class="btn ghost small" disabled>next unread <Kbd>n</Kbd></button>}
          <span class="hint">
            <Kbd>[</Kbd> <Kbd>]</Kbd> timeline step · <Kbd>t</Kbd> diff / then / at step · <Kbd>r</Kbd> reply · <Kbd>x</Kbd> resolve · <Kbd>/</Kbd> search files · <Kbd>Ctrl+O</Kbd> jump back · <Kbd>Esc</Kbd> back
          </span>
        </div>
      </div>
      <StateStrip d={d} />
      <div class="thread-code">
        <Timeline detail={d} selected={sel} onSelect={(i) => (selectedStep.value = i)} />
        <CodeArea key={t.id} d={d} />
        <PeekView />
      </div>
      <Splitter
        id="msgs"
        kind="msgs-splitter"
        target={() => msgs.current}
        grows={left ? "right" : "left"}
        min={300}
        max={() => Math.max(320, (root.current?.clientWidth ?? 1200) - 420)}
        swap={{ title: `conversation to the ${left ? "right" : "left"} of the code · Space u l`, run: () => toggleSwap("thread") }}
      />
      <div class="thread-msgs" ref={msgs}>
        <Conversation detail={d} />
        <Composer
          key={`reply-${t.id}`}
          storageKey={`reply:${rid}:${t.id}`}
          focusSignal={composerFocus.value}
          append={replyQuote.value}
          placeholder={t.draft ? "Add to this draft thread…" : "Reply to the thread…  (r)"}
          onSubmit={async (body, mode) => {
            if (rid === null) return false;
            const r = await guard(api.reply(rid, t.id, { body, draft: mode === "draft" }));
            if (!r) return false;
            notify(mode === "draft" ? "draft reply saved · the agent sees it after you submit the review" : "reply sent to the agent");
            await reloadAll();
          }}
        />
      </div>
    </div>
  );
}
