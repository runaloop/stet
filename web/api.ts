import type {
  AnchorState,
  BlameDto,
  CommentDto,
  CommitsDto,
  CompareDto,
  CursorsDto,
  GitStateDto,
  GrepResultDto,
  GuideDto,
  NowStateDto,
  Intent,
  ResolveReason,
  ReviewDto,
  ReviewedDto,
  StatusDto,
  SubmissionDto,
  SubmittedDto,
  ThreadDetail,
  ThreadSummary,
  Verdict,
  VersionDto,
} from "../src/core/types.ts";

export type ReviewStatus = StatusDto & {
  pinnedNow: string | null;
  versionsList: VersionDto[];
  submissions?: SubmissionDto[];
  ui?: { tests: string | null; skipMarkers: string | null; collapse: string | null; order: string | null; markdown: string | null; guide: string | null };
};

export interface BlobDto {
  sha: string;
  path: string;
  exists: boolean;
  binary: boolean;
  contents: string | null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

let token = "";

export function setToken(t: string): void {
  token = t;
  try {
    if (t) sessionStorage.setItem("stet.token", t);
  } catch {
    return;
  }
}

export function getToken(): string {
  return token;
}

/** Bytes of an image file at a commit, for <img>: the token goes in the URL as it does for the event stream. */
export function rawUrl(sha: string, path: string): string {
  return `/api/raw?${new URLSearchParams({ sha, path, token })}`;
}

type Query = Record<string, string | number | boolean | null | undefined>;

async function call<T>(method: string, path: string, opts: { body?: unknown; query?: Query } = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== null && v !== undefined && v !== "") qs.set(k, String(v));
  const url = qs.size ? `${path}?${qs}` : path;
  const res = await fetch(url, {
    method,
    headers: { "x-stet-token": token, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: string } }).error;
    throw new ApiError(err?.message ?? `${res.status} ${res.statusText}`, res.status, err?.code ?? "error");
  }
  return data as T;
}

const blobCache = new Map<string, Promise<BlobDto>>();
const blobValues = new Map<string, BlobDto>();

export const api = {
  reviews: () => call<{ reviews: ReviewDto[]; default: number | null }>("GET", "/api/reviews"),
  review: (review: number) => call<ReviewStatus>("GET", "/api/review", { query: { review } }),
  git: (review: number) => call<GitStateDto>("GET", "/api/git", { query: { review } }),
  refreshNow: (review: number) => call<{ sha: string | null; changed: boolean }>("POST", "/api/now/refresh", { query: { review } }),
  threads: (review: number) => call<ThreadSummary[]>("GET", "/api/threads", { query: { review, status: "all" } }),
  thread: (review: number, id: number) => call<ThreadDetail>("GET", `/api/threads/${id}`, { query: { review } }),
  addThread: (
    review: number,
    b: { path: string; start: number; end: number; side: "new" | "old"; at: string; body: string; draft: boolean; region?: { x: number; y: number; w: number; h: number; iw?: number; ih?: number } | null; shot?: { full: string; crop?: string | null } | null },
  ) =>
    call<ThreadSummary>("POST", "/api/threads", { query: { review }, body: b }),
  reply: (review: number, id: number, b: { body: string; parentId?: number | null; draft: boolean; intent?: Intent | null }) =>
    call<CommentDto>("POST", `/api/threads/${id}/comments`, { query: { review }, body: b }),
  restore: (review: number, b: { from: string; path: string; start: number; end: number; at?: string; thread?: number; body: string }) =>
    call<CommentDto>("POST", "/api/restore", { query: { review }, body: b }),
  editDraft: (review: number, id: number, body: string) => call("PATCH", `/api/comments/${id}`, { query: { review }, body: { body } }),
  discardDraft: (review: number, id: number) => call<{ thread: number; threadDeleted: boolean }>("DELETE", `/api/comments/${id}`, { query: { review } }),
  resolve: (review: number, id: number, reason: ResolveReason | null) => call("POST", `/api/threads/${id}/resolve`, { query: { review }, body: { reason } }),
  resolveWithMessage: (review: number, id: number, body: string) => call<CommentDto>("POST", `/api/threads/${id}/resolve`, { query: { review }, body: { body } }),
  reopen: (review: number, id: number) => call("POST", `/api/threads/${id}/reopen`, { query: { review }, body: {} }),
  drafts: (review: number) => call<CommentDto[]>("GET", "/api/drafts", { query: { review } }),
  submit: (review: number, body: string, how: { verdict?: Verdict; open?: "keep" | "resolve"; guide?: boolean } = {}) =>
    call<SubmittedDto>("POST", "/api/review/submit", { query: { review }, body: { body, ...how } }),
  compare: (review: number, from: string, to: string) => call<CompareDto>("GET", "/api/compare", { query: { review, from, to } }),
  commits: (review: number) => call<CommitsDto>("GET", "/api/commits", { query: { review } }),
  guide: (review: number, version: number) => call<GuideDto>("GET", "/api/guide", { query: { review, version } }),
  read: (review: number, threadId: number) => call("POST", "/api/read", { query: { review }, body: { threadId } }),
  readAll: (review: number) => call("POST", "/api/read", { query: { review }, body: { all: true } }),
  open: (review: number, threadId: number) => call<{ launched: boolean; command: string }>("POST", "/api/open", { query: { review }, body: { threadId } }),
  session: () => call<{ token: string }>("GET", "/api/session"),
  startSession: () => call<{ ok: boolean }>("POST", "/api/session"),
  placements: (review: number, sha: string, path: string) =>
    call<{ threadId: number; path: string; range: { start: number; end: number }; state: AnchorState }[]>("GET", "/api/placements", { query: { review, sha, path } }),
  cursors: (review: number) => call<CursorsDto>("GET", "/api/cursors", { query: { review } }),
  markReviewed: (review: number, ref: string) => call<ReviewedDto>("POST", "/api/reviewed", { query: { review }, body: { ref } }),
  setConfig: (key: string, value: string) => call<{ key: string; value: string }>("POST", "/api/config", { body: { key, value } }),
  setViewed: (review: number, keys: string[], on: boolean) => call("POST", "/api/viewed", { query: { review }, body: { keys, on } }),
  blame: (review: number, q: { path: string; from: number; to: number; at: string }) => call<BlameDto>("GET", "/api/blame", { query: { review, ...q } }),
  grep: (sha: string, q: string, regex: boolean) => call<GrepResultDto>("GET", "/api/grep", { query: { sha, q, regex: regex ? 1 : 0 } }),
  async patch(from: string, to: string): Promise<string> {
    const res = await fetch(`/api/patch?from=${from}&to=${to}`, { headers: { "x-stet-token": token } });
    if (!res.ok) throw new ApiError(`patch: ${res.status}`, res.status, "error");
    return res.text();
  },
  blob(sha: string, path: string): Promise<BlobDto> {
    const key = `${sha}:${path}`;
    let hit = blobCache.get(key);
    if (!hit) {
      hit = call<BlobDto>("GET", "/api/blob", { query: { sha, path } });
      hit.then(
        (b) => blobValues.set(key, b),
        () => blobCache.delete(key),
      );
      blobCache.set(key, hit);
    }
    return hit;
  },
  /** A blob already fetched, at once: a view drawn again shows it without a frame of "loading". */
  loadedBlob: (sha: string, path: string): BlobDto | undefined => blobValues.get(`${sha}:${path}`),
};

export interface Live {
  change(seq: number, events: { type: string; role: string; thread_id: number | null }[]): void;
  /** "now" as the worktree is, against the one the server pinned. */
  now(n: NowStateDto): void;
  git(g: GitStateDto): void;
  /** The stream broke and has not come back for a few seconds, or it is back. */
  connection(up: boolean): void;
}

const LOST_AFTER_MS = 3000;

/** The server's event stream, kept open across server restarts: the browser retries a broken stream, this retries a refused one. */
export function subscribe(review: number, since: number, live: Live): () => void {
  let es: EventSource | null = null;
  let last = since;
  let lost = false;
  let closed = false;
  let lostTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  const data = (e: Event) => JSON.parse((e as MessageEvent).data);
  const open = () => {
    es = new EventSource(`/api/events?token=${encodeURIComponent(token)}&review=${review}&since=${last}`);
    es.addEventListener("open", () => {
      retries = 0;
      clearTimeout(lostTimer);
      lostTimer = undefined;
      if (lost) {
        lost = false;
        live.connection(true);
      }
    });
    es.addEventListener("error", () => {
      if (closed) return;
      lostTimer ??= setTimeout(() => {
        lost = true;
        live.connection(false);
      }, LOST_AFTER_MS);
      if (es?.readyState === EventSource.CLOSED) {
        es = null;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(open, Math.min(10_000, 1000 * 2 ** retries++));
      }
    });
    es.addEventListener("change", (e) => {
      const d = data(e);
      last = Math.max(last, d.seq);
      live.change(d.seq, d.events);
    });
    es.addEventListener("now", (e) => live.now(data(e)));
    es.addEventListener("git", (e) => live.git(data(e)));
  };
  open();
  return () => {
    closed = true;
    clearTimeout(lostTimer);
    clearTimeout(retryTimer);
    es?.close();
  };
}
