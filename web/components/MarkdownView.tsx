import { DEFAULT_THEMES, getSharedHighlighter, type DiffsHighlighter } from "@pierre/diffs";
import { render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ComparePlacement } from "../../src/core/types.ts";
import { rawUrl, type BlobDto } from "../api.ts";
import { compareData, compareFiles, compareNav, cursor, hoverThread, peek, pendingLines, setCursor, setFileBlocks, shownPlacements, visualAnchor } from "../compare.ts";
import { changesOf, layoutOf, renderMarkdown, slotsOf, stopsOn, type MdSide, type RowKind, type SideChanges, type Stop } from "../lib/markdown.ts";
import { diffRows, type Side } from "../lib/search.ts";
import { compareFocus, diffStyle } from "../state.ts";
import { rangeText } from "./Bits.tsx";
import { hi, lo, PendingBox } from "./NewThread.tsx";
import { ThreadMini } from "./ThreadMini.tsx";
import { useBlob } from "./useBlob.ts";

type Highlight = (code: string, lang: string) => string | null;

/** Code blocks in the colors of the diff, for the languages shiki knows. */
async function highlighter(langs: string[]): Promise<Highlight> {
  const themes = [DEFAULT_THEMES.light, DEFAULT_THEMES.dark];
  let h: DiffsHighlighter = await getSharedHighlighter({ themes, langs: [] });
  for (const lang of langs) h = await getSharedHighlighter({ themes, langs: [lang] }).catch(() => h);
  return (code, lang) => {
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
  };
}

const textOf = (b: BlobDto | null | "loading") => (b && b !== "loading" ? b.contents : null);
const lineCount = (t: string | null) => (t === null ? 0 : t.split("\n").length);
const diffSide = (side: MdSide): Side => (side === "old" ? "deletions" : "additions");

interface Cell {
  key: string;
  side: MdSide;
  kind: RowKind;
  html: string;
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

function ThreadCards({ items }: { items: { p: ComparePlacement; partial: boolean }[] }) {
  return (
    <>
      {items.map(({ p, partial }) => (
        <div class="md-thread-card" key={p.threadId}>
          {partial ? <span class="md-thread-lines">lines {rangeText(p.range)}</span> : null}
          <ThreadMini id={p.threadId} state={p.state} />
        </div>
      ))}
    </>
  );
}

/**
 * A Markdown file of the diff rendered: in split view the old and the new side next to each other, unchanged blocks
 * level; in unified view one column where a changed block's old version stands above its new one. Threads show on
 * the blocks their lines are in, and a block can be commented on like lines of code.
 */
export function MarkdownView({ file }: { file: string }) {
  const d = compareData.value;
  const fd = compareFiles.value?.find((f) => f.name === file);
  const oldPath = fd?.prevName ?? file;
  const oldSha = d && fd && fd.type !== "new" ? d.from.sha : null;
  const newSha = d && fd && fd.type !== "deleted" ? d.to.sha : null;
  const oldBlob = useBlob(oldSha, oldPath);
  const newBlob = useBlob(newSha, file);
  const oldText = textOf(oldBlob);
  const newText = textOf(newBlob);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const changes = useMemo(() => (fd ? changesOf(fd) : null), [fd]);
  const sides = useMemo(() => {
    const side = (text: string | null, sha: string | null, path: string, ch: SideChanges | null) =>
      text !== null && sha ? renderMarkdown(text, { path, imageUrl: (p) => rawUrl(sha, p), changes: ch, highlight }) : null;
    return { old: side(oldText, oldSha, oldPath, changes?.old ?? null), new: side(newText, newSha, file, changes?.new ?? null) };
  }, [oldText, newText, oldSha, newSha, oldPath, file, changes, highlight]);
  const layout = useMemo(() => (fd && (sides.old || sides.new) ? layoutOf(sides.old, sides.new, slotsOf(fd, lineCount(oldText), lineCount(newText))) : null), [fd, sides]);
  const split = diffStyle.value === "split" && !!sides.old && !!sides.new;
  const cells = useMemo(() => {
    if (!layout) return [];
    const tops = { old: new Map(sides.old?.tops.map((t) => [t.block, t.html])), new: new Map(sides.new?.tops.map((t) => [t.block, t.html])) };
    const html = (side: MdSide, list: number[]) => list.map((b) => tops[side].get(b) ?? "").join("");
    const out: Cell[] = [];
    layout.rows.forEach((r, i) => {
      if (split || (r.old.length && r.kind !== "same")) out.push({ key: `${i}o`, side: "old", kind: r.kind, html: html("old", r.old) });
      if (split || r.new.length) out.push({ key: `${i}n`, side: "new", kind: r.kind, html: html("new", r.new) });
    });
    return out;
  }, [layout, sides, split]);

  const langs = [...new Set([...(sides.old?.langs ?? []), ...(sides.new?.langs ?? [])])].join(" ");
  useEffect(() => {
    if (!langs) return;
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
    if (fd && layout) setFileBlocks(fd, layout.stops.map((s) => s.nav));
  }, [fd, layout]);

  const grid = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g || !layout) return;
    layout.stops.forEach((s, k) => {
      for (const el of [elementOf(g, s, "new", split), elementOf(g, s, "old", split)]) if (el) el.dataset.stop = String(k);
    });
  }, [layout, cells]);

  const c = cursor.value;
  const anchor = visualAnchor.value;
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g) return;
    for (const el of g.querySelectorAll(".md-cursor, .md-visual")) el.classList.remove("md-cursor", "md-visual");
    if (!layout || c?.path !== file || c.row < 0) return;
    const mark = (k: number, cls: string) => g.querySelectorAll(`[data-stop="${k}"]`).forEach((el) => el.classList.add(cls));
    if (anchor?.path === file && anchor.row >= 0) for (let k = Math.min(anchor.row, c.row); k <= Math.max(anchor.row, c.row); k++) mark(k, "md-visual");
    mark(c.row, "md-cursor");
  }, [c, anchor, layout, cells]);

  const placed = shownPlacements.value.filter((p) => p.path === file);
  const placedKey = JSON.stringify(placed.map((p) => [p.threadId, p.side, p.range.start, p.range.end, p.state]));
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g || !layout) return;
    const marked: HTMLElement[] = [];
    const under = new Map<HTMLElement, { p: ComparePlacement; partial: boolean }[]>();
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
      under.set(at, [...(under.get(at) ?? []), { p, partial }]);
    }
    const boxes = [...under].map(([el, items]) => {
      const box = document.createElement("div");
      box.className = "md-threads";
      if (el === g) g.append(box);
      else placeUnder(el, box);
      render(<ThreadCards items={items} />, box);
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
  }, [layout, cells, placedKey]);

  const focus = hoverThread.value ?? compareFocus.value;
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g) return;
    for (const el of g.querySelectorAll(".md-thread-focus")) el.classList.remove("md-thread-focus");
    if (focus !== null) for (const el of g.querySelectorAll(`[data-threads~="${focus}"]`)) el.classList.add("md-thread-focus");
  }, [focus, layout, cells, placedKey]);

  const pending = pendingLines.value;
  const mine = pending?.path === file ? pending : null;
  const pendingKey = mine ? `${mine.range.side}:${lo(mine.range)}-${hi(mine.range)}` : "";
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g || !layout || !mine) return;
    const side: MdSide = mine.range.side === "deletions" ? "old" : "new";
    const els = stopsOn(layout.stops, side, lo(mine.range), hi(mine.range)).stops.flatMap((k) => elementOf(g, layout.stops[k]!, side, split) ?? []);
    for (const el of els) el.classList.add("md-picked");
    const box = document.createElement("div");
    box.className = "md-threads md-pending";
    const at = els[els.length - 1];
    if (at) placeUnder(at, box, true);
    else g.append(box);
    render(<PendingBox p={mine} />, box);
    return () => {
      render(null, box);
      box.remove();
      for (const el of els) el.classList.remove("md-picked");
    };
  }, [layout, cells, pendingKey]);

  const [hover, setHover] = useState<{ stop: number; side: MdSide; top: number; left: number } | null>(null);

  if (!d || !fd) return null;
  if ((oldSha && oldBlob === "loading") || (newSha && newBlob === "loading")) return <div class="note">loading…</div>;
  if (!layout) return <div class="note">{file} is not a text file here.</div>;

  const at = (side: MdSide) => (side === "old" ? { sha: d.from.sha, label: d.from.label } : { sha: d.to.sha, label: d.to.label });
  const sideOf = (el: Element): MdSide => ((el.closest(".md-cell") as HTMLElement | null)?.dataset.side === "old" ? "old" : "new");

  const comment = (k: number, side: MdSide) => {
    const r = side === "old" ? layout.stops[k]?.nav.old : layout.stops[k]?.nav.new;
    if (!r) return;
    setCursor({ path: file, row: k }, false);
    compareNav.current?.startComment({ path: file, side: diffSide(side), start: r.start, end: r.end });
  };

  const toCode = (k: number, side: MdSide) => {
    const r = side === "old" ? layout.stops[k]?.nav.old : layout.stops[k]?.nav.new;
    if (!r) return;
    const shown = new Set(diffRows(fd).map((row) => (side === "old" ? (row.kind !== "add" ? row.old : null) : row.kind !== "del" ? row.new : null)));
    let line = r.start;
    while (line < r.end && !shown.has(line)) line++;
    compareNav.current?.openLine(file, diffSide(side), shown.has(line) ? line : r.start);
  };

  const click = (e: MouseEvent) => {
    const el = e.target as Element;
    if (el.closest(".md-threads, .md-gutter")) return;
    const link = el.closest("a");
    if (link) {
      e.preventDefault();
      const path = link.getAttribute("data-path");
      if (path) peek.value = { path, ...at(sideOf(link)), line: Number(link.getAttribute("data-line")) || 1 };
      return;
    }
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    const block = el.closest<HTMLElement>("[data-stop]");
    if (block) setCursor({ path: file, row: Number(block.dataset.stop) }, false);
  };

  // The innermost block level with the pointer, so the gutter beside a block stays while the pointer moves to it.
  const move = (e: MouseEvent) => {
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
      ? `${d.from.label} → ${d.to.label} · a changed block shows what was there above what is there now`
      : sides.new
        ? `added at ${d.to.label}`
        : `deleted after ${d.from.label}`;

  return (
    <div class={`md-view${split ? " md-split" : " md-one"}`} data-file={file}>
      <div class="md-bar">
        <span class="md-caption">{caption}</span>
        <span class="hint">click a block for the cursor · + or i comments on it · ‹/› shows its lines in the code</span>
      </div>
      <div class="md-grid" ref={grid} onClick={click} onMouseMove={move} onMouseLeave={() => setHover(null)} onErrorCapture={missing}>
        {split ? (
          <>
            <div class="md-head" data-side="old">{d.from.label}</div>
            <div class="md-head" data-side="new">{d.to.label}</div>
          </>
        ) : null}
        {cells.map((cell) => (
          <div
            key={cell.key}
            class={`md md-cell md-${cell.kind}${cell.html ? "" : " md-empty"}`}
            data-side={cell.side}
            data-label={at(cell.side).label}
            dangerouslySetInnerHTML={{ __html: cell.html }}
          />
        ))}
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
