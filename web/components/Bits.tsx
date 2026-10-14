import type { ComponentChildren } from "preact";
import type { AnchorState, Intent, ThreadSummary } from "../../src/core/types.ts";
import { stateTone } from "../../src/ui/timeline.ts";
import { areaText } from "../../src/core/media.ts";
import type { Round } from "../../src/ui/versions.ts";
import { THREAD_REF } from "../../src/ui/strip.ts";
import { fileRefs, linesText, type FileRef } from "../../src/ui/filerefs.ts";
import { branchRoute, chooseFile, openFileRef, targetsOf, type MessageCode } from "../filerefs.ts";
import { plainClick } from "../lib/route.ts";
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
  return t.region ? areaText(t.region) : `L${rangeText(t.anchor.range ?? t.range)}`;
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

/** A file a message names, as a link once it names files of the review: one opens over the code, several in the finder. */
function FileRefLink({ r, from }: { r: FileRef; from: MessageCode }) {
  const paths = targetsOf(r);
  if (!paths?.length) return <>{r.text}</>;
  const lines = linesText(r);
  const where = `${lines ? ` · ${r.start === r.end ? "line" : "lines"} ${lines}` : ""}${r.column ? `, column ${r.column}` : ""}`;
  if (paths.length > 1) {
    const pick = (e: MouseEvent) => {
      if (!plainClick(e)) return;
      e.preventDefault();
      chooseFile(paths, r, from);
    };
    return (
      <span class="fref">
        <a href="#" onClick={pick}>{r.text}</a>
        <span class="tref-card" role="tooltip">
          <span><b>{r.path}</b>{where}</span>
          <span class="tref-title">{paths.length} files have this name: a click lets you pick one</span>
          {paths.slice(0, 5).map((p) => <span class="fref-path">{p}</span>)}
          {paths.length > 5 ? <span class="fref-path">…</span> : null}
        </span>
      </span>
    );
  }
  const path = paths[0]!;
  const open = () => void openFileRef(path, r, from);
  const target = branchRoute(path, r);
  return (
    <span class="fref">
      <a {...(target ? link(target, open) : { href: "#", onClick: (e: MouseEvent) => plainClick(e) && (e.preventDefault(), open()) })}>{r.text}</a>
      <span class="tref-card" role="tooltip">
        <span><b>{path}</b>{where}</span>
        <span class="tref-title">opens over the thread's code, as it was when this was written</span>
      </span>
    </span>
  );
}

/** Thread refs (`#12`) and, in a message of a thread, file refs as links. */
function withRefs(text: string, from: MessageCode | undefined, threads = true): ComponentChildren {
  const found: { index: number; length: number; node: ComponentChildren }[] = from ? fileRefs(text).map((r) => ({ index: r.index, length: r.text.length, node: <FileRefLink r={r} from={from} /> })) : [];
  const taken = (at: number, n: number) => found.some((f) => at < f.index + f.length && at + n > f.index);
  if (threads) {
    for (const m of text.matchAll(THREAD_REF)) {
      if (!taken(m.index!, m[0].length)) found.push({ index: m.index!, length: m[0].length, node: <ThreadRef id={Number(m[1] ?? m[2])}>{m[0]}</ThreadRef> });
    }
  }
  found.sort((a, b) => a.index - b.index);
  const out: ComponentChildren[] = [];
  let pos = 0;
  for (const f of found) {
    out.push(text.slice(pos, f.index), f.node);
    pos = f.index + f.length;
  }
  out.push(text.slice(pos));
  return out;
}

export function Body({ text, from }: { text: string; from?: MessageCode }) {
  const parts: ComponentChildren[] = [];
  const blocks = text.split(/```/);
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      parts.push(<pre class="body-code">{withRefs(block.replace(/^\w*\n/, ""), from, false)}</pre>);
      return;
    }
    const inline = block.split(/(`[^`\n]+`)/);
    parts.push(
      <span>
        {inline.map((seg) => (seg.startsWith("`") && seg.endsWith("`") && seg.length > 1 ? <code>{withRefs(seg.slice(1, -1), from, false)}</code> : withRefs(seg, from)))}
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
