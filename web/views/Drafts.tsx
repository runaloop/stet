import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { api } from "../api.ts";
import { Body, Kbd } from "../components/Bits.tsx";
import { ask } from "../components/Choice.tsx";
import { drafts, guard, lastCompare, link, loadDrafts, navigate, notify, reloadAll, reviewId, threads, versions } from "../state.ts";

/** The summary for the whole review: kept while you move around, so S sends it too. */
const summary = signal("");

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function afterSubmit(): Promise<void> {
  summary.value = "";
  await reloadAll();
  if (lastCompare.value) navigate({ name: "compare", ...lastCompare.value });
}

export async function submitReview(body = summary.value): Promise<boolean> {
  const rid = reviewId.value;
  if (rid === null) return false;
  if (drafts.value.length === 0) {
    notify("no drafts to submit", "error");
    return false;
  }
  const r = await guard(api.submit(rid, body));
  if (!r) return false;
  notify(`changes requested: ${plural(r.comments, "comment")} in ${plural(r.threads.length, "thread")} went to the agent`);
  await afterSubmit();
  return true;
}

/** Approves the latest version. Drafts go along as nits, if you say so; you pick what happens to the other open threads. */
export async function approveReview(body = summary.value): Promise<boolean> {
  const rid = reviewId.value;
  if (rid === null) return false;
  const mine = drafts.value;
  if (mine.length > 0) {
    const how = await ask(
      `Approve with ${plural(mine.length, "draft")}?`,
      <>Approving says this version is done. The drafts can go with it as nits, or as a request for changes and a new round.</>,
      [
        { value: "nits", label: "Approve; drafts go as nits (the agent fixes them without a new round)" },
        { value: "changes", label: "Send as Request changes" },
      ],
    );
    if (how === null) return false;
    if (how === "changes") return submitReview(body);
  }
  const inReview = new Set(mine.map((c) => c.threadId));
  const open = threads.value.filter((t) => t.status === "open" && !t.draft && !inReview.has(t.id));
  let keep: "keep" | "resolve" | undefined;
  if (open.length > 0) {
    const how = await ask(
      `${plural(open.length, "thread")} still open`,
      <>
        Approve and leave {open.length === 1 ? "it" : "them"} open, or resolve {open.length === 1 ? "it" : "them all"} first:
        <ul>
          {open.slice(0, 5).map((t) => (
            <li>
              #{t.id} {t.title}
            </li>
          ))}
          {open.length > 5 ? <li>and {open.length - 5} more</li> : null}
        </ul>
      </>,
      [
        { value: "keep", label: "Approve anyway" },
        { value: "resolve", label: "Resolve all and approve" },
      ],
    );
    if (how === null) return false;
    keep = how;
  }
  const r = await guard(api.submit(rid, body, { verdict: "approved", open: keep }));
  if (!r) return false;
  const nits = r.comments ? `; ${plural(r.comments, "comment")} went to the agent as nits` : "";
  notify(`approved v${r.version}${nits}${r.resolved.length ? `; resolved ${plural(r.resolved.length, "thread")}` : ""}`);
  await afterSubmit();
  return true;
}

export function DraftsView() {
  useEffect(() => {
    void loadDrafts();
  }, []);
  const list = drafts.value;
  const byId = new Map(threads.value.map((t) => [t.id, t]));
  const rid = reviewId.value;
  const latest = versions.value.length;

  return (
    <div class="drafts">
      <h2>Your review · {plural(list.length, "draft")}</h2>
      <p class="note">
        Drafts are saved on disk but the agent does not see them yet. <b>Request changes</b> sends everything below in one go, like a GitLab review.{" "}
        <b>Approve</b> says the latest version is done; drafts sent with it are nits the agent fixes without a new round.
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
        value={summary.value}
        onInput={(e) => (summary.value = (e.target as HTMLTextAreaElement).value)}
      />
      <div class="submit-actions">
        <button class="btn primary" disabled={list.length === 0} onClick={() => void submitReview()}>
          Request changes: send {plural(list.length, "comment")} to the agent {list.length ? <Kbd>S</Kbd> : null}
        </button>
        <button class={`btn approve${list.length ? "" : " solid"}`} onClick={() => void approveReview()}>
          ✓ Approve{latest ? ` v${latest}` : ""} {list.length ? null : <Kbd>S</Kbd>}
        </button>
      </div>
    </div>
  );
}
