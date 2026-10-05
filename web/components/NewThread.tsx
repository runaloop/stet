import type { SelectedLineRange } from "@pierre/diffs";
import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { compareData, copyLinesUrl, linesNav, threadCode, type PendingLines } from "../compare.ts";
import { guard, notify, reloadAll, reviewId, route } from "../state.ts";
import { canQuote, quoteLines } from "../quote.ts";
import { rangeText } from "./Bits.tsx";
import { Composer, loadText, saveText } from "./Composer.tsx";
import { RESTORE_TITLE, restorable } from "./Restore.tsx";

export interface NewHere {
  path: string;
  side: "new" | "old";
  sha: string;
  label: string;
  start: number;
  end: number;
  diffSide: "additions" | "deletions" | null;
}

export interface Here {
  pending: NewHere | null;
  start: (p: NewHere) => void;
  cancel: () => void;
  create: (body: string, mode: "draft" | "now") => Promise<boolean | void>;
  storageKey: (p: NewHere) => string;
}

export const lo = (r: SelectedLineRange) => Math.min(r.start, r.end);
export const hi = (r: SelectedLineRange) => Math.max(r.start, r.end);

export function useNewThread(scope: string): Here {
  const rid = reviewId.value;
  const [pending, setPending] = useState<NewHere | null>(null);
  return {
    pending,
    start: setPending,
    cancel: () => setPending(null),
    storageKey: (p) => `new:${rid}:${scope}:${p.sha}:${p.path}:${p.side}:${p.start}-${p.end}`,
    create: async (body, how) => {
      if (!pending || rid === null) return false;
      const t = await guard(api.addThread(rid, { path: pending.path, start: pending.start, end: pending.end, side: pending.side, at: pending.sha, body, draft: how === "draft" }));
      if (!t) return false;
      setPending(null);
      notify(
        how === "draft" ? `draft #${t.id} saved on ${pending.path}:${rangeText(pending)} · the agent sees it after you submit the review` : `thread #${t.id} sent to the agent`,
        "info",
        { label: `open #${t.id}`, route: { name: "thread", id: t.id } },
      );
      await reloadAll();
    },
  };
}

/** The comment box for lines picked in a file's preview. */
export function NewHereBox({ here, p }: { here: Here; p: NewHere }) {
  return (
    <div class="new-thread inline">
      <div class="note">
        New thread on {p.path}
        {p.side === "old" ? " · removed lines" : ""} ({p.label}) · lines {rangeText(p)}
        {canQuote() ? (
          <>
            {" · or "}
            <button
              class="btn small"
              title="put these lines, with path and line numbers, into your reply in this thread"
              onClick={() => {
                void quoteLines({ path: p.path, start: p.start, end: p.end, sha: p.sha, label: p.label });
                here.cancel();
              }}
            >
              ❝ Quote in reply
            </button>
          </>
        ) : null}
      </div>
      <Composer storageKey={here.storageKey(p)} autoFocus placeholder="What is wrong here?" onCancel={here.cancel} onSubmit={here.create} secondaryLabel="Send now" />
    </div>
  );
}

/**
 * The comment box for lines picked on the Changes page or in a thread's code: under them in the code, or under a
 * rendered block. In a thread's code the lines can go into the reply instead, and an older version's be restored there.
 */
export function PendingBox({ p }: { p: PendingLines }) {
  const d = compareData.value;
  const r = route.value;
  const t = r.name === "thread" ? threadCode.value : null;
  const removed = p.range.side === "deletions";
  const at = t ? (removed ? t.old : t.now) : null;
  const [from, to] = r.name === "compare" ? [r.from, r.to] : ["", ""];
  const where = at ? `${at.path}${removed ? " · removed lines" : ""} (${at.label})` : removed ? `${p.oldPath} · removed lines (${d?.from.label ?? from})` : `${p.path} (${d?.to.label ?? to})`;
  const key = t && at ? `new:${reviewId.value}:t${t.thread}:${at.sha}:${at.path}:${removed ? "old" : "new"}:${lo(p.range)}-${hi(p.range)}` : `new:${reviewId.value}:${from}..${to}:${p.path}:${p.range.side}:${p.range.start}-${p.range.end}`;
  const old = t && at ? (at.sha !== t.newest ? restorable(at.label) : null) : removed ? restorable(d?.from.label) : null;
  return (
    <div class="new-thread inline">
      <div class="note">
        New thread on {where} · lines {rangeText({ start: lo(p.range), end: hi(p.range) })}
        {" · or "}
        {at ? (
          <button
            class="btn small quote-lines"
            title="put these lines, with path and line numbers, into your reply in this thread"
            onClick={() => {
              void quoteLines({ path: at.path, start: lo(p.range), end: hi(p.range), sha: at.sha, label: at.label });
              linesNav()?.cancelComment();
            }}
          >
            ❝ Quote in reply
          </button>
        ) : null}
        <button
          class="btn small copy-link"
          title="copy a link that opens the Changes page at these lines, highlighted (Space g Y)"
          onClick={() => void copyLinesUrl({ path: p.path, side: p.range.side === "deletions" ? "deletions" : "additions", start: lo(p.range), end: hi(p.range) })}
        >
          Copy link
        </button>
        {old ? (
          <button
            class="btn small restore-lines"
            title={`${RESTORE_TITLE}; ${t ? "in this thread, with what you typed below" : "what you typed below goes with it"}`}
            onClick={async () => {
              if (await linesNav()?.restoreLines(loadText(key) ?? "")) saveText(key, "");
            }}
          >
            ↺ Restore as in {old}
          </button>
        ) : null}
      </div>
      <Composer
        storageKey={key}
        autoFocus
        placeholder="What is wrong here?"
        onCancel={() => linesNav()?.cancelComment()}
        onSubmit={(body, mode) => linesNav()?.submitComment(body, mode) ?? Promise.resolve(false)}
        onEscape={(el) => el.blur()}
        secondaryLabel="Send now"
      />
    </div>
  );
}
