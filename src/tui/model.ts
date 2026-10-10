import type { CommentDto, NowStateDto, ReviewStatusDto, ThreadDetail, ThreadSummary } from "../core/types.ts";
import { applyFilters, DEFAULT_FILTERS } from "../ui/filters.ts";
import { DEFAULT_TEST_GLOBS, parseList } from "../ui/fold.ts";
import { CORE_PRESETS, orderOf } from "../ui/order.ts";
import { groups as orderedGroups, nowMoved } from "../ui/state.ts";
import { flatten, type FileGroup } from "../ui/tree.ts";

/** What the server told this client about the review. */
export interface Data {
  status: ReviewStatusDto | null;
  threads: ThreadSummary[];
  drafts: CommentDto[];
  /** The thread open on the thread page. */
  detail: ThreadDetail | null;
  /** The worktree against the server's pin of "now", from the event stream. */
  now: NowStateDto | null;
  online: boolean;
}

export const NO_DATA: Data = { status: null, threads: [], drafts: [], detail: null, now: null, online: true };

export interface ListFilter {
  status: "open" | "all";
  newOnly: boolean;
}

const setting = (d: Data, key: string) => d.status?.ui?.config[key] ?? null;

/** Threads by file in reading order, as the web's tree has them; the open thread stays in even when filtered out. */
export function threadGroups(d: Data, f: ListFilter, current: number | null): FileGroup[] {
  const list = applyFilters(d.threads, { ...DEFAULT_FILTERS, status: f.status, newOnly: f.newOnly });
  const here = current !== null && !list.some((t) => t.id === current) ? d.threads.find((t) => t.id === current) : undefined;
  const order = orderOf(setting(d, "compare.order"), CORE_PRESETS);
  return orderedGroups(here ? [...list, here] : list, order, parseList(setting(d, "compare.tests"), DEFAULT_TEST_GLOBS));
}

export function ordered(d: Data, f: ListFilter, current: number | null): ThreadSummary[] {
  return flatten(threadGroups(d, f, current));
}

/** Files that changed in the worktree after the "now" shown, or null when it did not move. */
export function moved(d: Data): number | null {
  return nowMoved(d.now, d.status?.pinnedNow, d.status?.pinnedNowAt);
}
