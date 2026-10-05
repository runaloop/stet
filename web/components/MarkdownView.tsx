import { DEFAULT_THEMES, getSharedHighlighter, type DiffsHighlighter, type FileDiffMetadata } from "@pierre/diffs";
import { render, type VNode } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { rawUrl, type BlobDto } from "../api.ts";
import {
  compareData,
  compareFiles,
  compareNav,
  currentGrepHit,
  currentHit,
  changeReveal,
  cursor,
  grepHits,
  hoverThread,
  isWhole,
  peek,
  pendingLines,
  searchQuery,
  searchRegex,
  searchResult,
  searchScope,
  setCursor,
  setFileBlocks,
  shownPlacements,
  visualAnchor,
} from "../compare.ts";
import { paintTextHits } from "../lib/marks.ts";
import { changesOf, pairsOf, renderMarkdown, rowsOf, slotsOf, stopsOf, stopsOn, subtree, type MdSide, type Row, type RowKind, type SideBlocks, type SideChanges, type Stop } from "../lib/markdown.ts";
import { isSimple, markInline, markPairs, markWords, textOf as blockText, unitsOf } from "../lib/richdiff.ts";
import { breakAfter, unitOf } from "../lib/breaks.ts";
import { closeGaps, foldInside, meets, opening } from "../lib/mdfold.ts";
import { CHUNK, newLineOf, withSpan } from "../lib/reveal.ts";
import type { NavBlock, Span } from "../lib/cursor.ts";
import { compileQuery, type Side } from "../lib/search.ts";
import { compareFocus, diffStyle } from "../state.ts";
import { rangeText } from "./Bits.tsx";
import { hi, lo, PendingBox } from "./NewThread.tsx";
import { ThreadMini } from "./ThreadMini.tsx";
import { useBlob } from "./useBlob.ts";

type Highlight = (code: string, lang: string) => string | null;

// What a view drawn again needs at once to come out as tall as before: the highlighter with the languages loaded so
// far, and the sizes of the pictures it showed.
let lit: Highlight | null = null;
const litLangs = new Set<string>();
const pictureSizes = new Map<string, [number, number]>();

/** Code blocks in the colors of the diff, for the languages shiki knows. */
async function highlighter(langs: string[]): Promise<Highlight> {
  const themes = [DEFAULT_THEMES.light, DEFAULT_THEMES.dark];
  let h: DiffsHighlighter = await getSharedHighlighter({ themes, langs: [] });
  for (const lang of langs) h = await getSharedHighlighter({ themes, langs: [lang] }).catch(() => h);
  for (const lang of langs) litLangs.add(lang);
  return (lit = (code, lang) => {
    try {
      return h.codeToHtml(code, {
        lang,
        themes: DEFAULT_THEMES,
        defaultColor: "light-dark()",
        transformers: [
          {
            pre(node) {
              delete node.properties.style;
            },
          },
        ],
      });
    } catch {
      return null;
    }
  });
}

/** Pictures the page has shown keep their size when drawn again, so the text around them does not move. */
const sized = (html: string) =>
  html.replace(/<img src="([^"]*)"/g, (m, src: string) => {
    const s = pictureSizes.get(src.replaceAll("&amp;", "&"));
    return s ? `${m} width="${s[0]}" height="${s[1]}"` : m;
  });

const textOf = (b: BlobDto | null | "loading") => (b && b !== "loading" ? b.contents : null);
const lineCount = (t: string | null) => (t === null ? 0 : t.split("\n").length);
const diffSide = (side: MdSide): Side => (side === "old" ? "deletions" : "additions");

interface Cell {
  key: string;
  row: number;
  side: MdSide;
  kind: RowKind;
  html: string;
}

/** A run of rows folded away, across both columns: the lines of their blocks, on the new side. */
type Fold = { key: string; hidden: Span[] };

/** Whether a row has a block on the lines shown, on either side. */
function rowsShown(rows: readonly Row[], sides: { old: SideBlocks | null; new: SideBlocks | null }, shown: MdShown): boolean[] {
  const on = (s: SideBlocks | null, list: number[], spans: readonly Span[]) => !!s && list.some((i) => meets(s.blocks[i]!, spans));
  return rows.map((r) => on(sides.old, r.old, shown.old) || on(sides.new, r.new, shown.new));
}

/** The cells of the rows shown, and a fold for each run of rows between them. */
function foldRows(cells: Cell[], rows: readonly Row[], keep: readonly boolean[], sides: { old: SideBlocks | null; new: SideBlocks | null }): (Cell | Fold)[] {
  const out: (Cell | Fold)[] = [];
  let hidden: Span[] = [];
  const fold = (at: number) => {
    if (hidden.length) out.push({ key: `fold${at}`, hidden });
    hidden = [];
  };
  rows.forEach((r, i) => {
    if (!keep[i]) {
      const s = r.new.length ? sides.new : sides.old;
      for (const b of r.new.length ? r.new : r.old) hidden.push({ start: s!.blocks[b]!.start, end: s!.blocks[b]!.end });
      return;
    }
    fold(i);
    out.push(...cells.filter((c) => c.row === i));
  });
  fold(rows.length);
  return out;
}

const foldText = (hidden: readonly Span[]) => {
  const n = hidden[hidden.length - 1]!.end - hidden[0]!.start + 1;
  return `${n} line${n === 1 ? "" : "s"} folded`;
};

/** A fold bar's buttons: open about `CHUNK` lines from its top or its bottom, or all of it. */
function foldButtons(hidden: readonly Span[]): string {
  const n = hidden[hidden.length - 1]!.end - hidden[0]!.start + 1;
  const all = `<button class="md-fold-all" data-act="all" title="show the folded lines">show all ${n}</button>`;
  if (n <= CHUNK || hidden.length < 2) return all;
  return `<button data-act="above" title="show about ${CHUNK} more lines from the top of the fold, under the text above">▲ show above</button><button data-act="below" title="show about ${CHUNK} more lines from the bottom of the fold, over the text below">▼ show below</button>${all}`;
}

function foldBar(hidden: Span[], side: MdSide, pair: string, live: boolean): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "md-fold";
  bar.setAttribute("data-side", side);
  bar.setAttribute("data-hidden", JSON.stringify(hidden.map((s) => [s.start, s.end])));
  bar.setAttribute("data-pair", pair);
  bar.innerHTML = `<span class="md-fold-text">⋯ ${foldText(hidden)}</span>${live ? foldButtons(hidden) : ""}`;
  return bar;
}

/** The element a stop is drawn as, for a thread or a comment on `side`: in split view an unchanged block's old twin stands for the old side. */
function elementOf(grid: HTMLElement, s: Stop, side: MdSide, split: boolean): HTMLElement | null {
  const q = (at: MdSide, b: number) => grid.querySelector<HTMLElement>(`.md-cell[data-side="${at}"] [data-b="${b}"]`);
  if (split && side === "old" && s.twin !== null) return q("old", s.twin) ?? q(s.side, s.block);
  return q(s.side, s.block);
}

/**
 * Puts a box right under a block, outside it so the block's marks do not cover the box: after a list item among the
 * items, after a table row under the table.
 */
function placeUnder(el: HTMLElement, box: HTMLElement, afterCards = false): void {
  let at = el;
  while (at.parentElement && /^(TABLE|THEAD|TBODY|TR)$/.test(at.parentElement.tagName)) at = at.parentElement;
  while (afterCards && at.nextElementSibling?.matches(".md-threads:not(.md-pending)")) at = at.nextElementSibling as HTMLElement;
  at.after(box);
}

/** The innermost stop whose lines on `side` hold `line`, or -1. */
function holding(stops: readonly Stop[], side: Side, line: number): number {
  let best = -1;
  let size = Infinity;
  stops.forEach((s, k) => {
    const r = side === "deletions" ? s.nav.old : s.nav.new;
    if (r && r.start <= line && line <= r.end && r.end - r.start < size) {
      best = k;
      size = r.end - r.start;
    }
  });
  return best;
}

/** Where `re` matches the text a block shows. */
function rangesOf(el: Element, re: RegExp): Range[] {
  const t = blockText([el], true);
  const out: Range[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(t.text); m; m = re.exec(t.text)) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    const s = m.index;
    const e = s + m[0].length;
    const a = t.pieces.find((p) => p.start <= s && s < p.end);
    const b = t.pieces.find((p) => p.start < e && e <= p.end);
    if (!a || !b) continue;
    const r = el.ownerDocument.createRange();
    r.setStart(a.node, s - a.start);
    r.setEnd(b.node, e - b.start);
    out.push(r);
  }
  return out;
}

/** Moves the higher of two blocks down until their tops are level; margins that collapse may take a few steps. */
function level(a: HTMLElement, b: HTMLElement): void {
  for (let i = 0; i < 5; i++) {
    const d = a.getBoundingClientRect().top - b.getBoundingClientRect().top;
    if (Math.abs(d) < 0.5) return;
    const up = d > 0 ? b : a;
    up.style.marginTop = `${parseFloat(getComputedStyle(up).marginTop) + Math.abs(d)}px`;
  }
}

/** Lines up the pairs of each changed row of a split view (`data-pair`), top to bottom, and sizes the empty slots. */
/** A table broken under its threads keeps one set of column widths across its parts, the widest of each column. */
function alignColumns(g: HTMLElement): void {
  for (const first of g.querySelectorAll<HTMLTableElement>(".md-cell table:not(.md-more)")) {
    const parts = [first];
    for (let at: Element | null = first.nextElementSibling; at?.matches(".md-slot, .md-fold"); ) {
      const more = at.nextElementSibling;
      if (!(more instanceof HTMLTableElement) || !more.classList.contains("md-more")) break;
      parts.push(more);
      at = more.nextElementSibling;
    }
    if (parts.length < 2) continue;
    const heads = parts.map((t) => [...(t.rows[0]?.cells ?? [])]);
    for (const c of heads.flat()) c.style.width = "";
    if (heads.flat().some((c) => !c.getBoundingClientRect().width)) continue;
    const widths = heads[0]!.map((_, i) => Math.max(...heads.map((r) => r[i]?.getBoundingClientRect().width ?? 0)));
    for (const r of heads) r.forEach((c, i) => (c.style.width = `${widths[i]}px`));
  }
}

function lineUp(g: HTMLElement): void {
  for (const el of g.querySelectorAll<HTMLElement>("[data-pair]")) {
    el.style.marginTop = "";
    el.style.height = "";
  }
  for (const oldCell of g.querySelectorAll<HTMLElement>('.md-cell[data-side="old"]')) {
    const newCell = g.querySelector<HTMLElement>(`.md-cell[data-side="new"][data-row="${oldCell.dataset.row}"]`);
    if (!newCell) continue;
    const facing = new Map([...newCell.querySelectorAll<HTMLElement>("[data-pair]")].map((el) => [el.dataset.pair!, el]));
    for (const a of oldCell.querySelectorAll<HTMLElement>("[data-pair]")) {
      const b = facing.get(a.dataset.pair!);
      if (!b) continue;
      const empty = (x: HTMLElement) => x.classList.contains("md-gap") || (x.classList.contains("md-slot") && !x.childElementCount);
      const gap = empty(a) ? a : empty(b) ? b : null;
      const real = gap === a ? b : a;
      if (a.tagName !== "TR") level(a, b);
      if (gap) gap.style.height = `${real.getBoundingClientRect().height}px`;
      else if (a.tagName === "TR") a.style.height = b.style.height = `${Math.max(a.getBoundingClientRect().height, b.getBoundingClientRect().height)}px`;
    }
  }
}

/** The slot a broken table or list keeps right under the row or item of `el`, as a way to put a box there. */
function slotFor(el: HTMLElement): ((_: HTMLElement, box: HTMLElement) => void) | null {
  const unit = unitOf(el);
  const b = unit?.getAttribute("data-b");
  const slot = b ? el.closest(".md-cell")?.querySelector(`.md-slot[data-after="${b}"]`) : null;
  return slot ? (_, box) => slot.append(box) : null;
}

/** A version of the file a side of the view shows. */
export interface MdSource {
  sha: string;
  path: string;
  label: string;
}

/** A thread on lines of one side. */
export interface MdThread {
  threadId: number;
  side: Side;
  range: Span;
  state: string;
}

const miniCard = (p: MdThread) => <ThreadMini id={p.threadId} state={p.state} />;

function ThreadCards({ items, cardOf }: { items: { p: MdThread; partial: boolean }[]; cardOf: (p: MdThread) => VNode | null }) {
  return (
    <>
      {items.map(({ p, partial }) => (
        <div class="md-thread-card" key={p.threadId}>
          {partial ? <span class="md-thread-lines">lines {rangeText(p.range)}</span> : null}
          {cardOf(p)}
        </div>
      ))}
    </>
  );
}

/** A Markdown file of the Changes page, rendered. */
export function MarkdownView({ file }: { file: string }) {
  const d = compareData.value;
  const fd = compareFiles.value?.find((f) => f.name === file) ?? null;
  const at = (side: "from" | "to", path: string) => (d ? { sha: d[side].sha, path, label: d[side].label } : null);
  return (
    <RenderedMarkdown
      file={file}
      fd={fd}
      old={fd && fd.type !== "new" ? at("from", fd.prevName ?? file) : null}
      now={fd && fd.type !== "deleted" ? at("to", file) : null}
      split={diffStyle.value === "split"}
      threads={shownPlacements.value.filter((p) => p.path === file)}
      shown={fd && !isWhole(file) ? spansOf(fd.hunks) : null}
      onReveal={(span) => void changeReveal(file, (r) => withSpan(r, span))}
      live
      onStops={(navs) => fd && setFileBlocks(fd, navs)}
    />
  );
}

/** The lines the hunks of a diff show, on each side. */
export const spansOf = (hunks: Pick<FileDiffMetadata, "hunks">["hunks"]): MdShown => ({
  old: hunks.map((h) => ({ start: h.deletionStart, end: h.deletionStart + h.deletionCount - 1 })),
  new: hunks.map((h) => ({ start: h.additionStart, end: h.additionStart + h.additionCount - 1 })),
});

/** Lines of each side to show, the rest folded; all of them when absent. */
export interface MdShown {
  old: readonly Span[];
  new: readonly Span[];
}

interface RenderedProps {
  file: string;
  /** The diff from `old` to `now`, for its hunks. */
  fd: Pick<FileDiffMetadata, "hunks"> | null;
  old: MdSource | null;
  now: MdSource | null;
  split: boolean;
  threads: readonly MdThread[];
  shown?: MdShown | null;
  /** Opens folded lines (of the new version): the buttons of a fold bar. */
  onReveal?: (span: Span) => void;
  /** What stands under a thread's blocks; null for a mark on its blocks only. */
  cardOf?: (p: MdThread) => VNode | null;
  /** On the Changes page: the cursor, comments, search and the gutter beside a block. */
  live?: boolean;
  onStops?: (navs: NavBlock[]) => void;
}

/**
 * A Markdown file rendered, two versions compared: in split view the old and the new side next to each other, block
 * facing block and item facing item, the changed words marked; in unified view one column where a block with a few
 * words changed shows once with the changes in it, and another changed block's old version stands above its new one.
 * Threads show on the blocks their lines are in; on the Changes page a block can be commented on like lines of code,
 * and search hits are highlighted in the text.
 */
export function RenderedMarkdown({ file, fd, old, now, split: splitWanted, threads: placed, shown = null, onReveal, cardOf = miniCard, live = false, onStops }: RenderedProps) {
  const oldPath = old?.path ?? file;
  const oldSha = fd && old ? old.sha : null;
  const newSha = fd && now ? now.sha : null;
  const oldBlob = useBlob(oldSha, oldPath);
  const newBlob = useBlob(newSha, file);
  const oldText = textOf(oldBlob);
  const newText = textOf(newBlob);
  const [highlight, setHighlight] = useState<Highlight | null>(() => lit);
  const changes = useMemo(() => (fd ? changesOf(fd) : null), [fd]);
  const sides = useMemo(() => {
    const side = (text: string | null, sha: string | null, path: string, ch: SideChanges | null) =>
      text !== null && sha ? renderMarkdown(text, { path, imageUrl: (p) => rawUrl(sha, p), changes: ch, highlight }) : null;
    return { old: side(oldText, oldSha, oldPath, changes?.old ?? null), new: side(newText, newSha, file, changes?.new ?? null) };
  }, [oldText, newText, oldSha, newSha, oldPath, file, changes, highlight]);
  const split = splitWanted && !!sides.old && !!sides.new;
  const placedKey = JSON.stringify(placed.map((p) => [p.threadId, p.side, p.range.start, p.range.end, p.state]));
  const pending = live ? pendingLines.value : null;
  const mine = pending?.path === file ? pending : null;
  const shownKey = shown ? JSON.stringify(shown) : "";
  const revealing = !!onReveal;
  const pendingKey = mine ? `${mine.range.side}:${lo(mine.range)}-${hi(mine.range)}` : "";
  const layout = useMemo(() => {
    if (!fd || !(sides.old || sides.new)) return null;
    const slots = slotsOf(fd, lineCount(oldText), lineCount(newText));
    const rows = rowsOf(sides.old, sides.new, slots);
    const pairs = rows.map((r) => (r.kind === "changed" ? pairsOf(r, sides.old, sides.new, slots) : []));
    const tops = { old: new Map(sides.old?.tops.map((t) => [t.block, t.html])), new: new Map(sides.new?.tops.map((t) => [t.block, t.html])) };
    const html = (side: MdSide, list: number[]) => list.map((b) => tops[side].get(b) ?? "").join("");
    const parse = (h: string) => {
      const t = document.createElement("template");
      t.innerHTML = h;
      return t;
    };
    const tagOf = (side: MdSide, i: number) => (side === "old" ? sides.old : sides.new)!.blocks[i]!.tag;
    const frags: { key: string; row: number; side: MdSide; kind: RowKind; t: HTMLTemplateElement }[] = [];
    const merged = new Set<number>();
    rows.forEach((r, i) => {
      const cell = (side: MdSide, t: HTMLTemplateElement) => frags.push({ key: `${i}${side}`, row: i, side, kind: r.kind, t });
      if (r.kind === "changed" && r.old.length && r.new.length) {
        const a = parse(html("old", r.old));
        const b = parse(html("new", r.new));
        const units = unitsOf(a.content, b.content, pairs[i]!);
        if (!split && isSimple(pairs[i]!, units, tagOf)) {
          merged.add(i);
          markInline(b.content, pairs[i]!, units);
          cell("new", b);
          return;
        }
        markWords(units);
        if (split) markPairs(a.content, b.content, pairs[i]!);
        cell("old", a);
        cell("new", b);
        return;
      }
      if (split || (r.old.length && r.kind !== "same")) cell("old", parse(html("old", r.old)));
      if (split || r.new.length) cell("new", parse(html("new", r.new)));
    });
    const stops = stopsOf(rows, pairs, sides.old, sides.new, split, merged);

    // A thread (or the comment being written) on a table row or a list item breaks the table or the list after it,
    // so its card stands right under its row; in split view the other side breaks at the facing row.
    const twins = new Map<string, number>();
    rows.forEach((r) => {
      if (r.kind !== "same" || !sides.old || !sides.new) return;
      const a = subtree(sides.old.blocks, r.old[0]!);
      const b = subtree(sides.new.blocks, r.new[0]!);
      if (a.length !== b.length) return;
      a.forEach((o, k) => {
        twins.set(`old:${o}`, b[k]!);
        twins.set(`new:${b[k]}`, o);
      });
    });
    const root = (row: number, side: MdSide) => frags.find((f) => f.row === row && f.side === side)?.t.content ?? null;
    const ranges = [
      ...placed.filter((p) => cardOf(p) !== null).map((p) => ({ side: (p.side === "deletions" ? "old" : "new") as MdSide, start: p.range.start, end: p.range.end })),
      ...(mine ? [{ side: (mine.range.side === "deletions" ? "old" : "new") as MdSide, start: lo(mine.range), end: hi(mine.range) }] : []),
    ];
    const broken = new Set<Element>();
    for (const range of ranges) {
      const k = stopsOn(stops, range.side, range.start, range.end).stops.at(-1);
      const s = k === undefined ? null : stops[k]!;
      if (!s) continue;
      const side: MdSide = split && range.side === "old" && s.twin !== null ? "old" : s.side;
      const b = side === "old" && s.side === "new" ? s.twin! : s.block;
      const el = root(s.row, side)?.querySelector(`[data-b="${b}"]`);
      const unit = el ? unitOf(el) : null;
      if (!unit || broken.has(unit)) continue;
      const id = String(broken.size);
      breakAfter(unit, id);
      broken.add(unit);
      if (!split) continue;
      const there: MdSide = side === "old" ? "new" : "old";
      const pair = unit.getAttribute("data-pair");
      const twin = twins.get(`${side}:${unit.getAttribute("data-b")}`);
      const facing = pair !== null ? root(s.row, there)?.querySelector(`[data-pair="${pair}"]`) : twin !== undefined ? root(s.row, there)?.querySelector(`[data-b="${twin}"]`) : null;
      if (facing && /^(TR|LI)$/.test(facing.tagName) && !broken.has(facing)) {
        breakAfter(facing, id);
        broken.add(facing);
      }
    }

    // What the diff does not show is folded: whole rows across both columns, and inside a list or a table partly
    // shown its items or rows. Threads and the comment being written keep their blocks shown.
    const sideOf = (s: Side): MdSide => (s === "deletions" ? "old" : "new");
    const kept = [
      ...placed.map((p) => ({ side: sideOf(p.side), start: p.range.start, end: p.range.end })),
      ...(mine ? [{ side: sideOf(mine.range.side ?? "additions"), start: lo(mine.range), end: hi(mine.range) }] : []),
    ];
    const fold = shown
      ? { old: [...closeGaps(shown.old, lineCount(oldText)), ...kept.filter((r) => r.side === "old")], new: [...closeGaps(shown.new, lineCount(newText)), ...kept.filter((r) => r.side === "new")] }
      : null;
    const keep = fold ? rowsShown(rows, sides, fold) : rows.map(() => true);
    if (fold)
      for (const f of frags) {
        if (!keep[f.row]) continue;
        let k = 0;
        foldInside(f.t.content, fold[f.side], (hidden) => foldBar(hidden, f.side, `fold-${f.row}-${k++}`, revealing));
      }
    const shownStops = fold ? stops.filter((s) => keep[s.row] && !!root(s.row, s.side)?.querySelector(`[data-b="${s.block}"]`)) : stops;
    const cells: Cell[] = frags.filter((f) => keep[f.row]).map((f) => ({ key: f.key, row: f.row, side: f.side, kind: f.kind, html: sized(f.t.innerHTML) }));
    return { rows, pairs, cells: fold ? foldRows(cells, rows, keep, sides) : cells, merged, stops: shownStops };
  }, [fd, sides, split, placedKey, pendingKey, shownKey, revealing]);
  const cells = layout?.cells ?? [];
  const seen = (e: Event) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.naturalWidth) pictureSizes.set(img.getAttribute("src") ?? "", [img.naturalWidth, img.naturalHeight]);
  };

  const langs = [...new Set([...(sides.old?.langs ?? []), ...(sides.new?.langs ?? [])])].join(" ");
  useEffect(() => {
    if (!langs || (highlight && langs.split(" ").every((l) => litLangs.has(l)))) return;
    let live = true;
    highlighter(langs.split(" ")).then(
      (h) => live && setHighlight(() => h),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [langs]);

  useEffect(() => {
    if (fd && layout && onStops) onStops(layout.stops.map((s) => s.nav));
  }, [fd, layout]);

  const grid = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g || !layout) return;
    layout.stops.forEach((s, k) => {
      for (const el of [elementOf(g, s, "new", split), elementOf(g, s, "old", split)]) if (el) el.dataset.stop = String(k);
    });
  }, [layout]);

  const c = cursor.value;
  const anchor = visualAnchor.value;
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g) return;
    for (const el of g.querySelectorAll(".md-cursor, .md-visual")) el.classList.remove("md-cursor", "md-visual");
    if (!layout || !live || c?.path !== file || c.row < 0) return;
    const mark = (k: number, cls: string) => g.querySelectorAll(`[data-stop="${k}"]`).forEach((el) => el.classList.add(cls));
    if (anchor?.path === file && anchor.row >= 0) for (let k = Math.min(anchor.row, c.row); k <= Math.max(anchor.row, c.row); k++) mark(k, "md-visual");
    mark(c.row, "md-cursor");
  }, [c, anchor, layout]);

  useLayoutEffect(() => {
    const g = grid.current;
    if (!g || !layout) return;
    const marked: HTMLElement[] = [];
    const under = new Map<HTMLElement, { p: MdThread; partial: boolean }[]>();
    for (const p of placed) {
      const side: MdSide = p.side === "deletions" ? "old" : "new";
      const { stops, partial } = stopsOn(layout.stops, side, p.range.start, p.range.end);
      const els = stops.flatMap((k) => elementOf(g, layout.stops[k]!, side, split) ?? []);
      for (const el of els) {
        el.classList.add("md-thread");
        el.dataset.threads = `${el.dataset.threads ?? ""} ${p.threadId}`.trim();
        marked.push(el);
      }
      const at = els[els.length - 1] ?? g;
      if (cardOf(p)) under.set(at, [...(under.get(at) ?? []), { p, partial }]);
    }
    const boxes = [...under].map(([el, items]) => {
      const box = document.createElement("div");
      box.className = "md-threads";
      if (el === g) g.append(box);
      else (slotFor(el) ?? placeUnder)(el, box);
      render(<ThreadCards items={items} cardOf={cardOf} />, box);
      return box;
    });
    return () => {
      for (const box of boxes) {
        render(null, box);
        box.remove();
      }
      for (const el of marked) {
        el.classList.remove("md-thread", "md-thread-focus");
        delete el.dataset.threads;
      }
    };
  }, [layout, placedKey]);

  const focus = hoverThread.value ?? compareFocus.value;
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g) return;
    for (const el of g.querySelectorAll(".md-thread-focus")) el.classList.remove("md-thread-focus");
    if (focus !== null) for (const el of g.querySelectorAll(`[data-threads~="${focus}"]`)) el.classList.add("md-thread-focus");
  }, [focus, layout, placedKey]);

  useLayoutEffect(() => {
    const g = grid.current;
    if (!g || !layout || !mine) return;
    const side: MdSide = mine.range.side === "deletions" ? "old" : "new";
    const els = stopsOn(layout.stops, side, lo(mine.range), hi(mine.range)).stops.flatMap((k) => elementOf(g, layout.stops[k]!, side, split) ?? []);
    for (const el of els) el.classList.add("md-picked");
    const box = document.createElement("div");
    box.className = "md-threads md-pending";
    const at = els[els.length - 1];
    if (at) (slotFor(at) ?? ((el: HTMLElement, b: HTMLElement) => placeUnder(el, b, true)))(at, box);
    else g.append(box);
    render(<PendingBox p={mine} />, box);
    return () => {
      render(null, box);
      box.remove();
      for (const el of els) el.classList.remove("md-picked");
    };
  }, [layout, pendingKey]);

  // Search hits in the rendered text: each block that holds a line with a hit, and the hit the search is at.
  const hits = !live ? [] : searchScope.value === "files" ? grepHits.value.filter((h) => h.path === file && h.inDiff).map((h) => ({ side: "additions" as Side, line: h.line })) : (searchResult.value.files.find((f) => f.path === file)?.hits ?? []);
  const current = searchScope.value === "files" ? currentGrepHit.value : currentHit.value;
  const query = compileQuery(searchQuery.value, searchRegex.value);
  const hitsKey = JSON.stringify([hits.map((h) => [h.side, h.line]), current?.path === file ? [current.line, "side" in current ? current.side : "additions"] : null, String(query)]);
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g) return;
    const ranges: { range: Range; current: boolean }[] = [];
    if (layout && query instanceof RegExp && hits.length) {
      const seen = new Map<Element, boolean>();
      for (const h of hits) {
        const k = holding(layout.stops, h.side, h.line);
        const el = k === -1 ? null : elementOf(g, layout.stops[k]!, h.side === "deletions" ? "old" : "new", split);
        const now = current?.path === file && current.line === h.line && ("side" in current ? current.side : "additions") === h.side;
        if (el) seen.set(el, (seen.get(el) ?? false) || now);
      }
      for (const [el, now] of seen) for (const range of rangesOf(el, query)) ranges.push({ range, current: now });
    }
    paintTextHits(g, ranges);
    return () => paintTextHits(g, []);
  }, [layout, hitsKey]);

  // A table broken under threads keeps its column widths; in split view the blocks of a changed row are lined up pair
  // by pair, and empty slots get the height of what faces them.
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g) return;
    // the view is drawn before pierre puts it on the page: measure only once it is there and has a width
    const measure = () => {
      if (!g.isConnected || !g.clientWidth) return;
      alignColumns(g);
      if (split) lineUp(g);
    };
    let frame = 0;
    const again = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    let width = g.clientWidth;
    const resized = new ResizeObserver(() => {
      if (g.clientWidth === width) return;
      width = g.clientWidth;
      again();
    });
    resized.observe(g);
    // a card or a comment box under a row grows (a reply, typing): the slot facing it grows with it
    const filled = new ResizeObserver(again);
    for (const box of g.querySelectorAll(".md-slot > .md-threads")) filled.observe(box);
    g.addEventListener("load", again, true);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
      filled.disconnect();
      g.removeEventListener("load", again, true);
    };
  }, [layout, split, placedKey, pendingKey]);

  const [hover, setHover] = useState<{ stop: number; side: MdSide; top: number; left: number } | null>(null);

  if (!fd || !(old || now)) return null;
  if ((oldSha && oldBlob === "loading") || (newSha && newBlob === "loading")) return <div class="note" data-file={file}>loading…</div>;
  if (!layout) return <div class="note" data-file={file}>{file} is not a text file here.</div>;

  const from = old ?? now!;
  const to = now ?? old!;
  const at = (side: MdSide) => (side === "old" ? from : to);
  const sideOf = (el: Element): MdSide => ((el.closest(".md-cell") as HTMLElement | null)?.dataset.side === "old" ? "old" : "new");

  const comment = (k: number, side: MdSide) => {
    const r = side === "old" ? layout.stops[k]?.nav.old : layout.stops[k]?.nav.new;
    if (!r) return;
    setCursor({ path: file, row: k }, false);
    compareNav.current?.startComment({ path: file, side: diffSide(side), start: r.start, end: r.end });
  };

  const toCode = (k: number, side: MdSide) => compareNav.current?.showCode(file, k, side);

  const click = (e: MouseEvent) => {
    const el = e.target as Element;
    if (el.closest(".md-threads, .md-gutter")) return;
    const bar = el.closest<HTMLElement>(".md-fold");
    if (bar) {
      const act = el.closest<HTMLElement>("button[data-act]")?.dataset.act as "above" | "below" | "all" | undefined;
      const hidden = (JSON.parse(bar.dataset.hidden ?? "[]") as [number, number][]).map(([start, end]) => ({ start, end }));
      const span = act ? opening(hidden, act) : null;
      if (span && onReveal) onReveal(bar.dataset.side === "old" ? { start: newLineOf(fd.hunks, span.start), end: newLineOf(fd.hunks, span.end) } : span);
      return;
    }
    const link = el.closest("a");
    if (link) {
      e.preventDefault();
      const path = link.getAttribute("data-path");
      const { sha, label } = at(sideOf(link));
      if (path) peek.value = { path, sha, label, line: Number(link.getAttribute("data-line")) || 1 };
      return;
    }
    if (!live || !(window.getSelection()?.isCollapsed ?? true)) return;
    const block = el.closest<HTMLElement>("[data-stop]");
    if (block) setCursor({ path: file, row: Number(block.dataset.stop) }, false);
  };

  // The innermost block level with the pointer, so the gutter beside a block stays while the pointer moves to it.
  const move = (e: MouseEvent) => {
    if (!live) return;
    const t = e.target as Element;
    if (t.closest(".md-gutter")) return;
    const cell = t.closest<HTMLElement>(".md-cell");
    if (!cell || t.closest(".md-threads")) return setHover(null);
    let best: HTMLElement | null = null;
    let height = Infinity;
    for (const el of cell.querySelectorAll<HTMLElement>("[data-stop]")) {
      const r = el.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY < r.bottom && r.height < height) {
        best = el;
        height = r.height;
      }
    }
    if (!best || !grid.current) return setHover(null);
    const g = grid.current.getBoundingClientRect();
    const next = { stop: Number(best.dataset.stop), side: sideOf(cell), top: Math.round(best.getBoundingClientRect().top - g.top), left: Math.round(cell.getBoundingClientRect().left - g.left) };
    setHover((h) => (h && h.stop === next.stop && h.side === next.side && h.top === next.top && h.left === next.left ? h : next));
  };

  const missing = (e: Event) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const note = document.createElement("span");
    note.className = "md-image-off";
    note.textContent = `▧ ${img.alt ? `${img.alt} · ` : ""}${img.dataset.path ?? ""} is not in the repository at ${at(sideOf(img)).label}`;
    img.replaceWith(note);
  };

  const caption = split
    ? `${oldPath === file ? "" : `${oldPath} → ${file} · `}old and new side by side; unchanged blocks are level`
    : sides.old && sides.new
      ? `${from.label} → ${to.label} · changed words are marked in the text; a rewritten block shows what was there above what is there now`
      : sides.new
        ? `added at ${to.label}`
        : `deleted after ${from.label}`;
  const one = old && now && old.sha === now.sha && old.path === now.path;

  return (
    <div class={`md-view${split ? " md-split" : " md-one"}`} data-file={file}>
      {one ? null : (
        <div class="md-bar">
          <span class="md-caption">{caption}</span>
          {live ? <span class="hint">click a block for the cursor · + or i comments on it · ‹/› shows its lines in the code</span> : null}
        </div>
      )}
      <div class="md-grid" ref={grid} onClick={click} onMouseMove={move} onMouseLeave={() => setHover(null)} onErrorCapture={missing} onLoadCapture={seen}>
        {split ? (
          <>
            <div class="md-head" data-side="old">{from.label}</div>
            <div class="md-head" data-side="new">{to.label}</div>
          </>
        ) : null}
        {cells.map((cell) =>
          "hidden" in cell ? (
            <div
              key={cell.key}
              class="md-fold md-fold-rows"
              data-side="new"
              data-hidden={JSON.stringify(cell.hidden.map((s) => [s.start, s.end]))}
              dangerouslySetInnerHTML={{ __html: `<span class="md-fold-text">⋯ ${foldText(cell.hidden)}</span>${onReveal ? foldButtons(cell.hidden) : ""}` }}
            />
          ) : (
            <div
              key={cell.key}
              class={`md md-cell md-${cell.kind}${cell.html ? "" : " md-empty"}`}
              data-row={cell.row}
              data-side={cell.side}
              data-label={at(cell.side).label}
              dangerouslySetInnerHTML={{ __html: cell.html }}
            />
          ),
        )}
        {hover ? (
          <div class="md-gutter" style={{ top: `${hover.top}px`, left: `${hover.left}px` }}>
            <button class="md-plus" title="comment on this block (i)" onClick={() => comment(hover.stop, hover.side)}>
              +
            </button>
            <button class="md-jump" title="show its lines in the code" onClick={() => toCode(hover.stop, hover.side)}>
              ‹/›
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
