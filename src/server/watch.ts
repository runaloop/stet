import { nowSource, reviewById, type Ctx } from "../core/context.ts";
import { gitState, worktreeStatus } from "../core/gitstate.ts";
import { filesBetween } from "../core/service.ts";
import { takeNow } from "../core/snapshot.ts";
import type { GitStateDto, NowStateDto as NowState } from "../core/types.ts";

type Listener = (event: "now" | "git", data: NowState | GitStateDto) => void;

interface Watch {
  listeners: Set<Listener>;
  timer: ReturnType<typeof setTimeout> | undefined;
  fingerprint: string | null;
  pinned: string | null;
  gitKey: string;
  git: GitStateDto | null;
  now: NowState | null;
  error: string | null;
}

const DEFAULT_MS = 3000;

/**
 * Looks at each watched review's worktree every few seconds (only while a page listens) and tells the pages
 * when "now" moved away from the pinned one, or the git state changed. The pages decide when to re-read.
 */
export class Watcher {
  private watches = new Map<number, Watch>();
  private readonly every: number;

  constructor(
    private readonly ctx: Ctx,
    private readonly pinnedOf: (reviewId: number) => string | null,
    every = Number(process.env.STET_WATCH_MS) || DEFAULT_MS,
  ) {
    this.every = every;
  }

  subscribe(reviewId: number, fn: Listener): () => void {
    let w = this.watches.get(reviewId);
    if (!w) {
      w = { listeners: new Set(), timer: undefined, fingerprint: null, pinned: null, gitKey: "", git: null, now: null, error: null };
      this.watches.set(reviewId, w);
    }
    w.listeners.add(fn);
    if (w.git) fn("git", w.git);
    if (w.now) fn("now", w.now);
    if (!w.timer) this.schedule(reviewId, w, 0);
    return () => {
      w.listeners.delete(fn);
      if (w.listeners.size === 0) {
        clearTimeout(w.timer);
        this.watches.delete(reviewId);
      }
    };
  }

  /** Looks again soon, e.g. after "now" was re-read. */
  poke(reviewId: number): void {
    const w = this.watches.get(reviewId);
    if (w) this.schedule(reviewId, w, 0);
  }

  private schedule(reviewId: number, w: Watch, delay: number): void {
    clearTimeout(w.timer);
    w.timer = setTimeout(async () => {
      const t0 = performance.now();
      await this.tick(reviewId, w).then(
        () => (w.error = null),
        (e: Error) => {
          if (e.message !== w.error) console.error(`stet serve: watching review ${reviewId}: ${e.message}`);
          w.error = e.message;
        },
      );
      if (this.watches.get(reviewId) === w) this.schedule(reviewId, w, Math.max(this.every, (performance.now() - t0) * 10));
    }, delay);
  }

  private emit(w: Watch, event: "now" | "git", data: NowState | GitStateDto): void {
    for (const fn of w.listeners) fn(event, data);
  }

  private async tick(reviewId: number, w: Watch): Promise<void> {
    const review = reviewById(this.ctx.store, reviewId);
    if (review.state !== "active") return;
    const src = await nowSource(this.ctx, review);
    const status = src.kind === "worktree" ? await worktreeStatus(src.path) : null;
    const git = await gitState(this.ctx, review, src, status ?? undefined);
    const key = JSON.stringify(git);
    if (key !== w.gitKey) {
      w.gitKey = key;
      w.git = git;
      this.emit(w, "git", git);
    }
    const fingerprint = status?.fingerprint ?? git.tip ?? "";
    const pinned = this.pinnedOf(reviewId);
    if (!pinned || (fingerprint === w.fingerprint && pinned === w.pinned)) return;
    w.fingerprint = fingerprint;
    w.pinned = pinned;
    const snap = await takeNow(this.ctx, review, { keep: false, fresh: true });
    const now: NowState = { sha: snap.sha, pinned, files: snap.sha === pinned ? 0 : await filesBetween(this.ctx, pinned, snap.sha) };
    if (now.sha !== w.now?.sha || now.pinned !== w.now?.pinned || now.files !== w.now?.files) {
      w.now = now;
      this.emit(w, "now", now);
    }
  }
}
