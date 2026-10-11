/**
 * Syntax colours for the diff, from a worker: the code is painted plain first and coloured as tokens come, the lines on
 * screen first. Tokens stay here once they came; the worker ends a second after it has nothing left to do, so a big
 * file's grammar states do not hold memory, and a new one starts when lines without colours come into view.
 */
import { getFiletypeFromFileName, type FileDiffMetadata } from "@pierre/diffs";
import { blend } from "./colors.ts";
import { lineText } from "./model.ts";
import type { TokenSource } from "./paint.ts";
import type { Want } from "./view.ts";

const RECYCLE_MS = 1000;
/** The theme's background, for colours it gives with an alpha. */
const THEME_BG = "#070707";

type Lines = (Uint32Array | undefined)[];

/** Where the worker is: next to this file in the source tree, or as an entry point of the compiled binary. */
function workerUrl(): string {
  return new URL("./hl-worker.ts", import.meta.url).href;
}

export class Highlighter implements TokenSource {
  /** Files whose colours came: the caller paints them again. */
  onColours: (fd: FileDiffMetadata) => void = () => {};
  private worker: Worker | null = null;
  private sent = new Map<FileDiffMetadata, number>();
  private readonly byId = new Map<number, FileDiffMetadata>();
  private readonly toks = new WeakMap<FileDiffMetadata, [Lines, Lines]>();
  /** Files in a language the worker has no grammar for. */
  private readonly plain = new WeakSet<FileDiffMetadata>();
  private readonly styles: ({ fg: string; fs: number } | undefined)[] = [];
  private nextId = 1;
  private recycle: ReturnType<typeof setTimeout> | undefined;
  private last: Want[] = [];
  private closed = false;

  constructor(private readonly url: string = workerUrl()) {}

  line(fd: FileDiffMetadata, side: 0 | 1, i: number): Uint32Array | undefined {
    return this.toks.get(fd)?.[side][i];
  }

  style(id: number): { fg: string; fs: number } | undefined {
    return this.styles[id];
  }

  private start(): Worker {
    const w = new Worker(this.url);
    w.onmessage = (e: MessageEvent) => this.message(e.data);
    // a worker that cannot start leaves the code plain
    w.onerror = () => this.stop();
    this.worker = w;
    this.sent = new Map();
    return w;
  }

  private stop(): void {
    clearTimeout(this.recycle);
    this.worker?.terminate();
    this.worker = null;
    this.sent = new Map();
  }

  close(): void {
    this.closed = true;
    this.stop();
  }

  private colored(fd: FileDiffMetadata, w: Want): boolean {
    const t = this.toks.get(fd)?.[w.side];
    if (!t) return false;
    for (let i = w.from; i < w.to; i++) if (!t[i]) return false;
    return true;
  }

  /** The lines on screen and around it: those without colours go to the worker, first in line. */
  want(list: Want[]): void {
    if (this.closed) return;
    this.last = list;
    const open = list.filter((w) => !this.plain.has(w.fd) && !this.colored(w.fd, w));
    if (!open.length) return;
    clearTimeout(this.recycle);
    const worker = this.worker ?? this.start();
    for (const w of open) {
      if (this.sent.has(w.fd)) continue;
      const lang = getFiletypeFromFileName(w.fd.name);
      if (!lang || lang === "text") {
        this.plain.add(w.fd);
        continue;
      }
      const id = this.nextId++;
      this.sent.set(w.fd, id);
      this.byId.set(id, w.fd);
      const fd = w.fd;
      const sides = [fd.deletionLines.map((_, i) => lineText(fd, 0, i)), fd.additionLines.map((_, i) => lineText(fd, 1, i))];
      const chains: [number, number, number][] = fd.isPartial
        ? fd.hunks.flatMap((h) => [[1, h.additionLineIndex, h.additionLineIndex + h.additionCount] as [number, number, number], [0, h.deletionLineIndex, h.deletionLineIndex + h.deletionCount] as [number, number, number]])
        : [[1, 0, sides[1]!.length], [0, 0, sides[0]!.length]];
      worker.postMessage({ t: "file", id, lang, sides, chains });
    }
    const view = open.flatMap((w) => {
      const id = this.sent.get(w.fd);
      return id === undefined ? [] : [[id, w.side, w.from, w.to]];
    });
    worker.postMessage({ t: "view", want: view });
  }

  private message(m: { t: string; id?: number; side?: 0 | 1; start?: number; n?: number; pal?: [number, string, number][]; buf?: Uint32Array }): void {
    if (m.t === "idle") {
      clearTimeout(this.recycle);
      this.recycle = setTimeout(() => this.stop(), RECYCLE_MS);
      return;
    }
    const fd = m.id !== undefined ? this.byId.get(m.id) : undefined;
    if (!fd) return;
    if (m.t === "plain") {
      this.plain.add(fd);
      return;
    }
    if (m.t !== "tok") return;
    for (const [id, color, fs] of m.pal ?? []) this.styles[id] = { fg: color.length === 9 ? blend(color.slice(0, 7), THEME_BG, parseInt(color.slice(7), 16) / 255) : color || "#d6ddd8", fs };
    let t = this.toks.get(fd);
    if (!t) this.toks.set(fd, (t = [[], []]));
    const lines = t[m.side!];
    const buf = m.buf!;
    let p = 0;
    for (let j = 0; j < m.n!; j++) {
      const len = 1 + 2 * buf[p]!;
      lines[m.start! + j] = buf.subarray(p, p + len);
      p += len;
    }
    this.onColours(fd);
  }

  /** Whether every line on screen has its colours, for the tests. */
  done(): boolean {
    return this.last.every((w) => this.plain.has(w.fd) || this.colored(w.fd, w));
  }
}
