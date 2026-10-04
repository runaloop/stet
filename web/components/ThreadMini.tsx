import type { AnchorState } from "../../src/core/types.ts";
import { hoverThread } from "../compare.ts";
import { compareFocus, link, navigate, threads } from "../state.ts";
import { Badge, StateBadge } from "./Bits.tsx";

export function ThreadMini({ id, state }: { id: number; state: string }) {
  const t = threads.value.find((x) => x.id === id);
  if (!t) return null;
  return (
    <a
      class={`thread-mini${compareFocus.value === id ? " focused" : ""}${t.status === "resolved" ? " resolved" : ""}`}
      data-thread={id}
      onMouseEnter={() => (hoverThread.value = t.id)}
      onMouseLeave={() => hoverThread.value === t.id && (hoverThread.value = null)}
      {...link({ name: "thread", id: t.id }, () => {
        hoverThread.value = null;
        compareFocus.value = t.id;
        navigate({ name: "thread", id: t.id });
      })}
    >
      <b>#{t.id}</b> {t.status === "resolved" ? <Badge tone="ok">✓ resolved</Badge> : null}
      <StateBadge state={state as AnchorState} /> {t.draft ? <Badge tone="warn">draft</Badge> : null}
      <span class="mini-title">{t.title}</span>
      <span class="mini-count">{t.commentCount} 💬</span>
    </a>
  );
}
