import type { ComponentChildren } from "preact";
import type { AnchorState, Intent, ThreadSummary } from "../../src/core/types.ts";
import { stateTone } from "../lib/timeline.ts";
import type { Round } from "../lib/versions.ts";
import { link, threads } from "../state.ts";

export function Badge({ tone = "muted", children, title }: { tone?: string; children: ComponentChildren; title?: string }) {
  return <span class={`badge badge-${tone}`} title={title}>{children}</span>;
}

export function StateBadge({ state, label }: { state: AnchorState; label?: string }) {
  if (state === "ok" && !label) return null;
  const titles: Record<AnchorState, string> = {
    ok: "the commented code is unchanged",
    moved: "same code, now at other lines",
    changed: "the commented code was edited",
    outdated: "the commented code is gone",
  };
  return <Badge tone={stateTone(state)} title={titles[state]}>{label ?? state}</Badge>;
}

export function IntentBadge({ intent }: { intent: Intent | null }) {
  if (!intent) return null;
  const tone = intent === "fixed" ? "ok" : intent === "disagree" ? "bad" : intent === "question" ? "warn" : "info";
  return <Badge tone={tone}>{intent}</Badge>;
}

export function ThreadBadges({ t }: { t: ThreadSummary }) {
  return (
    <>
      {t.draft ? <Badge tone="warn">draft</Badge> : null}
      {t.status === "resolved" ? <Badge tone="ok">✓ resolved{t.resolveReason ? `: ${t.resolveReason}` : ""}</Badge> : null}
      <StateBadge state={t.anchor.state} />
      {t.status === "open" && t.needsReply === "reviewer" && !t.draft ? <Badge tone="accent">your turn</Badge> : null}
      {t.status === "open" && t.needsReply === "agent" && !t.draft ? <Badge tone="muted">agent's turn</Badge> : null}
    </>
  );
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function rangeText(r: { start: number; end: number } | null): string {
  if (!r) return "—";
  return r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`;
}

/** `L12–14`, or `area 50×75` for a thread on an image. */
export function whereText(t: ThreadSummary): string {
  return t.region ? `area ${t.region.w}×${t.region.h}` : `L${rangeText(t.anchor.range ?? t.range)}`;
}

// "тред" is "thread" in Russian.
export const THREAD_REF = /(?<![\p{L}\d_])(?:thread|тред\p{L}*)\s+#?(\d+)|(?<![\w&#])#(\d+)\b/giu;

export function threadRefs(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(THREAD_REF)) out.add(Number(m[1] ?? m[2]));
  return [...out];
}

export function ThreadRef({ id, children }: { id: number; children: ComponentChildren }) {
  const t = threads.value.find((x) => x.id === id);
  if (!t) return <>{children}</>;
  return (
    <span class="tref">
      <a {...link({ name: "thread", id })}>{children}</a>
      <span class="tref-card" role="tooltip">
        <b>#{t.id}</b> {t.anchor.path ?? t.path}{t.region ? ` · ${whereText(t)}` : `:${rangeText(t.anchor.range ?? t.range)}`} <ThreadBadges t={t} />
        <span class="tref-title">{t.title}</span>
        {t.last && t.commentCount > 1 ? (
          <span class="tref-last">
            ↳ <b>{t.last.name}</b>: {t.last.preview}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function withRefs(text: string): ComponentChildren {
  const out: ComponentChildren[] = [];
  let pos = 0;
  for (const m of text.matchAll(THREAD_REF)) {
    out.push(text.slice(pos, m.index));
    out.push(<ThreadRef id={Number(m[1] ?? m[2])}>{m[0]}</ThreadRef>);
    pos = m.index! + m[0].length;
  }
  out.push(text.slice(pos));
  return out;
}

export function Body({ text }: { text: string }) {
  const parts: ComponentChildren[] = [];
  const blocks = text.split(/```/);
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      parts.push(<pre class="body-code">{block.replace(/^\w*\n/, "")}</pre>);
      return;
    }
    const inline = block.split(/(`[^`\n]+`)/);
    parts.push(
      <span>
        {inline.map((seg) => (seg.startsWith("`") && seg.endsWith("`") && seg.length > 1 ? <code>{seg.slice(1, -1)}</code> : withRefs(seg)))}
      </span>,
    );
  });
  return <div class="body">{parts}</div>;
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd>{children}</kbd>;
}

/** Scrolls a horizontal list so the items `first` … `last` are in view; when they do not fit, `last` wins. */
export function revealRange(list: HTMLElement | null, first: string, last: string): void {
  const a = list?.querySelector(first)?.getBoundingClientRect();
  const b = list?.querySelector(last)?.getBoundingClientRect() ?? a;
  if (!list || !a || !b) return;
  const box = list.getBoundingClientRect();
  const left = Math.min(a.left, b.left) - box.left + list.scrollLeft;
  const right = Math.max(a.right, b.right) - box.left + list.scrollLeft;
  const view = list.clientWidth;
  if (left >= list.scrollLeft && right <= list.scrollLeft + view) return;
  list.scrollLeft = right - left <= view ? left - (view - (right - left)) / 2 : right - view + 8;
}

export function roundTitle(r: Round): string {
  return r.index === 0 ? "before your first review" : `after your review ${r.index} · ${r.verdict === "approved" ? "approved" : "changes requested"} · ${ago(r.at!)}`;
}
