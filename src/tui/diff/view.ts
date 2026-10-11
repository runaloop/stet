/**
 * The diff widget: the rows of its items laid out for a width, a window of them on screen with the file's header kept
 * on top, a cursor over the rows, and the moves of the Changes page's keys. Split or unified by width (`auto` splits
 * when each side's code gets 72 cells), wrapped or cut sideways. Painted rows are cached until what they show changes.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import { blank, type Line } from "../text.ts";
import { lineCells } from "./cells.ts";
import { Layout } from "./layout.ts";
import { ADD, buildRows, CARD, CTX, DEL, FILE, GAP, GROUP, isLine, lastRow, lineText, PAIR, type FileItem, type Item, type Rows } from "./model.ts";
import { Painter, type Hooks, type LineMarks, type PaintOpts, type TokenSource } from "./paint.ts";

export type LayoutPref = "auto" | "split" | "unified";

/** Cells each side's code needs before `auto` puts the sides next to each other. */
export const SPLIT_MIN = 72;
const WRAP_CAP = 50;
const MARGIN = 2;
const NO_MARKS: LineMarks = { old: [], new: [] };

/** Lines of a file's side the screen shows or soon may: to be highlighted first. */
export interface Want {
  fd: FileDiffMetadata;
  side: 0 | 1;
  from: number;
  to: number;
}

/** What a row is, so that a key or a click on it can act: a file's header, a bar, a line, a thread's card. */
export interface RowInfo {
  row: number;
  kind: number;
  item: Item;
  index: number;
  oldNo: number;
  newNo: number;
  /** The thread of a card. */
  thread: number | null;
}

interface Anchor {
  key: string;
  kind: number;
  oldNo: number;
  newNo: number;
  thread: number;
  /** Screen lines from the row's top to the anchor point. */
  sub: number;
}

const digits = (n: number) => String(Math.max(1, n)).length;

export class DiffView {
  items: Item[] = [];
  rows: Rows = buildRows([], false);
  lay = new Layout(0, () => 1);
  width = 0;
  height = 0;
  pref: LayoutPref = "auto";
  wrap = true;
  hoff = 0;
  split = false;
  /** The screen line at the top of the view. */
  top = 0;
  cursor = 0;
  focus = true;
  /** Threads whose cards are open. */
  readonly opened = new Set<number>();
  /** The ▌ of threads on each file's lines, by item key. */
  marks = new Map<string, LineMarks>();
  /** Called with the lines on screen and around it, when they change. */
  onWant: ((w: Want[]) => void) | null = null;
  private num = 3;
  private readonly painted = new Map<number, Line[]>();
  private readonly cells = new WeakMap<FileDiffMetadata, [Int32Array, Int32Array]>();
  private readonly painter: Painter;
  private lastWant = "";

  constructor(
    private readonly hooks: Hooks,
    readonly tokens: TokenSource,
  ) {
    this.painter = new Painter(tokens);
  }

  // --- layout

  private get codeWidth(): number {
    if (!this.split) return Math.max(1, this.width - this.num * 2 - 3);
    const left = Math.floor((this.width - 1) / 2);
    return Math.max(1, Math.min(left, this.width - 1 - left) - this.num - 3);
  }

  private resolveSplit(): boolean {
    if (this.pref !== "auto") return this.pref === "split";
    const left = Math.floor((this.width - 1) / 2);
    return Math.min(left, this.width - 1 - left) - this.num - 3 >= SPLIT_MIN;
  }

  private lineCellsOf(fd: FileDiffMetadata, side: 0 | 1, i: number): number {
    let c = this.cells.get(fd);
    if (!c) this.cells.set(fd, (c = [new Int32Array(fd.deletionLines.length).fill(-1), new Int32Array(fd.additionLines.length).fill(-1)]));
    const arr = c[side];
    let v = arr[i] ?? -1;
    if (v < 0) arr[i] = v = lineCells(lineText(fd, side, i));
    return v;
  }

  private heightOf(r: number): number {
    const k = this.rows.kind[r]!;
    if (k === CARD) return this.paintRow(r).length;
    if (!isLine(k) || !this.wrap) return 1;
    const fd = (this.items[this.rows.item[r]!] as FileItem).fd;
    const cw = this.codeWidth;
    let h = 1;
    const a = this.rows.a[r]!;
    const b = this.rows.b[r]!;
    if (a >= 0 && (this.split || k === DEL)) h = Math.max(h, Math.ceil(this.lineCellsOf(fd, 0, a) / cw));
    if (b >= 0 && k !== DEL) h = Math.max(h, Math.ceil(this.lineCellsOf(fd, 1, b) / cw));
    return Math.min(WRAP_CAP, h);
  }

  private anchorAt(row: number, sub: number): Anchor | null {
    if (row < 0 || row >= this.rows.len) return null;
    const item = this.items[this.rows.item[row]!]!;
    const k = this.rows.kind[row]!;
    const f = item.kind === "file" ? item : null;
    return {
      key: item.key,
      kind: k,
      oldNo: this.rows.oldNo[row]!,
      newNo: this.rows.newNo[row]!,
      thread: k === CARD && f ? (f.placed?.[this.rows.x[row]!]?.threadId ?? -1) : -1,
      sub,
    };
  }

  /** The row an anchor names in the rows as they are now: the same line, else the nearest one before it in its file. */
  private find(a: Anchor): number {
    const i = this.items.findIndex((x) => x.key === a.key);
    if (i === -1) return -1;
    const first = this.rows.first[i]!;
    const last = lastRow(this.rows, i);
    const line = (r: number) => (a.newNo ? (this.rows.kind[r] === DEL ? 0 : this.rows.newNo[r]!) : this.rows.kind[r] === ADD ? 0 : this.rows.oldNo[r]!);
    const want = a.newNo || a.oldNo;
    let best = first;
    for (let r = first; r <= last; r++) {
      const k = this.rows.kind[r]!;
      if (k === CARD && a.thread !== -1) {
        const f = this.items[i] as FileItem;
        if (f.placed?.[this.rows.x[r]!]?.threadId === a.thread) return r;
        continue;
      }
      if (!want || (!isLine(k) && k !== GAP)) continue;
      const n = line(r);
      if (k === GAP) {
        if (n && want >= n && want < n + this.rows.n[r]!) best = r;
        continue;
      }
      if (n === want && (k === a.kind || isLine(a.kind) || a.kind === GAP)) return r;
      if (n && n < want) best = r;
    }
    return best;
  }

  /** Rows and their layout anew, the line at the top of the view and the cursor's row kept where they are. */
  private relayout(rebuild: Item[] | null): void {
    const topRow = this.lay.len ? this.lay.rowAt(this.top) : 0;
    const anchor = this.anchorAt(topRow, this.top - this.lay.top(topRow));
    const cur = this.anchorAt(this.cursor, 0);
    const screenY = this.lay.len ? this.lay.top(this.cursor) - this.top : 0;
    if (rebuild) this.items = rebuild;
    let most = 1;
    for (const it of this.items) {
      if (it.kind !== "file") continue;
      const fd = it.fd;
      const h = fd.hunks[fd.hunks.length - 1];
      most = Math.max(most, h ? Math.max(h.deletionStart + h.deletionCount, h.additionStart + h.additionCount) : 1, fd.isPartial ? 0 : Math.max(fd.deletionLines.length, fd.additionLines.length));
    }
    this.num = Math.max(3, digits(most) + 1);
    this.split = this.resolveSplit();
    if (rebuild || this.rows.len === 0 || this.split !== this.builtSplit) {
      this.rows = buildRows(this.items, this.split);
      this.builtSplit = this.split;
    }
    this.painted.clear();
    this.lineRows.clear();
    this.lay = new Layout(this.rows.len, (r) => this.heightOf(r));
    if (cur) {
      const r = this.find(cur);
      this.cursor = r === -1 ? Math.min(this.cursor, Math.max(0, this.rows.len - 1)) : r;
    } else this.cursor = Math.min(this.cursor, Math.max(0, this.rows.len - 1));
    this.painted.clear();
    // the cursor's line keeps its place on the screen when it was on it, else the line at the top does
    if (cur && screenY >= 0 && screenY < this.height) this.top = this.lay.top(this.cursor) - screenY;
    else if (anchor) {
      const r = this.find(anchor);
      if (r !== -1) this.top = this.lay.top(r) + Math.min(anchor.sub, this.lay.height(r) - 1);
    }
    this.clampTop();
  }

  private builtSplit = false;

  setItems(items: Item[]): void {
    this.relayout(items);
  }

  setSize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    const relay = w !== this.width;
    this.width = w;
    this.height = h;
    if (relay) this.relayout(null);
    else this.clampTop();
  }

  setLayout(pref: LayoutPref): void {
    this.pref = pref;
    this.relayout(null);
  }

  setWrap(on: boolean): void {
    this.wrap = on;
    this.hoff = 0;
    this.relayout(null);
  }

  /** Sideways, without wrap. */
  scrollSide(dx: number): void {
    if (this.wrap) return;
    this.hoff = Math.max(0, this.hoff + dx);
    this.painted.clear();
  }

  /** The rows of each file's lines, by side, made when colours first come for it. */
  private lineRows = new Map<FileDiffMetadata, [Int32Array, Int32Array]>();

  private rowsOfLines(fd: FileDiffMetadata): [Int32Array, Int32Array] | null {
    let m = this.lineRows.get(fd);
    if (m) return m;
    const i = this.items.findIndex((x) => x.kind === "file" && x.fd === fd);
    if (i === -1) return null;
    m = [new Int32Array(fd.deletionLines.length).fill(-1), new Int32Array(fd.additionLines.length).fill(-1)];
    for (let r = this.rows.first[i]!, end = lastRow(this.rows, i); r <= end; r++) {
      if (!isLine(this.rows.kind[r]!)) continue;
      if (this.rows.a[r]! >= 0) m[0][this.rows.a[r]!] = r;
      if (this.rows.b[r]! >= 0) m[1][this.rows.b[r]!] = r;
    }
    this.lineRows.set(fd, m);
    return m;
  }

  /**
   * Painted rows go as colours came for their lines: of a file's side from `start` on, `n` lines (all of the view's
   * rows without a file). True when one of them is on screen.
   */
  invalidate(fd: FileDiffMetadata | null = null, side: 0 | 1 = 1, start = 0, n = Number.MAX_SAFE_INTEGER): boolean {
    if (!fd) {
      this.painted.clear();
      return true;
    }
    const m = this.rowsOfLines(fd);
    if (!m) return false;
    const first = this.lay.len ? this.lay.rowAt(this.top) : 0;
    const last = this.lay.len ? this.lay.rowAt(this.top + this.height) : 0;
    let seen = false;
    const arr = m[side];
    for (let i = start, end = Math.min(arr.length, start + n); i < end; i++) {
      const r = arr[i]!;
      if (r < 0) continue;
      this.painted.delete(r);
      if (this.all || (r >= first && r <= last)) seen = true;
    }
    return seen;
  }

  /** Every row painted, for a short diff that scrolls with the text around it rather than on its own. */
  private all = false;

  allLines(): Line[] {
    this.all = true;
    const saved = [this.top, this.height];
    this.top = 0;
    this.height = this.lay.total;
    const out: Line[] = [];
    for (let r = 0; r < this.rows.len; r++) for (const l of this.paintRow(r)) out.push(l);
    this.want();
    [this.top, this.height] = saved as [number, number];
    return out;
  }

  /** A card opened or closed: its height changes and what is below moves. */
  toggleCard(thread: number, open?: boolean): void {
    const on = open ?? !this.opened.has(thread);
    if (on) this.opened.add(thread);
    else this.opened.delete(thread);
    this.relayout(null);
  }

  // --- painting

  private get opts(): PaintOpts {
    return { width: this.width, split: this.split, wrap: this.wrap, hoff: this.hoff, num: this.num, cap: WRAP_CAP };
  }

  /** In unified, the line a removed or added row's words are compared with: its partner in the change. */
  private pairOf(r: number): number {
    const k = this.rows.kind;
    if (this.split || (k[r] !== DEL && k[r] !== ADD)) return -1;
    let start = r;
    while (start > 0 && (k[start - 1] === DEL || k[start - 1] === ADD) && this.rows.x[start - 1] === this.rows.x[r] && !(k[start] === DEL && k[start - 1] === ADD)) start--;
    let firstAdd = start;
    while (firstAdd < this.rows.len && k[firstAdd] === DEL) firstAdd++;
    let end = firstAdd;
    while (end < this.rows.len && k[end] === ADD) end++;
    const dels = firstAdd - start;
    const adds = end - firstAdd;
    if (!dels || !adds) return -1;
    if (k[r] === DEL) {
      const p = r - start;
      return p < adds ? this.rows.b[firstAdd + p]! : -1;
    }
    const p = r - firstAdd;
    return p < dels ? this.rows.a[start + p]! : -1;
  }

  private paintRow(r: number): Line[] {
    const hit = this.painted.get(r);
    if (hit) return hit;
    const item = this.items[this.rows.item[r]!]!;
    const k = this.rows.kind[r]!;
    const f = item.kind === "file" ? item : null;
    const placed = k === CARD && f ? f.placed?.[this.rows.x[r]!] : undefined;
    const height = isLine(k) && r < this.lay.len ? this.lay.height(r) : 1;
    const lines = this.painter.row(this.rows, r, item, this.opts, {
      hooks: this.hooks,
      marks: f ? (this.marks.get(f.key) ?? NO_MARKS) : NO_MARKS,
      pair: this.pairOf(r),
      at: r === this.cursor,
      focus: this.focus,
      open: !!placed && this.opened.has(placed.threadId),
      height: isLine(k) ? Math.max(1, height) : 1,
    });
    if (!this.all && this.painted.size > 4000) this.painted.clear();
    this.painted.set(r, lines);
    return lines;
  }

  /** The item a row belongs to and what the row is. */
  info(r = this.cursor): RowInfo | null {
    if (r < 0 || r >= this.rows.len) return null;
    const index = this.rows.item[r]!;
    const item = this.items[index]!;
    const k = this.rows.kind[r]!;
    return {
      row: r,
      kind: k,
      item,
      index,
      oldNo: k === ADD ? 0 : this.rows.oldNo[r]!,
      newNo: k === DEL ? 0 : this.rows.newNo[r]!,
      thread: k === CARD && item.kind === "file" ? (item.placed?.[this.rows.x[r]!]?.threadId ?? null) : null,
    };
  }

  /** The file whose rows are at the top of the view. */
  topItem(): number {
    if (!this.rows.len) return -1;
    return this.rows.item[this.lay.rowAt(this.top + 1)]!;
  }

  /** Whether the row at the top is under its file's header, so the header stays on top over it. */
  private sticky(): boolean {
    if (!this.rows.len) return false;
    const r = this.lay.rowAt(this.top);
    const k = this.rows.kind[r]!;
    if (k === FILE && this.lay.top(r) === this.top) return false;
    const item = this.items[this.rows.item[r]!]!;
    return item.kind === "file" && k !== GROUP;
  }

  /** The view's `height` lines: the rows from the top, the file's header kept on top. */
  lines(): Line[] {
    this.clampTop();
    const out: Line[] = [];
    let r = this.rows.len ? this.lay.rowAt(this.top) : 0;
    let sub = this.rows.len ? this.top - this.lay.top(r) : 0;
    while (out.length < this.height && r < this.rows.len) {
      const lines = this.paintRow(r);
      for (; sub < lines.length && out.length < this.height; sub++) out.push(lines[sub]!);
      sub = 0;
      r++;
    }
    while (out.length < this.height) out.push(blank());
    if (this.sticky() && out.length) {
      const i = this.rows.item[this.lay.rowAt(this.top)]!;
      out[0] = this.paintRow(this.rows.first[i]!)[0]!;
    }
    this.want();
    return out;
  }

  private want(): void {
    if (!this.onWant || !this.rows.len) return;
    const ranges = new Map<FileDiffMetadata, [number, number, number, number]>();
    const add = (from: number, to: number) => {
      const a = this.lay.rowAt(Math.max(0, from));
      const b = this.lay.rowAt(Math.max(0, Math.min(this.lay.total - 1, to)));
      for (let r = a; r <= b; r++) {
        const k = this.rows.kind[r]!;
        if (!isLine(k)) continue;
        const it = this.items[this.rows.item[r]!] as FileItem;
        let x = ranges.get(it.fd);
        if (!x) ranges.set(it.fd, (x = [Infinity, -1, Infinity, -1]));
        const o = this.rows.a[r]!;
        const n = this.rows.b[r]!;
        if (o >= 0 && (this.split || k === DEL)) {
          x[0] = Math.min(x[0], o);
          x[1] = Math.max(x[1], o);
        }
        if (n >= 0 && k !== DEL) {
          x[2] = Math.min(x[2], n);
          x[3] = Math.max(x[3], n);
        }
      }
    };
    add(this.top, this.top + this.height);
    add(this.top + this.height, this.top + 3 * this.height);
    add(this.top - this.height, this.top);
    const out: Want[] = [];
    for (const [fd, x] of ranges) {
      if (x[3] >= 0) out.push({ fd, side: 1, from: x[2], to: x[3] + 1 });
      if (x[1] >= 0) out.push({ fd, side: 0, from: x[0], to: x[1] + 1 });
    }
    const key = out.map((w) => `${w.fd.cacheKey ?? w.fd.name}:${w.side}:${w.from}-${w.to}`).join(",");
    if (key === this.lastWant) return;
    this.lastWant = key;
    this.onWant(out);
  }

  // --- moving

  private clampTop(): void {
    const total = this.lay.total;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, total - this.height)));
  }

  /** Scrolls so that the cursor's row is in sight, with a margin; `align` puts it at the top or the middle. */
  reveal(align: "nearest" | "top" | "center" = "nearest"): void {
    if (!this.rows.len) return;
    const t = this.lay.top(this.cursor);
    const h = this.lay.height(this.cursor);
    const head = this.rows.kind[this.cursor] === FILE || this.rows.kind[this.cursor] === GROUP ? 0 : 1;
    if (align === "top") this.top = this.rows.kind[this.cursor] === FILE ? t : t - head;
    else if (align === "center") this.top = t - Math.max(0, Math.floor((this.height - h) / 2));
    else {
      const margin = Math.min(MARGIN, Math.floor(this.height / 4));
      if (t - margin - head < this.top) this.top = t - margin - head;
      else if (t + Math.min(h, this.height) + margin > this.top + this.height) this.top = t + Math.min(h, this.height) + margin - this.height;
    }
    this.clampTop();
    this.painted.clear();
  }

  /** Puts the cursor on row `r`. */
  goTo(r: number, align: "nearest" | "top" | "center" = "nearest"): void {
    if (!this.rows.len) return;
    const was = this.cursor;
    this.cursor = Math.max(0, Math.min(this.rows.len - 1, r));
    this.painted.delete(was);
    this.painted.delete(this.cursor);
    this.reveal(align);
  }

  moveBy(n: number): void {
    this.goTo(this.cursor + n);
  }

  first(): void {
    this.goTo(0, "top");
  }

  last(): void {
    this.goTo(this.rows.len - 1);
  }

  /** Half a screen: the view and the cursor move together, as Ctrl+d in Vim. */
  page(dir: 1 | -1): void {
    if (!this.rows.len) return;
    const by = Math.max(1, Math.floor(this.height / 2)) * dir;
    const y = this.lay.top(this.cursor) - this.top;
    this.top += by;
    this.clampTop();
    const target = this.lay.rowAt(Math.max(0, Math.min(this.lay.total - 1, this.top + y)));
    this.goTo(target);
  }

  /** The wheel: the view moves and the cursor stays on screen. */
  scroll(dy: number): void {
    this.top += dy;
    this.clampTop();
    const t = this.lay.top(this.cursor);
    if (t < this.top + 1) this.cursor = this.lay.rowAt(this.top + 1);
    else if (t >= this.top + this.height) this.cursor = this.lay.rowAt(this.top + this.height - 1);
    this.painted.clear();
  }

  /** The row on screen line `y` of the view. */
  rowAtLine(y: number): number {
    if (!this.rows.len) return -1;
    if (y === 0 && this.sticky()) return this.rows.first[this.rows.item[this.lay.rowAt(this.top)]!]!;
    const at = this.top + y;
    return at >= this.lay.total ? -1 : this.lay.rowAt(at);
  }

  private find1(dir: 1 | -1, test: (r: number) => boolean, from = this.cursor): number {
    for (let r = from + dir; r >= 0 && r < this.rows.len; r += dir) if (test(r)) return r;
    return -1;
  }

  /** The next file's header (or a fold group's row); -1 when there is none. */
  nextFile(dir: 1 | -1): number {
    const k = this.rows.kind;
    if (dir === -1) {
      // back to the header of the file the cursor is in, unless it is on it
      const own = this.rows.first[this.rows.item[this.cursor]!]!;
      if (own < this.cursor) return own;
    }
    return this.find1(dir, (r) => k[r] === FILE || k[r] === GROUP);
  }

  private isChange(r: number): boolean {
    const k = this.rows.kind[r]!;
    return k === DEL || k === ADD || (k === PAIR && this.rows.n[r]! > 0);
  }

  /** The first line of the next change: a run of removed or added lines. */
  nextChange(dir: 1 | -1): number {
    let r = this.cursor;
    if (dir === 1) {
      while (r < this.rows.len && this.isChange(r)) r++;
      return this.find1(1, (x) => this.isChange(x), r - 1);
    }
    while (r > 0 && this.isChange(r)) r--;
    const end = this.find1(-1, (x) => this.isChange(x), r);
    if (end === -1) return -1;
    let start = end;
    while (start > 0 && this.isChange(start - 1) && this.rows.item[start - 1] === this.rows.item[end]) start--;
    return start;
  }

  /** The first line of the next hunk. */
  nextHunk(dir: 1 | -1): number {
    const k = this.rows.kind;
    const startOf = (r: number) => isLine(k[r]!) && !(r > 0 && isLine(k[r - 1]!) && this.rows.item[r - 1] === this.rows.item[r] && this.rows.x[r - 1] === this.rows.x[r]);
    if (dir === 1) return this.find1(1, startOf);
    let r = this.cursor;
    while (r > 0 && !startOf(r)) r--;
    return this.find1(-1, startOf, r);
  }

  /** The next thread card, round the end. */
  nextCard(dir: 1 | -1): number {
    const k = this.rows.kind;
    const r = this.find1(dir, (x) => k[x] === CARD);
    if (r !== -1) return r;
    return this.find1(dir, (x) => k[x] === CARD, dir === 1 ? -1 : this.rows.len);
  }

  /** The row of a thread's card, -1 when the diff has none. */
  cardOf(thread: number): number {
    for (let r = 0; r < this.rows.len; r++) {
      if (this.rows.kind[r] !== CARD) continue;
      const it = this.items[this.rows.item[r]!] as FileItem;
      if (it.placed?.[this.rows.x[r]!]?.threadId === thread) return r;
    }
    return -1;
  }

  /** The thread whose lines (or card) the cursor is on. */
  threadAt(r = this.cursor): number | null {
    const i = this.info(r);
    if (!i || i.item.kind !== "file") return null;
    if (i.thread !== null) return i.thread;
    if (!isLine(i.kind)) return null;
    const hit = (i.item.placed ?? []).find((p) => {
      const n = p.side === "deletions" ? i.oldNo : i.newNo;
      return n > 0 && n >= p.range.start && n <= p.range.end;
    });
    return hit?.threadId ?? null;
  }

  /** The first row of item `i`. */
  itemRow(i: number): number {
    return this.rows.first[i] ?? -1;
  }

  /** Whether a row of the diff is a line of code or context, for the keys that act on lines. */
  static isCode(k: number): boolean {
    return k === CTX || k === DEL || k === ADD || k === PAIR;
  }
}
