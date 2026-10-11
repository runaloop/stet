import type { CommentDto, ThreadDetail, ThreadSummary, TimelineStepDto } from "../../core/types.ts";
import { readingOrder } from "../../ui/msgs.ts";
import { threadStrip } from "../../ui/strip.ts";
import { codeLines, codeViews, fileHeader, threadCode, type CodeView } from "../code.ts";
import { ago, blank, filled, key, line, plural, rangeText, s, wrap, type Cls, type Line, type Span } from "../text.ts";

const tag = (text: string, c: Cls) => s(` ${text} `, c);

/** The thread's marks: draft, resolved, where its code is, whose turn. */
export function tags(t: ThreadSummary): Span[] {
  const out: Span[] = [];
  if (t.draft) out.push(tag("draft", "tdr"));
  if (t.status === "resolved") out.push(s(`✓ resolved${t.resolveReason ? `: ${t.resolveReason === "wontfix" ? "won't fix" : t.resolveReason}` : ""}`, "ok"));
  if (t.anchor.state === "changed" || t.anchor.state === "moved") out.push(tag(t.anchor.state, "tchg"));
  if (t.anchor.state === "outdated") out.push(tag("outdated", "tout"));
  if (t.status === "open" && !t.draft && t.needsReply === "reviewer") out.push(tag("your turn", "tyou"));
  if (t.status === "open" && !t.draft && t.needsReply === "agent") out.push(tag("agent's turn", "tag"));
  return out.flatMap((b, i) => (i ? [s(" "), b] : [b]));
}

export function where(t: ThreadSummary): string {
  const r = t.anchor.range ?? t.range;
  return t.region ? `area ${t.region.w}×${t.region.h}` : `L${rangeText(r)}`;
}

/** The thread's title in its border: `#1 src/auth.ts:6–7  changed   your turn  written on v1`. */
export function threadTitle(d: ThreadDetail, written = true): Span[] {
  const t = d.thread;
  const path = t.anchor.path ?? t.path;
  const at = t.region ? ` · area ${t.region.w}×${t.region.h}` : `:${rangeText(t.anchor.range ?? t.range)}`;
  const marks = tags(t);
  return [s(`#${t.id}`, "b"), s(" "), s(`${path}${at}`, "b"), ...(marks.length ? [s(" "), ...marks] : []), ...(written ? [s(" "), s(`written on ${d.timeline[0]!.label}`, "dim")] : [])];
}

/** The strip over the code: what the thread waits for, from the same derivation as the web's. */
export function stripLines(d: ThreadDetail, w: number, now = Date.now()): Line[] {
  const st = threadStrip(d);
  if (!st) return [];
  let lead = "";
  let text: string;
  if (st.kind === "draft") text = "Draft thread: the agent sees it after you submit the review (S).";
  else if (st.kind === "settles") text = "Your message resolves this thread when you submit the review (S); the agent then does as it says, without asking again.";
  else if (st.kind === "resolved") {
    lead = "✓ Resolved";
    text = `${st.reason ? ` · ${st.reason}` : ""}${st.by ? ` · by ${st.by}` : ""}${st.at ? ` · ${ago(st.at, now)}` : ""} · X reopens it`;
  } else if (st.kind === "waiting") {
    text = `Waiting for the agent: it has your last message.${st.myDraft ? " Your newer reply is a draft: it goes out when you submit the review (S)." : ""}`;
  } else {
    lead = "Your turn.";
    const refs = st.refs.length ? ` It refers to ${st.refs.map((id) => `#${id}`).join(", ")}.` : "";
    const since = st.since ? ` ⚠ The commented lines are the same as at ${st.since}: the fix may be elsewhere, or not made yet.` : "";
    text = ` ${st.wait}${refs}${since}${st.myDraft ? " Your reply is a draft: submit the review (S) to send it." : ""}`;
  }
  const parts = wrap(`${lead}${text}`, w - 2);
  return parts.map((p, i) => {
    if (i === 0 && lead && p.startsWith(lead)) return filled(["state"], s(" "), s(lead, "b"), s(p.slice(lead.length)));
    return filled(["state"], s(` ${p}`));
  });
}

function stepWord(step: TimelineStepDto): Span {
  if (step.index === 0) return s("written", "dim");
  if (step.state === "changed" || step.state === "moved") return s(step.state, "mod");
  if (step.state === "outdated") return s("gone", "delc");
  return s("no change", "dim");
}

/** The thread's steps as chips: `v1 written · L5 · 1 msg ──▶ v2 changed · L6–7 · 2 msgs`; quiet steps fold into a note. */
export function timelineLine(d: ThreadDetail): Line {
  const spans: Span[] = [];
  let msgs = 0;
  let quiet: string[] = [];
  const last = d.timeline.length - 1;
  const flush = () => {
    if (quiet.length) spans.push(s(`    no change in ${quiet.length === 1 ? quiet[0] : `${quiet[0]}–${quiet[quiet.length - 1]}`}`, "dim"));
    quiet = [];
  };
  d.timeline.forEach((step, i) => {
    msgs += step.commentIds.length;
    const shown = i === 0 || step.state !== "ok" || step.commentIds.length > 0;
    if (!shown) {
      quiet.push(step.label);
      return;
    }
    flush();
    if (spans.length) spans.push(s("  ──▶  ", "dim"));
    else spans.push(s(" "));
    spans.push(s(` ${step.label} `, i === last ? "chips" : "chip"), s(" "), stepWord(step));
    spans.push(s(` · ${step.range ? `L${rangeText(step.range)}` : "—"} · ${plural(msgs, "msg")}`, "dim"));
  });
  flush();
  return { spans };
}

const VIEW_NAMES: Record<CodeView, (d: ThreadDetail) => string> = {
  diff: () => "Diff",
  then: () => "Then",
  at: (d) => `At ${d.timeline[d.timeline.length - 1]!.label}`,
};

/** Diff / Then / At, and how much code: only "around the thread" until the diff widget comes. */
export function viewsLine(d: ThreadDetail, view: CodeView): Line {
  const have = codeViews(d);
  const spans: Span[] = [s(" ")];
  const rest: string[] = [];
  for (const v of ["diff", "then", "at"] as const) {
    if (v === view) spans.push(s(` ${VIEW_NAMES[v](d)} `, "seg"));
    else rest.push(VIEW_NAMES[v](d));
  }
  const others = rest.join(" · ");
  if (view === "diff") spans.push(s(" "), s(others, "dim"));
  else spans.splice(1, 0, s(`${others} `, "dim"));
  spans.push(s(" "), ...(have.length > 1 ? [key("t")] : [s(" t ", "dim")]), s("    "), s(" around the thread ", "seg"), s(" "), s("all changes · whole file", "dim"), s(" "), key("z"));
  return { spans };
}

/** The code part: the file's header and its rows, with the ▲ row under the thread's lines. */
export function codePart(d: ThreadDetail, view: CodeView | null, w: number): { lines: Line[]; view: CodeView } {
  const code = threadCode(d, view);
  const t = d.thread;
  const last = d.timeline[d.timeline.length - 1]!;
  const stateTag = t.anchor.state === "changed" || t.anchor.state === "moved" ? [s(" "), tag(t.anchor.state, "tchg")] : [];
  const mark = [s(`▲ thread #${t.id} · ${code.view === "then" ? d.timeline[0]!.label : last.label}`, "acc"), ...(code.view === "then" ? [] : stateTag)];
  return { lines: [fileHeader(t.anchor.path ?? t.path, code, w), ...codeLines(code, w, mark)], view: code.view };
}

/** What sits over the code in a thread's column: the strip, the steps, the views. */
export function threadHead(d: ThreadDetail, view: CodeView, w: number): Line[] {
  return [...stripLines(d, w), blank(), timelineLine(d), viewsLine(d, view), blank()];
}

const INTENT: Record<string, Cls> = { fixed: "tok", question: "tq", answered: "tchg", disagree: "tbad" };

function head(c: CommentDto, d: ThreadDetail, now: number): Line {
  const step = d.timeline[c.step];
  const who = c.role === "reviewer" ? [s("you", "you"), s(" · reviewer", "dim")] : [s(c.author, "agentc"), s(" · agent", "dim")];
  const marks: Span[] = [];
  if (c.intent) marks.push(s(" "), tag(c.intent, INTENT[c.intent] ?? "tchg"));
  if (c.draft) marks.push(s(" "), tag("draft", "tdr"), s(" not sent", "dim"));
  if (c.resolves) marks.push(s(" "), s(c.draft ? "✓ resolves the thread when sent" : "✓ resolved with this", "ok"));
  const when = c.draft ? "" : `${step ? `@${step.label} · ` : ""}${ago(c.createdAt, now)}`;
  return line(s(" "), ...who, ...marks, ...(when ? [s(` ${when}`, "dim")] : []));
}

function body(text: string, w: number): Line[] {
  const out: Line[] = [];
  let fenced = false;
  for (const raw of text.split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      fenced = !fenced;
      out.push(line(s(`   ${raw}`, "dim")));
      continue;
    }
    for (const part of wrap(raw, w - 4)) out.push(line(s("   "), fenced ? s(part, "acc") : s(part)));
  }
  return out;
}

export interface Conversation {
  lines: Line[];
  /** The line each message starts at, for { and }. */
  starts: number[];
  /** The line of the NEW rule, when a message is new. */
  newAt: number | null;
  fresh: number;
}

/** The messages in reading order, with resolve and reopen events by time; a red NEW rule before the first new one. */
export function conversation(d: ThreadDetail, fresh: ReadonlySet<number>, w: number, now = Date.now()): Conversation {
  const lines: Line[] = [];
  const starts: number[] = [];
  let newAt: number | null = null;
  const items: { at: string; emit: () => void }[] = readingOrder(d).map((c) => ({
    at: c.createdAt,
    emit: () => {
      if (fresh.has(c.id) && newAt === null) {
        newAt = lines.length;
        lines.push(line(s(" "), s(`── NEW ${"─".repeat(Math.max(0, w - 12))}`, "new")));
      }
      starts.push(lines.length);
      lines.push(head(c, d, now), ...body(c.body, w));
      if (c.restore) {
        const v = c.restore.version === "base" ? "the base" : `v${c.restore.version}`;
        lines.push(line(s(`   ↺ asks to restore ${c.restore.path}:${rangeText(c.restore.range)} as in ${v}`, "acc")));
      }
      lines.push(blank());
    },
  }));
  for (const e of d.events) {
    items.push({
      at: e.at,
      emit: () => {
        const who = e.role === "reviewer" ? "you" : e.role;
        lines.push(line(s(" "), s(e.type === "resolved" ? "✓ resolved" : "↺ reopened", e.type === "resolved" ? "ok" : "warn"), s(` by ${who} · ${ago(e.at, now)}`, "dim")), blank());
      },
    });
  }
  // readingOrder keeps replies under their first message, so only events move by time
  const msgs = items.slice(0, readingOrder(d).length);
  const events = items.slice(msgs.length).sort((a, b) => a.at.localeCompare(b.at));
  const merged: typeof items = [];
  for (const m of msgs) {
    while (events.length && events[0]!.at < m.at) merged.push(events.shift()!);
    merged.push(m);
  }
  merged.push(...events);
  for (const item of merged) item.emit();
  return { lines, starts, newAt, fresh: d.comments.filter((c) => fresh.has(c.id)).length };
}

/** `2 messages · 1 new` for the conversation's border. */
export function messagesNote(d: ThreadDetail, fresh: number): Span[] {
  const n = plural(d.comments.length, "message");
  return fresh ? [s(`${n} ·`, "dim"), s(" "), s(`${fresh} new`, "new")] : [s(n, "dim")];
}

export function rule(title: string, w: number): Line {
  const head = `── ${title} `;
  return line(s(" "), s(`${head}${"─".repeat(Math.max(0, w - Bun.stringWidth(head) - 4))}`, "rule"));
}

export function hintLine(spans: (Span | string)[]): Line {
  return line(s(" "), ...spans.map((x) => (typeof x === "string" ? s(x, "dim") : x)));
}

export const THREAD_HINT = hintLine([key("r"), " reply · ", key("x"), " resolve · ", key("{ }"), " previous / next message"]);
export const PREVIEW_HINT = hintLine([key("Enter"), " or ", key("l"), " go into the thread · ", key("r"), " reply here"]);
