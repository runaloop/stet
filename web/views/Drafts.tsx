import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Body, Kbd } from "../components/Bits.tsx";
import { drafts, guard, lastCompare, link, loadDrafts, navigate, notify, reloadAll, reviewId, threads } from "../state.ts";

export async function submitReview(body = ""): Promise<boolean> {
  const rid = reviewId.value;
  if (rid === null) return false;
  if (drafts.value.length === 0) {
    notify("no drafts to submit", "error");
    return false;
  }
  const r = await guard(api.submit(rid, body));
  if (!r) return false;
  notify(`review submitted: ${r.comments} comments in ${r.threads.length} threads went to the agent`);
  await reloadAll();
  if (lastCompare.value) navigate({ name: "compare", ...lastCompare.value });
  return true;
}

export function DraftsView() {
  const [summary, setSummary] = useState("");
  useEffect(() => {
    void loadDrafts();
  }, []);
  const list = drafts.value;
  const byId = new Map(threads.value.map((t) => [t.id, t]));
  const rid = reviewId.value;

  return (
    <div class="drafts">
      <h2>Your review · {list.length} draft{list.length === 1 ? "" : "s"}</h2>
      <p class="note">
        Drafts are saved on disk but the agent does not see them yet. <b>Submit review</b> sends everything below in one go, like a GitLab review.
      </p>
      {list.map((c) => {
        const t = byId.get(c.threadId);
        return (
          <div class="draft" key={c.id}>
            <div class="draft-head">
              <a {...link({ name: "thread", id: c.threadId })}>
                #{c.threadId} {t ? (t.region ? `${t.path} · area ${t.region.w}×${t.region.h}` : `${t.path}:${t.range.start}`) : ""}
              </a>
              <span>{c.parentId === null ? "new thread" : "reply"}</span>
              <span class="spacer" />
              <button
                class="link danger"
                onClick={async () => {
                  if (rid !== null && (await guard(api.discardDraft(rid, c.id)))) await reloadAll();
                }}
              >
                discard
              </button>
            </div>
            <Body text={c.body} />
          </div>
        );
      })}
      <textarea
        class="summary"
        placeholder="Optional summary for the whole review"
        value={summary}
        onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)}
      />
      <button class="btn primary" disabled={list.length === 0} onClick={async () => { if (await submitReview(summary)) setSummary(""); }}>
        Submit review: send {list.length} comment{list.length === 1 ? "" : "s"} to the agent <Kbd>S</Kbd>
      </button>
    </div>
  );
}
