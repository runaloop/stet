import { signal } from "@preact/signals";
import type { ThreadDetail } from "../../src/core/types.ts";
import { api } from "../api.ts";
import { guard, notify, reloadAll, reviewId } from "../state.ts";
import { Composer } from "./Composer.tsx";

export const RESOLVE_WITH_MESSAGE_TITLE =
  "your last word to the agent: a draft that resolves the thread when you submit the review; the agent then does as it says, without asking again (Space r x)";

/** The thread whose "Resolve with message" box is open. */
export const resolvingWith = signal<number | null>(null);

export function openResolveWithMessage(d: ThreadDetail | null): boolean {
  if (!d || d.thread.draft) return false;
  resolvingWith.value = d.thread.id;
  return true;
}

export function ResolveWithMessageBox({ d }: { d: ThreadDetail }) {
  const rid = reviewId.value;
  if (rid === null || resolvingWith.value !== d.thread.id) return null;
  const pending = d.comments.find((c) => c.draft && c.resolves);
  return (
    <div class="resolve-box">
      <div class="resolve-box-head">
        <b>Resolve with message</b> · the thread closes when you submit the review, and the agent does as you say without asking again
      </div>
      <Composer
        compact
        autoFocus
        storageKey={`resolve:${rid}:${d.thread.id}`}
        initial={pending?.body}
        placeholder="What the agent should do…"
        primaryLabel={pending ? "Save draft" : "Resolve with message"}
        secondaryLabel={null}
        onCancel={() => (resolvingWith.value = null)}
        onSubmit={async (body) => {
          const c = await guard(api.resolveWithMessage(rid, d.thread.id, body));
          if (!c) return false;
          resolvingWith.value = null;
          notify(`#${d.thread.id} resolves with your message when you submit the review (S)`);
          await reloadAll();
        }}
      />
    </div>
  );
}
