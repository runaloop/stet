import { CodeView, parsePatchFiles, type CodeViewItem, type CodeViewScrollTarget, type DiffLineAnnotation, type FileDiffMetadata, type LineAnnotation, type SelectedLineRange } from "@pierre/diffs";
import { effect } from "@preact/signals";
import { render, type ComponentChild } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { isPixelImage, isSvg } from "../../src/core/image.ts";
import type { ComparePlacement } from "../../src/core/types.ts";
import { api } from "../api.ts";
import { Kbd } from "../components/Bits.tsx";
import { mount, workerPool } from "../components/Code.tsx";
import { FileGitMarks } from "../components/GitState.tsx";
import { GuideToggle, GuideView } from "../components/Guide.tsx";
import { ImageDiff } from "../components/ImageView.tsx";
import { MarkdownView } from "../components/MarkdownView.tsx";
import { hi, lo, PendingBox } from "../components/NewThread.tsx";
import { askRestore, restorable } from "../components/Restore.tsx";
import { ThreadMini } from "../components/ThreadMini.tsx";
import { CommitPicker } from "../components/CommitPicker.tsx";
import { commitPicker, commits, isSha, loadCommits } from "../commits.ts";
import {
  compareData,
  baseFiles,
  changeReveal,
  isWhole,
  revealNow,
  compareFiles,
  compareNav,
  activeFile,
  fileRows,
  groupsOpen,
  imagePending,
  landings,
  isCollapsed,
  linkedLines,
  setFileView,
  fileView,
  markdownView,
  isViewed,
  marksByPath,
  marksFor,
  cursor,
  cursorLayer,
  cursorSpace,
  drawnFiles,
  fileBlocks,
  pendingLines,
  type PendingLines,
  searchQuery,
  searchRegex,
  setCursor,
  resolvedIds,
  setViewed,
  shownPlacements,
  toggleFile,
  viewed,
  visibleFiles,
  visualAnchor,
  fileOpen,
  peek,
  sideTab,
  spotThread,
} from "../compare.ts";
import { MARK_CSS, paintMarks } from "../lib/marks.ts";
import { isMarkdown } from "../lib/markdown.ts";
import { CHUNK, expansionOf, newLineOf, textLines, withSpan, type Reveal } from "../lib/reveal.ts";
import { rowPosition, type Cursor, type LineRange, type Seen } from "../lib/cursor.ts";
import { compareOrder } from "../lib/nav.ts";
import { PeekView } from "./Peek.tsx";
import { plusLines } from "../plus.ts";
import { blocksInSight, codeTop, lineAt, linesInSight, onScreen, placeAt, renderedTop, rowElement, stopElement } from "./anchor.ts";
import { holdFade, snapshot, visibleBox } from "../lib/fade.ts";
import { Presets, rangeTitle, ReviewedButton, VersionStrip } from "../components/VersionStrip.tsx";
import { takeSpot } from "../jumps.ts";
import { compileQuery, diffRows } from "../lib/search.ts";
import type { Side } from "../lib/search.ts";
import { compareFocus, diffStyle, guard, navigate, noteJump, notify, reloadAll, reviewId, route, showResolved, status, threads, wrap } from "../state.ts";

function FileToggle({ path }: { path: string }) {
  const fd = compareFiles.value?.find((f) => f.name === path);
  if (!fd) return null;
  const collapsed = isCollapsed(fd);
  const here = cursor.value?.path === path && cursor.value.row === -1;
  return (
    <button class={`file-toggle${here ? " at-cursor" : ""}`} title={collapsed ? "show this file" : "collapse this file"} onClick={() => toggleFile(fd)}>
      {collapsed ? "▸" : "▾"}
    </button>
  );
}

function FileMeta({ path }: { path: string }) {
  const fd = compareFiles.value?.find((f) => f.name === path);
  if (!fd) return null;
  const rows = fileRows.value;
  const at = rows.findIndex((r) => r.fd === fd);
  const row = rows[at];
  const next = row?.section ? rows.findIndex((r, i) => i > at && r.section !== null) : -1;
  const count = (next === -1 ? rows.length : next) - at;
  return (
    <span class="file-meta">
      {row?.section ? (
        <span class="section-tag" title="files are ordered by kind: code, then resources, build and config, changed tests, docs (compare.order)">
          {row.section}: {count} file{count === 1 ? "" : "s"} from here
        </span>
      ) : null}
      {row?.keptBecause ? <span class="kept" title="a test file that is shown on purpose: tests are hidden only when they only add code">⚠ {row.keptBecause}</span> : null}
      <FileGitMarks path={path} />
      {isSvg(path) ? (
        <button class="btn ghost small svg-toggle" title="an SVG: show it as a picture or as code" onClick={() => setFileView(path, drawnFiles.value.has(path) ? "code" : "picture")}>
          {drawnFiles.value.has(path) ? "‹/› code" : "▣ picture"}
        </button>
      ) : isMarkdown(path) ? (
        <button class="btn ghost small md-toggle" title="Markdown: show it rendered or as code" onClick={() => (compareHandle.current?.switchView ?? setFileView)(path, drawnFiles.value.has(path) ? "code" : "rendered")}>
          {drawnFiles.value.has(path) ? "‹/› code" : "¶ rendered"}
        </button>
      ) : null}
      {isMarkdown(path) && fd && fd.type !== "new" && fd.type !== "deleted" ? (
        <button
          class={`btn ghost small md-whole${isWhole(path) ? " on" : ""}`}
          title={isWhole(path) ? "show only the changes and the lines opened around them, rendered and as code" : "show the whole file, rendered and as code"}
          onClick={() => (compareHandle.current?.wholeFile ?? ((p: string, on: boolean) => void changeReveal(p, (r) => ({ ...r, full: on }))))(path, !isWhole(path))}
        >
          full file
        </button>
      ) : null}
      <label class="viewed" title="mark as viewed: the file collapses until its content changes">
        <input type="checkbox" checked={isViewed(fd)} onChange={(e) => setViewed(fd, (e.target as HTMLInputElement).checked)} /> viewed
      </label>
    </span>
  );
}

function FoldFooter() {
  const rows = fileRows.value;
  const open = groupsOpen.value;
  const groups = (["tests", "generated"] as const)
    .map((g) => {
      const list = rows.filter((r) => r.group === g);
      const add = list.reduce((s, r) => s + r.fd.hunks.reduce((a, h) => a + h.additionLines, 0), 0);
      const del = list.reduce((s, r) => s + r.fd.hunks.reduce((a, h) => a + h.deletionLines, 0), 0);
      return { g, n: list.length, add, del };
    })
    .filter((x) => x.n > 0);
  if (groups.length === 0) return null;
  return (
    <div class="fold-footer">
      {groups.map(({ g, n, add, del }) => (
        <div class="fold-group">
          <button class="btn small" onClick={() => (groupsOpen.value = { ...open, [g]: !open[g] })}>
            {open[g] ? "▾ hide" : "▸ show"} {n} {g === "tests" ? "test" : "generated / lock"} file{n === 1 ? "" : "s"}
          </button>{" "}
          <span class="stat"><span class="add">+{add}</span> <span class="del">−{del}</span></span>{" "}
          <span class="hint">
            {g === "tests"
              ? "only new test code: nothing removed, no skip markers. Tests that remove or change lines stay in the list above."
              : "matched by compare.collapse"}
          </span>
        </div>
      ))}
    </div>
  );
}

function FoldSummary() {
  const rows = fileRows.value;
  const open = groupsOpen.value;
  const kept = rows.filter((r) => r.keptBecause).length;
  const groups = (["tests", "generated"] as const).map((g) => ({ g, list: rows.filter((r) => r.group === g) })).filter((x) => x.list.length);
  if (!groups.length && !kept) return null;
  return (
    <span class="fold-summary">
      {groups.map(({ g, list }) => {
        const what = `${list.length} ${g === "tests" ? "test" : "generated / lock"} file${list.length === 1 ? "" : "s"}`;
        return (
          <button
            class={`btn ghost small fold-${g}`}
            title={g === "tests" ? "test files that only add code (nothing removed or changed, no skip markers) are folded into one group at the end · Space u t" : "files matched by compare.collapse"}
            onClick={() => (open[g] ? (groupsOpen.value = { ...open, [g]: false }) : compareNav.current?.scrollToFile(list[0]!.fd.name))}
          >
            {open[g] ? `▾ ${what} shown · hide` : `▸ ${what} with only new code folded · show`}
          </button>
        );
      })}
      {kept ? (
        <span class="kept" title="a test that removes or changes lines, adds a skip marker or is deleted is never folded: that is how a test gets weakened">
          ⚠ {kept} changed test file{kept === 1 ? "" : "s"} stay{kept === 1 ? "s" : ""} in the diff
        </span>
      ) : null}
    </span>
  );
}

type Viewer = "image" | "markdown";
type Anno = { kind: "thread"; placement: ComparePlacement } | { kind: "new" } | { kind: Viewer; path: string; version: number };
type SelectionContext = { item: { id: string; fileDiff?: FileDiffMetadata } };

/**
 * What a file is drawn as instead of its lines: a picture for an image git calls binary, or for an SVG unless the
 * reader picked its code or lines of it have threads; rendered Markdown unless the reader or `compare.markdown` picked
 * its code.
 */
function viewerOf(fd: FileDiffMetadata, placed: ComparePlacement[] | undefined): Viewer | null {
  if (fd.hunks.length === 0 && isPixelImage(fd.name)) return "image";
  if (isMarkdown(fd.name)) return (fileView.value.get(fd.name) ?? markdownView.value) === "rendered" ? "markdown" : null;
  if (!isSvg(fd.name)) return null;
  const view = fileView.value.get(fd.name);
  if (view) return view === "picture" ? "image" : null;
  return (placed ?? []).some((p) => !threads.peek().find((t) => t.id === p.threadId)?.region) ? null : "image";
}

// The empty file a viewer is drawn on gets a key of its own: pierre takes an equal file (same name, same empty text) for
// the one it drew earlier, and then fails with "rendered a different file than its prepared layout".
let viewerFiles = 0;
const viewerFile = (name: string) => ({ name, contents: "", cacheKey: `stet-viewer-${++viewerFiles}` });

/** True when a file kept from `before` to `after` sits at another index. */
type Expandable = { expandHunk: (hunk: number, direction: "up" | "down" | "both", count?: number) => void };
const ownExpand = new WeakMap<Expandable, Expandable["expandHunk"]>();

/**
 * The "show more" bars of a Markdown file's code open lines in the model its rendered view shares (they come back as
 * context of the file's diff), not in pierre's own state, so both views show the same lines.
 */
function sharedExpansion(inst: Expandable, path: string): void {
  if (!ownExpand.has(inst)) ownExpand.set(inst, inst.expandHunk);
  if (!isMarkdown(path)) {
    inst.expandHunk = ownExpand.get(inst)!;
    return;
  }
  inst.expandHunk = (hunk, direction, count) =>
    void changeReveal(path, (r) => {
      const d = compareData.peek();
      const fd = compareFiles.peek()?.find((f) => f.name === path);
      const text = d && fd ? (fd.type === "deleted" ? "" : api.loadedBlob(d.to.sha, path)?.contents) : null;
      const span = fd && typeof text === "string" ? expansionOf(fd.hunks, textLines(text).lines.length, hunk, direction, count ?? CHUNK) : null;
      return span ? withSpan(r, span) : r;
    });
}

function moved(before: string[], after: string[]): boolean {
  const at = new Map(after.map((id, i) => [id, i]));
  return before.some((id, i) => at.has(id) && at.get(id) !== i);
}

function annotationsFor(placements: ComparePlacement[] | undefined, pending: PendingLines | null, path: string): DiffLineAnnotation<Anno>[] {
  const out: DiffLineAnnotation<Anno>[] = (placements ?? []).map((p) => ({ side: p.side, lineNumber: p.range.end, metadata: { kind: "thread", placement: p } }));
  if (pending && pending.path === path && !pending.guide) {
    out.push({ side: pending.range.side === "deletions" ? "deletions" : "additions", lineNumber: hi(pending.range), metadata: { kind: "new" } });
  }
  return out;
}

export function CompareView({ from, to }: { from: string; to: string }) {
  const data = compareData.value;
  const files = compareFiles.value;
  const [error, setError] = useState<string | null>(null);
  const pendingKey = `stet.pending.${reviewId.value}.${from}..${to}`;
  // read once as the page opens, like a state: the box stays put while the range in the address settles
  useState(() => {
    try {
      const raw = localStorage.getItem(pendingKey);
      pendingLines.value = raw ? (JSON.parse(raw) as PendingLines) : null;
    } catch {
      pendingLines.value = null;
    }
  });
  useEffect(() => () => void (pendingLines.value = null), []);
  const pending = pendingLines.value;
  const setPending = (p: PendingLines | null) => {
    pendingLines.value = p;
    try {
      if (p) localStorage.setItem(pendingKey, JSON.stringify(p));
      else localStorage.removeItem(pendingKey);
    } catch {
      return;
    }
  };
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<CodeView<Anno> | null>(null);
  const rid = reviewId.value;
  const seq = status.value?.lastSeq ?? 0;
  const pinned = status.value?.pinnedNow ?? null;

  useEffect(() => {
    if (rid === null) return;
    let live = true;
    setError(null);
    api.compare(rid, from, to).then(
      (d) => {
        if (!live) return;
        const cur = compareData.value;
        if (cur && (cur.from.sha !== d.from.sha || cur.to.sha !== d.to.sha)) baseFiles.value = null;
        compareData.value = d;
      },
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [rid, from, to, seq, pinned]);

  useEffect(() => {
    if (!data) return;
    let live = true;
    const base = baseFiles.peek() as (FileDiffMetadata[] & { key?: string }) | null;
    if (base?.key === `${data.from.sha}-${data.to.sha}`) return;
    api.patch(data.from.sha, data.to.sha).then(
      (text) => {
        if (!live) return;
        const parsed = parsePatchFiles(text, `${data.from.sha}-${data.to.sha}`).flatMap((p) => p.files) as FileDiffMetadata[] & { key?: string };
        parsed.key = `${data.from.sha}-${data.to.sha}`;
        fileOpen.value = new Map();
        baseFiles.value = parsed;
      },
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [data?.from.sha, data?.to.sha]);

  const shown = shownPlacements.value;
  const outside = (data?.outside ?? []).filter((id) => showResolved.value || !resolvedIds.value.has(id));
  const hiddenCount = (data?.placements.length ?? 0) - shown.length + (data?.outside.length ?? 0) - outside.length;
  const byPath = useMemo(() => {
    const m = new Map<string, ComparePlacement[]>();
    for (const p of shown) m.set(p.path, [...(m.get(p.path) ?? []), p]);
    return m;
  }, [shown]);
  const visible = visibleFiles.value;
  const order = useMemo(() => compareOrder(shown, visible.map((f) => f.name)), [shown, visible]);

  // Lines picked with the mouse, by a drag over the line numbers or + (the lines of a text selection, if any): the
  // cursor goes to the last of them, so the keys go on from there.
  const startThread = (range: SelectedLineRange | null, ctx: SelectionContext) => {
    if (!range) return;
    if (range.endSide && range.side && range.endSide !== range.side) {
      notify("select lines on one side of the diff: removed or added lines", "error");
      return;
    }
    const at = cursorSpace.peek().locate(ctx.item.id, range.side === "deletions" ? "deletions" : "additions", hi(range));
    if (at) cursor.value = at;
    visualAnchor.value = null;
    // pierre marks the line under + as selected once the click is over: the lines picked instead, after it
    queueMicrotask(() => {
      const shown = view.current?.getSelectedLines();
      if (shown?.id !== ctx.item.id || shown.range.start !== range.start || shown.range.end !== range.end) view.current?.setSelectedLines({ id: ctx.item.id, range }, { notify: false });
    });
    setPending({ path: ctx.item.id, oldPath: ctx.item.fileDiff?.prevName ?? ctx.item.id, range });
  };

  const cancelPending = () => {
    setPending(null);
    imagePending.value = null;
    view.current?.clearSelectedLines();
  };

  const createThread = async (body: string, mode: "draft" | "now") => {
    const pending = pendingLines.peek();
    if (!pending || !data || rid === null) return false;
    const side = pending.range.side === "deletions" ? "old" : "new";
    const t = await guard(
      api.addThread(rid, {
        path: side === "old" ? pending.oldPath : pending.path,
        start: lo(pending.range),
        end: hi(pending.range),
        side,
        at: side === "old" ? data.from.sha : data.to.sha,
        body,
        draft: mode === "draft",
      }),
    );
    if (!t) return false;
    setPending(null);
    view.current?.clearSelectedLines();
    compareFocus.value = t.id;
    notify(mode === "draft" ? `draft #${t.id} saved · the agent sees it after you submit the review` : `thread #${t.id} sent to the agent`, "info", { label: `open #${t.id}`, route: { name: "thread", id: t.id } });
    await reloadAll();
  };

  const createRestore = async (body: string) => {
    const pending = pendingLines.peek();
    const from = restorable(data?.from.label);
    if (!pending || !data || !from || pending.range.side !== "deletions") return false;
    const c = await askRestore({ from, path: pending.oldPath, start: lo(pending.range), end: hi(pending.range), at: data.to.sha, body });
    if (!c) return false;
    setPending(null);
    view.current?.clearSelectedLines();
    compareFocus.value = c.threadId;
    return true;
  };

  const reveal = (path: string, expand: boolean): boolean => {
    const row = fileRows.value.find((r) => r.fd.name === path);
    if (!row) return false;
    let changed = false;
    if (row.hidden && row.group) {
      groupsOpen.value = { ...groupsOpen.value, [row.group]: true };
      changed = true;
    }
    if (expand && isCollapsed(row.fd)) {
      const open = new Map(fileOpen.value);
      open.set(path, true);
      fileOpen.value = open;
      changed = true;
    }
    return changed;
  };

  const pendingScroll = useRef<CodeViewScrollTarget | null>(null);
  // run once the next list of items is drawn, when a file switched between code and a picture or rendered text
  const afterDraw = useRef<(() => void)[]>([]);
  const parked = useRef<{ path: string; block: number; line: Cursor } | null>(null);
  const scrollOrQueue = (target: CodeViewScrollTarget, wait: boolean) => {
    if (wait) pendingScroll.current = target;
    else view.current?.scrollTo(target);
  };

  /** Whether the reader scrolled, clicked or typed since this was called, for `ms`. */
  const readerMoved = (ms: number) => {
    let moved = false;
    const stop = () => (moved = true);
    const events = ["wheel", "pointerdown", "keydown"] as const;
    for (const ev of events) window.addEventListener(ev, stop, { capture: true, passive: true });
    setTimeout(() => {
      for (const ev of events) window.removeEventListener(ev, stop, { capture: true });
    }, ms);
    return () => moved;
  };

  // Images, rendered Markdown and the thread cards under lines measure their height only when drawn, and the ones
  // drawn around a jump move it: jump again once they are measured, unless the reader scrolls, clicks or types meanwhile.
  const settle = (target: CodeViewScrollTarget) => {
    const moved = readerMoved(1500);
    for (const ms of [250, 700, 1400]) setTimeout(() => moved() || view.current?.scrollTo(target), ms);
  };

  const settleOn = (path: string) => {
    if (isPixelImage(path) || drawnFiles.peek().has(path)) settle({ type: "item", id: path, align: "start" });
  };

  const scrollToThread = (id: number) => {
    const p = order.find((x) => x.threadId === id);
    if (!p || !view.current) return false;
    if (isMarkdown(p.path) && drawnFiles.peek().has(p.path)) {
      whenLaidOut(p.path, () => {
        const block = cursorSpace.peek().locate(p.path, p.side, p.range.start);
        if (block) revealBlock(p.path, block.row, "center", p.side);
      });
    } else if (threads.peek().find((t) => t.id === id)?.region) {
      view.current.scrollTo({ type: "item", id: p.path, align: "start" });
      settleOn(p.path);
    } else scrollOrQueue({ type: "line", id: p.path, lineNumber: p.range.end, side: p.side, align: "center" }, codeOf(p.path));
    return true;
  };

  // A copy of the files on screen, faded out over them once the view under it is in place.
  const coverView = (h: HTMLElement) => snapshot(visibleBox(h), [...h.querySelectorAll("diffs-container, .codeview-footer")]);

  // Lines of an SVG shown as a picture or of rendered Markdown: show its code first.
  const codeOf = (path: string): boolean => {
    if (!(isSvg(path) || isMarkdown(path)) || !drawnFiles.peek().has(path)) return false;
    setFileView(path, "code");
    return true;
  };

  const scrollToLine = (path: string, side: Side, line: number, align: "center" | "start" = "center") => {
    const h = host.current;
    const fade = h && (isSvg(path) || isMarkdown(path)) && drawnFiles.peek().has(path) ? coverView(h) : null;
    const switched = codeOf(path);
    const target: CodeViewScrollTarget = { type: "line", id: path, lineNumber: line, side, align, offset: align === "start" ? 60 : 0 };
    scrollOrQueue(target, reveal(path, true) || switched);
    // the queued scroll runs in the frame after the draw
    if (fade) afterDraw.current.push(() => requestAnimationFrame(() => requestAnimationFrame(fade.go)));
    return target;
  };

  // A search hit in a rendered Markdown file goes to its block when the rendered text has the match; a match only the
  // source has (a link address, a picture's path, markup) shows the file as code.
  const showHit = (path: string, side: Side, line: number) => {
    if (!(isMarkdown(path) && drawnFiles.peek().has(path))) return scrollToLine(path, side, line);
    whenLaidOut(path, () => {
      const at = cursorSpace.peek().locate(path, side, line);
      const nav = at ? cursorSpace.peek().block(at) : null;
      const span = nav ? (side === "deletions" ? nav.old : nav.new) : null;
      const el = at && span && span.start <= line && line <= span.end ? stopElement(path, at.row, side) : null;
      const re = compileQuery(searchQuery.peek(), searchRegex.peek());
      if (at && el && re instanceof RegExp && ((re.lastIndex = 0), re.test(el.textContent ?? ""))) {
        cursor.value = at;
        revealBlock(path, at.row, "center", side);
        return;
      }
      notify(`${path}: the match is in the Markdown source, not in the rendered text, so the file shows as code`);
      scrollToLine(path, side, line);
    });
  };

  const scrollToFile = (path: string) => {
    scrollOrQueue({ type: "item", id: path, align: "start" }, reveal(path, false));
    settleOn(path);
  };

  // Runs `fn` once the rendered Markdown file has laid out its blocks for the cursor; the file is scrolled to when it
  // is not drawn (at once, or with `later` only if it is still not drawn a moment later).
  const whenLaidOut = (path: string, fn: () => void, later = false) => {
    const fd = files?.find((f) => f.name === path);
    const ready = () => !!fd && fileBlocks.peek().get(path)?.fd === fd && !!stopElement(path, 0);
    if (ready()) return fn();
    const drawn = () => !!document.querySelector(`.md-anno [data-file="${CSS.escape(path)}"]`);
    if (!later && !drawn()) view.current?.scrollTo({ type: "item", id: path, align: "start" });
    if (later) setTimeout(() => drawn() || view.current?.scrollTo({ type: "item", id: path, align: "start" }), 150);
    const end = performance.now() + 5000;
    const free = holdFade();
    const poll = () => {
      if (ready()) fn();
      else if (performance.now() < end) return void requestAnimationFrame(poll);
      free();
    };
    requestAnimationFrame(poll);
  };

  // A block of rendered Markdown, by its place among the file's blocks (`data-stop`): drawn inside the file's one row,
  // so pierre cannot scroll to it. It is kept in place while pictures around it load.
  const revealBlock = (path: string, stop: number, align: "nearest" | "center" | "start", side: Side = "additions") => {
    const h = host.current;
    if (!h) return;
    const find = () => stopElement(path, stop, side);
    const el = find();
    const height = h.clientHeight;
    const box = el?.getBoundingClientRect();
    const now = box ? box.top - h.getBoundingClientRect().top : null;
    const head = 72;
    const centered = box ? Math.max(head, (height - box.height) / 2) : height / 3;
    let y = align === "start" ? head + 24 : centered;
    if (align === "nearest" && box && now !== null) y = now < head ? head : now + box.height + 24 > height ? Math.max(head, height - box.height - 24) : now;
    if (!el) view.current?.scrollTo({ type: "item", id: path, align: "start" });
    placeAt(h, find, y, 1200);
  };

  /** The line of `span` on `side` that the diff shows, or the nearest one it shows. */
  const shownLine = (fd: FileDiffMetadata, side: Side, span: { start: number; end: number }): number => {
    const lines = diffRows(fd).flatMap((r) => (side === "deletions" ? (r.kind !== "add" && r.old !== null ? [r.old] : []) : r.kind !== "del" && r.new !== null ? [r.new] : []));
    const inside = lines.find((n) => n >= span.start && n <= span.end);
    if (inside !== undefined) return inside;
    return lines.reduce((best, n) => (Math.abs(n - span.start) < Math.abs(best - span.start) ? n : best), lines[0] ?? span.start);
  };

  // Switches a Markdown file between rendered and code and keeps the first text the reader sees where it was. The
  // topmost block in view becomes its line at the point it is scrolled to (halfway through a 10-line paragraph: its
  // 5th line), or the nearest line the diff shows; the topmost line in view becomes the block that holds it, placed so
  // that the line's share of the block sits where the line was. The ‹/› beside a block (`at`) anchors on that block.
  // The cursor goes to the anchor only when it was on screen (or with `at`); else it keeps its place in the file.
  const switchView = (path: string, to: "code" | "rendered", at?: { stop: number; side: "old" | "new" }) => {
    const h = host.current;
    const v = view.current as CodeView<never> | null;
    const fd = files?.find((f) => f.name === path);
    const c = cursor.peek();
    const here = c?.path === path && c.row >= 0;
    if (!h || !v || !fd) return setFileView(path, to);
    // the change of height around the text read is covered by a copy of the old view, faded out once the new one is in place
    const fade = coverView(h);
    const fadeLater = () => requestAnimationFrame(() => requestAnimationFrame(fade.go));
    const spanOf = (side: Side, row: number) => {
      const nav = cursorSpace.peek().block({ path, row });
      return nav ? (side === "deletions" ? nav.old : nav.new) : null;
    };
    if (to === "code") {
      const el = at ? stopElement(path, at.stop, at.side === "old" ? "deletions" : "additions") : null;
      const top = at ? (el ? { stop: at.stop, side: at.side, y: el.getBoundingClientRect().top - h.getBoundingClientRect().top, height: 0, past: 0 } : null) : renderedTop(h, path);
      const nav = top ? cursorSpace.peek().block({ path, row: top.stop }) : null;
      const seen = here && onScreen(h, stopElement(path, c!.row));
      const kept = here && !seen ? { at: cursorSpace.peek().block(c!) } : null;
      if (!top || !nav) {
        setFileView(path, "code");
        afterDraw.current.push(fadeLater);
        return;
      }
      const side: Side = (top.side === "old" || !nav.new) && nav.old ? "deletions" : "additions";
      const span = (side === "deletions" ? nav.old : nav.new)!;
      const count = span.end - span.start + 1;
      const k = Math.min(count - 1, Math.floor(top.past * count));
      const want = at ? span : { start: span.start + k, end: span.start + k };
      const y = top.y + (k / count) * top.height;
      // the text read stays in the code: its lines and a screen of lines around them join the lines shown
      const toNew = (n: number) => (side === "additions" ? n : newLineOf(fd.hunks, n));
      const rows = (px: number) => Math.ceil(Math.max(0, px) / 20) + 5;
      revealNow(path, (r) => withSpan(r, { start: Math.max(1, toNew(want.start) - rows(y)), end: toNew(want.end) + rows(h.clientHeight - y) }));
      const shown = compareFiles.peek()?.find((f) => f.name === path) ?? fd;
      const line = shownLine(shown, side, want);
      setFileView(path, "code");
      afterDraw.current.push(() => {
        const space = cursorSpace.peek();
        if (at || seen) cursor.value = space.locate(path, side, line) ?? cursor.peek();
        else if (kept?.at) {
          const s: Side = kept.at.new ? "additions" : "deletions";
          const r = (s === "additions" ? kept.at.new : kept.at.old)!;
          const moved = space.locate(path, s, shownLine(shown, s, r));
          if (moved) {
            cursor.value = moved;
            // a block the diff does not show lands on the nearest line; back in rendered it comes back to that block
            parked.current = { path, block: c!.row, line: moved };
          }
        }
        requestAnimationFrame(() => {
          const cv = view.current as CodeView<never> | null;
          if (cv) lineAt(h, cv, path, side, line, y, 1500, fade.go);
          else fade.go();
        });
      });
      return;
    }
    const top = codeTop(h, v, path);
    const r = here ? cursorSpace.peek().row(c!) : null;
    const where = r ? rowPosition(r) : null;
    const seen = !!where && onScreen(h, rowElement(v, path, where.side, where.line));
    const d = data;
    // with both texts at hand the rendered file lays out in the next frames, not after a round trip
    const texts = d ? Promise.all([fd.type === "new" ? null : api.blob(d.from.sha, fd.prevName ?? path), fd.type === "deleted" ? null : api.blob(d.to.sha, path)]) : Promise.resolve();
    void texts.catch(() => null).then(() => {
      setFileView(path, "rendered");
      if (!top && !where) {
        afterDraw.current.push(fadeLater);
        return;
      }
      afterDraw.current.push(() =>
        whenLaidOut(
          path,
          () => {
            const space = cursorSpace.peek();
            const s = top ? space.locate(path, top.side, top.line) : null;
            const back = parked.current;
            parked.current = null;
            if (seen && s) cursor.value = s;
            else if (back?.path === path && c?.row === back.line.row) cursor.value = { path, row: back.block };
            else if (where) cursor.value = space.locate(path, where.side, where.line) ?? cursor.peek();
            if (!top || !s) return fadeLater();
            const span = spanOf(top.side, s.row);
            const share = span ? Math.min(1, Math.max(0, (top.line - span.start) / (span.end - span.start + 1))) : 0;
            placeAt(h, () => stopElement(path, s.row, top.side), (el) => top.y - share * el.getBoundingClientRect().height, 2500, fade.go);
          },
          true,
        ),
      );
    });
  };

  // Shows a Markdown file whole, or again only around its changes, rendered and as code; the first text in view stays
  // where it was.
  const wholeFile = (path: string, on: boolean) => {
    const h = host.current;
    const v = view.current as CodeView<never> | null;
    const next = (r: Reveal) => ({ ...r, full: on });
    if (!h || !v) return void changeReveal(path, next);
    const fade = coverView(h);
    const fadeLater = () => requestAnimationFrame(() => requestAnimationFrame(fade.go));
    if (drawnFiles.peek().has(path)) {
      const top = renderedTop(h, path);
      const b = top ? stopElement(path, top.stop, top.side === "old" ? "deletions" : "additions")?.getAttribute("data-b") : null;
      void changeReveal(path, next).then(() => {
        if (!top || b === null || b === undefined) return fadeLater();
        const find = () => document.querySelector(`.md-view[data-file="${CSS.escape(path)}"] .md-cell[data-side="${top.side}"] [data-b="${b}"]`);
        placeAt(h, find, top.y, 1500, fade.go);
      });
      return;
    }
    const top = codeTop(h, v, path);
    void changeReveal(path, next).then(() => {
      afterDraw.current.push(() => requestAnimationFrame(() => {
        const cv = view.current as CodeView<never> | null;
        if (cv && top) lineAt(h, cv, path, top.side, top.line, top.y, 1500, fade.go);
        else fade.go();
      }));
    });
  };

  const revealCursor = (c: Cursor, align: "nearest" | "center" = "nearest") => {
    if (c.row >= 0 && cursorSpace.peek().block(c)) {
      revealBlock(c.path, c.row, align);
      return;
    }
    const r = cursorSpace.peek().row(c);
    if (!r) {
      view.current?.scrollTo({ type: "item", id: c.path, align: "nearest" });
      return;
    }
    const { side, line } = rowPosition(r);
    view.current?.scrollTo({ type: "line", id: c.path, lineNumber: line, side, align });
  };

  const cursorElement = (c: Cursor): Element | null => {
    const block = c.row >= 0 ? cursorSpace.peek().block(c) : null;
    if (block) return stopElement(c.path, c.row, block.new ? "additions" : "deletions");
    const r = cursorSpace.peek().row(c);
    const v = view.current as CodeView<never> | null;
    if (!r || !v) return null;
    const { side, line } = rowPosition(r);
    return rowElement(v, c.path, side, line);
  };

  const inSight = (): Seen[] => {
    const h = host.current;
    const v = view.current as CodeView<never> | null;
    if (!h || !v) return [];
    const space = cursorSpace.peek();
    return v.getRenderedItems().flatMap((item) => {
      if (!drawnFiles.peek().has(item.id)) return linesInSight(h, item.element, item.id, space);
      const md = document.querySelector(`.md-view[data-file="${CSS.escape(item.id)}"]`);
      return md ? blocksInSight(h, md, item.id) : [];
    });
  };

  const startComment = (range: LineRange) => {
    const fd = files?.find((x) => x.name === range.path);
    setPending({ path: range.path, oldPath: fd?.prevName ?? range.path, range: { start: range.start, end: range.end, side: range.side } });
  };

  const pageRows = () => Math.max(4, Math.floor((host.current?.clientHeight ?? 600) / 20 / 2));

  // Half a screen in a rendered file: the block that far below (or above) the cursor's block, by where they are drawn.
  const pageFrom = (c: Cursor, dir: 1 | -1): Cursor | null => {
    const nav = c.row >= 0 ? cursorSpace.peek().block(c) : null;
    const h = host.current;
    const from = nav && h ? stopElement(c.path, c.row) : null;
    if (!from || !h) return null;
    const goal = from.getBoundingClientRect().top + (dir * h.clientHeight) / 2;
    const count = cursorSpace.peek().rows(cursorSpace.peek().fileIndex(c.path)).length;
    let to = c.row;
    for (let k = c.row + dir; k >= 0 && k < count; k += dir) {
      const el = stopElement(c.path, k);
      if (!el) break;
      to = k;
      const top = el.getBoundingClientRect().top;
      if (dir === 1 ? top >= goal : top <= goal) break;
    }
    return to === c.row ? null : { path: c.path, row: to };
  };

  // A link: its lines with the cursor on the first and all of them highlighted, a range from near the top of the
  // screen; in a rendered Markdown file the blocks that hold them. Lines of a Markdown file the diff folds are opened
  // first; other lines the diff does not show open in the file's preview.
  const openTarget = (path: string, line: number | null, side: Side, end = line, opened = false) => {
    const fd = files?.find((x) => x.name === path);
    const at = side === "deletions" ? data?.from : data?.to;
    if (!fd) {
      if (at) peek.value = { path, sha: at.sha, label: at.label, line: line ?? 1 };
      return;
    }
    if (line === null) {
      scrollToFile(path);
      return;
    }
    const lines: LineRange = { path, side, start: line, end: Math.max(line, end ?? line) };
    const align = lines.end > lines.start ? "start" : "center";
    const shown = diffRows(fd)
      .flatMap((r) => (side === "deletions" ? (r.kind !== "add" ? [r.old] : []) : r.kind !== "del" ? [r.new] : []))
      .filter((n): n is number => n !== null && n >= lines.start && n <= lines.end);
    if (new Set(shown).size <= lines.end - lines.start && isMarkdown(path) && !opened) {
      const toNew = (n: number) => (side === "additions" ? n : newLineOf(fd.hunks, n));
      void changeReveal(path, (r) => withSpan(r, { start: toNew(lines.start), end: toNew(lines.end) })).then(() => {
        const again = () => latest.current.openTarget(path, line, side, lines.end, true);
        if (compareFiles.peek()?.find((f) => f.name === path) !== fd) afterDraw.current.push(again);
        else again();
      });
      return;
    }
    if (isMarkdown(path) && drawnFiles.peek().has(path)) {
      reveal(path, true);
      whenLaidOut(path, () => {
        const c = cursorSpace.peek().locate(path, side, line);
        if (c) cursor.value = c;
        linkedLines.value = lines;
        if (!c) return;
        revealBlock(path, c.row, align, side);
        // rendered files above it may grow only after it is placed, and push it out of the drawn window
        const moved = readerMoved(3000);
        for (const ms of [800, 1600, 2800])
          setTimeout(() => {
            if (!moved() && host.current && !onScreen(host.current, stopElement(path, c.row, side))) revealBlock(path, c.row, align, side);
          }, ms);
      });
      return;
    }
    const first = shown.length ? shown.reduce((a, b) => Math.min(a, b)) : null;
    if (first === null) {
      if (at) peek.value = { path, sha: at.sha, label: at.label, line };
      return;
    }
    const switching = drawnFiles.peek().has(path);
    settle(scrollToLine(path, side, first, align));
    const place = () => {
      const c = cursorSpace.peek().locate(path, side, first);
      if (c) cursor.value = c;
      linkedLines.value = lines;
    };
    // a file drawn as a picture has its lines in the cursor only once it is drawn as code
    if (switching) afterDraw.current.push(place);
    else place();
  };

  const latest = useRef({ data, pending, from, to, rid, order, visible, startThread, createThread, createRestore, cancelPending, scrollToThread, scrollToLine, showHit, scrollToFile, revealCursor, cursorElement, inSight, startComment, pageRows, pageFrom, openTarget, switchView, wholeFile });
  latest.current = { data, pending, from, to, rid, order, visible, startThread, createThread, createRestore, cancelPending, scrollToThread, scrollToLine, showHit, scrollToFile, revealCursor, cursorElement, inSight, startComment, pageRows, pageFrom, openTarget, switchView, wholeFile };

  const firstRange = useRef({ range: `${from}..${to}`, landing: landings.peek() });
  useEffect(() => {
    if (firstRange.current.range === `${from}..${to}`) return;
    // the first range of a review just switched to: the side panel's tab is the landing's
    const landed = firstRange.current.landing !== landings.peek();
    firstRange.current = { range: `${from}..${to}`, landing: landings.peek() };
    imagePending.value = null;
    linkedLines.value = null;
    if (!landed && sideTab.value === "threads") sideTab.value = "files";
  }, [from, to]);
  useEffect(() => () => void (linkedLines.value = null), []);

  const r = route.value;
  const targetKey = r.name === "compare" && r.file ? `${r.file}:${r.line ?? ""}-${r.end ?? ""}:${r.side ?? ""}` : "";
  const handledTarget = useRef(targetKey);
  // after a change of range the files are still the old range's until the new ones load: a file missing from them
  // would open in the preview instead of the diff
  const filesOfRange = !!data && data.from.ref === from && data.to.ref === to && (baseFiles.value as { key?: string } | null)?.key === `${data.from.sha}-${data.to.sha}`;
  useEffect(() => {
    if (!targetKey || handledTarget.current === targetKey || !files || !filesOfRange || r.name !== "compare") return;
    handledTarget.current = targetKey;
    latest.current.openTarget(r.file!, r.line ?? null, r.side === "old" ? "deletions" : "additions", r.end ?? r.line ?? null);
  }, [targetKey, files, filesOfRange]);

  useEffect(() => {
    const handle = {
      get order() {
        return latest.current.order;
      },
      scrollToThread: (id: number) => latest.current.scrollToThread(id),
      switchView: (path: string, to: "code" | "rendered") => latest.current.switchView(path, to),
      wholeFile: (path: string, on: boolean) => latest.current.wholeFile(path, on),
      cancelPending: () => latest.current.cancelPending(),
    };
    compareHandle.current = handle;
    const nav = {
      scrollToFile: (path: string) => {
        noteJump();
        latest.current.scrollToFile(path);
      },
      scrollToLine: (path: string, side: Side, line: number) => latest.current.scrollToLine(path, side, line),
      showHit: (path: string, side: Side, line: number) => latest.current.showHit(path, side, line),
      openLine: (path: string, side: Side, line: number) => latest.current.openTarget(path, line, side),
      showCode: (path: string, stop: number, side: "old" | "new") => latest.current.switchView(path, "code", { stop, side }),
      revealCursor: (c: Cursor, align?: "nearest" | "center") => latest.current.revealCursor(c, align),
      cursorElement: (c: Cursor) => latest.current.cursorElement(c),
      inSight: () => latest.current.inSight(),
      startComment: (range: LineRange) => latest.current.startComment(range),
      submitComment: (body: string, mode: "draft" | "now") => latest.current.createThread(body, mode),
      restoreLines: (body: string) => latest.current.createRestore(body),
      cancelComment: () => latest.current.cancelPending(),
      pageRows: () => latest.current.pageRows(),
      pageFrom: (c: Cursor, dir: 1 | -1) => latest.current.pageFrom(c, dir),
      getScrollTop: () => view.current?.getScrollTop() ?? 0,
      setScrollTop: (top: number) => view.current?.scrollTo({ type: "position", position: top }),
    };
    compareNav.current = nav;
    return () => {
      if (compareHandle.current === handle) compareHandle.current = null;
      if (compareNav.current === nav) compareNav.current = null;
    };
  }, []);

  useEffect(() => {
    if (!host.current) return;
    const headers = new Map<string, { prefix: HTMLElement; meta: HTMLElement }>();
    const header = (path: string) => {
      let h = headers.get(path);
      if (!h) headers.set(path, (h = { prefix: mount(<FileToggle path={path} />, "hdr-prefix"), meta: mount(<FileMeta path={path} />, "hdr-meta") }));
      return h;
    };
    const footer = mount(<FoldFooter />, "codeview-footer");
    // pierre drops a file's viewer when the file scrolls away and asks for one again when it comes back: hand back the
    // same one while the file is the same, so it keeps its height (a new one would start small and grow, and move
    // everything below it), and unmount it once the file changes
    const viewers = new Map<string, { version: number; el: HTMLElement }>();
    const viewer = (path: string, version: number, child: ComponentChild, className: string) => {
      const was = viewers.get(path);
      if (was?.version === version) return was.el;
      if (was) render(null, was.el);
      const el = mount(child, className);
      viewers.set(path, { version, el });
      return el;
    };
    // pierre ends a click on + as a selection of the line under it: the lines a text selection gave stay
    let plus: SelectedLineRange | null = null;
    const options = {
      diffStyle: diffStyle.value,
      overflow: wrap.value ? ("wrap" as const) : ("scroll" as const),
      themeType: "system" as const,
      lineDiffType: "word" as const,
      hunkSeparators: "line-info" as const,
      stickyHeaders: true,
      enableLineSelection: true,
      enableGutterUtility: true,
      unsafeCSS: MARK_CSS,
      loadDiffFiles: async (fd: FileDiffMetadata) => {
        const d = latest.current.data!;
        const oldPath = fd.prevName ?? fd.name;
        const [oldBlob, newBlob] = await Promise.all([api.blob(d.from.sha, oldPath), api.blob(d.to.sha, fd.name)]);
        return {
          oldFile: { name: oldPath, contents: oldBlob.contents ?? "" },
          newFile: { name: fd.name, contents: newBlob.contents ?? "" },
        };
      },
      renderHeaderPrefix: (fd: FileDiffMetadata) => header(fd.name).prefix,
      renderHeaderMetadata: (fd: FileDiffMetadata) => header(fd.name).meta,
      renderCodeViewFooter: () => footer,
      onPostRender: (node: HTMLElement, inst: unknown, phase: string, ctx: SelectionContext) => {
        if (phase === "unmount") return;
        node.toggleAttribute("data-stet-viewer", !ctx.item.fileDiff);
        paintMarks(node, marksFor(ctx.item.id));
        if (ctx.item.fileDiff) sharedExpansion(inst as Expandable, ctx.item.id);
      },
      renderAnnotation: (a: DiffLineAnnotation<Anno>) => {
        if (a.metadata.kind === "image") return viewer(a.metadata.path, a.metadata.version, <ImageDiff file={a.metadata.path} />, "anno image-anno");
        if (a.metadata.kind === "markdown") return viewer(a.metadata.path, a.metadata.version, <MarkdownView file={a.metadata.path} />, "anno md-anno");
        if (a.metadata.kind === "thread") return mount(<ThreadMini id={a.metadata.placement.threadId} state={a.metadata.placement.state} />, "anno");
        const p = pendingLines.peek();
        return p ? mount(<PendingBox p={p} />, "anno") : undefined;
      },
      // a click on a line number, or the one that ends a click on +, is a selection of lines, which moves the cursor itself
      onLineClick: (p: { lineNumber: number; annotationSide: Side; numberColumn: boolean }, ctx: SelectionContext) => {
        if (p.numberColumn) return;
        const c = cursorSpace.peek().locate(ctx.item.id, p.annotationSide, p.lineNumber);
        if (c) setCursor(c, false);
      },
      onLineSelectionEnd: (range: SelectedLineRange | null, ctx: SelectionContext) => latest.current.startThread(plus ?? range, ctx),
      onGutterUtilityClick: (range: SelectedLineRange, ctx: SelectionContext) => {
        plus = plusLines(cv.getRenderedItems().find((r) => r.id === ctx.item.id)?.element ?? null, range);
        queueMicrotask(() => (plus = null));
        latest.current.startThread(plus, ctx);
      },
    };
    const cv = new CodeView<Anno>(options as never, workerPool());
    // Rows must be measured before they scroll into view: a wrapped line is 5-6x the estimated 20 px, and with
    // pierre's 200 px a fast wheel shifts the code under the pointer (`bun run perf:scroll`).
    cv.config.overscrollSize = 1600;
    cv.setup(host.current);
    view.current = cv;

    let frame = 0;
    const spy = () => {
      frame = 0;
      const list = latest.current.visible;
      if (list.length === 0) return;
      const at = cursor.peek()?.path;
      const ci = at ? list.findIndex((f) => f.name === at) : -1;
      if (ci >= 0) {
        const top = cv.getTopForItem(at!) ?? 0;
        const bottom = ci + 1 < list.length ? (cv.getTopForItem(list[ci + 1]!.name) ?? cv.getScrollHeight()) : cv.getScrollHeight();
        if (bottom > cv.getScrollTop() && top < cv.getScrollTop() + cv.getHeight()) {
          if (activeFile.peek() !== at) activeFile.value = at!;
          return;
        }
      }
      if (cv.getScrollTop() + cv.getHeight() >= cv.getScrollHeight() - 4) {
        const last = list[list.length - 1]!.name;
        if (activeFile.peek() !== last) activeFile.value = last;
        return;
      }
      const top = cv.getScrollTop() + 40;
      let lo = 0;
      let hi = list.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((cv.getTopForItem(list[mid]!.name) ?? Infinity) <= top) lo = mid;
        else hi = mid - 1;
      }
      const name = list[lo]!.name;
      if (activeFile.peek() !== name) activeFile.value = name;
    };
    const unsubscribe = cv.subscribeToScroll(() => {
      if (!frame) frame = requestAnimationFrame(spy);
    });
    const stopPaint = effect(() => {
      marksByPath.value;
      cursorLayer.value;
      for (const r of cv.getRenderedItems()) paintMarks(r.element, marksFor(r.id));
    });
    return () => {
      stopPaint();
      unsubscribe();
      cancelAnimationFrame(frame);
      cv.cleanUp();
      for (const { el } of viewers.values()) render(null, el);
      view.current = null;
    };
  }, [diffStyle.value, wrap.value]);

  const versions = useRef({ gen: 0, byItem: new Map<string, { sig: string; version: number; fd?: FileDiffMetadata; viewer?: { file: ReturnType<typeof viewerFile>; annotations: LineAnnotation<Anno>[] } }>(), files: null as FileDiffMetadata[] | null, scrolled: false, ids: [] as string[] });
  useEffect(() => {
    const cv = view.current;
    if (!cv || !files) return;
    const v = versions.current;
    // lines opened in a Markdown file give it another diff, not another range
    const base = baseFiles.peek();
    if (v.files !== base) {
      v.files = base;
      v.byItem.clear();
      v.scrolled = false;
    }
    const pendingSig = pending ? `${pending.path}:${pending.range.side}:${pending.range.start}-${pending.range.end}` : "";
    const drawn = new Set<string>();
    const items: CodeViewItem<Anno>[] = visible.map((fd): CodeViewItem<Anno> => {
      const viewer = viewerOf(fd, byPath.get(fd.name));
      if (viewer) {
        drawn.add(fd.name);
        const collapsed = isCollapsed(fd);
        let entry = v.byItem.get(fd.name);
        if (!entry || entry.sig !== String(collapsed)) {
          const version = ++v.gen;
          entry = { sig: String(collapsed), version, viewer: { file: viewerFile(fd.name), annotations: [{ lineNumber: 1, metadata: { kind: viewer, path: fd.name, version } }] } };
          v.byItem.set(fd.name, entry);
        }
        return { id: fd.name, type: "file", file: entry.viewer!.file, annotations: entry.viewer!.annotations, version: entry.version, collapsed };
      }
      const annotations = annotationsFor(byPath.get(fd.name), pending, fd.name);
      const collapsed = isCollapsed(fd);
      const sig = JSON.stringify([collapsed, annotations.map((a) => [a.side, a.lineNumber, a.metadata.kind === "thread" ? [a.metadata.placement.threadId, a.metadata.placement.state] : pendingSig])]);
      let entry = v.byItem.get(fd.name);
      if (!entry || entry.sig !== sig || entry.fd !== fd) {
        entry = { sig, version: ++v.gen, fd };
        v.byItem.set(fd.name, entry);
      }
      return { id: fd.name, type: "diff", fileDiff: fd, annotations, version: entry.version, collapsed };
    });
    const ids = items.map((i) => i.id);
    // pierre releases only the items at the indexes it had drawn, so a drawn file that lands at another index
    // (another range: files added before it) stays in the DOM, unseen and tall; the drawn window then sticks
    // and jumps while scrolling (Chromium draws before the new list arrives)
    if (moved(v.ids, ids)) cv.setItems([]);
    v.ids = ids;
    cv.setItems(items);
    if ([...drawn].join("\n") !== [...drawnFiles.peek()].join("\n")) drawnFiles.value = drawn;
    for (const run of afterDraw.current.splice(0)) run();
    const queued = pendingScroll.current;
    if (queued) {
      pendingScroll.current = null;
      requestAnimationFrame(() => view.current?.scrollTo(queued));
    }
    if (!v.scrolled) {
      const spot = takeSpot(location.hash);
      const r = route.peek();
      const target = r.name === "compare" && r.file ? r : null;
      if (spot && spot.compareTop !== null) {
        v.scrolled = true;
        const top = spot.compareTop;
        if (spot.cursor) cursor.value = spot.cursor;
        requestAnimationFrame(() => view.current?.scrollTo({ type: "position", position: top }));
      } else if (target) {
        v.scrolled = true;
        requestAnimationFrame(() => latest.current.openTarget(target.file!, target.line ?? null, target.side === "old" ? "deletions" : "additions", target.end ?? target.line ?? null));
      } else if (compareFocus.value !== null) {
        v.scrolled = true;
        const id = compareFocus.value;
        requestAnimationFrame(() => latest.current.scrollToThread(id) && spotThread(id));
      }
    }
  }, [files, visible, byPath, pending, fileOpen.value, viewed.value, diffStyle.value, wrap.value, fileView.value, markdownView.value]);

  useEffect(() => {
    if ((isSha(from) || isSha(to)) && !commits.peek()) void loadCommits();
  }, [from, to]);
  const pickRange = (f: string, t: string) => navigate({ name: "compare", from: f, to: t });
  const rows = fileRows.value;
  const allViewed = rows.length > 0 && rows.every((x) => isViewed(x.fd));

  return (
    <div class="compare">
      <div class="compare-head">
        <h2 class="range-title" title={data ? `${data.from.label} (${data.from.sha.slice(0, 8)}) → ${data.to.label} (${data.to.sha.slice(0, 8)})` : ""}>
          {rangeTitle(from, to)}
          {data ? <span class="subtle"> · {data.files.length} file{data.files.length === 1 ? "" : "s"}</span> : null}
        </h2>
        <GuideToggle />
        <ReviewedButton to={to} toSha={data?.to.sha ?? null} allViewed={allViewed} />
        <FoldSummary />
        <span class="spacer" />
        <button class={`btn ghost small${wrap.value ? " on" : ""}`} title="w" onClick={() => (wrap.value = !wrap.value)}>wrap</button>
        <button class="btn ghost small" onClick={() => (diffStyle.value = diffStyle.value === "split" ? "unified" : "split")}>
          {diffStyle.value === "split" ? "unified" : "split"}
        </button>
      </div>
      <div class="range-bar">
        <VersionStrip from={from} to={to} onPick={pickRange} />
        <Presets from={from} to={to} onPick={pickRange} />
        <button class={`chip commits-chip${commitPicker.value ? " on" : ""}`} title="pick commits to compare (Space g c)" onClick={() => (commitPicker.value = !commitPicker.value)}>
          commits…
        </button>
      </div>
      {commitPicker.value ? <CommitPicker from={from} to={to} fromSha={data?.from.sha ?? null} toSha={data?.to.sha ?? null} onPick={pickRange} /> : null}
      {error ? <div class="note error">{error}</div> : null}
      {data ? (
        <div class="note subtle">
          {shown.length} threads on this diff{shown.length ? <> (<Kbd>]t</Kbd>/<Kbd>[t</Kbd> to step, <Kbd>Enter</Kbd> to open)</> : null} ·{" "}
          {outside.length} elsewhere
          {hiddenCount || showResolved.value ? (
            <>
              {" · "}
              <button class="link" onClick={() => (showResolved.value = !showResolved.value)}>
                {showResolved.value ? "hide resolved" : `${hiddenCount} resolved hidden · show`}
              </button>
            </>
          ) : null}
          {data.files.length === 0 ? " · no changes between these two" : ""}
          {" · "}select lines or click <b>+</b> to comment ({"j k V i"}) · <Kbd>/</Kbd> search · <Kbd>]v</Kbd> <Kbd>[v</Kbd> <Kbd>{"{"}</Kbd> <Kbd>{"}"}</Kbd> move the range · <Kbd>Space</Kbd> menu · <Kbd>?</Kbd> keys
        </div>
      ) : !error ? (
        <div class="note">loading…</div>
      ) : null}
      {data && outside.length ? (
        <details class="outside">
          <summary>Threads outside this diff ({outside.length})</summary>
          <p class="note subtle">Their code did not change between {data.from.label} and {data.to.label}, or it is gone.</p>
          {outside.map((id) => {
            const t = threads.value.find((x) => x.id === id);
            return t ? <ThreadMini id={t.id} state={t.anchor.state} /> : null;
          })}
        </details>
      ) : null}
      <div class="code-stack">
        <div class="codeview-host" ref={host} />
        <GuideView from={from} to={to} />
        <PeekView />
      </div>
    </div>
  );
}

export function stepCompareThread(dir: 1 | -1): boolean {
  const cur = compareHandle.current;
  if (!cur) return false;
  const { order, scrollToThread } = cur;
  if (order.length === 0) {
    notify("no threads on this diff");
    return true;
  }
  const i = order.findIndex((p) => p.threadId === compareFocus.value);
  const next = order[i === -1 ? (dir === 1 ? 0 : order.length - 1) : (i + dir + order.length) % order.length]!;
  compareFocus.value = next.threadId;
  if (scrollToThread(next.threadId)) spotThread(next.threadId);
  return true;
}

export function openFocusedCompareThread(): boolean {
  const id = compareFocus.value;
  if (id === null || !compareHandle.current?.order.some((p) => p.threadId === id)) return false;
  navigate({ name: "thread", id });
  return true;
}

export const compareHandle: {
  current: { order: ComparePlacement[]; scrollToThread: (id: number) => boolean; switchView: (path: string, to: "code" | "rendered") => void; wholeFile: (path: string, on: boolean) => void; cancelPending: () => void } | null;
} = { current: null };
