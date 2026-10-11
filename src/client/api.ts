import { StetError } from "../core/context.ts";
import type {
  CommentDto,
  CompareDto,
  CursorsDto,
  GitStateDto,
  Intent,
  ResolveReason,
  ReviewDto,
  ReviewedDto,
  ReviewStatusDto,
  SubmittedDto,
  ThreadDetail,
  ThreadSummary,
  Verdict,
} from "../core/types.ts";
import type { Address } from "./server.ts";

/** A request the server refused, with its HTTP status and error code; status 0 when the server did not answer. */
export class ApiError extends StetError {
  constructor(message: string, readonly status: number, code: string) {
    super(message, status === 404 ? 2 : status === 409 ? 3 : 1, code);
    this.name = "ApiError";
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

/** The server's API as the page calls it, from Bun: every call carries the token. */
export function clientApi(server: Address) {
  async function call<T>(method: string, path: string, opts: { body?: unknown; query?: Query } = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== null && v !== undefined && v !== "") qs.set(k, String(v));
    const url = `http://127.0.0.1:${server.port}${path}${qs.size ? `?${qs}` : ""}`;
    const res = await fetch(url, {
      method,
      headers: { "x-stet-token": server.token, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }).catch((e: Error) => {
      throw new ApiError(`the server on port ${server.port} does not answer: ${e.message}`, 0, "unreachable");
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (data as { error?: { message?: string; code?: string } }).error;
      throw new ApiError(err?.message ?? `${res.status} ${res.statusText}`, res.status, err?.code ?? "error");
    }
    return data as T;
  }

  return {
    ping: () => call<{ ok: boolean; build: string }>("GET", "/api/ping"),
    reviews: () => call<{ reviews: ReviewDto[]; default: number | null }>("GET", "/api/reviews"),
    review: (review: number) => call<ReviewStatusDto>("GET", "/api/review", { query: { review } }),
    git: (review: number) => call<GitStateDto>("GET", "/api/git", { query: { review } }),
    compare: (review: number, from: string, to: string) => call<CompareDto>("GET", "/api/compare", { query: { review, from, to } }),
    refreshNow: (review: number) => call<{ sha: string | null; changed: boolean }>("POST", "/api/now/refresh", { query: { review } }),
    threads: (review: number) => call<ThreadSummary[]>("GET", "/api/threads", { query: { review, status: "all" } }),
    thread: (review: number, id: number) => call<ThreadDetail>("GET", `/api/threads/${id}`, { query: { review } }),
    reply: (review: number, id: number, b: { body: string; parentId?: number | null; draft: boolean; intent?: Intent | null }) =>
      call<CommentDto>("POST", `/api/threads/${id}/comments`, { query: { review }, body: b }),
    editDraft: (review: number, id: number, body: string) => call<{ ok: boolean }>("PATCH", `/api/comments/${id}`, { query: { review }, body: { body } }),
    discardDraft: (review: number, id: number) => call<{ thread: number; threadDeleted: boolean }>("DELETE", `/api/comments/${id}`, { query: { review } }),
    resolve: (review: number, id: number, reason: ResolveReason | null) => call<{ ok: boolean }>("POST", `/api/threads/${id}/resolve`, { query: { review }, body: { reason } }),
    resolveWithMessage: (review: number, id: number, body: string) => call<CommentDto>("POST", `/api/threads/${id}/resolve`, { query: { review }, body: { body } }),
    reopen: (review: number, id: number) => call<{ ok: boolean }>("POST", `/api/threads/${id}/reopen`, { query: { review }, body: {} }),
    drafts: (review: number) => call<CommentDto[]>("GET", "/api/drafts", { query: { review } }),
    submit: (review: number, body: string, how: { verdict?: Verdict; open?: "keep" | "resolve"; guide?: boolean } = {}) =>
      call<SubmittedDto>("POST", "/api/review/submit", { query: { review }, body: { body, ...how } }),
    cursors: (review: number) => call<CursorsDto>("GET", "/api/cursors", { query: { review } }),
    markReviewed: (review: number, ref: string) => call<ReviewedDto>("POST", "/api/reviewed", { query: { review }, body: { ref } }),
    setViewed: (review: number, keys: string[], on: boolean) => call<{ ok: boolean }>("POST", "/api/viewed", { query: { review }, body: { keys, on } }),
    read: (review: number, threadId: number) => call<{ ok: boolean }>("POST", "/api/read", { query: { review }, body: { threadId } }),
    readAll: (review: number) => call<{ read: number }>("POST", "/api/read", { query: { review }, body: { all: true } }),
  };
}

export type Api = ReturnType<typeof clientApi>;
