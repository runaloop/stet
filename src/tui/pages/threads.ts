import type { ThreadSummary } from "../../core/types.ts";
import { stateTone } from "../../ui/timeline.ts";
import { lineOf } from "../../ui/tree.ts";
import { threadGroups, type Data, type ListFilter } from "../model.ts";
import { blank, clip, line, plural, rangeText, s, spread, truncate, width, type Line, type Span } from "../text.ts";

export interface PageLines {
  lines: Line[];
  /** The thread each line shows, null for the others. */
  ids: (number | null)[];
}

/** The thread's marks in the list: draft, resolved, where its code is, whose turn. */
export function badges(t: ThreadSummary): Span[] {
  const out: Span[] = [];
  if (t.draft) out.push(s("draft", { tone: "warn" }));
  if (t.status === "resolved") out.push(s(`✓ resolved${t.resolveReason ? `: ${t.resolveReason}` : ""}`, { tone: "ok" }));
  if (t.anchor.state !== "ok") out.push(s(t.anchor.state, { tone: stateTone(t.anchor.state) }));
  if (t.status === "open" && !t.draft && t.needsReply === "reviewer") out.push(s("your turn", { tone: "accent", bold: true }));
  if (t.status === "open" && !t.draft && t.needsReply === "agent") out.push(s("agent's turn", { tone: "muted" }));
  return out.flatMap((b, i) => (i ? [s(" "), b] : [b]));
}

export function where(t: ThreadSummary): string {
  return t.region ? `area ${t.region.w}×${t.region.h}` : `L${rangeText(t.anchor.range ?? t.range)}`;
}

function row(t: ThreadSummary, idWidth: number, whereWidth: number, w: number, selected: boolean): Line {
  const title = t.title.split("\n")[0] ?? "";
  const marks = badges(t);
  const head: Span[] = [
    s(t.unread ? " ● " : "   ", { tone: "accent" }),
    s(`#${t.id}`.padEnd(idWidth + 1), { bold: t.unread, dim: t.status === "resolved" }),
    s(` ${where(t).padEnd(whereWidth)}  `, { tone: "muted" }),
    ...marks,
    s(marks.length ? "  " : ""),
  ];
  const used = head.reduce((n, x) => n + width(x.text), 0);
  return { spans: clip([...head, s(truncate(title, Math.max(0, w - used)), { dim: t.status === "resolved" })], w), selected };
}

export function threadsPage(d: Data, f: ListFilter, selected: number | null, w: number): PageLines {
  const groups = threadGroups(d, f, null);
  const open = d.threads.filter((t) => t.status === "open" && !t.draft).length;
  const fresh = d.threads.filter((t) => t.unread).length;
  const shown = f.newOnly ? "only threads with news" : f.status === "open" ? "open threads and drafts" : "all threads";
  const lines: Line[] = [
    { spans: spread([s("Threads", { bold: true }), s(`  ${open} open · ${d.threads.length} in all${fresh ? ` · ${fresh} new` : ""}`, { tone: "muted" })], [s(`showing ${shown}`, { tone: "muted" })], w) },
    blank(),
  ];
  const ids: (number | null)[] = [null, null];
  if (groups.length === 0) {
    lines.push(line(s(d.threads.length ? "  No threads match the filters: ␣ur shows resolved ones." : "  No threads yet. Comment on code in the browser or with `stet comment add`.", { tone: "muted" })));
    ids.push(null);
    return { lines, ids };
  }
  const all = groups.flatMap((g) => g.threads);
  const idWidth = Math.max(...all.map((t) => String(t.id).length + 1));
  const whereWidth = Math.max(...all.map((t) => where(t).length));
  for (const g of groups) {
    const slash = g.path.lastIndexOf("/");
    lines.push({ spans: spread([s(` ${g.path.slice(0, slash + 1)}`, { tone: "muted" }), s(g.path.slice(slash + 1), { bold: true })], [s(`${g.threads.length} `, { tone: "muted" })], w) });
    ids.push(null);
    for (const t of [...g.threads].sort((a, b) => lineOf(a) - lineOf(b))) {
      lines.push(row(t, idWidth, whereWidth, w, t.id === selected));
      ids.push(t.id);
    }
  }
  if (!f.newOnly && f.status === "open") {
    const resolved = d.threads.length - all.length;
    if (resolved > 0) {
      lines.push(blank(), line(s(`  ${plural(resolved, "resolved thread")} hidden: ␣ur shows them`, { tone: "muted" })));
      ids.push(null, null);
    }
  }
  return { lines, ids };
}
