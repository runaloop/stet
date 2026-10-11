import type { CommentDto, Intent, ResolveReason, ThreadDetail, TimelineStepDto } from "../core/types.ts";

/** What the agent's last word asks of the reviewer, by its intent. */
export const WAITS: Record<string, string> = {
  question: "The agent asked you a question and waits for your answer.",
  fixed: "The agent says it fixed this. Check the code, then resolve (x) or reply (r).",
  disagree: "The agent disagrees. Read why, then resolve (x) or answer (r).",
  answered: "The agent answered. Resolve (x) if that settles it, or reply (r).",
};

// "тред" is "thread" in Russian.
export const THREAD_REF = /(?<![\p{L}\d_])(?:thread|тред\p{L}*)\s+#?(\d+)|(?<![\w&#])#(\d+)\b/giu;

export function threadRefs(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(THREAD_REF)) out.add(Number(m[1] ?? m[2]));
  return [...out];
}

function regionText(step: TimelineStepDto | undefined): string | null {
  const ex = step?.excerpt;
  if (!ex || !step?.range) return null;
  return ex.lines.slice(step.range.start - ex.firstLine, step.range.end - ex.firstLine + 1).join("\n");
}

/** The version whose lines are still the same as when the reviewer asked, for a reply that says it fixed them. */
export function unchangedSince(detail: ThreadDetail, c: CommentDto): string | null {
  const i = detail.comments.indexOf(c);
  const asked = detail.comments.slice(0, i).reverse().find((x) => x.role === "reviewer" && !x.draft);
  const base = detail.timeline[asked?.step ?? 0];
  const last = detail.timeline[detail.timeline.length - 1];
  if (!base || !last || last.state === "outdated") return null;
  const a = regionText(base);
  const b = regionText(last);
  return a !== null && a === b ? base.label : null;
}

export function resolveReasonText(reason: ResolveReason | null): string | null {
  return reason === "wontfix" ? "won't fix" : reason === "go" ? "with your message: the agent does as it says" : reason;
}

/** What a thread waits for, as the strip over its code says it. */
export type Strip =
  | { kind: "draft" }
  | { kind: "settles" }
  | { kind: "resolved"; reason: string | null; by: string | null; at: string | null }
  | { kind: "waiting"; myDraft: boolean }
  | { kind: "turn"; intent: Intent | null; wait: string; refs: number[]; since: string | null; myDraft: boolean };

export function threadStrip(d: ThreadDetail): Strip | null {
  const t = d.thread;
  const myDraft = d.comments.some((c) => c.draft && c.role === "reviewer");
  if (t.draft) return { kind: "draft" };
  if (t.status === "open" && d.comments.some((c) => c.draft && c.resolves)) return { kind: "settles" };
  if (t.status === "resolved") {
    return { kind: "resolved", reason: resolveReasonText(t.resolveReason), by: t.resolvedBy ? (t.resolvedBy === "reviewer" ? "you" : t.resolvedBy) : null, at: t.resolvedAt };
  }
  const published = d.comments.filter((c) => !c.draft);
  const last = published[published.length - 1];
  if (!last) return null;
  if (last.role === "reviewer") return { kind: "waiting", myDraft };
  return {
    kind: "turn",
    intent: last.intent,
    wait: WAITS[last.intent ?? ""] ?? "The agent replied.",
    refs: threadRefs(last.body).filter((id) => id !== t.id),
    since: last.intent === "fixed" ? unchangedSince(d, last) : null,
    myDraft,
  };
}
