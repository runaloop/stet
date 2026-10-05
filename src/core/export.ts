import type { Ctx } from "./context.ts";
import { regionText } from "./image.ts";
import { reviewDto, short, status, submissionTimes, threadDetail, threadSummaries, versionDto, versionRows } from "./service.ts";
import { takeNow } from "./snapshot.ts";
import type { ReviewRow } from "./store/db.ts";
import type { CommentDto, Excerpt, Range, ReviewDto, StatusDto, SubmissionDto, ThreadDetail, VersionDto } from "./types.ts";

export interface ReviewExport {
  review: ReviewDto & { closedAt: string | null };
  versions: VersionDto[];
  submissions: SubmissionDto[];
  /** As in `stet status`. */
  lastSubmission: StatusDto["lastSubmission"];
  /** Published threads with their published comments only, by id. */
  threads: ThreadDetail[];
}

/**
 * Everything an export shows, read fresh from the database. "Now" is the code as it is for an active review,
 * and the latest version for a closed one, so that an archive does not depend on where the branch went.
 */
export async function collectExport(ctx: Ctx, review: ReviewRow): Promise<ReviewExport> {
  const versions = versionRows(ctx, review.id);
  const latest = versions[versions.length - 1] ?? null;
  let now: string | null = review.state === "closed" ? (latest?.snapshot ?? null) : null;
  if (!now) {
    try {
      now = (await takeNow(ctx, review, { keep: false })).sha;
    } catch {
      now = latest?.snapshot ?? null;
    }
  }
  const s = await status(ctx, review, { pinnedNow: now });
  const threads: ThreadDetail[] = [];
  for (const t of await threadSummaries(ctx, review, { includeDrafts: false, pinnedNow: now })) {
    const d = await threadDetail(ctx, review, t.id, { pinnedNow: now });
    const comments = d.comments.filter((c) => !c.draft);
    const published = new Set(comments.map((c) => c.id));
    threads.push({
      ...d,
      thread: { ...d.thread, commentCount: comments.length },
      comments,
      timeline: d.timeline.map((step) => ({ ...step, commentIds: step.commentIds.filter((id) => published.has(id)) })),
    });
  }
  threads.sort((a, b) => a.thread.id - b.thread.id);
  return {
    review: { ...reviewDto(review), closedAt: review.closed_at },
    versions: versions.map(versionDto),
    submissions: submissionTimes(ctx, review.id),
    lastSubmission: s.lastSubmission,
    threads,
  };
}

export function exportMarkdown(x: ReviewExport, opts: { all?: boolean } = {}): string {
  return (opts.all ? fullMarkdown(x) : summaryMarkdown(x)).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Titles and outcomes, no comment bodies but a short gist of the agent's last reply: safe to paste for a team. */
export function summaryMarkdown(x: ReviewExport): string {
  const out = [`### Review: ${headline(x)}`, ""];
  const settled = x.threads.filter((d) => d.thread.status === "resolved");
  const open = x.threads.filter((d) => d.thread.status === "open");
  for (const d of settled) out.push(`- ${threadLine(x, d)}`);
  if (open.length) {
    if (settled.length) out.push("");
    out.push("Open:", "");
    for (const d of open) out.push(`- ${threadLine(x, d)}`);
  }
  if (!x.threads.length) out.push("No threads.");
  return out.join("\n");
}

/** Everything, for an archive or for someone without stet: code then and now, whole conversations, the timeline. */
export function fullMarkdown(x: ReviewExport): string {
  const r = x.review;
  const resolved = x.threads.filter((d) => d.thread.status === "resolved").length;
  const out = [
    `# Review of ${r.branch}`,
    "",
    `- ${headline(x)}`,
    `- Review ${r.id} of ${r.source === "index" ? "staged changes" : "the working tree"}, base ${r.baseRef ?? "none"}`,
    `- Started ${when(r.createdAt)}${r.closedAt ? `, closed ${when(r.closedAt)}` : ""}`,
    `- Threads: ${x.threads.length} (${resolved} resolved, ${x.threads.length - resolved} open)`,
    "",
    "## Versions",
    "",
  ];
  if (!x.versions.length) out.push("No versions.");
  for (const v of x.versions) {
    out.push(`- v${v.number} · ${when(v.createdAt)} · ${v.author} (${v.role}) · snapshot ${short(v.snapshot)}${v.label ? ` · ${v.label}` : ""}`);
  }
  out.push("", "## Reviews", "");
  if (!x.submissions.length) out.push("No review submitted.");
  x.submissions.forEach((s, i) => {
    out.push(`### Review ${i + 1}: ${verdictText(s)} · ${when(s.at)}`, "");
    if (s.body?.trim()) out.push(quote(s.body), "");
  });
  out.push("", "## Threads", "");
  if (!x.threads.length) out.push("No threads.");
  for (const d of x.threads) out.push(...threadSection(d), "");
  return out.join("\n");
}

function headline(x: ReviewExport): string {
  const parts: string[] = [];
  const n = x.submissions.length;
  if (n) parts.push(`${n} round${n === 1 ? "" : "s"}`);
  const first = x.versions[0];
  const last = x.versions[x.versions.length - 1];
  parts.push(!first || !last ? "no versions" : first === last ? `v${first.number}` : `v${first.number}–v${last.number}`);
  const ls = x.lastSubmission;
  if (ls) parts.push(verdictText(ls) + (ls.verdict === "approved" && ls.changedAfter ? " · changed after" : ""));
  return parts.join(", ");
}

function verdictText(s: SubmissionDto): string {
  return `${s.verdict === "approved" ? "approved" : "changes requested"}${s.version !== null ? ` at v${s.version}` : ""}`;
}

const REASONS = { fixed: "fixed", wontfix: "won't fix", answered: "answered" } as const;

function threadLine(x: ReviewExport, d: ThreadDetail): string {
  const t = d.thread;
  const head = `#${t.id} ${t.title} (${location(d)})`;
  const replies = d.comments.slice(1).reverse();
  const lastAgent = replies.find((c) => c.role === "agent") ?? null;
  if (t.status === "open") {
    const turn = t.needsReply ? `waits for the ${t.needsReply}` : "open";
    const said = t.needsReply === "reviewer" && lastAgent?.intent ? ` (the agent: ${lastAgent.intent})` : "";
    return `${head} — ${t.anchor.state === "outdated" ? "outdated, " : ""}${turn}${said}`;
  }
  const at = settledAt(x, d);
  if (t.resolveReason === "fixed") return `${head} — fixed${at === null ? "" : ` in v${at}`}`;
  const outcome = `${t.resolveReason ? REASONS[t.resolveReason] : "resolved"}${at === null ? "" : ` at v${at}`}`;
  const other = t.author.role === "agent" ? replies.find((c) => c.role === "reviewer") : lastAgent;
  const g = other ? gist(other.body) : null;
  return `${head} — ${outcome}${g ? `: ${g}` : ""}`;
}

/** The version a resolved thread was settled at: where the agent's last fix landed, or else the latest one when it was resolved. */
function settledAt(x: ReviewExport, d: ThreadDetail): number | null {
  if (d.thread.resolveReason === "fixed") {
    const fix = [...d.comments].reverse().find((c) => c.role === "agent" && c.intent === "fixed");
    const step = fix ? d.timeline[fix.step] : undefined;
    if (step?.kind === "version" && step.version !== null) return step.version;
  }
  const at = d.thread.resolvedAt;
  if (!at) return null;
  let n: number | null = null;
  for (const v of x.versions) if (v.createdAt <= at) n = v.number;
  return n;
}

/** Where the thread is now, or where it was written when its code is gone. */
function location(d: ThreadDetail): string {
  const t = d.thread;
  const a = t.anchor;
  if (t.region) return `${a.path ?? t.path}, ${regionText(t.region)}`;
  if (a.state !== "outdated" && a.path && a.range) return `${a.path}:${lineRange(a.range)}`;
  return `${t.path}:${lineRange(t.range)} in ${d.timeline[0]!.label}`;
}

const GIST_MIN = 60;
const GIST_MAX = 140;

/**
 * Sentences from the start of the first paragraph of prose until there are `GIST_MIN` characters, since a
 * first sentence alone is often just "Yes." or "Good idea."; cut at a word to at most `GIST_MAX` characters.
 */
export function gist(body: string): string | null {
  const paragraph: string[] = [];
  let fence = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      if (paragraph.length) break;
      continue;
    }
    if (fence) continue;
    if (!line) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(line.replace(/^(#+|>|[-*+]|\d+[.)])\s+/, ""));
  }
  if (!paragraph.length) return null;
  let text = "";
  for (const sentence of paragraph.join(" ").split(/(?<=[.!?…])\s+/u)) {
    text = text ? `${text} ${sentence}` : sentence;
    if (text.length >= GIST_MIN) break;
  }
  if (text.length <= GIST_MAX) return text;
  return text.slice(0, GIST_MAX).replace(/\s+\S*$/u, "") + "…";
}

function threadSection(d: ThreadDetail): string[] {
  const t = d.thread;
  const first = d.timeline[0]!;
  const last = d.timeline[d.timeline.length - 1]!;
  const out = [`### #${t.id} ${t.title}`, ""];
  out.push(
    t.status === "open"
      ? `- Status: open${t.needsReply ? `, waits for the ${t.needsReply}` : ""}`
      : `- Status: resolved${t.resolveReason ? `, ${REASONS[t.resolveReason]}` : ""}${t.resolvedBy ? ` by ${t.resolvedBy}` : ""}${t.resolvedAt ? ` · ${when(t.resolvedAt)}` : ""}`,
  );
  if (t.region) {
    out.push(`- Image: \`${t.path}\` at ${first.label}, area ${regionText(t.region)} (pixels from the top left)`);
  } else {
    out.push(`- Written on: \`${t.path}:${lineRange(t.range)}\` at ${first.label}${t.side === "old" ? " (the old side)" : ""}`);
  }
  out.push(`- Now: ${nowText(d)}`);
  if (!t.region) {
    if (d.code.then) out.push("", `#### Code then (${first.label})`, "", ...excerptBlock(d.code.then));
    const now = d.code.now;
    const same = now && d.code.then && now.firstLine === d.code.then.firstLine && now.lines.join("\n") === d.code.then.lines.join("\n");
    if (last.index > 0 && now && !same) out.push("", `#### Code now (${last.label})`, "", ...excerptBlock(now));
    if (d.code.interdiff) out.push("", "#### Then → now", "", ...fenced(d.code.interdiff.trimEnd().split("\n").filter((l) => !l.startsWith("====")), "diff"));
  }
  out.push("", "#### Timeline", "");
  for (const s of d.timeline) {
    const where = s.path ? (t.region ? `\`${s.path}\`` : s.range ? `\`${s.path}:${lineRange(s.range)}\`` : `\`${s.path}\``) : "-";
    const state = s.index === 0 ? "written" : s.state === "outdated" && s.reason ? `outdated (${s.reason})` : s.state;
    out.push(`- ${s.label}: ${state}, ${where}${s.commentIds.length ? ` · comments ${s.commentIds.map((i) => "#" + i).join(" ")}` : ""}`);
  }
  out.push("", "#### Conversation", "");
  const root = d.comments[0]?.id;
  const entries: { at: string; lines: string[] }[] = d.comments.map((c) => ({ at: c.createdAt, lines: commentEntry(c, root) }));
  for (const e of d.events) entries.push({ at: e.at, lines: [`_${e.type === "resolved" ? "Resolved" : "Reopened"} by the ${e.role} · ${when(e.at)}_`] });
  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const e of entries) out.push(...e.lines, "");
  return out;
}

function nowText(d: ThreadDetail): string {
  const a = d.thread.anchor;
  if (a.state === "outdated") return `outdated at ${a.againstLabel}${a.reason ? ` (${a.reason})` : ""}: the code it was on is gone`;
  const where = a.path ? (d.thread.region || !a.range ? `\`${a.path}\`` : `\`${a.path}:${lineRange(a.range)}\``) : "-";
  return `${where} at ${a.againstLabel}${a.state === "ok" ? "" : `, ${a.state}`}`;
}

function commentEntry(c: CommentDto, root: number | undefined): string[] {
  const meta = [`${c.role}${c.intent ? `, ${c.intent}` : ""}`, when(c.createdAt)];
  if (c.version !== null) meta.push(`at v${c.version}`);
  if (c.parentId !== null && c.parentId !== root) meta.push(`in reply to #${c.parentId}`);
  const r = c.restore;
  const restore = r ? ["", `Restore as in ${r.version === "base" ? "base" : `v${r.version}`}, \`${r.path}:${lineRange(r.range)}\`:`, "", ...fenced(r.text.split("\n"))] : [];
  return [`**#${c.id} ${c.author}** (${meta.join(" · ")})`, ...(c.body.trim() ? ["", quote(c.body)] : []), ...restore];
}

function excerptBlock(e: Excerpt): string[] {
  const width = String(e.firstLine + e.lines.length - 1).length;
  return fenced(e.lines.map((l, i) => {
    const n = e.firstLine + i;
    return `${n >= e.start && n <= e.end ? ">" : " "} ${String(n).padStart(width)}  ${l}`.trimEnd();
  }));
}

/** A code block whose fence is longer than any run of backticks inside it. */
function fenced(lines: string[], lang = ""): string[] {
  const longest = Math.max(0, ...lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((m) => m.length))));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence + lang, ...lines, fence];
}

function quote(body: string): string {
  return body.trimEnd().split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
}

const lineRange = (r: Range) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`);

const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
