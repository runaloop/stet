import { BUILD } from "../core/build.ts";
import { StetError, forbidden, notFound, reviewById, usage, type Ctx } from "../core/context.ts";
import { configKey, configValue, uiConfig } from "../core/config.ts";
import { unifiedPatch } from "../core/diff.ts";
import { listFiles, readBlobAt } from "../core/git.ts";
import { imageType } from "../core/media.ts";
import { actionTarget, editorCommand, editorTemplate, launchCommand } from "../core/actions.ts";
import * as svc from "../core/service.ts";
import { takeNow } from "../core/snapshot.ts";
import type { Intent, ResolveReason, ReviewRow, Verdict } from "../core/store/db.ts";
import { gitState } from "../core/gitstate.ts";
import { requireGuide } from "../core/guide.ts";
import type { ModuleSpec } from "../core/module.ts";
import { actionOf, actionsOf, enabled } from "../core/modules.ts";
import type { Watcher } from "./watch.ts";

/** The "now" the server pinned for a review, and when it took it. */
export interface Pin {
  sha: string;
  at: string;
}

export interface ServerState {
  ctx: Ctx;
  defaultReview: number | null;
  pinnedNow: Map<number, Pin>;
  /** A pin being taken: requests that come meanwhile wait for it instead of taking their own "now". */
  pinning: Map<number, Promise<Pin | null>>;
  watcher?: Watcher;
  /** The modules of the build; a test gives its own. */
  modules?: readonly ModuleSpec[];
}

type Params = Record<string, string>;
type Handler = (s: ServerState, req: Request, url: URL, params: Params) => Promise<unknown>;

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" + path.replace(/:(\w+)/g, (_, k: string) => {
      keys.push(k);
      return "([^/]+)";
    }) + "$",
  );
  routes.push({ method, pattern, keys, handler });
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw usage("request body must be JSON");
  }
}

function review(s: ServerState, url: URL): ReviewRow {
  const id = url.searchParams.get("review");
  if (id) return reviewById(s.ctx.store, Number(id));
  if (s.defaultReview !== null) return reviewById(s.ctx.store, s.defaultReview);
  const first = svc.listReviews(s.ctx)[0];
  if (!first) throw new StetError("no active reviews in this repository: run `stet init` on a branch", 2, "no_review");
  return reviewById(s.ctx.store, first.id);
}

async function pinOf(s: ServerState, r: ReviewRow, refresh = false): Promise<Pin | null> {
  const have = s.pinnedNow.get(r.id);
  const newest = svc.latestVersion(s.ctx, r.id);
  const stale = have !== undefined && newest !== null && newest.created_at > have.at;
  if (have && !refresh && !stale) return have;
  const taking = s.pinning.get(r.id);
  if (taking && !refresh) return taking;
  const pin = (async () => {
    try {
      const at = new Date().toISOString();
      const snap = await takeNow(s.ctx, r, { keep: false, fresh: refresh || stale });
      const taken = { sha: snap.sha, at };
      s.pinnedNow.set(r.id, taken);
      return taken;
    } catch {
      return null;
    }
  })();
  s.pinning.set(r.id, pin);
  try {
    return await pin;
  } finally {
    if (s.pinning.get(r.id) === pin) s.pinning.delete(r.id);
  }
}

async function pinned(s: ServerState, r: ReviewRow): Promise<string | null> {
  return (await pinOf(s, r))?.sha ?? null;
}

async function baseOf(s: ServerState, r: ReviewRow, tip: string): Promise<string | null> {
  try {
    return (await svc.resolveRef(s.ctx, r, "base", { baseFor: tip })).sha;
  } catch {
    return null;
  }
}

const MAX_SHOT = 24 << 20;

const num = (v: string | undefined, name: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw usage(`bad ${name}`);
  return n;
};

route("GET", "/api/ping", async () => ({ ok: true, build: BUILD }));

route("GET", "/api/reviews", async (s) => {
  const reviews = svc.listReviews(s.ctx);
  return { reviews, default: s.defaultReview ?? reviews[0]?.id ?? null };
});

route("GET", "/api/review", async (s, _req, url) => {
  const r = review(s, url);
  const pin = await pinOf(s, r);
  const now = pin?.sha ?? null;
  const pinnedNowAt = pin?.at ?? null;
  const status = await svc.status(s.ctx, r, { pinnedNow: now });
  const actions = actionsOf(s.ctx, s.modules).map((a) => ({ id: a.id, label: a.label, command: a.command, where: a.where }));
  const ui = { config: uiConfig(s.ctx), modules: enabled(s.ctx, s.modules).map((m) => m.id), actions };
  const rows = svc.versionRows(s.ctx, r.id);
  const versionsList = await Promise.all(
    rows.map(async (v, i) => ({ ...svc.versionDto(v), files: await svc.filesBetween(s.ctx, i > 0 ? rows[i - 1]!.snapshot : await baseOf(s, r, v.snapshot), v.snapshot) })),
  );
  const last = rows[rows.length - 1];
  if (status.now) status.now.files = last && status.now.changedSinceLatest ? await svc.filesBetween(s.ctx, last.snapshot, status.now.sha) : 0;
  return { ...status, pinnedNow: now, pinnedNowAt, versionsList, submissions: svc.submissionTimes(s.ctx, r.id), ui };
});

/** A setting of the repository the page may change: only those marked `ui: "write"`, with the values the CLI takes. */
route("POST", "/api/config", async (s, req) => {
  const b = await body<{ key?: unknown; value?: unknown }>(req);
  const spec = configKey(s.ctx, typeof b.key === "string" ? b.key : undefined, "key must be a setting's name");
  const key = spec.key;
  if (spec.ui !== "write") throw forbidden(`${key} is set with stet config set, not from the page`);
  if (typeof b.value !== "string") throw usage("value must be a string");
  const value = configValue(spec, b.value, s.ctx, s.modules);
  s.ctx.store.setMeta(key, value);
  return { key, value };
});

route("POST", "/api/now/refresh", async (s, _req, url) => {
  const r = review(s, url);
  const before = s.pinnedNow.get(r.id)?.sha ?? null;
  const now = (await pinOf(s, r, true))?.sha ?? null;
  s.watcher?.poke(r.id);
  return { sha: now, changed: now !== before };
});

route("GET", "/api/git", async (s, _req, url) => gitState(s.ctx, review(s, url)));

route("GET", "/api/threads", async (s, _req, url) => {
  const r = review(s, url);
  const q = url.searchParams;
  const status = (q.get("status") ?? "all") as "open" | "resolved" | "all";
  return svc.listThreads(
    s.ctx,
    r,
    {
      status,
      state: q.get("state")?.split(",").filter(Boolean),
      unread: q.get("unread") === "1",
      file: q.get("file") || undefined,
      drafts: true,
      newSince: q.get("newSince") ? Number(q.get("newSince")) : undefined,
    },
    { pinnedNow: await pinned(s, r) },
  );
});

route("GET", "/api/threads/:id", async (s, _req, url, p) => {
  const r = review(s, url);
  return svc.threadDetail(s.ctx, r, num(p.id, "thread id"), { pinnedNow: await pinned(s, r) });
});

route("POST", "/api/threads", async (s, req, url) => {
  const r = review(s, url);
  const b = await body<{
    path: string;
    start: number;
    end: number;
    side?: "new" | "old";
    at?: string;
    body: string;
    draft?: boolean;
    region?: { x: number; y: number; w: number; h: number; iw?: number; ih?: number } | null;
    shot?: { full: string; crop?: string | null } | null;
  }>(req);
  const png = (b64: string) => {
    if (b64.length > MAX_SHOT) throw usage("shot is too large");
    return new Uint8Array(Buffer.from(b64, "base64"));
  };
  return svc.addThread(s.ctx, r, {
    path: b.path,
    start: b.start,
    end: b.end,
    region: b.region ?? null,
    shot: b.region && b.shot?.full ? { full: png(b.shot.full), crop: b.shot.crop ? png(b.shot.crop) : null } : null,
    side: b.side,
    at: b.at ?? "now",
    body: b.body,
    draft: b.draft ?? true,
    pinnedNow: await pinned(s, r),
  });
});

route("POST", "/api/threads/:id/comments", async (s, req, url, p) => {
  const r = review(s, url);
  const b = await body<{ body: string; parentId?: number | null; draft?: boolean; intent?: Intent | null }>(req);
  return svc.addReply(s.ctx, r, num(p.id, "thread id"), {
    body: b.body,
    parentId: b.parentId ?? null,
    draft: b.draft ?? false,
    intent: b.intent ?? null,
    pinnedNow: await pinned(s, r),
  });
});

route("POST", "/api/restore", async (s, req, url) => {
  const r = review(s, url);
  const b = await body<{ from: string; path: string; start: number; end: number; at?: string; thread?: number | null; body?: string; draft?: boolean }>(req);
  if (typeof b.from !== "string" || typeof b.path !== "string") throw usage("from and path are required");
  return svc.requestRestore(s.ctx, r, {
    from: b.from,
    path: b.path,
    start: b.start,
    end: b.end,
    at: b.at ?? "now",
    thread: b.thread ?? null,
    body: b.body ?? "",
    draft: b.draft ?? true,
    pinnedNow: await pinned(s, r),
  });
});

route("PATCH", "/api/comments/:id", async (s, req, url, p) => {
  const b = await body<{ body: string }>(req);
  svc.editDraft(s.ctx, review(s, url), num(p.id, "comment id"), b.body);
  return { ok: true };
});

route("DELETE", "/api/comments/:id", async (s, _req, url, p) => svc.discardDraft(s.ctx, review(s, url), num(p.id, "comment id")));

route("POST", "/api/threads/:id/resolve", async (s, req, url, p) => {
  const b = await body<{ reason?: ResolveReason | null; body?: string }>(req).catch(() => ({ reason: null, body: undefined }));
  if (b.body !== undefined) {
    if (typeof b.body !== "string") throw usage("body must be text");
    return svc.resolveWithMessage(s.ctx, review(s, url), num(p.id, "thread id"), b.body);
  }
  svc.resolveThread(s.ctx, review(s, url), num(p.id, "thread id"), b.reason ?? null);
  return { ok: true };
});

route("POST", "/api/threads/:id/reopen", async (s, _req, url, p) => {
  svc.reopenThread(s.ctx, review(s, url), num(p.id, "thread id"));
  return { ok: true };
});

route("GET", "/api/drafts", async (s, _req, url) => svc.listDrafts(s.ctx, review(s, url)));

route("POST", "/api/review/submit", async (s, req, url) => {
  const b = await body<{ body?: string; verdict?: Verdict; open?: "keep" | "resolve"; guide?: boolean }>(req).catch(() => ({ body: undefined, verdict: undefined, open: undefined, guide: undefined }));
  if (b.verdict !== undefined && b.verdict !== "changes" && b.verdict !== "approved") throw usage("verdict must be changes or approved");
  if (b.open !== undefined && b.open !== "keep" && b.open !== "resolve") throw usage("open must be keep or resolve");
  if (b.guide !== undefined && typeof b.guide !== "boolean") throw usage("guide must be true or false");
  return svc.submitReview(s.ctx, review(s, url), { body: b.body || undefined, verdict: b.verdict, open: b.open, guide: b.guide });
});

route("GET", "/api/compare", async (s, _req, url) => {
  const r = review(s, url);
  const from = url.searchParams.get("from") ?? "base";
  const to = url.searchParams.get("to") ?? "now";
  return svc.compare(s.ctx, r, from, to, { pinnedNow: await pinned(s, r) });
});

route("GET", "/api/guide", async (s, _req, url) => requireGuide(s.ctx, review(s, url).id, num(url.searchParams.get("version") ?? undefined, "version")));

route("GET", "/api/commits", async (s, _req, url) => {
  const limit = url.searchParams.get("limit");
  return svc.branchCommits(s.ctx, review(s, url), { limit: limit ? num(limit, "limit") : undefined });
});

route("GET", "/api/patch", async (s, _req, url) => {
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!/^[0-9a-f]{7,64}$/.test(from) || !/^[0-9a-f]{7,64}$/.test(to)) throw usage("bad sha");
  // one file's change alone: its path, and its old one when it was renamed
  const paths = url.searchParams.getAll("path");
  if (paths.some((p) => !p || p.startsWith("/") || p.split("/").includes(".."))) throw usage("bad path");
  return new Response(await unifiedPatch(s.ctx.repo.cwd, from, to, paths), { headers: { "content-type": "text/plain; charset=utf-8" } });
});

route("GET", "/api/grep", async (s, _req, url) => {
  const { grepTree } = await import("../core/grep.ts");
  return grepTree(s.ctx.repo.cwd, url.searchParams.get("sha") ?? "", url.searchParams.get("q") ?? "", { regex: url.searchParams.get("regex") === "1" });
});

route("GET", "/api/blob", async (s, _req, url) => {
  const sha = url.searchParams.get("sha") ?? "";
  const path = url.searchParams.get("path") ?? "";
  if (!/^[0-9a-f]{7,64}$/.test(sha) || !path || path.startsWith("/") || path.split("/").includes("..")) throw usage("bad sha or path");
  const blob = await readBlobAt(s.ctx.repo.cwd, sha, path);
  if (!blob) return { sha, path, exists: false, binary: false, contents: null };
  return { sha, path, exists: true, binary: blob.binary, contents: blob.binary ? null : blob.text };
});

// past this the page resolves names in the diff only: a part of the tree could make a name that several files have look like one
const MAX_FILES = 200_000;

route("GET", "/api/files", async (s, _req, url) => {
  const sha = url.searchParams.get("sha") ?? "";
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw usage("bad sha");
  const paths = await listFiles(s.ctx.repo.cwd, sha).catch(() => {
    throw notFound(`commit ${sha.slice(0, 10)}`);
  });
  return { sha, paths: paths.length > MAX_FILES ? null : paths };
});

route("GET", "/api/raw", async (s, _req, url) => {
  const sha = url.searchParams.get("sha") ?? "";
  const path = url.searchParams.get("path") ?? "";
  if (!/^[0-9a-f]{7,64}$/.test(sha) || !path || path.startsWith("/") || path.split("/").includes("..")) throw usage("bad sha or path");
  const type = imageType(path);
  if (!type) throw usage("not an image");
  const blob = await readBlobAt(s.ctx.repo.cwd, sha, path);
  if (!blob) throw notFound(`${path} at ${sha.slice(0, 10)}`);
  return new Response(blob.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": type,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
});

route("GET", "/api/placements", async (s, _req, url) => {
  const r = review(s, url);
  const sha = url.searchParams.get("sha") ?? "";
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw usage("bad sha");
  return svc.placementsAt(s.ctx, r, sha, url.searchParams.get("path") || null, { pinnedNow: await pinned(s, r) });
});

route("GET", "/api/blame", async (s, _req, url) => {
  const r = review(s, url);
  const q = url.searchParams;
  const path = q.get("path") ?? "";
  if (!path || path.startsWith("/") || path.split("/").includes("..")) throw usage("bad path");
  const from = q.get("from");
  const to = q.get("to");
  const start = from ? num(from, "from") : undefined;
  const { blame } = await import("../core/blame.ts");
  return blame(s.ctx, r, { path, start, end: to ? num(to, "to") : start, at: q.get("at") || undefined, pinnedNow: await pinned(s, r) });
});

route("GET", "/api/cursors", async (s, _req, url) => {
  const r = review(s, url);
  return { reviewed: svc.reviewed(s.ctx, r), viewed: svc.viewedKeys(s.ctx, r) };
});

route("POST", "/api/reviewed", async (s, req, url) => {
  const r = review(s, url);
  const b = await body<{ ref: string }>(req);
  if (typeof b.ref !== "string" || !b.ref) throw usage("ref is required");
  return svc.markReviewed(s.ctx, r, b.ref, { pinnedNow: await pinned(s, r) });
});

route("POST", "/api/viewed", async (s, req, url) => {
  const b = await body<{ keys: string[]; on: boolean }>(req);
  if (!Array.isArray(b.keys) || b.keys.some((k) => typeof k !== "string")) throw usage("keys must be a list of strings");
  svc.setViewed(s.ctx, review(s, url), b.keys, b.on !== false);
  return { ok: true };
});

route("POST", "/api/read", async (s, req, url) => {
  const b = await body<{ threadId?: number; all?: boolean }>(req);
  const r = review(s, url);
  if (b.all) return { read: svc.markAllRead(s.ctx, r) };
  svc.markRead(s.ctx, r, num(String(b.threadId), "thread id"));
  return { ok: true };
});

/**
 * Resolves an action for the page and runs what the page cannot: a file goes to `STET_EDITOR` when the server has one,
 * else the page copies the command. Other launches go back for the page to open.
 */
route("POST", "/api/actions/:id", async (s, req, url, params) => {
  const r = review(s, url);
  const action = actionOf(s.ctx, params.id!, s.modules);
  const target = actionTarget(await body<unknown>(req));
  if (!action.available(s.ctx, target)) throw usage(`${action.id} has nothing to open there`);
  const launch = await action.resolve(s.ctx, r, target);
  if (launch.kind === "file") {
    const cmd = editorCommand(launch);
    const launched = editorTemplate() !== null;
    if (launched) Bun.spawn(cmd.argv, { cwd: cmd.cwd, stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
    return { launch, launched, command: cmd.shell };
  }
  return { launch, launched: false, command: launch.kind === "url" ? launch.url : launchCommand(launch).shell };
});

export async function handleApi(s: ServerState, req: Request, url: URL): Promise<Response> {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.pattern.exec(url.pathname);
    if (!m) continue;
    const params: Params = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    try {
      const data = await r.handler(s, req, url, params);
      if (data instanceof Response) return data;
      return Response.json(data ?? { ok: true });
    } catch (e) {
      if (e instanceof StetError) {
        const status = e.exitCode === 2 ? 404 : e.exitCode === 3 ? 409 : 400;
        return Response.json({ error: { code: e.code, message: e.message } }, { status });
      }
      return Response.json({ error: { code: "internal", message: (e as Error).message } }, { status: 500 });
    }
  }
  return Response.json({ error: { code: "not_found", message: `no route ${req.method} ${url.pathname}` } }, { status: 404 });
}
