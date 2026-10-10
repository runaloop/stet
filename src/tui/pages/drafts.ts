import type { Data } from "../model.ts";
import { blank, line, plural, rangeText, s, spread, wrap, type Line } from "../text.ts";

export interface DraftLines {
  lines: Line[];
  /** The draft each line shows, null for the others. */
  ids: (number | null)[];
}

const BODY_LINES = 6;

/** Your review before it goes out: the drafts, the summary, and what S and A do. */
export function draftsPage(d: Data, selected: number | null, summary: string, w: number): DraftLines {
  const list = d.drafts;
  const latest = d.status?.versions ?? 0;
  const lines: Line[] = [line(s("Your review", { bold: true }), s(` · ${plural(list.length, "draft")}`, { tone: "muted" })), blank()];
  const ids: (number | null)[] = [null, null];
  const note = list.length
    ? `The agent does not see these yet. S sends them all in one go: request changes. A approves${latest ? ` v${latest}` : ""}; drafts sent with it are nits the agent fixes without a new round.`
    : `No drafts. A (or S) approves${latest ? ` v${latest}` : " the latest version"}: it says this version is done.`;
  for (const part of wrap(note, w)) {
    lines.push(line(s(part, { tone: "muted" })));
    ids.push(null);
  }
  lines.push(blank());
  ids.push(null);
  const byId = new Map(d.threads.map((t) => [t.id, t]));
  for (const c of list) {
    const t = byId.get(c.threadId);
    const at = t ? (t.region ? ` ${t.path} · area` : ` ${t.anchor.path ?? t.path}:${rangeText(t.anchor.range ?? t.range)}`) : "";
    const right = c.resolves ? [s("✓ resolves the thread ", { tone: "ok" })] : [];
    lines.push({ spans: spread([s(` #${c.threadId}`, { bold: true }), s(at), s(` · ${c.parentId === null ? "new thread" : "reply"}`, { tone: "muted" })], right, w), selected: c.id === selected });
    ids.push(c.id);
    const body = wrap(c.body, w - 3);
    for (const part of body.slice(0, BODY_LINES)) {
      lines.push(line("   ", s(part)));
      ids.push(c.id);
    }
    if (body.length > BODY_LINES) {
      lines.push(line(s(`   … ${plural(body.length - BODY_LINES, "more line")}`, { tone: "muted" })));
      ids.push(c.id);
    }
    if (c.restore) {
      lines.push(line(s(`   ↺ asks to restore ${c.restore.path}:${rangeText(c.restore.range)}`, { tone: "info" })));
      ids.push(c.id);
    }
    lines.push(blank());
    ids.push(null);
  }
  lines.push({ spans: spread([s("── summary for the whole review ", { tone: "muted" })], [s("c writes it ", { tone: "muted" })], w) });
  ids.push(null);
  for (const part of summary.trim() ? wrap(summary, w - 3) : ["(none)"]) {
    lines.push(line("   ", s(part, summary.trim() ? {} : { tone: "muted" })));
    ids.push(null);
  }
  return { lines, ids };
}
