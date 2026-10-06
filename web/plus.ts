import type { SelectedLineRange } from "@pierre/diffs";
import { selectionLines, type SideLines } from "./lib/cursor.ts";
import { drawnLines } from "./lib/marks.ts";
import { selectionIn, touchedBy } from "./lib/selection.ts";
import { notify } from "./state.ts";

export type Picked = { side: "additions" | "deletions"; start: number; end: number };

/**
 * What `+` beside a line or a block comments on when text is selected: every line, or block, the selection takes some
 * text of; null without a selection there. A selection that takes removed lines and added ones, or reaches into
 * another file, has no one range: `+` keeps to its own line, and a notice says so.
 */
export function pickedBySelection(root: Element, pieces: (touched: Range[]) => SideLines[], what: "line" | "block"): Picked | null {
  const ranges = selectionIn(root);
  const picked = ranges === "outside" ? "outside" : ranges.length ? selectionLines(pieces(ranges)) : null;
  if (picked === "outside" || picked === "both") {
    notify(`the selection ${picked === "both" ? "takes removed lines and added ones" : "goes past this file"}, so + comments on its own ${what} only`);
    return null;
  }
  if (picked) root.ownerDocument.getSelection()?.removeAllRanges();
  return picked;
}

/** The lines `+` in a file's code comments on: the lines a text selection in the file takes, else the line or lines `+` picked. */
export function plusLines(container: Element | null, range: SelectedLineRange): SelectedLineRange {
  if (!container || range.start !== range.end) return range;
  const rows = (ranges: Range[]) => {
    const drawn = drawnLines(container);
    const els = new Set(touchedBy(ranges, drawn.map((r) => r.el)));
    return drawn.filter((r) => els.has(r.el)).map((r) => Object.fromEntries(r.at.map(([side, n]) => [side, { start: n, end: n }])) as SideLines);
  };
  const picked = pickedBySelection(container, rows, "line");
  return picked ? { start: picked.start, end: picked.end, side: picked.side, endSide: picked.side } : range;
}
