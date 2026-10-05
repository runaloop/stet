import type { CommentDto, RestoreDto } from "../../src/core/types.ts";
import { api } from "../api.ts";
import { guard, notify, reloadAll, reviewId } from "../state.ts";
import { rangeText } from "./Bits.tsx";

/** The old side's label when lines can be restored from it: a version (`v2`) or `base`. */
export const restorable = (label: string | undefined): string | null => (label && (/^v\d+$/.test(label) || label === "base") ? label : null);

export const RESTORE_TITLE = "a draft that asks the agent to put these lines back exactly as they were; it goes with your review";

/** Saves a restore request as a draft: in `thread`, or in a new thread on the lines of `at` that stand in their place. */
export async function askRestore(b: { from: string; path: string; start: number; end: number; at?: string; thread?: number; body?: string }): Promise<CommentDto | undefined> {
  const rid = reviewId.value;
  if (rid === null) return undefined;
  const c = await guard(api.restore(rid, { ...b, body: b.body ?? "" }));
  if (!c) return undefined;
  notify(`restore draft saved in #${c.threadId} · the agent sees it after you submit the review`, "info", { label: `open #${c.threadId}`, route: { name: "thread", id: c.threadId } });
  await reloadAll();
  return c;
}

export function RestoreBlock({ r }: { r: RestoreDto }) {
  const from = r.version === "base" ? "base" : `v${r.version}`;
  return (
    <div class="restore" title={`the agent is asked to put back exactly these lines of ${r.path}, as they were in ${from}`}>
      <div class="restore-label">
        Restore as in {from} · {r.range.start === r.range.end ? "line" : "lines"} {rangeText(r.range)}
      </div>
      <pre class="restore-code">
        {r.text.split("\n").map((line, i) => (
          <span class="restore-line" data-n={r.range.start + i}>
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}
