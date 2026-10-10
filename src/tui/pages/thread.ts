import type { CommentDto, ThreadDetail, ThreadEventDto } from "../../core/types.ts";
import { codeLines, threadCode } from "../code.ts";
import { ago, blank, line, plural, rangeText, s, spread, wrap, type Line, type Span, type Tone } from "../text.ts";
import { badges } from "./threads.ts";

export interface ThreadLines {
  lines: Line[];
  /** The line of the first message that was new when the thread was opened. */
  newAt: number | null;
}

const WAITS: Record<string, string> = {
  question: "The agent asked you a question and waits for your answer.",
  fixed: "The agent says it fixed this. Check the code, then resolve (x) or reply (r).",
  disagree: "The agent disagrees. Read why, then resolve (x) or answer (r).",
  answered: "The agent answered. Resolve (x) if that settles it, or reply (r).",
};

const INTENT_TONE: Record<string, Tone> = { fixed: "ok", disagree: "bad", question: "warn", answered: "info" };

/** What the thread waits for, as the web's strip over the code says it. */
export function stateText(d: ThreadDetail, now = Date.now()): { text: string; tone: Tone } | null {
  const t = d.thread;
  const myDraft = d.comments.some((c) => c.draft && c.role === "reviewer");
  if (t.draft) return { text: "Draft thread: the agent sees it after you submit the review (S).", tone: "warn" };
  if (t.status === "open" && d.comments.some((c) => c.draft && c.resolves)) {
    return { text: "Your message resolves this thread when you submit the review (S); the agent then does as it says, without asking again.", tone: "warn" };
  }
  if (t.status === "resolved") {
    const reason = t.resolveReason === "wontfix" ? "won't fix" : t.resolveReason === "go" ? "with your message: the agent does as it says" : t.resolveReason;
    const by = t.resolvedBy ? ` · by ${t.resolvedBy === "reviewer" ? "you" : t.resolvedBy}` : "";
    return { text: `✓ Resolved${reason ? ` · ${reason}` : ""}${by}${t.resolvedAt ? ` · ${ago(t.resolvedAt, now)}` : ""} · X reopens it`, tone: "ok" };
  }
  const published = d.comments.filter((c) => !c.draft);
  const last = published[published.length - 1];
  if (!last) return null;
  const draftNote = myDraft ? " Your reply is a draft: submit the review (S) to send it." : "";
  if (last.role === "reviewer") return { text: `Waiting for the agent: it has your last message.${draftNote}`, tone: "muted" };
  return { text: `Your turn. ${WAITS[last.intent ?? ""] ?? "The agent replied."}${draftNote}`, tone: "accent" };
}

function rule(title: string, w: number): Line {
  const head = `── ${title} `;
  return line(s(head, { tone: "muted" }), s("─".repeat(Math.max(0, w - Bun.stringWidth(head))), { tone: "muted" }));
}

function commentHead(c: CommentDto, d: ThreadDetail, now: number): Span[] {
  const step = d.timeline[c.step];
  const out: Span[] = [s(c.author, { bold: true, tone: c.role === "agent" ? "agent" : undefined }), s(c.role === "agent" ? " · agent" : " · you", { tone: "muted" })];
  if (c.intent) out.push(s(" · "), s(c.intent, { tone: INTENT_TONE[c.intent] ?? "info" }));
  if (c.draft) out.push(s(" · "), s("draft · not sent", { tone: "warn", bold: true }));
  if (c.resolves) out.push(s(" · "), s(c.draft ? "✓ resolves the thread when sent" : "✓ resolved with this", { tone: "ok" }));
  if (step) out.push(s(` · @${step.label}`, { tone: "muted" }));
  out.push(s(` · ${ago(c.createdAt, now)}`, { tone: "muted" }));
  return out;
}

function bodyLines(text: string, indent: number, w: number): Line[] {
  const pad = " ".repeat(indent);
  const out: Line[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      fenced = !fenced;
      out.push(line(pad, s(raw, { tone: "muted" })));
      continue;
    }
    for (const part of wrap(raw, w - indent)) out.push(line(pad, s(part, fenced ? { tone: "info" } : {})));
  }
  return out;
}

function eventLine(e: ThreadEventDto, now: number): Line {
  const who = e.role === "reviewer" ? "you" : e.role;
  return line(s(e.type === "resolved" ? "✓ resolved" : "↺ reopened", { tone: e.type === "resolved" ? "ok" : "warn" }), s(` by ${who} · ${ago(e.at, now)}`, { tone: "muted" }));
}

/** The thread page: where its code is and what it waits for, the code, then the conversation. */
export function threadPage(d: ThreadDetail, fresh: ReadonlySet<number>, w: number, now = Date.now()): ThreadLines {
  const t = d.thread;
  const path = t.anchor.path ?? t.path;
  const lines: Line[] = [];
  const at = t.region ? ` · area ${t.region.w}×${t.region.h}` : `:${rangeText(t.anchor.range ?? t.range)}`;
  lines.push({ spans: spread([s(`#${t.id} `, { bold: true }), s(path, { bold: true }), s(at, { tone: "muted" })], [s(`written on ${d.timeline[0]!.label}`, { tone: "muted" })], w) });
  const marks = badges(t);
  const status = t.status === "open" && !t.draft ? [s("open", { tone: "accent" }), ...(marks.length ? [s(" · ")] : [])] : [];
  const moved = t.anchor.path && t.anchor.path !== t.path ? [s(` · was ${t.path}`, { tone: "info" })] : [];
  if (status.length || marks.length || moved.length) lines.push(line(...status, ...marks, ...moved));
  lines.push(line(s(t.title.split("\n")[0] ?? "", { italic: true })));
  const state = stateText(d, now);
  if (state) for (const part of wrap(state.text, w)) lines.push(line(s(part, { tone: state.tone })));
  lines.push(blank());

  const code = threadCode(d);
  lines.push(rule(`code · ${code.title}`, w), ...codeLines(code, w), blank());

  lines.push(rule(plural(d.comments.length, "message"), w));
  let newAt: number | null = null;
  const kids = new Map<number | null, CommentDto[]>();
  for (const c of d.comments) kids.set(c.parentId, [...(kids.get(c.parentId) ?? []), c]);
  const emit = (c: CommentDto, depth: number) => {
    const indent = Math.min(depth, 3) * 2;
    if (fresh.has(c.id) && newAt === null) {
      newAt = lines.length;
      lines.push(line(s(`${" ".repeat(indent)}── new `, { tone: "accent", bold: true }), s("─".repeat(Math.max(0, w - indent - 7)), { tone: "accent" })));
    }
    lines.push(line(" ".repeat(indent), ...commentHead(c, d, now)), ...bodyLines(c.body, indent + 2, w));
    if (c.restore) {
      const v = c.restore.version === "base" ? "the base" : `v${c.restore.version}`;
      lines.push(line(" ".repeat(indent + 2), s(`↺ asks to restore ${c.restore.path}:${rangeText(c.restore.range)} as in ${v}`, { tone: "info" })));
    }
    lines.push(blank());
    for (const k of kids.get(c.id) ?? []) emit(k, depth + 1);
  };
  const items: { at: string; emit: () => void }[] = [
    ...(kids.get(null) ?? []).map((c) => ({ at: c.createdAt, emit: () => emit(c, 0) })),
    ...d.events.map((e) => ({ at: e.at, emit: () => void lines.push(eventLine(e, now), blank()) })),
  ];
  for (const item of items.sort((a, b) => a.at.localeCompare(b.at))) item.emit();
  return { lines, newAt };
}
