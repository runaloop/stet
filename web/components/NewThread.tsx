import type { SelectedLineRange } from "@pierre/diffs";
import { useState } from "preact/hooks";
import { api } from "../api.ts";
import { compareData, compareNav, copyLinesUrl, type PendingLines } from "../compare.ts";
import { guard, notify, reloadAll, reviewId, route } from "../state.ts";
import { canQuote, quoteLines } from "../quote.ts";
import { rangeText } from "./Bits.tsx";
import { Composer, loadText, saveText } from "./Composer.tsx";
import { askRestore, RESTORE_TITLE, restorable } from "./Restore.tsx";

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

/** `thread`: lines picked on a thread's page, where they can be restored in that thread from an older version. */
export function NewHereBox({ here, p, thread }: { here: Here; p: NewHere; thread?: { id: number; newest: string } }) {
  const old = thread && p.sha !== thread.newest ? restorable(p.label) : null;
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
        {old && thread ? (
          <>
            {" · or "}
            <button
              class="btn small restore-lines"
              title={`${RESTORE_TITLE}; in this thread, with what you typed below`}
              onClick={async () => {
                const key = here.storageKey(p);
                if (!(await askRestore({ from: old, path: p.path, start: p.start, end: p.end, thread: thread.id, body: loadText(key) ?? "" }))) return;
                saveText(key, "");
                here.cancel();
              }}
            >
              ↺ Restore as in {old}
            </button>
          </>
        ) : null}
      </div>
      <Composer storageKey={here.storageKey(p)} autoFocus placeholder="What is wrong here?" onCancel={here.cancel} onSubmit={here.create} secondaryLabel="Send now" />
    </div>
  );
}

/** The comment box for lines picked on the Changes page: under them in the code, or under a rendered block. */
export function PendingBox({ p }: { p: PendingLines }) {
  const d = compareData.value;
  const r = route.value;
  const [from, to] = r.name === "compare" ? [r.from, r.to] : ["", ""];
  const where = p.range.side === "deletions" ? `${p.oldPath} · removed lines (${d?.from.label ?? from})` : `${p.path} (${d?.to.label ?? to})`;
  const key = `new:${reviewId.value}:${from}..${to}:${p.path}:${p.range.side}:${p.range.start}-${p.range.end}`;
  const old = p.range.side === "deletions" ? restorable(d?.from.label) : null;
  return (
    <div class="new-thread inline">
      <div class="note">
        New thread on {where} · lines {rangeText({ start: lo(p.range), end: hi(p.range) })}
        {" · or "}
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
            title={`${RESTORE_TITLE}; what you typed below goes with it`}
            onClick={async () => {
              if (await compareNav.current?.restoreLines(loadText(key) ?? "")) saveText(key, "");
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
        onCancel={() => compareNav.current?.cancelComment()}
        onSubmit={(body, mode) => compareNav.current?.submitComment(body, mode) ?? Promise.resolve(false)}
        onEscape={(el) => el.blur()}
        secondaryLabel="Send now"
      />
    </div>
  );
}
