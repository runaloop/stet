import type { CommentDto, ThreadDetail, ThreadSummary, TimelineStepDto } from "../../core/types.ts";
import { readingOrder } from "../../ui/msgs.ts";
import { threadStrip } from "../../ui/strip.ts";
import { codeViews, fileHeader, scopesOf, threadBlock, threadCode, wholeFile, type CodeView, type Scope, type ThreadBlock, type Wide } from "../code.ts";
import type { FileItem } from "../diff/model.ts";
import type { Hooks, TokenSource } from "../diff/paint.ts";
import { DiffView, type Want } from "../diff/view.ts";
import type { RefLink } from "../filerefs.ts";
import { ago, blank, clean, filled, key, line, plural, rangeText, s, wrap, type Cls, type Line, type Span } from "../text.ts";

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

const SCOPE_NAMES: Record<Scope, string> = { around: "around the thread", changes: "all changes", file: "whole file" };

/** One choice of several in a line: the chosen one lit, the others dim around it, and the key that steps through them. */
function choices<T extends string>(all: readonly T[], on: T, name: (x: T) => string): Span[] {
  const at = all.indexOf(on);
  const before = all.slice(0, Math.max(0, at)).map(name).join(" · ");
  const after = all.slice(at + 1).map(name).join(" · ");
  return [...(before ? [s(`${before} `, "dim")] : []), s(` ${name(on)} `, "seg"), ...(after ? [s(` ${after}`, "dim")] : [])];
}

/** Diff / Then / At, and how much of the file: around the thread, all changes, the whole file. */
export function viewsLine(d: ThreadDetail, view: CodeView, scope: Scope): Line {
  const have = codeViews(d);
  const scopes = scopesOf(d, view);
  const spans: Span[] = [s(" "), ...choices(["diff", "then", "at"] as const, view, (v) => VIEW_NAMES[v](d))];
  spans.push(s(" "), ...(have.length > 1 ? [key("t")] : [s(" t ", "dim")]), s("    "), ...choices(scopes, scopes.includes(scope) ? scope : "around", (x) => SCOPE_NAMES[x]));
  spans.push(s(" "), ...(scopes.length > 1 ? [key("z")] : [s(" z ", "dim")]));
  return { spans };
}

/**
 * A thread's code on the diff widget, painted whole: it scrolls with the text around it. The file's header over it, the
 * ▲ row under the thread's lines.
 */
export class CodePane {
  readonly diff: DiffView;
  private block: ThreadBlock | null = null;
  private d: ThreadDetail | null = null;
  private shown: FileItem | null = null;

  constructor(tokens: TokenSource, want: (w: Want[]) => void) {
    const hooks: Hooks = {
      header: (f, w) => fileHeader(f.key, this.block?.title ?? "", f.fd.hunks.length ? f.fd : null, w),
      group: () => blank(),
      note: (f) => line(s(`   ${f.note || "no lines to show"}`, "dim")),
      card: (_f, _p, _w, _open, indent) => {
        const d = this.d!;
        const t = d.thread;
        const then = this.block?.view === "then";
        const label = then ? d.timeline[0]!.label : d.timeline[d.timeline.length - 1]!.label;
        const stateTag = !then && (t.anchor.state === "changed" || t.anchor.state === "moved") ? [s(" "), tag(t.anchor.state, "tchg")] : [];
        return [line(s(" ".repeat(indent), "ln"), s(`▲ thread #${t.id} · ${label}`, "acc"), ...stateTag)];
      },
    };
    this.diff = new DiffView(hooks, tokens);
    this.diff.cursor = -1;
    this.diff.onWant = want;
  }

  /** The view and scope last drawn, whose two ends the code's sides are at. */
  get drawn(): { view: CodeView; scope: Scope } | null {
    return this.block ? { view: this.block.view, scope: this.block.scope } : null;
  }

  /** A cursor on the code: on the thread's first line where it is drawn, else on the first line. */
  enter(): boolean {
    const d = this.diff;
    if (d.cursor >= 0 && d.cursor < d.rows.len) return true;
    const p = this.block?.item.placed?.[0];
    let r = p ? d.lineRow(this.block!.item.key, p.side === "deletions" ? 0 : 1, p.range.start) : -1;
    if (r === -1) for (let i = 0; i < d.rows.len && r === -1; i++) if (DiffView.isCode(d.rows.kind[i]!)) r = i;
    if (r === -1) return false;
    d.goTo(r);
    return true;
  }

  /** The cursor off the code: it is not drawn, and the selection goes. */
  leave(): void {
    this.diff.clearSelection();
    this.diff.cursor = -1;
    this.diff.invalidate();
  }

  /** The code of `view` and `scope` in `w` cells; while a wider scope loads, the header says so. */
  lines(d: ThreadDetail, view: CodeView | null, scope: Scope, wide: Wide | null, w: number, around: number | null = null, mark = true): { lines: Line[]; view: CodeView; scope: Scope } {
    this.d = d;
    const block = threadBlock(d, view, scope, wide, around);
    if (!block) {
      const v = threadCode(d, view).view;
      const busy = wide?.error ?? "loading…";
      return { lines: [fileHeader(d.thread.anchor.path ?? d.thread.path, `${SCOPE_NAMES[scope]} · ${busy}`, null, w)], view: v, scope };
    }
    this.block = block;
    this.diff.setSize(w, 1000);
    const it = mark ? block.item : { ...block.item, placed: [] };
    const same = this.shown && this.shown.fd === it.fd && this.shown.key === it.key && this.shown.single === it.single && JSON.stringify(this.shown.placed) === JSON.stringify(it.placed);
    this.diff.marks.set(it.key, block.marks);
    if (!same) {
      this.shown = it;
      this.diff.setItems([it]);
    }
    return { lines: this.diff.allLines(), view: block.view, scope: block.scope };
  }
}

/** A file a message named, over the thread's code: the whole file as it was then, the lines named marked. */
export interface PeekView {
  path: string;
  label: string;
  line: number;
  end?: number;
  note?: string;
  /** The text, once it came; null when the file is not text there. */
  text?: string | null;
}

export class PeekPane {
  readonly diff: DiffView;
  private key = "";

  constructor(tokens: TokenSource, want: (w: Want[]) => void) {
    const hooks: Hooks = {
      header: () => blank(),
      group: () => blank(),
      note: (f) => line(s(`   ${f.note || "no lines to show"}`, "dim")),
      card: () => [],
    };
    this.diff = new DiffView(hooks, tokens);
    this.diff.cursor = -1;
    this.diff.onWant = want;
  }

  /** The file's lines in `w` cells under a line that says whose code it is, and the line the marked ones start on. */
  lines(p: PeekView, w: number): { lines: Line[]; at: number } {
    const lines = p.end !== undefined ? (p.end > p.line ? `lines ${p.line}–${p.end}` : `line ${p.line}`) : `line ${p.line}`;
    const head: Line[] = [
      { spans: [s(" "), s(p.path, "fh"), s(` · ${p.note ?? `at ${p.label}`} · ${lines}`, "dim")] },
      line(s(" "), key("Esc"), s(" back to the thread's code · ", "dim"), key("g x"), s(" in the browser", "dim")),
      blank(),
    ];
    if (p.text === undefined) return { lines: [...head, line(s(" loading…", "dim"))], at: head.length };
    if (p.text === null) return { lines: [...head, line(s(` ${p.path} is not a text file at ${p.label}.`, "dim"))], at: head.length };
    const key1 = `peek:${p.label}:${p.path}:${p.text.length}`;
    const fd = wholeFile(key1, p.path, p.text);
    if (!fd) return { lines: [...head, line(s(" an empty file", "dim"))], at: head.length };
    this.diff.setSize(w, 1000);
    this.diff.marks.set(p.path, { old: [], new: p.end !== undefined ? [{ start: p.line, end: p.end, strong: true }] : [] });
    if (this.key !== `${key1}:${p.line}:${p.end ?? ""}`) {
      this.key = `${key1}:${p.line}:${p.end ?? ""}`;
      this.diff.setItems([{ kind: "file", key: p.path, fd, collapsed: false, single: true, excerpt: true, reveal: { spans: [], full: true } }]);
    }
    // the file's header row stays out: the line over it names the file
    const all = this.diff.allLines().slice(1);
    const row = this.diff.lineRow(p.path, 1, p.line);
    return { lines: [...head, ...all], at: head.length + Math.max(0, row === -1 ? 0 : this.diff.lay.top(row) - 1) };
  }
}

/** What sits over the code in a thread's column: the strip, the steps, the views. */
export function threadHead(d: ThreadDetail, view: CodeView, scope: Scope, w: number): Line[] {
  return [...stripLines(d, w), blank(), timelineLine(d), viewsLine(d, view, scope), blank()];
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

/** A wrapped piece of a line, `at` cells into it, with the file references in it as links. */
function linked(part: string, at: number, refs: readonly { a: number; b: number; hit: string }[], fenced: boolean): Span[] {
  const out: Span[] = [];
  const plainOf = (t: string) => (fenced ? s(t, "acc") : s(t));
  let pos = 0;
  for (const r of refs) {
    const a = Math.max(r.a - at, pos);
    const b = Math.min(r.b - at, part.length);
    if (b <= a) continue;
    if (a > pos) out.push(plainOf(part.slice(pos, a)));
    out.push({ ...s(part.slice(a, b), "fref"), hit: r.hit });
    pos = b;
  }
  if (pos < part.length || !out.length) out.push(plainOf(part.slice(pos)));
  return out;
}

/** A message's text wrapped to `w`, its code blocks in colour, the files it names as links. */
function body(text: string, w: number, links: readonly RefLink[] = []): Line[] {
  const out: Line[] = [];
  let fenced = false;
  let start = 0;
  for (const raw of text.split("\n")) {
    const end = start + raw.length;
    const mine = links.filter((l) => l.ref.index >= start && l.ref.index < end);
    start = end + 1;
    if (raw.trimStart().startsWith("```")) {
      fenced = !fenced;
      out.push(line(s(`   ${raw}`, "dim")));
      continue;
    }
    const text1 = clean(raw);
    const refs: { a: number; b: number; hit: string }[] = [];
    let from = 0;
    for (const l of mine) {
      const a = text1.indexOf(l.ref.text, from);
      if (a === -1) continue;
      refs.push({ a, b: a + l.ref.text.length, hit: l.hit });
      from = a + l.ref.text.length;
    }
    let cur = 0;
    for (const part of wrap(raw, w - 4)) {
      const at = part ? Math.max(cur, text1.indexOf(part, cur)) : cur;
      out.push(line(s("   "), ...linked(part, at, refs, fenced)));
      cur = at + part.length;
    }
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
export function conversation(d: ThreadDetail, fresh: ReadonlySet<number>, w: number, now = Date.now(), links: (c: CommentDto) => RefLink[] = () => []): Conversation {
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
      lines.push(head(c, d, now), ...body(c.body, w, links(c)));
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
