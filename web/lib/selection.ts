type Composed = Selection & { getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[] };

/**
 * The text the reader selected in `root` (an element, or the host of a file's code in its shadow root), as ranges:
 * Firefox gives a selection that skips text it may not select in several. "outside" when the selection reaches past
 * `root` (another file), none when it is elsewhere or empty.
 */
export function selectionIn(root: Element): Range[] | "outside" {
  const doc = root.ownerDocument;
  const sel = doc.getSelection() as Composed | null;
  if (!sel || sel.rangeCount === 0) return [];
  const scope: Node = root.shadowRoot ?? root;
  const all: AbstractRange[] =
    typeof sel.getComposedRanges === "function" ? sel.getComposedRanges({ shadowRoots: root.shadowRoot ? [root.shadowRoot] : [] }) : Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i));
  const out: Range[] = [];
  for (const r of all) {
    if (r.collapsed) continue;
    const inside = [scope.contains(r.startContainer), scope.contains(r.endContainer)];
    if (inside[0] !== inside[1]) return "outside";
    if (!inside[0]) continue;
    const live = doc.createRange();
    live.setStart(r.startContainer, r.startOffset);
    live.setEnd(r.endContainer, r.endOffset);
    out.push(live);
  }
  return out;
}

/** Of `els`, the ones a selection takes some text of: one it only reaches the edge of does not count. */
export function touchedBy(ranges: readonly Range[], els: Iterable<Element>): Element[] {
  return [...els].filter((el) =>
    ranges.some((range) => {
      if (!range.intersectsNode(el)) return false;
      const part = el.ownerDocument.createRange();
      part.selectNodeContents(el);
      if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0) part.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
      return part.toString() !== "";
    }),
  );
}

/** Drops the elements that hold another of them: a list whose items are there too. */
export function innermost(els: readonly Element[]): Element[] {
  return els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
}
