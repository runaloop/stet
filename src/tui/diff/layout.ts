/** Rows laid out top to bottom: each row's height in screen lines, and where it starts, by prefix sums. */
export class Layout {
  /** `tops[r]` is the screen line row `r` starts at; `tops[len]` the height of everything. */
  readonly tops: Int32Array;

  constructor(
    readonly len: number,
    private readonly heightOf: (r: number) => number,
  ) {
    this.tops = new Int32Array(len + 1);
    this.from(0);
  }

  get total(): number {
    return this.tops[this.len]!;
  }

  height(r: number): number {
    return this.tops[r + 1]! - this.tops[r]!;
  }

  top(r: number): number {
    return this.tops[Math.max(0, Math.min(this.len, r))]!;
  }

  /** Heights again from row `r` on, after its height changed. */
  from(r: number): void {
    const t = this.tops;
    for (let i = r; i < this.len; i++) t[i + 1] = t[i]! + this.heightOf(i);
  }

  /** The row on screen line `y`. */
  rowAt(y: number): number {
    const t = this.tops;
    let lo = 0;
    let hi = Math.max(0, this.len - 1);
    if (y <= 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (t[mid]! <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}
