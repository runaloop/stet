import type { ChangeContent, FileDiffMetadata, Hunk } from "@pierre/diffs";
import MarkdownIt, { type Env, type Token } from "markdown-it";
import { imageType } from "../../src/core/image.ts";
import type { NavBlock, Span } from "./cursor.ts";

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** Where a link or an image of a Markdown file points: a file of the repository (with a `#L12` line), or somewhere else. */
export type Ref = { path: string; line: number | null } | { outside: string };

/** Resolves `ref` written in the Markdown file `from`: relative to its folder, or to the repository root with a leading slash. */
export function resolveRef(ref: string, from: string): Ref {
  if (!ref || ref.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) return { outside: ref };
  const hash = ref.indexOf("#");
  let target: string;
  try {
    target = decodeURIComponent((hash === -1 ? ref : ref.slice(0, hash)).replace(/\?.*$/, ""));
  } catch {
    return { outside: ref };
  }
  const parts = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const p of target.split("/")) {
    if (p === "" || p === ".") continue;
    if (p !== "..") parts.push(p);
    else if (parts.pop() === undefined) return { outside: ref };
  }
  if (parts.length === 0) return { outside: ref };
  const line = /^L(\d+)/.exec(hash === -1 ? "" : ref.slice(hash + 1))?.[1];
  return { path: parts.join("/"), line: line ? Number(line) : null };
}

/** What the diff changed on one side: its lines that the other side does not have, and the places between its lines (after line `g`) where only the other side has lines. */
export interface SideChanges {
  lines: ReadonlySet<number>;
  gaps: readonly number[];
}

// a hunk with no lines on a side names the line before them
const firstLine = (start: number, count: number) => (count ? start : start + 1);

/** A diff's hunks, and the lines they removed and added when it has them. */
export type MdDiff = Pick<FileDiffMetadata, "hunks"> & Partial<Pick<FileDiffMetadata, "deletionLines" | "additionLines">>;

type Content = { type: "context"; lines: number } | { type: "change"; deletions: number; additions: number };

/** An ordered list item's line with its number left out, or null for another line. */
export function unnumbered(line: string | undefined): string | null {
  const m = /^(\s*(?:>\s*)*)\d{1,9}([.)](?:[ \t].*)?)$/.exec(line?.replace(/\r?\n$/, "") ?? "");
  return m ? `${m[1]}#${m[2]}` : null;
}

/**
 * A change with the lines it only renumbered taken out of it as unchanged: an ordered list item whose number alone
 * changed renders as before, since the list numbers its items by their place.
 */
function renumbered(fd: MdDiff, g: ChangeContent): Content[] {
  const keys = (lines: string[] | undefined, at: number, count: number) => Array.from({ length: count }, (_, i) => unnumbered(lines?.[at + i]));
  const a = keys(fd.deletionLines, g.deletionLineIndex, g.deletions);
  const b = keys(fd.additionLines, g.additionLineIndex, g.additions);
  if (!a.some((k) => k !== null) || !b.some((k) => k !== null) || a.length * b.length > 1e6) return [g];
  const same = (i: number, j: number) => a[i] !== null && a[i] === b[j];
  const best = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) best[i]![j] = same(i, j) ? best[i + 1]![j + 1]! + 1 : Math.max(best[i + 1]![j]!, best[i]![j + 1]!);
  const out: Content[] = [];
  let run = { type: "change" as const, deletions: 0, additions: 0 };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && same(i, j)) {
      if (run.deletions || run.additions) out.push(run);
      run = { type: "change", deletions: 0, additions: 0 };
      out.push({ type: "context", lines: 1 });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || best[i]![j + 1]! >= best[i + 1]![j]!)) {
      run.additions++;
      j++;
    } else {
      run.deletions++;
      i++;
    }
  }
  if (run.deletions || run.additions) out.push(run);
  return out;
}

const contentOf = (fd: MdDiff, h: Hunk): Content[] => h.hunkContent.flatMap((g) => (g.type === "change" ? renumbered(fd, g) : [g]));

export function changesOf(fd: MdDiff): { old: SideChanges; new: SideChanges } {
  const removed = new Set<number>();
  const added = new Set<number>();
  const oldGaps: number[] = [];
  const newGaps: number[] = [];
  for (const h of fd.hunks) {
    let o = firstLine(h.deletionStart, h.deletionCount);
    let n = firstLine(h.additionStart, h.additionCount);
    for (const g of contentOf(fd, h)) {
      if (g.type === "context") {
        o += g.lines;
        n += g.lines;
        continue;
      }
      for (let i = 0; i < g.deletions; i++) removed.add(o + i);
      for (let i = 0; i < g.additions; i++) added.add(n + i);
      if (!g.additions) newGaps.push(n - 1);
      if (!g.deletions) oldGaps.push(o - 1);
      o += g.deletions;
      n += g.additions;
    }
  }
  return { old: { lines: removed, gaps: oldGaps }, new: { lines: added, gaps: newGaps } };
}

/**
 * A rendered block and its source lines, 1-based and inclusive; `parent` is the index of the block around it, -1 at the
 * top; `tag` the element it renders as (`code` for a code block).
 */
export interface Block extends Span {
  parent: number;
  tag: string;
}

/** Blocks whose lines changed, or that the other side has lines inside of. */
export function hitBlocks(blocks: readonly Block[], changes: SideChanges): boolean[] {
  return blocks.map((b) => {
    for (let n = b.start; n <= b.end; n++) if (changes.lines.has(n)) return true;
    return changes.gaps.some((g) => b.start <= g && g < b.end);
  });
}

/** Blocks whose own lines changed: the lines no block inside them holds. */
export function ownHits(blocks: readonly Block[], changes: SideChanges): boolean[] {
  return blocks.map((b, i) => {
    const inner = blocks.filter((c) => c.parent === i);
    const own = (n: number) => !inner.some((c) => c.start <= n && n <= c.end);
    for (let n = b.start; n <= b.end; n++) if (own(n) && changes.lines.has(n)) return true;
    return changes.gaps.some((g) => b.start <= g && g < b.end && !inner.some((c) => c.start <= g && g < c.end));
  });
}

/** The innermost blocks that changed: not the ones around them. */
export function changedBlocks(blocks: readonly Block[], hit: readonly boolean[]): Set<number> {
  const around = new Set<number>();
  blocks.forEach((b, i) => {
    if (hit[i]) for (let p = b.parent; p !== -1; p = blocks[p]!.parent) around.add(p);
  });
  return new Set(blocks.flatMap((_, i) => (hit[i] && !around.has(i) ? [i] : [])));
}

/**
 * The blocks the cursor stops at: a block stops it unless a block inside it starts on the same line (a list stops at
 * its items, a table at its rows, a loose list item at its paragraphs).
 */
export function isStop(blocks: readonly Block[], i: number): boolean {
  const next = blocks[i + 1];
  return !(next && next.parent === i && next.start === blocks[i]!.start);
}

export interface RenderOptions {
  /** The file's path in the repository: relative links and images resolve against its folder. */
  path: string;
  /** Where the page loads an image file of the repository from, at the snapshot of the text. */
  imageUrl: (path: string) => string;
  changes: SideChanges | null;
  /** HTML of a highlighted code block, or null to leave it plain. */
  highlight?: ((code: string, lang: string) => string | null) | null;
}

export interface Rendered {
  blocks: Block[];
  hit: boolean[];
  /** Blocks whose own lines changed (see `ownHits`). */
  own: boolean[];
  /** The source, line by line (line 1 at index 0). */
  lines: string[];
  /** HTML of each top-level block, by its index in `blocks`. */
  tops: { block: number; html: string }[];
  /** Languages of the fenced code blocks. */
  langs: string[];
}

interface RenderEnv extends Env, RenderOptions {
  langs: Set<string>;
}

// html: false: raw HTML in the file comes out as text.
const md = new MarkdownIt({ html: false });
const { escapeHtml, unescapeAll } = md.utils;
const attr = (v: string | number | null) => escapeHtml(String(v ?? ""));

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const t = tokens[idx]!;
  const e = env as RenderEnv;
  const src = String(t.attrGet("src") ?? "");
  const alt = self.renderInlineAsText(t.children ?? [], options, env);
  const ref = resolveRef(src, e.path);
  if ("path" in ref && imageType(ref.path)) {
    const title = t.attrGet("title");
    return `<img src="${attr(e.imageUrl(ref.path))}" alt="${attr(alt)}" data-path="${attr(ref.path)}" data-src="${attr(src)}"${title ? ` title="${attr(title)}"` : ""}>`;
  }
  const why = "path" in ref ? "not an image file" : "not loaded: the review loads no pictures from outside the repository";
  return `<span class="md-image-off" title="${attr(why)}">▧ ${alt ? `${escapeHtml(alt)} · ` : ""}<code>${escapeHtml(src)}</code></span>`;
};

md.renderer.rules.link_open = (tokens, idx, _options, env) => {
  const href = String(tokens[idx]!.attrGet("href") ?? "");
  const ref = resolveRef(href, (env as RenderEnv).path);
  if ("path" in ref) return `<a class="md-file" data-path="${attr(ref.path)}"${ref.line ? ` data-line="${ref.line}"` : ""} data-href="${attr(href)}" title="${attr(`${ref.path}: open it in the preview`)}">`;
  return `<a class="md-outside" data-href="${attr(href)}" title="${attr(href)}">`;
};

md.renderer.rules.fence = (tokens, idx, _options, env, self) => {
  const t = tokens[idx]!;
  const e = env as RenderEnv;
  const lang = unescapeAll(t.info).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (lang) e.langs.add(lang);
  t.attrJoin("class", "md-code");
  return `<div${self.renderAttrs(t)}>${(lang && e.highlight?.(t.content, lang)) || `<pre><code>${escapeHtml(t.content)}</code></pre>`}</div>\n`;
};

md.renderer.rules.code_block = (tokens, idx, _options, _env, self) => {
  const t = tokens[idx]!;
  t.attrJoin("class", "md-code");
  return `<div${self.renderAttrs(t)}><pre><code>${escapeHtml(t.content)}</code></pre></div>\n`;
};

/**
 * The file as HTML, one piece per top-level block: every block carries its index (`data-b`) and its source lines
 * (`data-start`, `data-end`), and the innermost blocks the diff changed are marked `md-changed`.
 */
export function renderMarkdown(text: string, opts: RenderOptions): Rendered {
  const env: RenderEnv = { ...opts, langs: new Set() };
  const tokens = md.parse(text, env);
  const lines = text.split("\n");
  const blocks: Block[] = [];
  const owner = new Map<Token, number>();
  const stack: { i: number; level: number }[] = [];
  for (const t of tokens) {
    while (stack.length && stack[stack.length - 1]!.level >= t.level) stack.pop();
    if (!t.block || !t.map || t.hidden || t.nesting === -1 || t.type === "inline") continue;
    const i = blocks.length;
    const start = t.map[0] + 1;
    // a list item's lines run on over the blank lines after it
    let end = t.map[1];
    while (end > start && !lines[end - 1]!.trim()) end--;
    blocks.push({ start, end, parent: stack[stack.length - 1]?.i ?? -1, tag: t.type === "fence" || t.type === "code_block" ? "code" : t.tag });
    owner.set(t, i);
    t.attrSet("data-b", i);
    t.attrSet("data-start", start);
    t.attrSet("data-end", end);
    if (t.nesting === 1) stack.push({ i, level: t.level });
  }
  const hit = opts.changes ? hitBlocks(blocks, opts.changes) : blocks.map(() => false);
  const own = opts.changes ? ownHits(blocks, opts.changes) : blocks.map(() => false);
  const changed = changedBlocks(blocks, hit);
  for (const [t, i] of owner) if (changed.has(i)) t.attrJoin("class", "md-changed");
  const tops: Rendered["tops"] = [];
  let from = 0;
  tokens.forEach((t, i) => {
    if (t.level !== 0 || t.nesting === 1) return;
    const block = owner.get(tokens[from]!);
    const html = md.renderer.render(tokens.slice(from, i + 1), md.options, env);
    from = i + 1;
    if (block !== undefined) tops.push({ block, html });
  });
  return { blocks, hit, own, lines, tops, langs: [...env.langs] };
}

/**
 * Where each line of both sides sits in the diff: an unchanged line shares its place with the same line on the other
 * side, and all lines of one change (removed and added together) share one place.
 */
export interface Slots {
  old: number[];
  new: number[];
}

export function slotsOf(fd: MdDiff, oldLines: number, newLines: number): Slots {
  const old: number[] = [];
  const nw: number[] = [];
  let slot = 0;
  let o = 1;
  let n = 1;
  const same = () => {
    old[o++] = slot;
    nw[n++] = slot++;
  };
  for (const h of fd.hunks) {
    const first = firstLine(h.deletionStart, h.deletionCount);
    while (o < first) same();
    for (const g of contentOf(fd, h)) {
      if (g.type === "context") {
        for (let i = 0; i < g.lines; i++) same();
        continue;
      }
      for (let i = 0; i < g.deletions; i++) old[o++] = slot;
      for (let i = 0; i < g.additions; i++) nw[n++] = slot;
      slot++;
    }
  }
  while (o <= oldLines || n <= newLines) {
    if (o <= oldLines) old[o++] = slot;
    if (n <= newLines) nw[n++] = slot;
    slot++;
  }
  return { old, new: nw };
}

export type RowKind = "same" | "changed" | "removed" | "added";

/** Top-level blocks of the two sides that face each other, by their index among the top-level blocks of their side. */
export interface Row {
  kind: RowKind;
  old: number[];
  new: number[];
}

/**
 * Pairs the top-level blocks of the two sides: blocks that share a line or a change face each other in one row, a
 * block the other side has nothing of is a row of its own. A row is `same` when one unchanged block faces one
 * unchanged block.
 */
export function alignTops(oldTops: readonly (Span & { hit: boolean })[], newTops: readonly (Span & { hit: boolean })[], slots: Slots): Row[] {
  const parent = Array.from({ length: oldTops.length + newTops.length }, (_, i) => i);
  const root = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  const oldAt = new Map<number, number[]>();
  oldTops.forEach((t, i) => {
    for (let l = t.start; l <= t.end; l++) {
      const s = slots.old[l];
      if (s === undefined) continue;
      const list = oldAt.get(s);
      if (!list) oldAt.set(s, [i]);
      else if (list[list.length - 1] !== i) list.push(i);
    }
  });
  newTops.forEach((t, j) => {
    for (let l = t.start; l <= t.end; l++) for (const i of oldAt.get(slots.new[l] ?? -1) ?? []) parent[root(i)] = root(oldTops.length + j);
  });
  const groups = new Map<number, { old: number[]; new: number[]; at: number }>();
  const add = (x: number, side: "old" | "new", i: number, at: number) => {
    const r = root(x);
    const g = groups.get(r) ?? { old: [], new: [], at };
    g[side].push(i);
    g.at = Math.min(g.at, at);
    groups.set(r, g);
  };
  oldTops.forEach((t, i) => add(i, "old", i, slots.old[t.start] ?? 0));
  newTops.forEach((t, j) => add(oldTops.length + j, "new", j, slots.new[t.start] ?? 0));
  return [...groups.values()]
    .sort((a, b) => a.at - b.at || b.old.length - a.old.length)
    .map((g) => {
      const kind: RowKind =
        g.old.length && g.new.length
          ? g.old.length === 1 && g.new.length === 1 && !oldTops[g.old[0]!]!.hit && !newTops[g.new[0]!]!.hit
            ? "same"
            : "changed"
          : g.old.length
            ? "removed"
            : "added";
      return { kind, old: g.old, new: g.new };
    });
}

export type MdSide = "old" | "new";

/** A block the cursor stops at: on which side it is drawn, its index among that side's blocks, and its unchanged twin on the old side. */
export interface Stop {
  side: MdSide;
  block: number;
  twin: number | null;
  row: number;
  nav: NavBlock;
}

export interface SideBlocks {
  blocks: readonly Block[];
  hit: readonly boolean[];
  own: readonly boolean[];
  lines?: readonly string[];
}

const topsOf = (s: SideBlocks | null) => (s ? s.blocks.flatMap((b, i) => (b.parent === -1 ? [i] : [])) : []);

/** A block and all blocks inside it. */
export function subtree(blocks: readonly Block[], i: number): number[] {
  const out = [i];
  const inside = new Set([i]);
  for (let k = i + 1; k < blocks.length && inside.has(blocks[k]!.parent); k++) {
    out.push(k);
    inside.add(k);
  }
  return out;
}

const childrenOf = (blocks: readonly Block[], i: number) => blocks.flatMap((b, k) => (b.parent === i ? [k] : []));

/** Old and new rendered next to each other: rows of top-level blocks, by block index. */
export function rowsOf(old: SideBlocks | null, nw: SideBlocks | null, slots: Slots): Row[] {
  const oldTops = topsOf(old);
  const newTops = topsOf(nw);
  const span = (s: SideBlocks, i: number) => ({ start: s.blocks[i]!.start, end: s.blocks[i]!.end, hit: s.hit[i]! });
  return alignTops(
    oldTops.map((i) => span(old!, i)),
    newTops.map((i) => span(nw!, i)),
    slots,
  ).map((r) => ({ kind: r.kind, old: r.old.map((i) => oldTops[i]!), new: r.new.map((j) => newTops[j]!) }));
}

/**
 * Blocks of a changed row that face each other, by block index: one to one where the diff pairs them, one side only
 * for what was added or removed, several to several where it rewrote them together. A pair of lists, list items,
 * tables or quotes of the same kind pairs what is inside them (`children`); the item's own text then belongs to the
 * pair itself.
 */
export interface Pair {
  old: number[];
  new: number[];
  children: Pair[] | null;
}

const CONTAINERS = new Set(["ul", "ol", "li", "blockquote", "table", "thead", "tbody"]);

/** How alike two blocks' sources are: the share of their words they have in common, from 0 to 1. */
export function likeness(a: string, b: string): number {
  const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const x = words(a);
  const y = words(b);
  if (!x.length && !y.length) return 1;
  const left = new Map<string, number>();
  for (const w of x) left.set(w, (left.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of y) {
    const n = left.get(w) ?? 0;
    if (n > 0) {
      common++;
      left.set(w, n - 1);
    }
  }
  return (2 * common) / (x.length + y.length);
}

/** Blocks this alike, of the same kind, face each other inside a change that rewrote several of them together. */
export const ALIKE = 0.3;

/**
 * Splits blocks that one change rewrote together into pairs in their order, the most alike first (a longest common
 * subsequence weighted by likeness), and the rest one-sided. Without the sources it keeps them together.
 */
function split(os: number[], ns: number[], old: SideBlocks, nw: SideBlocks): { old: number[]; new: number[] }[] {
  if (!old.lines || !nw.lines) return [{ old: os, new: ns }];
  const text = (s: SideBlocks, i: number) => s.lines!.slice(s.blocks[i]!.start - 1, s.blocks[i]!.end).join("\n");
  const sim = os.map((o) => ns.map((n) => (old.blocks[o]!.tag === nw.blocks[n]!.tag ? likeness(text(old, o), text(nw, n)) : 0)));
  const best: number[][] = Array.from({ length: os.length + 1 }, () => new Array<number>(ns.length + 1).fill(0));
  for (let i = 1; i <= os.length; i++)
    for (let j = 1; j <= ns.length; j++) {
      const s = sim[i - 1]![j - 1]!;
      best[i]![j] = Math.max(best[i - 1]![j]!, best[i]![j - 1]!, s >= ALIKE ? best[i - 1]![j - 1]! + s : -Infinity);
    }
  const out: { old: number[]; new: number[] }[] = [];
  let i = os.length;
  let j = ns.length;
  while (i > 0 || j > 0) {
    const s = i > 0 && j > 0 ? sim[i - 1]![j - 1]! : 0;
    if (i > 0 && j > 0 && s >= ALIKE && best[i]![j] === best[i - 1]![j - 1]! + s) out.push({ old: [os[--i]!], new: [ns[--j]!] });
    else if (j > 0 && (i === 0 || best[i]![j] === best[i]![j - 1])) out.push({ old: [], new: [ns[--j]!] });
    else out.push({ old: [os[--i]!], new: [] });
  }
  out.reverse();
  return out.some((p) => p.old.length && p.new.length) ? out : [{ old: os, new: ns }];
}

export function pairsOf(row: Row, old: SideBlocks | null, nw: SideBlocks | null, slots: Slots): Pair[] {
  const pair = (os: number[], ns: number[], depth: number): Pair[] => {
    if (!old || !nw || !os.length || !ns.length) return [...os.map((o) => ({ old: [o], new: [], children: null })), ...ns.map((n) => ({ old: [], new: [n], children: null }))];
    const span = (s: SideBlocks, i: number) => ({ start: s.blocks[i]!.start, end: s.blocks[i]!.end, hit: s.hit[i]! });
    return alignTops(
      os.map((i) => span(old, i)),
      ns.map((i) => span(nw, i)),
      slots,
    ).flatMap((g) => {
      const o = g.old.map((k) => os[k]!);
      const n = g.new.map((k) => ns[k]!);
      return o.length > 1 || n.length > 1 ? split(o, n, old, nw) : [{ old: o, new: n }];
    }).map(({ old: o, new: n }): Pair => {
      if (o.length === 1 && n.length === 1 && depth < 8) {
        const tag = old.blocks[o[0]!]!.tag;
        const co = childrenOf(old.blocks, o[0]!);
        const cn = childrenOf(nw.blocks, n[0]!);
        if (tag === nw.blocks[n[0]!]!.tag && CONTAINERS.has(tag) && co.length && cn.length) return { old: o, new: n, children: pair(co, cn, depth + 1) };
      }
      return { old: o, new: n, children: null };
    });
  };
  return pair(row.old, row.new, 0);
}

export interface Layout {
  rows: Row[];
  pairs: Pair[][];
  stops: Stop[];
}

/**
 * The blocks the cursor stops at, in reading order. An unchanged row stops on its new side only (its old side is its
 * twin). In split view a changed row stops pair by pair, an unchanged pair once and a changed one on its old side,
 * then its new side; in unified view the old blocks of a changed row come first, then the new ones, except for a row
 * in `merged`, drawn once with its changes in the text, which stops pair by pair on the new side.
 */
export function stopsOf(rows: readonly Row[], pairs: readonly Pair[][], old: SideBlocks | null, nw: SideBlocks | null, split: boolean, merged: ReadonlySet<number> = new Set()): Stop[] {
  const stops: Stop[] = [];
  const span = (s: SideBlocks, i: number) => ({ start: s.blocks[i]!.start, end: s.blocks[i]!.end });
  const one = (side: MdSide, s: SideBlocks, i: number, row: number, changed: boolean) =>
    stops.push({ side, block: i, twin: null, row, nav: { old: side === "old" ? span(s, i) : null, new: side === "new" ? span(s, i) : null, changed, group: row } });
  const twin = (o: number, n: number, row: number, changed: boolean) => stops.push({ side: "new", block: n, twin: o, row, nav: { old: span(old!, o), new: span(nw!, n), changed, group: row } });
  const all = (side: MdSide, s: SideBlocks, list: readonly number[], row: number) => {
    for (const top of list) for (const i of subtree(s.blocks, top)) if (isStop(s.blocks, i)) one(side, s, i, row, s.hit[i]!);
  };
  const walk = (p: Pair, row: number, once: boolean) => {
    if (p.children) {
      const o = p.old[0]!;
      const n = p.new[0]!;
      if (isStop(old!.blocks, o) && isStop(nw!.blocks, n)) {
        const changed = old!.own[o]! || nw!.own[n]!;
        if (once || !changed) twin(o, n, row, changed);
        else {
          one("old", old!, o, row, true);
          one("new", nw!, n, row, true);
        }
      }
      for (const c of p.children) walk(c, row, once);
      return;
    }
    if (p.old.length === 1 && p.new.length === 1) {
      const a = subtree(old!.blocks, p.old[0]!).filter((i) => isStop(old!.blocks, i));
      const b = subtree(nw!.blocks, p.new[0]!).filter((i) => isStop(nw!.blocks, i));
      const changed = a.some((i) => old!.hit[i]) || b.some((i) => nw!.hit[i]);
      if (a.length === b.length && (once || !changed)) {
        a.forEach((o, k) => twin(o, b[k]!, row, old!.hit[o]! || nw!.hit[b[k]!]!));
        return;
      }
    }
    if (old) all("old", old, p.old, row);
    if (nw) all("new", nw, p.new, row);
  };
  rows.forEach((r, row) => {
    if (r.kind === "same") {
      const o = r.old[0]!;
      const n = r.new[0]!;
      const a = subtree(old!.blocks, o);
      const b = subtree(nw!.blocks, n);
      const shift = old!.blocks[o]!.start - nw!.blocks[n]!.start;
      for (const [k, i] of b.entries()) {
        if (!isStop(nw!.blocks, i)) continue;
        const { start, end } = nw!.blocks[i]!;
        stops.push({ side: "new", block: i, twin: a.length === b.length ? a[k]! : null, row, nav: { old: { start: start + shift, end: end + shift }, new: { start, end }, changed: false, group: row } });
      }
      return;
    }
    const first = stops.length;
    if ((split || merged.has(row)) && r.kind === "changed") for (const p of pairs[row] ?? []) walk(p, row, merged.has(row));
    else {
      if (old) all("old", old, r.old, row);
      if (nw) all("new", nw, r.new, row);
    }
    if (stops.length > first && !stops.slice(first).some((s) => s.nav.changed)) stops[first]!.nav.changed = true;
  });
  return stops;
}

/** Rows, pairs and stops of two rendered sides. */
export function layoutOf(old: SideBlocks | null, nw: SideBlocks | null, slots: Slots, split = true, merged: ReadonlySet<number> = new Set()): Layout {
  const rows = rowsOf(old, nw, slots);
  const pairs = rows.map((r) => (r.kind === "changed" ? pairsOf(r, old, nw, slots) : []));
  return { rows, pairs, stops: stopsOf(rows, pairs, old, nw, split, merged) };
}

/**
 * Where a thread on lines `start`-`end` of one side shows: the stops it covers, without one around another when only
 * the inner one has its lines (or the stop closest before it when it covers none, such as blank lines), and whether it
 * covers only part of them.
 */
export function stopsOn(stops: readonly Stop[], side: MdSide, start: number, end: number): { stops: number[]; partial: boolean } {
  const on = (s: Stop) => (side === "old" ? s.nav.old : s.nav.new);
  const meets = (r: Span | null): r is Span => !!r && r.start <= end && start <= r.end;
  const hits = stops.flatMap((s, k) => (meets(on(s)) ? [k] : []));
  const kept = hits.filter((k) => {
    const r = on(stops[k]!)!;
    const inner = hits.map((x) => on(stops[x]!)!).filter((x) => x !== r && r.start <= x.start && x.end <= r.end);
    for (let l = Math.max(r.start, start); l <= Math.min(r.end, end); l++) if (!inner.some((x) => x.start <= l && l <= x.end)) return true;
    return false;
  });
  if (kept.length === 0) {
    let best = -1;
    stops.forEach((s, k) => {
      const r = on(s);
      if (r && r.start <= start && (best === -1 || r.start >= on(stops[best]!)!.start)) best = k;
    });
    if (best === -1) best = stops.findIndex((s) => on(s) !== null);
    return { stops: best === -1 ? [] : [best], partial: true };
  }
  const lo = Math.min(...kept.map((k) => on(stops[k]!)!.start));
  const hi = Math.max(...kept.map((k) => on(stops[k]!)!.end));
  return { stops: kept, partial: start > lo || end < hi };
}
