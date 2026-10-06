const IDS = ["data-b", "data-start", "data-end", "data-pair", "data-stop"];

function strip<T extends Element>(el: T): T {
  for (const x of [el, ...el.querySelectorAll("*")]) for (const a of IDS) x.removeAttribute(a);
  return el;
}

/** What names a row or an item for the slot after it: its block, or the old block of a removed one. */
export function unitKey(unit: Element): string {
  const was = unit.getAttribute("data-was");
  return unit.getAttribute("data-b") ?? (was === null ? "" : `was${was}`);
}

/** The row or list item a block stands in: itself, or the item a paragraph of a loose list is in. */
export function unitOf(el: Element): Element | null {
  return el.closest("tr, li");
}

/**
 * Ends the table or the list right after `unit` (a row or an item), puts an empty slot there for the threads on it,
 * and goes on below: a table with its header again, so the columns stay readable, an ordered list from the next
 * number. `pair` names the slot and the part below, so the same break on the other side can be lined up with it.
 */
export function breakAfter(unit: Element, pair: string): HTMLElement {
  const doc = unit.ownerDocument;
  const slot = doc.createElement("div");
  slot.className = "md-slot";
  slot.setAttribute("data-after", unitKey(unit));
  slot.setAttribute("data-pair", `slot-${pair}`);
  if (unit.tagName === "TR") {
    const table = unit.closest("table")!;
    const rows: Element[] = [...table.querySelectorAll("tr")];
    const rest = rows.slice(rows.indexOf(unit) + 1).filter((r) => r.parentElement?.tagName !== "THEAD");
    table.after(slot);
    if (!rest.length) return slot;
    const more = strip(table.cloneNode(false) as Element);
    more.classList.add("md-more");
    const head = table.querySelector("thead");
    if (head) {
      const again = strip(head.cloneNode(true) as Element);
      again.classList.add("md-again");
      more.append(again);
    }
    const body = doc.createElement("tbody");
    body.append(...rest);
    more.append(body);
    for (const b of table.querySelectorAll("tbody")) if (!b.children.length) b.remove();
    more.setAttribute("data-pair", `more-${pair}`);
    slot.after(more);
    return slot;
  }
  const list = unit.parentElement!;
  const rest: Element[] = [];
  for (let n = unit.nextElementSibling; n; n = n.nextElementSibling) rest.push(n);
  list.after(slot);
  if (!rest.length) return slot;
  const more = strip(list.cloneNode(false) as Element);
  more.classList.add("md-more");
  more.append(...rest);
  if (list.tagName === "OL") {
    const counted = [...list.children].filter((li) => li.tagName === "LI" && !li.matches(".md-gap, .md-removed")).length;
    more.setAttribute("start", String(Number(list.getAttribute("start") ?? 1) + counted));
  }
  more.setAttribute("data-pair", `more-${pair}`);
  slot.after(more);
  return slot;
}
