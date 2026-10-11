import type { ThreadSummary } from "../../core/types.ts";
import { threadGroups, type Data, type ListFilter } from "../model.ts";
import { blank, key, line, s, spansWidth, spread, type Line, type Span } from "../text.ts";
import { tags, where } from "./thread.ts";

export interface ListLines {
  lines: Line[];
  /** The thread each line shows, null for the others. */
  ids: (number | null)[];
}

export const LIST_TITLE: Span[] = [s("Threads", "tabin"), s(" "), s("Files", "dim"), s(" "), s("Search", "dim")];

function headSpans(t: ThreadSummary): Span[] {
  const marks = tags(t);
  return [s(" "), t.unread ? s("●", "new") : s(" "), s(" "), s(`#${t.id}`, "b"), s(` ${where(t)}`), ...(marks.length ? [s(" "), ...marks] : [])];
}

function fileSpans(path: string, n: number, w: number): Span[] {
  const slash = path.lastIndexOf("/");
  return spread([s(" "), s(path.slice(0, slash + 1), "dim"), s(path.slice(slash + 1), "b")], [s(String(n), "dim")], w);
}

/** The cells the list's rows want, its border included; the title lines of threads are cut instead. */
export function listWidth(d: Data, f: ListFilter): number {
  const groups = threadGroups(d, f, null);
  let most = 0;
  for (const g of groups) {
    most = Math.max(most, Bun.stringWidth(g.path) + 4);
    for (const t of g.threads) most = Math.max(most, spansWidth(headSpans(t)) + 1);
  }
  return most + 2;
}

/** The threads by file, two rows each: where and whose turn, then the title. The selected thread's rows are filled. */
export function listLines(d: Data, f: ListFilter, selected: number | null, focus: boolean, w: number): ListLines {
  const groups = threadGroups(d, f, null);
  const open = d.threads.filter((t) => t.status === "open" && !t.draft).length;
  const resolved = d.threads.filter((t) => t.status === "resolved").length;
  const filters: Span[] = [
    s(" "),
    s(`open ${open}`, f.status === "open" && !f.newOnly ? "fon" : "dim"),
    s(" "),
    s(`resolved ${resolved} ·`, "dim"),
    s(" "),
    s(`all ${d.threads.length}`, f.status === "all" && !f.newOnly ? "fon" : "dim"),
    s(" · ", "dim"),
    s(`[${f.newOnly ? "x" : " "}] new`, f.newOnly ? "fon" : "dim"),
  ];
  const lines: Line[] = [{ spans: filters }, blank()];
  const ids: (number | null)[] = [null, null];
  if (groups.length === 0) {
    lines.push(line(s(d.threads.length ? " No threads match the filters." : " No threads yet.", "dim")));
    ids.push(null);
  }
  const fill = focus ? "sel" : "seli";
  for (const g of groups) {
    lines.push({ spans: fileSpans(g.path, g.threads.length, w) });
    ids.push(null);
    for (const t of g.threads) {
      const on = t.id === selected;
      const title = t.title.split("\n")[0] ?? "";
      lines.push({ spans: headSpans(t), ...(on ? { fill: [fill] } : {}) });
      lines.push({ spans: [s("   "), s(title, "dim")], ...(on ? { fill: [fill] } : {}) });
      ids.push(t.id, t.id);
    }
  }
  if (!f.newOnly && f.status === "open") {
    const hidden = d.threads.filter((t) => t.status === "resolved").length;
    if (hidden > 0) {
      lines.push(blank(), line(s(` ${hidden} resolved hidden ·`, "dim"), s(" "), key("Space u r")));
      ids.push(null, null);
    }
  }
  return { lines, ids };
}
