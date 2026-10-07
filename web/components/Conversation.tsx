import type { ComponentChild } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { CommentDto, ThreadDetail, ThreadEventDto, TimelineStepDto } from "../../src/core/types.ts";
import { api } from "../api.ts";
import { guard, reloadAll, reviewId, selectedStep } from "../state.ts";
import { firstNew, isFolded, isLong, jumpToNew, msgCursor, msgOpen, newMark, replyTo } from "../msgs.ts";
import { ago, Badge, Body, IntentBadge, Kbd } from "./Bits.tsx";
import { Composer } from "./Composer.tsx";
import { RestoreBlock } from "./Restore.tsx";

function regionText(step: TimelineStepDto | undefined): string | null {
  const ex = step?.excerpt;
  if (!ex || !step?.range) return null;
  return ex.lines.slice(step.range.start - ex.firstLine, step.range.end - ex.firstLine + 1).join("\n");
}

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

function Avatar({ c }: { c: CommentDto }) {
  return (
    <span class={`avatar ${c.role}`} aria-hidden="true">
      {c.role === "agent" ? "AI" : (c.author.slice(0, 1) || "?").toUpperCase()}
    </span>
  );
}

function CommentNode({ c, childrenOf, detail, depth, newId }: { c: CommentDto; childrenOf: Map<number | null, CommentDto[]>; detail: ThreadDetail; depth: number; newId: number | null }) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const step = detail.timeline[c.step];
  const kids = childrenOf.get(c.id) ?? [];
  const rid = reviewId.value!;
  const own = c.role === "reviewer";
  const since = c.role === "agent" && c.intent === "fixed" ? unchangedSince(detail, c) : null;
  const ask = replyTo.value;
  useEffect(() => {
    if (ask?.id === c.id) setReplying(true);
  }, [ask?.seq]);
  const long = isLong(c);
  const folded = long && !editing && isFolded(c, detail);
  const fold = () => (msgOpen.value = new Map(msgOpen.value).set(c.id, folded));

  return (
    <>
      {c.id === newId ? <div class="new-line">new</div> : null}
      <div class={`comment depth-${Math.min(depth, 6)} role-${c.role}${c.draft ? " is-draft" : ""}`}>
        <div
          class={`msg${msgCursor.value === c.id ? " at-cursor" : ""}${folded ? " folded" : ""}`}
          data-id={c.id}
          onMouseDown={(e) => {
            if (!(e.target as HTMLElement).closest("a, button, textarea, input, select")) msgCursor.value = c.id;
          }}
        >
          <div class="comment-head">
            <Avatar c={c} />
            <span class="author">{c.author}</span>
            <span class={`role-tag ${c.role}`}>{c.role === "agent" ? "agent" : "you · reviewer"}</span>
            <IntentBadge intent={c.intent} />
            {c.draft ? <Badge tone="warn">draft · not sent</Badge> : null}
            {c.resolves ? (
              <Badge tone="ok" title="the agent does as this message says, without asking again">
                {c.draft ? "✓ resolves the thread when sent" : "✓ resolved with this"}
              </Badge>
            ) : null}
            {since ? <Badge tone="warn" title="the thread's lines are identical before and after this reply">⚠ lines unchanged since {since}</Badge> : null}
            {step ? (
              <button class="step-chip" title="show the code at this step" onClick={() => (selectedStep.value = c.step)}>
                @{step.label}
              </button>
            ) : null}
            <span class="when" title={c.createdAt}>{ago(c.createdAt)}</span>
            <span class="spacer" />
            {c.draft && own ? (
              <>
                <button class="link" onClick={() => setEditing(!editing)}>edit</button>
                <button
                  class="link danger"
                  onClick={async () => {
                    if (await guard(api.discardDraft(rid, c.id))) await reloadAll();
                  }}
                >
                  discard
                </button>
              </>
            ) : null}
            {long && !folded ? (
              <button class="link" title="fold it to a few lines (za)" onClick={fold}>
                fold
              </button>
            ) : null}
            <button class="link" onClick={() => setReplying(!replying)}>reply</button>
          </div>
          {editing ? (
            <Composer
              compact
              autoFocus
              storageKey={`edit:${rid}:${c.id}`}
              initial={c.body}
              primaryLabel="save draft"
              secondaryLabel={null}
              allowEmpty={!!c.restore}
              onCancel={() => setEditing(false)}
              onSubmit={async (body) => {
                const ok = await guard(api.editDraft(rid, c.id, body));
                if (ok === undefined) return false;
                setEditing(false);
                await reloadAll();
              }}
            />
          ) : (
            <Body text={c.body} />
          )}
          {c.restore ? <RestoreBlock r={c.restore} /> : null}
          {folded ? <button class="unfold" title="za" onClick={fold}>▾ show the whole message</button> : null}
        </div>
        {replying ? (
          <Composer
            compact
            autoFocus
            storageKey={`reply:${rid}:${detail.thread.id}:${c.id}`}
            placeholder={`Reply to ${c.author}…`}
            onCancel={() => setReplying(false)}
            onSubmit={async (body, mode) => {
              const r = await guard(api.reply(rid, detail.thread.id, { body, parentId: c.id, draft: mode === "draft" }));
              if (!r) return false;
              setReplying(false);
              await reloadAll();
            }}
          />
        ) : null}
        {kids.length ? (
          <div class="children">
            {kids.map((k) => <CommentNode key={k.id} c={k} childrenOf={childrenOf} detail={detail} depth={depth + 1} newId={newId} />)}
          </div>
        ) : null}
      </div>
    </>
  );
}

function EventLine({ e }: { e: ThreadEventDto }) {
  return (
    <div class={`conv-event ${e.type}`}>
      {e.type === "resolved" ? "✓ resolved" : "↺ reopened"} by {e.role === "reviewer" ? "you" : e.role} <span title={e.at}>· {ago(e.at)}</span>
    </div>
  );
}

export function Conversation({ detail }: { detail: ThreadDetail }) {
  const childrenOf = new Map<number | null, CommentDto[]>();
  for (const c of detail.comments) {
    const list = childrenOf.get(c.parentId) ?? [];
    list.push(c);
    childrenOf.set(c.parentId, list);
  }
  const newId = firstNew(detail);
  const fresh = newMark.value?.thread === detail.thread.id ? newMark.value.ids.size : 0;
  const n = detail.comments.length;
  const items: { at: string; node: ComponentChild }[] = [
    ...(childrenOf.get(null) ?? []).map((c) => ({ at: c.createdAt, node: <CommentNode key={c.id} c={c} childrenOf={childrenOf} detail={detail} depth={0} newId={newId} /> })),
    ...(detail.events ?? []).map((e, i) => ({ at: e.at, node: <EventLine key={`e${i}`} e={e} /> })),
  ];
  items.sort((a, b) => a.at.localeCompare(b.at));
  return (
    <>
      {n > 1 ? (
        <div class="msgs-head">
          <span>{n} messages</span>
          {fresh ? (
            <button class="link" title="go to the first new message" onClick={jumpToNew}>
              · {fresh} new
            </button>
          ) : null}
          <span class="spacer" />
          <span class="hint">
            <Kbd>{"{"}</Kbd> <Kbd>{"}"}</Kbd> step · <Kbd>za</Kbd> fold · <Kbd>r</Kbd> reply to it
          </span>
        </div>
      ) : null}
      <div class="conversation">{items.map((x) => x.node)}</div>
    </>
  );
}
