import type { Side } from "./search.ts";

export interface LineMark {
  side: Side;
  start: number;
  end: number;
  tag: string;
  ranges?: [number, number][];
  current?: boolean;
  /** Shown over the line number of the mark's first line. */
  label?: string;
}

/** Where a thread is on the lines of a file. */
export interface ThreadLines {
  threadId: number;
  side: Side;
  range: { start: number; end: number };
}

/** The thread marked so that it cannot be mistaken for another at the same place; it flashes at first. */
export interface Spot {
  id: number;
  flash: boolean;
}

/**
 * The marks of the threads on one file's lines, the focused one's stronger. A thread in the spotlight is framed, with its
 * number on its first line, and the other threads of the file are dimmed.
 */
export function threadMarks(placed: readonly ThreadLines[], focus: number | null, spot: Spot | null): LineMark[] {
  const lit = !!spot && placed.some((p) => p.threadId === spot.id);
  return placed.flatMap((p): LineMark[] => {
    const at = { side: p.side, start: p.range.start, end: p.range.end };
    if (spot && p.threadId === spot.id) {
      return [
        { ...at, tag: "spot", label: `#${p.threadId}` },
        { ...at, end: at.start, tag: "spot-first" },
        { ...at, start: at.end, tag: "spot-last" },
        ...(spot.flash ? [{ ...at, tag: "flash" }] : []),
      ];
    }
    return [{ ...at, tag: lit ? "dim" : p.threadId === focus ? "focus" : "thread" }];
  });
}
