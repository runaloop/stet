import type { CompareDto, CompareFile, ThreadSummary } from "../../core/types.ts";
import { threadGroups, type Data, type ListFilter } from "../model.ts";
import { blank, key, line, s, spansWidth, spread, type Line, type Span } from "../text.ts";
import { tags, where } from "./thread.ts";

export interface ListLines {
  lines: Line[];
  /** The thread each line shows, null for the others. */
  ids: (number | null)[];
}

export type Side = "threads" | "files" | "search";

/** The left column's tabs in its border; the open one filled, Search dim until it comes. */
export function sideTitle(side: Side): Span[] {
  const tab = (id: Side, name: string): Span => ({ ...s(` ${name} `, ...(id === side ? (["tab"] as const) : id === "search" ? (["bd"] as const) : (["dim"] as const))), hit: `side:${id}` });
  return [tab("threads", "Threads"), s(" "), tab("files", "Files"), s(" "), tab("search", "Search")];
}

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
export function listLines(d: Data, f: ListFilter, selected: number | null, focus: boolean, w: number, landed: string | null = null): ListLines {
  const groups = threadGroups(d, f, selected);
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
    lines.push({ spans: fileSpans(g.path, g.threads.length, w), ...(g.path === landed ? { fill: ["info" as const] } : {}) });
    ids.push(null);
    for (const t of g.threads) {
      const on = t.id === selected;
      const title = t.title.split("\n")[0] ?? "";
      lines.push({ spans: headSpans(t), hit: `thread:${t.id}`, ...(on ? { fill: [fill] } : {}) });
      lines.push({ spans: [s("   "), s(title, "dim")], hit: `thread:${t.id}`, ...(on ? { fill: [fill] } : {}) });
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

export const fileOf = (t: ThreadSummary) => t.anchor.path ?? t.path;

function fileStatus(f: CompareFile): string {
  return f.status === "A" ? "new" : f.status === "D" ? "deleted" : f.status === "R" ? `renamed from ${f.oldPath}` : f.binary ? "binary" : "";
}

/** −N +M of a file, or its status when it has no lines to count. */
export function fileCounts(f: CompareFile): Span[] {
  const out: Span[] = [];
  if (f.deletions) out.push(s(`−${f.deletions}`, "delc"));
  if (f.additions) out.push(...(out.length ? [s(" ")] : []), s(`+${f.additions}`, "addc"));
  return out;
}

/** The review's changed files: −N +M and how many threads each has, a red dot when one of them is unread. */
export function filesLines(d: Data, files: CompareDto | null, selected: string | null, focus: boolean, w: number): { lines: Line[]; paths: (string | null)[] } {
  if (!files) return { lines: [blank(), line(s(" loading the files…", "dim"))], paths: [null, null] };
  const lines: Line[] = [line(s(` ${files.files.length} file${files.files.length === 1 ? "" : "s"} · ${files.from.label} → ${files.to.label}`, "dim")), blank()];
  const paths: (string | null)[] = [null, null];
  const fill = focus ? "sel" : "seli";
  for (const f of files.files) {
    const threads = d.threads.filter((t) => fileOf(t) === f.path);
    const slash = f.path.lastIndexOf("/");
    const status = fileStatus(f);
    const right: Span[] = [...fileCounts(f), s(" "), threads.some((t) => t.unread) ? s("●", "new") : s(" "), threads.length ? s(String(threads.length)) : s("·", "dim")];
    const left: Span[] = [s(" "), s(f.path.slice(0, slash + 1), "dim"), s(f.path.slice(slash + 1)), ...(status ? [s(` ${status}`, "dim")] : [])];
    lines.push({ spans: spread(left, right, w), hit: `file:${f.path}`, ...(f.path === selected ? { fill: [fill] } : {}) });
    paths.push(f.path);
  }
  return { lines, paths };
}
