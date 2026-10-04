import { searchInput, searchRegex, searchScope, sideTab } from "./compare.ts";
import { notify } from "./state.ts";

export function selectedWord(): string | null {
  const s = (window.getSelection()?.toString() ?? "").trim();
  return s && s.length <= 120 && !s.includes("\n") ? s : null;
}

const NAME_CHAR = /[\p{L}\p{N}_]/u;

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number, options?: { shadowRoots?: ShadowRoot[] }) => { offsetNode: Node; offset: number } | null;
};

/** A double-click on a name in code, on any page, finds where it is used. */
export function onDoubleClick(e: MouseEvent): void {
  const path = e.composedPath();
  const line = path.find(
    (n): n is Element => n instanceof Element && (n.matches("[data-content] > [data-line]") || (n.matches("code, pre") && n.getRootNode() === document)),
  );
  if (!line || (e.target as Element).closest?.("textarea, input, button, a, .new-thread")) return;
  selectName(e, path, line);
  const w = selectedWord();
  if (w && /^[\p{L}\w$.]{2,80}$/u.test(w)) findUsages(w);
}

/**
 * The browser picks the word from what is on screen, so a name that a wrapped line breaks in two ("popCo" | "unt")
 * came out as the piece that was clicked: select the whole name from the line's text instead.
 */
function selectName(e: MouseEvent, path: EventTarget[], line: Element): void {
  const shadowRoots = path.filter((n): n is ShadowRoot => n instanceof ShadowRoot);
  const at = (document as CaretDocument).caretPositionFromPoint?.(e.clientX, e.clientY, { shadowRoots });
  if (!at || at.offsetNode.nodeType !== Node.TEXT_NODE || !line.contains(at.offsetNode)) return;
  const parts: { node: Text; start: number }[] = [];
  let text = "";
  let pos = -1;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === at.offsetNode) pos = text.length + at.offset;
    parts.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }
  let from = pos;
  let to = pos;
  while (from > 0 && NAME_CHAR.test(text[from - 1]!)) from--;
  while (to < text.length && NAME_CHAR.test(text[to]!)) to++;
  if (pos < 0 || to - from < 2) return;
  const point = (i: number, end: boolean): [Node, number] => {
    let p = parts[0]!;
    for (const q of parts) if (end ? q.start < i : q.start <= i) p = q;
    return [p.node, i - p.start];
  };
  window.getSelection()?.setBaseAndExtent(...point(from, false), ...point(to, true));
}

export function findUsages(word: string | null = selectedWord()): boolean {
  if (!word) {
    notify("select a name first: * then finds where it is used (a double-click on a name does both)");
    return true;
  }
  searchScope.value = "files";
  searchRegex.value = true;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  searchInput.value = /^\w+$/.test(word) ? `\\b${escaped}\\b` : escaped;
  sideTab.value = "search";
  return true;
}
