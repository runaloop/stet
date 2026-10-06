import { diffWordsWithSpace, type ChangeObject } from "diff";
import type { Pair } from "./markdown.ts";

/** A pair of blocks in which more than this share of the words changed is marked as a whole, not word by word. */
export const REWRITTEN = 0.6;

interface Piece {
  node: Text;
  start: number;
  end: number;
}

/** The text of rendered blocks as one string, a line break between cells and blocks, and where each text node sits in it. */
export interface BlockText {
  text: string;
  pieces: Piece[];
}

/** A rendered block: of its own side, or of the old side put into the new one (see `markRemoved`). */
const BLOCK = "[data-b], [data-was]";

/** Text nodes of `roots` in document order; with `own`, only those no block inside the root holds. */
export function textOf(roots: readonly Element[], own = false): BlockText {
  let text = "";
  const pieces: Piece[] = [];
  let box: Element | null = null;
  for (const root of roots) {
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const parent = n.parentElement;
      if (!parent || (own && parent.closest(BLOCK) !== root) || parent.closest(".md-gap")) continue;
      const at = parent.closest(`td, th, ${BLOCK}`);
      if (box && at !== box) text += "\n";
      box = at;
      pieces.push({ node: n, start: text.length, end: text.length + n.data.length });
      text += n.data;
    }
  }
  return { text, pieces };
}

const words = (s: string) => s.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0;
const blank = (s: string) => !/\S/.test(s);

/**
 * Wrap a range of the text in `<del>` or `<ins>`, or put removed text in a `<del>` at a place of it; `from` is where
 * that text starts in the old text, to take its formatting along.
 */
export type Op = { at: number; end: number; tag: "del" | "ins" } | { at: number; text: string; from?: number };

/** The inline elements around a text node, innermost first, up to the block or the table cell it is in. */
function inlineAround(el: Element | null): Element[] {
  const out: Element[] = [];
  for (let at = el; at && !at.matches(`${BLOCK}, td, th`); at = at.parentElement) out.push(at);
  return out;
}

/**
 * The old text from `from` to `to` as nodes, with the formatting it had (bold, a link, code) that the place it goes
 * to does not have; a line break between table cells or blocks becomes a space.
 */
function removedNodes(was: BlockText, from: number, to: number, place: Element | null): Node[] {
  const have = new Set(inlineAround(place).map((e) => e.tagName));
  const out: Node[] = [];
  let last: Piece | null = null;
  for (const p of was.pieces) {
    const a = Math.max(from, p.start);
    const b = Math.min(to, p.end);
    if (a >= b) continue;
    const doc = p.node.ownerDocument;
    if (last && last.end < p.start) out.push(doc.createTextNode(" "));
    let node: Node = doc.createTextNode(p.node.data.slice(a - p.start, b - p.start));
    for (const el of inlineAround(p.node.parentElement)) {
      if (have.has(el.tagName)) continue;
      const copy = doc.createElement(el.tagName.toLowerCase());
      const cls = el.getAttribute("class");
      if (cls) copy.setAttribute("class", cls);
      copy.append(node);
      node = copy;
    }
    out.push(node);
    last = p;
  }
  return out;
}

/**
 * Splits text nodes at the ops and wraps or inserts the marks, from the end so the offsets of the rest hold. A range
 * that crosses inline elements (bold, a link, code) is wrapped piece by piece inside each of them. With `was`, the old
 * text, removed text keeps its formatting.
 */
export function applyOps(t: BlockText, ops: readonly Op[], was?: BlockText): void {
  const sorted = [...ops].sort((a, b) => b.at - a.at || ("text" in a ? 1 : 0) - ("text" in b ? 1 : 0));
  for (const op of sorted) {
    if ("text" in op) {
      const p = t.pieces.find((x) => x.start <= op.at && op.at < x.end) ?? [...t.pieces].reverse().find((x) => x.end === op.at);
      if (!p) continue;
      const del = p.node.ownerDocument.createElement("del");
      if (was && op.from !== undefined) del.append(...removedNodes(was, op.from, op.from + op.text.length, p.node.parentElement));
      else del.textContent = op.text.replace(/\n+/g, " ");
      const local = op.at - p.start;
      const wrapped = p.node.parentElement?.tagName === "INS" ? p.node.parentElement : null;
      if (local <= 0) (wrapped ?? p.node).before(del);
      else if (local >= p.node.data.length) p.node.after(del);
      else p.node.splitText(local).before(del);
      continue;
    }
    for (const p of [...t.pieces].reverse()) {
      let a = Math.max(op.at, p.start) - p.start;
      let b = Math.min(op.end, p.end) - p.start;
      if (a >= b || a >= p.node.data.length || blank(p.node.data.slice(a, b))) continue;
      const seg = p.node.data.slice(a, b);
      a += seg.length - seg.trimStart().length;
      b -= seg.length - seg.trimEnd().length;
      if (b < p.node.data.length) p.node.splitText(b);
      const mid = a > 0 ? p.node.splitText(a) : p.node;
      const el = p.node.ownerDocument.createElement(op.tag);
      mid.replaceWith(el);
      el.append(mid);
    }
  }
}

type Target = { tag: "img" | "a"; index: number; was: string };

/** Two sets of blocks compared word by word: the text the reader sees, not the Markdown under it. */
export interface Unit {
  old: Element[];
  new: Element[];
  /** Only the text the blocks hold themselves: what is inside them is a unit of its own. */
  own: boolean;
  parts: ChangeObject<string>[];
  changed: number;
  total: number;
  /** Pictures and links of the new side whose address changed, by their place among the unit's pictures or links. */
  targets: Target[];
  /** Pictures or links were added or removed. */
  linksMoved: boolean;
}

const ATTR = { img: "data-src", a: "data-href" } as const;
const targetEls = (roots: readonly Element[], own: boolean, tag: "img" | "a") =>
  roots.flatMap((r) => [...r.querySelectorAll(`${tag}[${ATTR[tag]}]`)].filter((el) => !own || el.closest(BLOCK) === r));

export function compareUnit(old: Element[], nw: Element[], own: boolean): Unit {
  const parts = diffWordsWithSpace(textOf(old, own).text, textOf(nw, own).text);
  let changed = 0;
  let total = 0;
  for (const p of parts) {
    const n = words(p.value);
    total += p.added || p.removed ? n : 2 * n;
    if (p.added || p.removed) changed += n;
  }
  const targets: Target[] = [];
  let linksMoved = false;
  for (const tag of ["img", "a"] as const) {
    const a = targetEls(old, own, tag);
    const b = targetEls(nw, own, tag);
    if (a.length !== b.length) linksMoved = true;
    a.forEach((x, index) => {
      const was = x.getAttribute(ATTR[tag]) ?? "";
      if (b[index] && b[index].getAttribute(ATTR[tag]) !== was) targets.push({ tag, index, was });
    });
  }
  return { old, new: nw, own, parts, changed, total, targets, linksMoved };
}

export const rewritten = (u: Unit) => u.total > 0 && u.changed / u.total > REWRITTEN;
export const worded = (u: Unit) => !rewritten(u) && (u.changed > 0 || u.targets.length > 0);

const els = (root: ParentNode, list: readonly number[]) => list.flatMap((i) => root.querySelector(`[data-b="${i}"]`) ?? []);

/** The units of a changed row: each pair with both sides, a paired list, item or quote for its own text only. */
export function unitsOf(oldRoot: ParentNode, newRoot: ParentNode, pairs: readonly Pair[]): Unit[] {
  const out: Unit[] = [];
  const walk = (p: Pair) => {
    if (!p.old.length || !p.new.length) return;
    out.push(compareUnit(els(oldRoot, p.old), els(newRoot, p.new), !!p.children));
    for (const c of p.children ?? []) walk(c);
  };
  for (const p of pairs) walk(p);
  return out;
}

/** The marks of a unit: `del` ranges of the old text, `ins` ranges of the new, and both in the new text for one version. */
export function opsOf(u: Unit): { old: Op[]; new: Op[]; inline: Op[] } {
  const out = { old: [] as Op[], new: [] as Op[], inline: [] as Op[] };
  let o = 0;
  let n = 0;
  for (const p of u.parts) {
    if (p.removed) {
      if (!blank(p.value)) {
        out.old.push({ at: o, end: o + p.value.length, tag: "del" });
        out.inline.push({ at: n, text: p.value, from: o });
      }
      o += p.value.length;
    } else if (p.added) {
      if (!blank(p.value)) {
        out.new.push({ at: n, end: n + p.value.length, tag: "ins" });
        out.inline.push({ at: n, end: n + p.value.length, tag: "ins" });
      }
      n += p.value.length;
    } else {
      o += p.value.length;
      n += p.value.length;
    }
  }
  return out;
}

function markTargets(u: Unit, newEls: readonly Element[], oldEls: readonly Element[] | null): void {
  for (const t of u.targets) {
    const b = targetEls(newEls, u.own, t.tag)[t.index];
    if (b) {
      b.classList.add("md-target-new");
      b.setAttribute("title", `${b.getAttribute("title") ? `${b.getAttribute("title")} · ` : ""}was ${t.was}`);
    }
    if (oldEls) targetEls(oldEls, u.own, t.tag)[t.index]?.classList.add("md-target-old");
  }
}

/** Marks what changed word by word on both sides: `<del>` on the old one, `<ins>` on the new one. */
export function markWords(units: readonly Unit[]): void {
  for (const u of units) {
    if (!worded(u)) continue;
    const ops = opsOf(u);
    applyOps(textOf(u.old, u.own), ops.old);
    applyOps(textOf(u.new, u.own), ops.new);
    markTargets(u, u.new, u.old);
    for (const el of [...u.old, ...u.new]) el.classList.add("md-words");
  }
}

const oneSided = (p: Pair): boolean => !p.old.length || !p.new.length;

/**
 * The pairs of a row with each item or row inside a list or a table that was rewritten (and holds no other blocks)
 * taken apart: the old one removed and the new one added, as unified code shows a rewritten line. Its unit goes too.
 */
export function splitRewritten(pairs: readonly Pair[], units: readonly Unit[]): { pairs: Pair[]; units: Unit[] } {
  let k = 0;
  const kept: Unit[] = [];
  const walk = (list: readonly Pair[], inside: boolean): Pair[] =>
    list.flatMap((p): Pair[] => {
      if (oneSided(p)) return [p];
      const u = units[k++]!;
      if (inside && !p.children && rewritten(u)) return [{ old: p.old, new: [], children: null }, { old: [], new: p.new, children: null }];
      kept.push(u);
      return [p.children ? { ...p, children: walk(p.children, true) } : p];
    });
  const out = walk(pairs, false);
  return { pairs: out, units: kept };
}

/**
 * Whether a changed row can show as one version with its changes in the text: blocks that face each other are of the
 * same kind and in the same order, a block or an item, a row facing nothing was added or removed, no code block
 * changed, nothing was rewritten, the same number of pictures and links, and something to mark.
 */
export function isSimple(pairs: readonly Pair[], units: readonly Unit[], tagOf: (side: "old" | "new", i: number) => string): boolean {
  const same = (p: Pair): boolean =>
    oneSided(p) ||
    (p.old.length === 1 && p.new.length === 1 && tagOf("old", p.old[0]!) === tagOf("new", p.new[0]!) && tagOf("new", p.new[0]!) !== "code" && (p.children ?? []).every(same));
  const added = (p: Pair): boolean => oneSided(p) || (p.children ?? []).some(added);
  return pairs.every(same) && units.every((u) => !rewritten(u) && !u.linksMoved) && (units.some(worded) || pairs.some(added));
}

/** The new version of a simple row with its changes in the text: what was removed struck through where it was. */
export function markInline(newRoot: ParentNode, pairs: readonly Pair[], units: readonly Unit[]): void {
  let k = 0;
  const walk = (p: Pair) => {
    if (!p.old.length || !p.new.length) return;
    const u = units[k++]!;
    const here = els(newRoot, p.new);
    if (worded(u)) {
      applyOps(textOf(here, u.own), opsOf(u).inline, textOf(u.old, u.own));
      markTargets(u, here, null);
      for (const el of here) el.classList.add("md-words");
    }
    for (const c of p.children ?? []) walk(c);
  };
  for (const p of pairs) walk(p);
}

/**
 * Puts the blocks, items and rows that a simple row removed into its new version where they were, marked
 * `md-removed`. A copy names its old blocks by `data-was` instead of `data-b` and has no lines of the new version; a
 * removed item of an ordered list keeps its old number (`data-n`).
 */
export function markRemoved(oldRoot: ParentNode, newRoot: ParentNode, pairs: readonly Pair[]): void {
  const walk = (list: readonly Pair[], box: ParentNode) => {
    list.forEach((p, k) => {
      if (p.new.length) {
        const b = p.children && p.old.length ? els(newRoot, [p.new[0]!])[0] : undefined;
        if (b) walk(p.children!, b);
        return;
      }
      const a = els(oldRoot, p.old)[0];
      if (!a) return;
      const copy = a.cloneNode(true) as Element;
      for (const x of [copy, ...copy.querySelectorAll("[data-b]")]) {
        x.setAttribute("data-was", x.getAttribute("data-b")!);
        for (const name of ["data-b", "data-start", "data-end"]) x.removeAttribute(name);
      }
      copy.classList.add("md-removed");
      if (a.tagName === "LI" && a.parentElement?.tagName === "OL") {
        const items = [...a.parentElement.children].filter((c) => c.tagName === "LI");
        copy.setAttribute("data-n", String(Number(a.parentElement.getAttribute("start") ?? 1) + items.indexOf(a)));
      }
      const next = list.slice(k + 1).flatMap((q) => (q.new.length ? els(newRoot, [q.new[0]!]) : []))[0];
      if (next?.parentNode === box) next.before(copy);
      else box.append(copy);
    });
  };
  walk(pairs, newRoot);
}

/**
 * Numbers the pairs of a row on both sides (`data-pair`) so the page can line them up, and puts an empty slot
 * (`md-gap`) where an item, a row or a block inside a pair has nothing facing it.
 */
export function markPairs(oldRoot: ParentNode, newRoot: ParentNode, pairs: readonly Pair[]): void {
  let id = 0;
  const gapFor = (real: Element, box: Element): Element => {
    const doc = real.ownerDocument;
    if (box.tagName === "UL" || box.tagName === "OL") return doc.createElement("li");
    if (box.tagName === "TBODY" || box.tagName === "THEAD") {
      const tr = doc.createElement("tr");
      const td = doc.createElement("td");
      td.setAttribute("colspan", String(Math.max(1, real.children.length)));
      tr.append(td);
      return tr;
    }
    return doc.createElement("div");
  };
  const walk = (list: readonly Pair[], boxes: { old: Element; new: Element } | null) => {
    list.forEach((p, k) => {
      const a = p.old.length ? els(oldRoot, [p.old[0]!])[0] : undefined;
      const b = p.new.length ? els(newRoot, [p.new[0]!])[0] : undefined;
      if (a && b) {
        a.setAttribute("data-pair", String(id));
        b.setAttribute("data-pair", String(id++));
        if (p.children) walk(p.children, { old: a, new: b });
        return;
      }
      const real = a ?? b;
      if (!real || !boxes || boxes.old.tagName === "TABLE") return;
      const side = a ? "new" : "old";
      const box = boxes[side];
      const root = side === "old" ? oldRoot : newRoot;
      const next = list.slice(k + 1).flatMap((q) => (q[side].length ? els(root, [q[side][0]!]) : []))[0];
      const gap = gapFor(real, box);
      gap.classList.add("md-gap");
      gap.setAttribute("aria-hidden", "true");
      if (next?.parentElement === box) next.before(gap);
      else box.append(gap);
      real.setAttribute("data-pair", String(id));
      gap.setAttribute("data-pair", String(id++));
    });
  };
  walk(pairs, null);
}
