import { formatPatch, structuredPatch } from "diff";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  baseBelow,
  conflict,
  EMPTY_BASE,
  emptyBase,
  forbidden,
  mergeBase,
  notFound,
  nowSource,
  resolveCommit,
  StetError,
  usage,
  type Ctx,
} from "./context.ts";
import { diffTreeRaw, NULL_BLOB, numstat, type Hunk } from "./diff.ts";
import { blobIdAt, git, Lru, readBlobById } from "./git.ts";
import { checkGuide, guideWanted, saveGuide, type ParsedGuide } from "./guide.ts";
import { imageType, isPng, sizeOf } from "./image.ts";
import { direct, fileChange, linesAt, trace, type TimelinePoint } from "./placement.ts";
import { mapLine, specAt, type AnchorSpec, type AnchorState } from "./reanchor.ts";
import { getSnapshot, promote, registerCommitSnapshot, takeNow } from "./snapshot.ts";
import type {
  CommentRow,
  EventRow,
  Intent,
  ResolveReason,
  RestoreRow,
  ReviewRow,
  Role,
  SubmissionRow,
  ThreadRow,
  Verdict,
  VersionRow,
} from "./store/db.ts";
import { nowIso } from "./store/db.ts";
import type {
  AnchorDto,
  CommentDto,
  CommitDto,
  CommitsDto,
  CompareDto,
  CompareFile,
  ComparePlacement,
  EventDto,
  Excerpt,
  GuideWanted,
  ImageFiles,
  ImageInfo,
  Range,
  Region,
  RestoreDto,
  ReviewDto,
  ReviewedDto,
  StatusDto,
  SubmissionDto,
  SettledDto,
  SubmittedDto,
  ThreadDetail,
  ThreadSummary,
  TimelineStepDto,
  VersionDto,
} from "./types.ts";

const EXCERPT_CONTEXT = 3;

export const short = (sha: string) => sha.slice(0, 10);

export function firstLine(body: string): string {
  const line = body.trim().split("\n")[0] ?? "";
  return line.length > 120 ? line.slice(0, 117) + "..." : line;
}

export function reviewDto(r: ReviewRow): ReviewDto {
  return { id: r.id, branch: r.branch, baseRef: r.base_ref, worktreeHint: r.worktree_hint, state: r.state, source: r.source, createdAt: r.created_at };
}

export function listReviews(ctx: Ctx, includeClosed = false): ReviewDto[] {
  const rows = ctx.store.db
    .query<ReviewRow, []>(`SELECT * FROM reviews ${includeClosed ? "" : "WHERE state = 'active'"} ORDER BY id`)
    .all();
  return rows.map(reviewDto);
}

export function versionRows(ctx: Ctx, reviewId: number): VersionRow[] {
  return ctx.store.db
    .query<VersionRow, [number]>(
      `SELECT v.*, EXISTS(SELECT 1 FROM guides g WHERE g.version_id = v.id) AS guide,
         EXISTS(SELECT 1 FROM submissions s WHERE s.review_id = v.review_id AND s.role = 'reviewer' AND s.guide = 1
           AND s.version_id IS (SELECT p.id FROM versions p WHERE p.review_id = v.review_id AND p.number = v.number - 1)) AS guide_requested
       FROM versions v WHERE v.review_id = ? ORDER BY v.number`,
    )
    .all(reviewId);
}

/** The reviewer's submitted reviews, oldest first: the versions after one of them are the agent's answer to it. */
export function submissionTimes(ctx: Ctx, reviewId: number): SubmissionDto[] {
  return ctx.store.db
    .query<SubmissionDto, [number]>(
      "SELECT s.submitted_at AS at, v.number AS version, s.verdict, s.body FROM submissions s LEFT JOIN versions v ON v.id = s.version_id WHERE s.review_id = ? AND s.role = 'reviewer' ORDER BY s.id",
    )
    .all(reviewId);
}

export function latestVersion(ctx: Ctx, reviewId: number): VersionRow | null {
  return ctx.store.db
    .query<VersionRow, [number]>("SELECT * FROM versions WHERE review_id = ? ORDER BY number DESC LIMIT 1")
    .get(reviewId);
}

function versionById(ctx: Ctx, id: number | null): VersionRow | null {
  if (id === null) return null;
  return ctx.store.db.query<VersionRow, [number]>("SELECT * FROM versions WHERE id = ?").get(id);
}

export function versionDto(v: VersionRow): VersionDto {
  return {
    number: v.number,
    snapshot: v.snapshot,
    baseSha: v.base_sha,
    label: v.label,
    role: v.role,
    author: v.author,
    createdAt: v.created_at,
    ...(v.guide ? { guide: true as const } : {}),
    ...(v.guide_requested ? { guideRequested: true as const } : {}),
  };
}

function snapshotTree(ctx: Ctx, sha: string): string | null {
  return getSnapshot(ctx, sha)?.tree ?? null;
}

export async function createVersion(
  ctx: Ctx,
  review: ReviewRow,
  opts: { label?: string; allowEmpty?: boolean; at?: string; guide?: ParsedGuide } = {},
): Promise<VersionDto> {
  // with a guide the snapshot is kept only once the guide fits it
  const keep = !opts.guide;
  const snap = opts.at
    ? await registerCommitSnapshot(ctx, opts.at, { keep })
    : await takeNow(ctx, review, { keep, fresh: true });
  const latest = latestVersion(ctx, review.id);
  if (latest && !opts.allowEmpty && snapshotTree(ctx, latest.snapshot) === snap.tree) {
    throw conflict(`nothing changed since version ${latest.number}`);
  }
  const baseSha = review.base_ref ? await baseBelow(ctx.repo.cwd, review.base_ref, snap.sha) : null;
  const asked = guideWanted(ctx, review.id) === "requested";
  if (opts.guide) {
    const base = baseSha ?? (await resolveRef(ctx, review, "base", { baseFor: snap.sha }).catch(() => null))?.sha;
    await checkGuide(ctx, opts.guide, snap.sha, "this version", [base, latest?.snapshot].filter((x): x is string => !!x));
    await promote(ctx, snap.sha);
  }
  const row = ctx.store.tx(() => {
    const max = ctx.store.db
      .query<{ n: number | null }, [number]>("SELECT max(number) AS n FROM versions WHERE review_id = ?")
      .get(review.id);
    const number = (max?.n ?? 0) + 1;
    const r = ctx.store.db.run(
      "INSERT INTO versions(review_id, number, snapshot, base_sha, label, role, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [review.id, number, snap.sha, baseSha, opts.label ?? null, ctx.role, ctx.author, nowIso()],
    );
    const id = Number(r.lastInsertRowid);
    if (opts.guide) saveGuide(ctx, id, opts.guide);
    ctx.store.addEvent({ review_id: review.id, type: "version.created", role: ctx.role, thread_id: null, comment_id: null, version_id: id, submission_id: null });
    return versionById(ctx, id)!;
  });
  return versionDto({ ...row, guide: opts.guide ? 1 : 0, guide_requested: asked ? 1 : 0 });
}

export interface ResolvedRef {
  ref: string;
  sha: string;
  label: string;
  version: VersionRow | null;
  isNow: boolean;
}

export async function resolveRef(
  ctx: Ctx,
  review: ReviewRow,
  ref: string,
  opts: { pinnedNow?: string | null; baseFor?: string } = {},
): Promise<ResolvedRef> {
  const versions = versionRows(ctx, review.id);
  const byNumber = (n: number) => {
    const v = versions.find((x) => x.number === n);
    if (!v) throw notFound(`version ${n}`);
    return v;
  };
  if (ref === "now") {
    const sha = opts.pinnedNow ?? (await takeNow(ctx, review, { keep: false })).sha;
    return { ref, sha, label: "now", version: null, isNow: true };
  }
  if (ref === "latest") {
    const v = versions[versions.length - 1];
    if (!v) throw notFound("any version");
    return { ref, sha: v.snapshot, label: `v${v.number}`, version: v, isNow: false };
  }
  if (ref === EMPTY_BASE) {
    return { ref, sha: await emptyBase(ctx.repo.cwd), label: EMPTY_BASE, version: null, isNow: false };
  }
  if (ref === "base") {
    const tip = opts.baseFor ?? versions[versions.length - 1]?.snapshot ?? (opts.pinnedNow ?? (await takeNow(ctx, review, { keep: false })).sha);
    if (!review.base_ref) {
      const first = versions[0]?.snapshot ?? tip;
      const parent = getSnapshot(ctx, first)?.parent ?? (await resolveCommit(ctx.repo.cwd, `${first}^1`)) ?? (await emptyBase(ctx.repo.cwd));
      return { ref, sha: parent, label: "base", version: null, isNow: false };
    }
    const stored = versions.find((v) => v.snapshot === tip)?.base_sha;
    const sha = stored ?? (await baseBelow(ctx.repo.cwd, review.base_ref, tip));
    if (!sha) throw notFound(`merge base of ${review.base_ref}`);
    return { ref, sha, label: "base", version: null, isNow: false };
  }
  const m = /^v?(\d+)$/.exec(ref);
  if (m) {
    const v = byNumber(Number(m[1]));
    return { ref, sha: v.snapshot, label: `v${v.number}`, version: v, isNow: false };
  }
  const sha = await resolveCommit(ctx.repo.cwd, ref);
  if (!sha) throw notFound(`revision '${ref}'`);
  const v = versions.find((x) => x.snapshot === sha) ?? null;
  return { ref, sha, label: v ? `v${v.number}` : short(sha), version: v, isNow: false };
}

async function ensureSnapshotRow(ctx: Ctx, sha: string): Promise<void> {
  const row = getSnapshot(ctx, sha);
  if (!row) await registerCommitSnapshot(ctx, sha, { keep: true });
  else if (!row.kept) await promote(ctx, sha);
}

export async function normalizePath(ctx: Ctx, p: string): Promise<string> {
  const top = ctx.repo.toplevel;
  let out = p;
  if (isAbsolute(p)) {
    out = top ? relative(top, p) : p;
  } else if (top) {
    out = relative(top, resolve(ctx.repo.cwd, p));
  }
  out = out.replace(/\\/g, "/").replace(/^\.\//, "");
  if (out.startsWith("../") || out === "..") throw usage(`path is outside the repository: ${p}`);
  return out;
}

export async function captureAnchor(ctx: Ctx, sha: string, path: string, start: number, end: number): Promise<AnchorSpec> {
  const lines = await linesAt(ctx.repo.cwd, sha, path);
  if (lines === null) throw notFound(`text file '${path}' at ${short(sha)}`);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
    throw usage(`range ${start}-${end} is outside '${path}' (${lines.length} lines at ${short(sha)})`);
  }
  return specAt(path, lines, start, end);
}

export async function excerptAt(ctx: Ctx, sha: string, path: string, start: number, end: number, context = EXCERPT_CONTEXT): Promise<Excerpt | null> {
  const lines = await linesAt(ctx.repo.cwd, sha, path);
  if (lines === null) return null;
  const firstLine = Math.max(1, start - context);
  const last = Math.min(lines.length, end + context);
  return { sha, path, start, end, firstLine, lines: lines.slice(firstLine - 1, last) };
}

export async function captureImageAnchor(
  ctx: Ctx,
  sha: string,
  path: string,
  area: { x: number; y: number; w: number; h: number; iw?: number; ih?: number },
): Promise<{ spec: AnchorSpec; region: Region }> {
  if (!imageType(path)) throw usage(`'${path}' is not an image (png, jpg, gif, webp, bmp, ico, avif, svg)`);
  const id = await blobIdAt(ctx.repo.cwd, sha, path);
  if (!id) throw notFound(`image '${path}' at ${short(sha)}`);
  const size = sizeOf(path, (await readBlobById(ctx.repo.cwd, id)).bytes) ?? (area.iw && area.ih ? { w: area.iw, h: area.ih } : null);
  if (!size) throw usage(`cannot read the size of '${path}'`);
  const n = (v: number, name: string) => {
    if (!Number.isFinite(v)) throw usage(`bad region ${name}`);
    return Math.round(v);
  };
  const x = Math.min(Math.max(0, n(area.x, "x")), size.w - 1);
  const y = Math.min(Math.max(0, n(area.y, "y")), size.h - 1);
  const w = Math.min(Math.max(1, n(area.w, "w")), size.w - x);
  const h = Math.min(Math.max(1, n(area.h, "h")), size.h - y);
  return {
    spec: { path, start: 1, end: 1, lines: [id], before: [], after: [], image: true },
    region: { x, y, w, h, iw: size.w, ih: size.h },
  };
}

function specOf(t: ThreadRow): AnchorSpec {
  return {
    path: t.path,
    start: t.start_line,
    end: t.end_line,
    lines: JSON.parse(t.anchor_lines),
    before: JSON.parse(t.ctx_before),
    after: JSON.parse(t.ctx_after),
    ...(t.region ? { image: true } : {}),
  };
}

function threadRow(ctx: Ctx, id: number): ThreadRow | null {
  return ctx.store.db.query<ThreadRow, [number]>("SELECT * FROM threads WHERE id = ?").get(id);
}

function rootComment(ctx: Ctx, threadId: number): CommentRow | null {
  return ctx.store.db
    .query<CommentRow, [number]>("SELECT * FROM comments WHERE thread_id = ? ORDER BY id LIMIT 1")
    .get(threadId);
}

function visibleThread(ctx: Ctx, review: ReviewRow, id: number): ThreadRow {
  const t = threadRow(ctx, id);
  if (!t || t.review_id !== review.id) throw notFound(`thread #${id}`);
  const root = rootComment(ctx, id);
  if (!root || (root.published_seq === null && root.role !== ctx.role)) throw notFound(`thread #${id}`);
  return t;
}

function publish(ctx: Ctx, review: ReviewRow, commentId: number, threadId: number, submissionId: number | null): number {
  const seq = ctx.store.addEvent({
    review_id: review.id,
    type: "comment.published",
    role: ctx.role,
    thread_id: threadId,
    comment_id: commentId,
    version_id: null,
    submission_id: submissionId,
  });
  ctx.store.db.run("UPDATE comments SET published_seq = ?, submission_id = ? WHERE id = ?", [seq, submissionId, commentId]);
  return seq;
}

function draftChanged(ctx: Ctx, review: ReviewRow, threadId: number | null, commentId: number | null): void {
  ctx.store.addEvent({ review_id: review.id, type: "draft.changed", role: ctx.role, thread_id: threadId, comment_id: commentId, version_id: null, submission_id: null });
}

export interface AddThreadInput {
  path: string;
  start: number;
  end: number;
  side?: "new" | "old";
  at?: string;
  body: string;
  draft?: boolean;
  pinnedNow?: string | null;
  /** A thread on an area of an image (pixels); `start` and `end` are then ignored. */
  region?: { x: number; y: number; w: number; h: number; iw?: number; ih?: number } | null;
  /** PNGs made by the browser: the image with the area framed, and the area at full size. */
  shot?: { full: Uint8Array; crop?: Uint8Array | null } | null;
  /** The first comment asks to restore these old lines; the body may then be empty. */
  restore?: RestoreText | null;
}

export async function addThread(ctx: Ctx, review: ReviewRow, input: AddThreadInput): Promise<ThreadSummary> {
  if (!input.body.trim() && !input.restore) throw usage("comment body is empty");
  const at = await resolveRef(ctx, review, input.at ?? "now", { pinnedNow: input.pinnedNow });
  await ensureSnapshotRow(ctx, at.sha);
  const image = input.region ? await captureImageAnchor(ctx, at.sha, input.path, input.region) : null;
  const spec = image ? image.spec : await captureAnchor(ctx, at.sha, input.path, input.start, input.end);
  const shot = image && input.shot ? input.shot : null;
  if (shot && (!isPng(shot.full) || (shot.crop && !isPng(shot.crop)))) throw usage("shot must be a PNG");
  if (!latestVersion(ctx, review.id)) {
    await createVersion(ctx, review, { label: "initial", at: at.sha, allowEmpty: true });
  }
  const version = at.version ?? latestVersion(ctx, review.id)!;
  const created = nowIso();
  const id = ctx.store.tx(() => {
    const r = ctx.store.db.run(
      `INSERT INTO threads(review_id, path, side, start_line, end_line, anchor_sha, anchor_lines, ctx_before, ctx_after,
         version_id, created_at, region) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        review.id, spec.path, input.side ?? "new", spec.start, spec.end, at.sha,
        JSON.stringify(spec.lines), JSON.stringify(spec.before), JSON.stringify(spec.after),
        version.id, created, image ? JSON.stringify(image.region) : null,
      ],
    );
    const threadId = Number(r.lastInsertRowid);
    if (shot) ctx.store.db.run("INSERT INTO shots(thread_id, full, crop, created_at) VALUES (?, ?, ?, ?)", [threadId, shot.full, shot.crop ?? null, created]);
    const c = ctx.store.db.run(
      `INSERT INTO comments(thread_id, parent_id, role, author, body, intent, snapshot, version_id, created_at)
       VALUES (?, NULL, ?, ?, ?, NULL, ?, ?, ?)`,
      [threadId, ctx.role, ctx.author, input.body, at.sha, version.id, created],
    );
    const commentId = Number(c.lastInsertRowid);
    if (input.restore) insertRestore(ctx, commentId, input.restore);
    if (input.draft) draftChanged(ctx, review, threadId, commentId);
    else publish(ctx, review, commentId, threadId, null);
    return threadId;
  });
  return (await threadSummaries(ctx, review, { ids: [id], includeDrafts: true, pinnedNow: input.pinnedNow }))[0]!;
}

export interface ReplyInput {
  body: string;
  intent?: Intent | null;
  parentId?: number | null;
  draft?: boolean;
  at?: string | null;
  pinnedNow?: string | null;
  restore?: RestoreText | null;
  /** The reviewer's last word: a draft that resolves the thread as `go` when the review is submitted. */
  resolves?: boolean;
}

export async function addReply(ctx: Ctx, review: ReviewRow, threadId: number, input: ReplyInput): Promise<CommentDto> {
  if (!input.body.trim() && !input.restore) throw usage("comment body is empty");
  const thread = visibleThread(ctx, review, threadId);
  const root = rootComment(ctx, thread.id)!;
  let parentId = input.parentId ?? root.id;
  const parent = ctx.store.db.query<CommentRow, [number]>("SELECT * FROM comments WHERE id = ?").get(parentId);
  if (!parent || parent.thread_id !== thread.id) throw notFound(`comment #${parentId} in thread #${thread.id}`);
  if (parent.published_seq === null && parent.role !== ctx.role) throw notFound(`comment #${parentId}`);
  let snapshot: string | null = null;
  if (input.at) {
    snapshot = (await resolveRef(ctx, review, input.at, { pinnedNow: input.pinnedNow })).sha;
  } else if (input.pinnedNow) {
    snapshot = input.pinnedNow;
  } else {
    try {
      snapshot = (await takeNow(ctx, review, { keep: true })).sha;
    } catch {
      snapshot = null;
    }
  }
  if (snapshot) await ensureSnapshotRow(ctx, snapshot);
  const version = latestVersion(ctx, review.id);
  const id = ctx.store.tx(() => {
    const c = ctx.store.db.run(
      `INSERT INTO comments(thread_id, parent_id, role, author, body, intent, snapshot, version_id, created_at, resolves)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [thread.id, parentId, ctx.role, ctx.author, input.body, input.intent ?? null, snapshot, version?.id ?? null, nowIso(), input.resolves ? 1 : 0],
    );
    const commentId = Number(c.lastInsertRowid);
    if (input.restore) insertRestore(ctx, commentId, input.restore);
    if (input.draft || input.resolves || root.published_seq === null) draftChanged(ctx, review, thread.id, commentId);
    else {
      publish(ctx, review, commentId, thread.id, null);
      reopenOnQuestion(ctx, review, thread.id, input.intent ?? null);
    }
    return commentId;
  });
  const detail = commentRows(ctx, [thread.id]).find((c) => c.id === id)!;
  return commentDto(ctx, detail, new Map(), 0, Infinity, restoresOf(ctx, [id]));
}

/** Old lines to put back: lines `start`-`end` of `path` in a version (by id), or in the base when `versionId` is null. */
export interface RestoreText {
  versionId: number | null;
  path: string;
  start: number;
  end: number;
  text: string;
}

function insertRestore(ctx: Ctx, commentId: number, r: RestoreText): void {
  ctx.store.db.run(
    "INSERT INTO restores(comment_id, version_id, path, start_line, end_line, text) VALUES (?, ?, ?, ?, ?, ?)",
    [commentId, r.versionId, r.path, r.start, r.end, r.text],
  );
}

function restoresOf(ctx: Ctx, commentIds: number[]): Map<number, RestoreDto> {
  const out = new Map<number, RestoreDto>();
  if (commentIds.length === 0) return out;
  const rows = ctx.store.db
    .query<RestoreRow & { number: number | null }, number[]>(
      `SELECT r.*, v.number FROM restores r LEFT JOIN versions v ON v.id = r.version_id WHERE r.comment_id IN (${commentIds.map(() => "?").join(",")})`,
    )
    .all(...commentIds);
  for (const r of rows) {
    out.set(r.comment_id, { path: r.path, range: { start: r.start_line, end: r.end_line }, version: r.number ?? "base", text: r.text });
  }
  return out;
}

export function restoreTitle(r: RestoreDto): string {
  const lines = r.range.start === r.range.end ? `line ${r.range.start}` : `lines ${r.range.start}-${r.range.end}`;
  return `Restore as in ${r.version === "base" ? "base" : `v${r.version}`}: ${r.path} ${lines}`;
}

/** The lines of the newer file that stand where old lines `start`-`end` were: the unchanged ones and what replaced the rest. */
export function linesInPlace(start: number, end: number, hunks: Hunk[], newLength: number): Range | null {
  if (newLength === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  const take = (a: number, b: number) => {
    lo = Math.min(lo, a);
    hi = Math.max(hi, b);
  };
  for (let n = start; n <= end; n++) {
    const m = mapLine(n, hunks);
    if (m !== null) take(m, m);
  }
  for (const h of hunks) {
    if (h.oldCount === 0 || h.oldStart > end || h.oldStart + h.oldCount - 1 < start) continue;
    // git puts a pure deletion after new line `newStart`: the line after it now stands in their place
    if (h.newCount > 0) take(h.newStart, h.newStart + h.newCount - 1);
    else take(h.newStart + 1, h.newStart + 1);
  }
  if (lo === Infinity) return null;
  const clamp = (n: number) => Math.min(Math.max(n, 1), newLength);
  return { start: clamp(lo), end: clamp(hi) };
}

export interface RestoreInput {
  /** The version the lines come from (`v2`, `2`, `latest`), or `base`: the base below `at`, as on the Changes page. */
  from: string;
  path: string;
  start: number;
  end: number;
  body?: string;
  draft?: boolean;
  /** Ask in this thread; otherwise in a new thread on the lines of `at` that stand where the old ones were. */
  thread?: number | null;
  at?: string;
  pinnedNow?: string | null;
}

/**
 * A comment asking to put back old lines exactly as they were in a version or the base. Without a thread, the new
 * thread sits on the matching lines of `at`, or on the old lines themselves when the file is gone there.
 */
export async function requestRestore(ctx: Ctx, review: ReviewRow, input: RestoreInput): Promise<CommentDto> {
  const at = input.thread ? null : await resolveRef(ctx, review, input.at ?? "now", { pinnedNow: input.pinnedNow });
  const from = await resolveRef(ctx, review, input.from, { pinnedNow: input.pinnedNow, ...(at ? { baseFor: at.sha } : {}) });
  if (!from.version && input.from !== "base") throw usage(`restore takes a version or base, not '${input.from}'`);
  const lines = await linesAt(ctx.repo.cwd, from.sha, input.path);
  if (lines === null) throw notFound(`text file '${input.path}' at ${from.label}`);
  const { start, end } = input;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
    throw usage(`range ${start}-${end} is outside '${input.path}' (${lines.length} lines at ${from.label})`);
  }
  const restore: RestoreText = { versionId: from.version?.id ?? null, path: input.path, start, end, text: lines.slice(start - 1, end).join("\n") };
  const common = { body: input.body ?? "", draft: input.draft ?? true, restore, pinnedNow: input.pinnedNow };
  if (input.thread) return addReply(ctx, review, input.thread, common);
  const change = await fileChange(ctx.repo.cwd, from.sha, at!.sha, input.path);
  const place =
    change.kind === "same"
      ? { path: change.newPath, range: { start, end } }
      : change.kind === "modified"
        ? { path: change.newPath, range: linesInPlace(start, end, change.hunks, change.newLines.length) }
        : null;
  const t = place?.range
    ? await addThread(ctx, review, { ...common, path: place.path, start: place.range.start, end: place.range.end, at: at!.sha })
    : await addThread(ctx, review, { ...common, path: input.path, start, end, side: "old", at: from.sha });
  const root = rootComment(ctx, t.id)!;
  return commentDto(ctx, root, new Map(), 0, Infinity, restoresOf(ctx, [root.id]));
}

/** Published threads that are still open, apart from `except`. */
function openThreadIds(ctx: Ctx, review: ReviewRow, except: ReadonlySet<number>): number[] {
  return ctx.store.db
    .query<{ id: number }, [number]>(
      `SELECT t.id FROM threads t
       JOIN comments r ON r.id = (SELECT min(id) FROM comments WHERE thread_id = t.id)
       WHERE t.review_id = ? AND t.status = 'open' AND r.published_seq IS NOT NULL ORDER BY t.id`,
    )
    .all(review.id)
    .map((r) => r.id)
    .filter((id) => !except.has(id));
}

export interface SubmitOptions {
  body?: string;
  verdict?: Verdict;
  /** An approval while threads outside it are open: `keep` leaves them open, `resolve` resolves them first. */
  open?: "keep" | "resolve";
  /** With `changes`: the agent writes a guide to the next version, whatever `agent.guide` says. */
  guide?: boolean;
}

/**
 * `changes` publishes the drafts for the next round. `approved` says the latest version is done; drafts go
 * along as nits that the agent fixes without a new round. Neither closes the review.
 */
export function submitReview(ctx: Ctx, review: ReviewRow, opts: SubmitOptions = {}): SubmittedDto {
  const verdict = opts.verdict ?? "changes";
  if (verdict === "approved" && ctx.role === "agent") throw forbidden("only the reviewer approves");
  if (opts.guide && verdict !== "changes") throw usage("a guide is asked for with a request for changes, not with an approval");
  return ctx.store.tx(() => {
    const drafts = ctx.store.db
      .query<CommentRow, [number, Role]>(
        `SELECT c.* FROM comments c JOIN threads t ON t.id = c.thread_id
         WHERE t.review_id = ? AND c.published_seq IS NULL AND c.role = ? ORDER BY c.id`,
      )
      .all(review.id, ctx.role);
    if (drafts.length === 0 && verdict === "changes") throw conflict("no drafts to submit");
    const version = latestVersion(ctx, review.id);
    const threads = [...new Set(drafts.map((d) => d.thread_id))];
    let resolved: number[] = [];
    if (verdict === "approved") {
      if (!version) throw conflict("nothing to approve: no version yet");
      const open = openThreadIds(ctx, review, new Set(threads));
      if (open.length && !opts.open) {
        throw new StetError(`${open.length} thread${open.length === 1 ? " is" : "s are"} still open: ${open.map((id) => "#" + id).join(" ")}`, 3, "open_threads");
      }
      if (opts.open === "resolve") {
        for (const id of open) markResolved(ctx, review, id, null);
        resolved = open;
      }
    }
    const r = ctx.store.db.run(
      "INSERT INTO submissions(review_id, role, author, body, version_id, submitted_at, verdict, guide) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [review.id, ctx.role, ctx.author, opts.body ?? null, version?.id ?? null, nowIso(), verdict, opts.guide ? 1 : 0],
    );
    const submissionId = Number(r.lastInsertRowid);
    for (const d of drafts) {
      publish(ctx, review, d.id, d.thread_id, submissionId);
      reopenOnQuestion(ctx, review, d.thread_id, d.intent);
    }
    const settled = [...new Set(drafts.filter((d) => d.resolves).map((d) => d.thread_id))];
    for (const id of settled) markResolved(ctx, review, id, "go");
    ctx.store.addEvent({ review_id: review.id, type: "review.submitted", role: ctx.role, thread_id: null, comment_id: null, version_id: version?.id ?? null, submission_id: submissionId });
    return { submission: submissionId, verdict, version: version?.number ?? null, threads, comments: drafts.length, resolved, settled, ...(opts.guide ? { guide: true as const } : {}) };
  });
}

function ownDraft(ctx: Ctx, review: ReviewRow, commentId: number): CommentRow {
  const c = ctx.store.db.query<CommentRow, [number]>("SELECT * FROM comments WHERE id = ?").get(commentId);
  const t = c ? threadRow(ctx, c.thread_id) : null;
  if (!c || !t || t.review_id !== review.id || c.role !== ctx.role || c.published_seq !== null) {
    throw notFound(`draft #${commentId}`);
  }
  return c;
}

export function editDraft(ctx: Ctx, review: ReviewRow, commentId: number, body: string): void {
  const c = ownDraft(ctx, review, commentId);
  if (!body.trim() && !restoresOf(ctx, [commentId]).size) throw usage("comment body is empty");
  ctx.store.tx(() => {
    ctx.store.db.run("UPDATE comments SET body = ?, updated_at = ? WHERE id = ?", [body, nowIso(), commentId]);
    draftChanged(ctx, review, c.thread_id, commentId);
  });
}

export function discardDraft(ctx: Ctx, review: ReviewRow, commentId: number): { thread: number; threadDeleted: boolean } {
  const c = ownDraft(ctx, review, commentId);
  return ctx.store.tx(() => {
    const root = rootComment(ctx, c.thread_id)!;
    if (root.id === c.id) {
      ctx.store.db.run("DELETE FROM comments WHERE thread_id = ?", [c.thread_id]);
      ctx.store.db.run("DELETE FROM reads WHERE thread_id = ?", [c.thread_id]);
      ctx.store.db.run("DELETE FROM threads WHERE id = ?", [c.thread_id]);
      draftChanged(ctx, review, null, null);
      return { thread: c.thread_id, threadDeleted: true };
    }
    ctx.store.db.run("UPDATE comments SET parent_id = ? WHERE parent_id = ?", [c.parent_id, c.id]);
    ctx.store.db.run("DELETE FROM comments WHERE id = ?", [c.id]);
    draftChanged(ctx, review, c.thread_id, null);
    return { thread: c.thread_id, threadDeleted: false };
  });
}

export function listDrafts(ctx: Ctx, review: ReviewRow): CommentDto[] {
  const rows = ctx.store.db
    .query<CommentRow, [number, Role]>(
      `SELECT c.* FROM comments c JOIN threads t ON t.id = c.thread_id
       WHERE t.review_id = ? AND c.published_seq IS NULL AND c.role = ? ORDER BY c.id`,
    )
    .all(review.id, ctx.role);
  const versions = new Map(versionRows(ctx, review.id).map((v) => [v.id, v.number]));
  const restores = restoresOf(ctx, rows.map((r) => r.id));
  return rows.map((r) => commentDto(ctx, r, versions, 0, Infinity, restores));
}

export function resolveThread(ctx: Ctx, review: ReviewRow, id: number, reason: ResolveReason | null): void {
  if (ctx.role === "agent") {
    throw forbidden("only the reviewer resolves threads: reply with an intent (fixed, answered) and let the reviewer close it");
  }
  if (reason === "go") throw usage("go comes with a message for the agent: stet resolve <id> --body <text>");
  const t = visibleThread(ctx, review, id);
  if (rootComment(ctx, id)!.published_seq === null) throw conflict(`thread #${id} is a draft`);
  ctx.store.tx(() => markResolved(ctx, review, t.id, reason));
}

/**
 * The reviewer's last word on a thread: a draft message that resolves it as `go` when the review is submitted, and
 * the agent then does as it says without asking again. A thread has one: a second message replaces the first.
 */
export async function resolveWithMessage(ctx: Ctx, review: ReviewRow, id: number, body: string): Promise<CommentDto> {
  if (ctx.role === "agent") {
    throw forbidden("only the reviewer resolves threads: reply with an intent (fixed, answered) and let the reviewer close it");
  }
  if (!body.trim()) throw usage("comment body is empty");
  const t = visibleThread(ctx, review, id);
  if (rootComment(ctx, id)!.published_seq === null) throw conflict(`thread #${id} is a draft`);
  const pending = ctx.store.db
    .query<CommentRow, [number, Role]>("SELECT * FROM comments WHERE thread_id = ? AND resolves = 1 AND published_seq IS NULL AND role = ?")
    .get(t.id, ctx.role);
  if (!pending) return addReply(ctx, review, t.id, { body, resolves: true });
  editDraft(ctx, review, pending.id, body);
  const versions = new Map(versionRows(ctx, review.id).map((v) => [v.id, v.number]));
  return commentDto(ctx, commentRows(ctx, [t.id]).find((c) => c.id === pending.id)!, versions, 0);
}

function markResolved(ctx: Ctx, review: ReviewRow, threadId: number, reason: ResolveReason | null): void {
  ctx.store.db.run(
    "UPDATE threads SET status = 'resolved', resolve_reason = ?, resolved_by = ?, resolved_at = ? WHERE id = ?",
    [reason, ctx.author, nowIso(), threadId],
  );
  ctx.store.addEvent({ review_id: review.id, type: "thread.resolved", role: ctx.role, thread_id: threadId, comment_id: null, version_id: null, submission_id: null });
}

export function reopenThread(ctx: Ctx, review: ReviewRow, id: number): void {
  if (ctx.role === "agent") {
    throw forbidden(
      threadRow(ctx, id)?.resolve_reason === "go"
        ? `only the reviewer reopens threads; to ask about #${id}, reply with --intent question: that reopens it`
        : "only the reviewer reopens threads",
    );
  }
  const t = visibleThread(ctx, review, id);
  ctx.store.tx(() => markOpen(ctx, review, t.id));
}

function markOpen(ctx: Ctx, review: ReviewRow, threadId: number): void {
  ctx.store.db.run("UPDATE threads SET status = 'open', resolve_reason = NULL, resolved_by = NULL, resolved_at = NULL WHERE id = ?", [threadId]);
  ctx.store.addEvent({ review_id: review.id, type: "thread.reopened", role: ctx.role, thread_id: threadId, comment_id: null, version_id: null, submission_id: null });
}

/** The agent's question or objection in a thread the reviewer settled (`go`) opens it again, for the reviewer to answer. */
function reopenOnQuestion(ctx: Ctx, review: ReviewRow, threadId: number, intent: Intent | null): void {
  if (ctx.role !== "agent" || (intent !== "question" && intent !== "disagree")) return;
  const t = threadRow(ctx, threadId);
  if (t?.status === "resolved" && t.resolve_reason === "go") markOpen(ctx, review, threadId);
}

function readerOf(ctx: Ctx): string {
  return ctx.role;
}

export function markRead(ctx: Ctx, review: ReviewRow, threadId: number, seq?: number): void {
  visibleThread(ctx, review, threadId);
  const s = seq ?? ctx.store.maxSeq(review.id);
  ctx.store.db.run(
    "INSERT INTO reads(reader, thread_id, seen_seq) VALUES (?, ?, ?) ON CONFLICT(reader, thread_id) DO UPDATE SET seen_seq = max(seen_seq, excluded.seen_seq)",
    [readerOf(ctx), threadId, s],
  );
}

export function markAllRead(ctx: Ctx, review: ReviewRow): number {
  const ids = visibleThreadRows(ctx, review, true).map((t) => t.id);
  const s = ctx.store.maxSeq(review.id);
  ctx.store.tx(() => {
    for (const id of ids) {
      ctx.store.db.run(
        "INSERT INTO reads(reader, thread_id, seen_seq) VALUES (?, ?, ?) ON CONFLICT(reader, thread_id) DO UPDATE SET seen_seq = max(seen_seq, excluded.seen_seq)",
        [readerOf(ctx), id, s],
      );
    }
  });
  return ids.length;
}

export function reviewed(ctx: Ctx, review: ReviewRow): ReviewedDto | null {
  const row = ctx.store.db
    .query<{ value: string }, [number, string]>("SELECT value FROM cursors WHERE review_id = ? AND reader = ? AND key = 'reviewed'")
    .get(review.id, readerOf(ctx));
  if (!row) return null;
  const saved = JSON.parse(row.value) as { sha: string; at: string };
  const versions = versionRows(ctx, review.id);
  const tree = snapshotTree(ctx, saved.sha);
  const v = versions.find((x) => x.snapshot === saved.sha) ?? (tree ? versions.find((x) => snapshotTree(ctx, x.snapshot) === tree) : undefined);
  return { sha: v?.snapshot ?? saved.sha, label: v ? `v${v.number}` : short(saved.sha), version: v?.number ?? null, at: saved.at };
}

export async function markReviewed(ctx: Ctx, review: ReviewRow, ref: string, opts: { pinnedNow?: string | null } = {}): Promise<ReviewedDto> {
  const r = await resolveRef(ctx, review, ref, opts);
  if (!r.version) await ensureSnapshotRow(ctx, r.sha);
  ctx.store.db.run(
    "INSERT INTO cursors(review_id, reader, key, value, updated_at) VALUES (?, ?, 'reviewed', ?, ?) ON CONFLICT(review_id, reader, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [review.id, readerOf(ctx), JSON.stringify({ sha: r.sha, at: nowIso() }), nowIso()],
  );
  return reviewed(ctx, review)!;
}

export function viewedKeys(ctx: Ctx, review: ReviewRow): string[] {
  return ctx.store.db
    .query<{ file_key: string }, [number, string]>("SELECT file_key FROM viewed WHERE review_id = ? AND reader = ? ORDER BY created_at")
    .all(review.id, readerOf(ctx))
    .map((r) => r.file_key);
}

export function setViewed(ctx: Ctx, review: ReviewRow, keys: string[], on: boolean): void {
  ctx.store.tx(() => {
    for (const key of keys.slice(0, 5000)) {
      if (on) ctx.store.db.run("INSERT OR IGNORE INTO viewed(review_id, reader, file_key, created_at) VALUES (?, ?, ?, ?)", [review.id, readerOf(ctx), key, nowIso()]);
      else ctx.store.db.run("DELETE FROM viewed WHERE review_id = ? AND reader = ? AND file_key = ?", [review.id, readerOf(ctx), key]);
    }
  });
}

export async function filesBetween(ctx: Ctx, from: string | null, to: string): Promise<number | null> {
  if (!from) return null;
  try {
    return (await diffTreeRaw(ctx.repo.cwd, from, to)).length;
  } catch {
    return null;
  }
}

const MAIN_LINES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];
const MAIN_LINE_SHOWN = 20;

async function forkPoint(ctx: Ctx, review: ReviewRow, tip: string): Promise<{ sha: string; ref: string } | null> {
  if (review.base_ref === EMPTY_BASE) return null;
  const refs = [...new Set([review.base_ref, ...MAIN_LINES].filter((r): r is string => !!r && r !== "HEAD"))];
  for (const ref of refs) {
    const sha = await mergeBase(ctx.repo.cwd, ref, tip);
    if (sha && sha !== tip) return { sha, ref };
  }
  return null;
}

/** The branch's own commits (first parent) from its tip down, then up to 20 from the main line below it. */
export async function branchCommits(ctx: Ctx, review: ReviewRow, opts: { limit?: number } = {}): Promise<CommitsDto> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 100), 1), 500);
  const src = await nowSource(ctx, review);
  const tip = src.kind === "commit" ? src.sha : await resolveCommit(src.path, "HEAD");
  if (!tip) return { tip: null, forkPoint: null, forkRef: null, commits: [], more: false };
  const fork = await forkPoint(ctx, review, tip);
  const log = await git(["log", "--first-parent", `--max-count=${limit + 1}`, "-z", "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s", "--end-of-options", tip], { cwd: ctx.repo.cwd });
  const rows = log.split("\0").filter(Boolean).map((rec) => rec.split("\x1f"));
  const at = new Map<string, { number: number; exact: boolean }[]>();
  for (const v of versionRows(ctx, review.id)) {
    const snap = getSnapshot(ctx, v.snapshot);
    const exact = !snap || snap.worktree === null;
    const commit = exact ? v.snapshot : snap.parent;
    if (commit) at.set(commit, [...(at.get(commit) ?? []), { number: v.number, exact }]);
  }
  let onBranch = true;
  const commits = rows.slice(0, limit).map(([sha, parents, author, date, subject]): CommitDto => {
    if (sha === fork?.sha) onBranch = false;
    return { sha: sha!, parent: parents?.split(" ")[0] || null, author: author ?? "", date: date ?? "", subject: subject ?? "", versions: at.get(sha!) ?? [], onBranch };
  });
  const firstMain = commits.findIndex((c) => !c.onBranch);
  const shown = firstMain === -1 ? commits : commits.slice(0, firstMain + MAIN_LINE_SHOWN);
  return { tip, forkPoint: fork?.sha ?? null, forkRef: fork?.ref ?? null, commits: shown, more: rows.length > limit || shown.length < commits.length };
}

function visibleThreadRows(ctx: Ctx, review: ReviewRow, includeDrafts: boolean): ThreadRow[] {
  return ctx.store.db
    .query<ThreadRow, [number, string, number]>(
      `SELECT t.* FROM threads t
       JOIN comments r ON r.id = (SELECT min(id) FROM comments WHERE thread_id = t.id)
       WHERE t.review_id = ? AND (r.published_seq IS NOT NULL OR (r.role = ? AND ?))
       ORDER BY t.path, t.start_line, t.id`,
    )
    .all(review.id, ctx.role, includeDrafts ? 1 : 0);
}

function commentRows(ctx: Ctx, threadIds: number[]): CommentRow[] {
  if (threadIds.length === 0) return [];
  const placeholders = threadIds.map(() => "?").join(",");
  return ctx.store.db
    .query<CommentRow, (number | string)[]>(
      `SELECT * FROM comments WHERE thread_id IN (${placeholders}) AND (published_seq IS NOT NULL OR role = ?) ORDER BY id`,
    )
    .all(...threadIds, ctx.role);
}

function commentDto(ctx: Ctx, c: CommentRow, versionNumbers: Map<number, number>, step: number, seen = Infinity, restores?: Map<number, RestoreDto>): CommentDto {
  const restore = restores?.get(c.id);
  let version: number | null = null;
  if (c.version_id !== null) {
    version = versionNumbers.get(c.version_id) ?? ctx.store.db.query<{ number: number }, [number]>("SELECT number FROM versions WHERE id = ?").get(c.version_id)?.number ?? null;
  }
  return {
    id: c.id,
    threadId: c.thread_id,
    parentId: c.parent_id,
    role: c.role,
    author: c.author,
    body: c.body,
    intent: c.intent,
    draft: c.published_seq === null,
    snapshot: c.snapshot,
    version,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    step,
    unread: c.published_seq !== null && c.role !== ctx.role && c.published_seq > seen,
    ...(restore ? { restore } : {}),
    ...(c.resolves ? { resolves: true as const } : {}),
  };
}

interface Target {
  sha: string;
  label: string;
  version: VersionRow | null;
  isNow: boolean;
}

interface Placer {
  versions: VersionRow[];
  now: Target | null;
  place(t: ThreadRow, target: Target): Promise<TimelinePoint>;
  timeline(t: ThreadRow): Promise<{ targets: Target[]; points: TimelinePoint[] }>;
}

function bornNumber(ctx: Ctx, versions: VersionRow[], t: ThreadRow): number {
  const exact = versions.find((v) => v.snapshot === t.anchor_sha);
  if (exact) return exact.number;
  const snap = getSnapshot(ctx, t.anchor_sha);
  if (!snap?.worktree) return 0;
  let n = 0;
  for (const v of versions) if (v.created_at <= snap.created_at) n = v.number;
  return n;
}

function makePlacer(ctx: Ctx, versions: VersionRow[], nowSha: string | null): Placer {
  const lastVersion = versions[versions.length - 1] ?? null;
  const nowDiffers = nowSha !== null && (!lastVersion || snapshotTree(ctx, lastVersion.snapshot) !== snapshotTree(ctx, nowSha));
  const now: Target | null = nowSha === null ? null : nowDiffers
    ? { sha: nowSha, label: "now", version: null, isNow: true }
    : { sha: lastVersion!.snapshot, label: `v${lastVersion!.number}`, version: lastVersion, isNow: true };
  const cache = new Map<number, Promise<{ targets: Target[]; points: TimelinePoint[] }>>();

  const timeline = (t: ThreadRow) => {
    let hit = cache.get(t.id);
    if (!hit) {
      hit = (async () => {
        const born = bornNumber(ctx, versions, t);
        const targets: Target[] = versions
          .filter((v) => v.number > born && v.snapshot !== t.anchor_sha)
          .map((v) => ({ sha: v.snapshot, label: `v${v.number}`, version: v, isNow: false }));
        if (now && now.version === null) targets.push(now);
        const points = await trace(
          ctx.repo.cwd,
          ctx.store,
          specOf(t),
          t.anchor_sha,
          targets.map((x) => ({ sha: x.sha, persist: !x.isNow })),
        );
        return { targets, points };
      })();
      cache.set(t.id, hit);
    }
    return hit;
  };

  const place = async (t: ThreadRow, target: Target): Promise<TimelinePoint> => {
    const spec = specOf(t);
    if (target.sha === t.anchor_sha) {
      return { sha: t.anchor_sha, step: { state: "ok", path: t.path, start: t.start_line, end: t.end_line, method: "identity" }, state: "ok", spec };
    }
    const tl = await timeline(t);
    const idx = tl.targets.findIndex((x) => x.sha === target.sha);
    if (idx >= 0) return tl.points[idx]!;
    return direct(ctx.repo.cwd, ctx.store, spec, t.anchor_sha, target.sha, !target.isNow);
  };

  return { versions, now, place, timeline };
}

function anchorDto(p: TimelinePoint, target: Target): AnchorDto {
  return {
    state: p.state,
    path: p.spec?.path ?? null,
    range: p.spec ? { start: p.spec.start, end: p.spec.end } : null,
    method: p.step.method,
    reason: p.step.reason,
    against: target.sha,
    againstLabel: target.label,
  };
}

export interface SummaryOptions {
  ids?: number[];
  includeDrafts?: boolean;
  pinnedNow?: string | null;
  against?: string;
  withAnchor?: boolean;
}

export async function threadSummaries(ctx: Ctx, review: ReviewRow, opts: SummaryOptions = {}): Promise<ThreadSummary[]> {
  let threads = visibleThreadRows(ctx, review, opts.includeDrafts ?? false);
  if (opts.ids) {
    const want = new Set(opts.ids);
    threads = threads.filter((t) => want.has(t.id));
  }
  const versions = versionRows(ctx, review.id);
  const versionNumbers = new Map(versions.map((v) => [v.id, v.number]));
  const comments = commentRows(ctx, threads.map((t) => t.id));
  const byThread = new Map<number, CommentRow[]>();
  for (const c of comments) {
    const list = byThread.get(c.thread_id) ?? [];
    list.push(c);
    byThread.set(c.thread_id, list);
  }
  const restores = restoresOf(ctx, comments.map((c) => c.id));
  const reads = new Map(
    ctx.store.db
      .query<{ thread_id: number; seen_seq: number }, [string]>("SELECT thread_id, seen_seq FROM reads WHERE reader = ?")
      .all(readerOf(ctx))
      .map((r) => [r.thread_id, r.seen_seq]),
  );

  let target: Target | null = null;
  let placer: Placer | null = null;
  if (opts.withAnchor !== false && threads.length > 0) {
    if (opts.against && opts.against !== "now") {
      const r = await resolveRef(ctx, review, opts.against, { pinnedNow: opts.pinnedNow });
      placer = makePlacer(ctx, versions, null);
      target = { sha: r.sha, label: r.label, version: r.version, isNow: false };
    } else {
      let nowSha: string | null = opts.pinnedNow ?? null;
      if (!nowSha) {
        try {
          nowSha = (await takeNow(ctx, review, { keep: false })).sha;
        } catch {
          nowSha = versions[versions.length - 1]?.snapshot ?? null;
        }
      }
      placer = makePlacer(ctx, versions, nowSha);
      target = placer.now;
    }
  }

  const result: ThreadSummary[] = [];
  for (const t of threads) {
    const list = byThread.get(t.id) ?? [];
    const root = list[0]!;
    const published = list.filter((c) => c.published_seq !== null);
    const last = published[published.length - 1] ?? null;
    const seen = reads.get(t.id) ?? 0;
    const unread = published.some((c) => c.role !== ctx.role && (c.published_seq ?? 0) > seen);
    let anchor: AnchorDto;
    if (placer && target) {
      anchor = anchorDto(await placer.place(t, target), target);
    } else {
      anchor = { state: "ok", path: t.path, range: { start: t.start_line, end: t.end_line }, method: "identity", against: t.anchor_sha, againstLabel: short(t.anchor_sha) };
    }
    result.push({
      id: t.id,
      status: t.status,
      resolveReason: t.resolve_reason,
      resolvedAt: t.resolved_at,
      resolvedBy: t.resolved_by,
      draft: root.published_seq === null,
      path: t.path,
      side: t.side,
      range: { start: t.start_line, end: t.end_line },
      region: t.region ? (JSON.parse(t.region) as Region) : null,
      version: t.version_id === null ? null : (versionNumbers.get(t.version_id) ?? null),
      anchorSha: t.anchor_sha,
      anchor,
      excerpt: t.region ? [] : JSON.parse(t.anchor_lines),
      title: firstLine(root.body) || titleOf(restores.get(root.id)),
      author: { role: root.role, name: root.author },
      createdAt: t.created_at,
      commentCount: list.length,
      unread,
      needsReply: t.status === "open" && last ? (last.role === "reviewer" ? "agent" : "reviewer") : null,
      last: last ? lastDto(last, restores.get(last.id)) : null,
    });
  }
  return result;
}

const titleOf = (r: RestoreDto | undefined) => (r ? restoreTitle(r) : "");

function lastDto(c: CommentRow, restore: RestoreDto | undefined): NonNullable<ThreadSummary["last"]> {
  return { role: c.role, name: c.author, at: c.created_at, intent: c.intent, preview: firstLine(c.body) || titleOf(restore), ...(restore ? { restore } : {}) };
}

export interface ThreadFilter {
  status?: "open" | "resolved" | "all";
  state?: string[];
  needsReply?: boolean;
  unread?: boolean;
  newSince?: number;
  file?: string;
  drafts?: boolean;
  /** Only the threads resolved with a message for the agent since its latest version, whatever `status` says. */
  settled?: boolean;
}

export async function listThreads(
  ctx: Ctx,
  review: ReviewRow,
  filter: ThreadFilter,
  opts: { pinnedNow?: string | null; against?: string } = {},
): Promise<ThreadSummary[]> {
  let list = await threadSummaries(ctx, review, { includeDrafts: filter.drafts ?? false, pinnedNow: opts.pinnedNow, against: opts.against });
  const status = filter.settled ? "all" : (filter.status ?? "open");
  if (status !== "all") list = list.filter((t) => t.status === status);
  if (filter.settled) {
    const settled = new Set(settledThreads(ctx, review));
    list = list.filter((t) => settled.has(t.id));
  }
  if (filter.state?.length) list = list.filter((t) => filter.state!.includes(t.anchor.state));
  if (filter.needsReply) list = list.filter((t) => t.needsReply === ctx.role);
  if (filter.unread) list = list.filter((t) => t.unread);
  if (filter.file) {
    const g = new Bun.Glob(filter.file);
    list = list.filter((t) => g.match(t.path) || (t.anchor.path !== null && g.match(t.anchor.path)));
  }
  if (filter.newSince !== undefined) {
    const v = versionRows(ctx, review.id).find((x) => x.number === filter.newSince);
    if (!v) throw notFound(`version ${filter.newSince}`);
    const seq = ctx.store.db
      .query<{ seq: number }, [number]>("SELECT seq FROM events WHERE type = 'version.created' AND version_id = ?")
      .get(v.id)?.seq ?? 0;
    const fresh = new Set(
      ctx.store.db
        .query<{ thread_id: number }, [number, number]>(
          `SELECT DISTINCT c.thread_id FROM comments c JOIN threads t ON t.id = c.thread_id
           WHERE t.review_id = ? AND c.published_seq > ?`,
        )
        .all(review.id, seq)
        .map((r) => r.thread_id),
    );
    list = list.filter((t) => fresh.has(t.id));
  }
  return list;
}

function assignSteps(
  comments: CommentRow[],
  rootId: number,
  steps: { version: number | null; kind: TimelineStepDto["kind"] }[],
  versionNumbers: Map<number, number>,
): Map<number, number> {
  const out = new Map<number, number>();
  const lastIndex = steps.length - 1;
  for (const c of comments) {
    if (c.id === rootId) {
      out.set(c.id, 0);
      continue;
    }
    const k = c.version_id === null ? 0 : (versionNumbers.get(c.version_id) ?? 0);
    let idx = 0;
    if (c.role === "reviewer") {
      for (let i = 0; i < steps.length; i++) {
        const v = steps[i]!.version;
        if (steps[i]!.kind === "anchor" || (v !== null && v <= k)) idx = i;
      }
    } else {
      idx = lastIndex;
      for (let i = 1; i < steps.length; i++) {
        const v = steps[i]!.version;
        if (v !== null && v > k) {
          idx = i;
          break;
        }
      }
    }
    out.set(c.id, idx);
  }
  return out;
}

export async function threadDetail(
  ctx: Ctx,
  review: ReviewRow,
  id: number,
  opts: { pinnedNow?: string | null } = {},
): Promise<ThreadDetail> {
  const t = visibleThread(ctx, review, id);
  const [summary] = await threadSummaries(ctx, review, { ids: [id], includeDrafts: true, pinnedNow: opts.pinnedNow });
  const versions = versionRows(ctx, review.id);
  const versionNumbers = new Map(versions.map((v) => [v.id, v.number]));
  let nowSha = opts.pinnedNow ?? null;
  if (!nowSha) {
    try {
      nowSha = (await takeNow(ctx, review, { keep: false })).sha;
    } catch {
      nowSha = null;
    }
  }
  const placer = makePlacer(ctx, versions, nowSha);
  const tl = await placer.timeline(t);
  const born = bornNumber(ctx, versions, t);
  const anchorVersion = versions.find((v) => v.snapshot === t.anchor_sha) ?? null;

  const then = t.region ? null : (await excerptAt(ctx, t.anchor_sha, t.path, t.start_line, t.end_line))!;
  const steps: TimelineStepDto[] = [
    {
      index: 0,
      kind: "anchor",
      label: anchorVersion ? `v${anchorVersion.number}` : born > 0 ? `v${born}+` : short(t.anchor_sha),
      sha: t.anchor_sha,
      version: anchorVersion?.number ?? (born > 0 ? born : null),
      state: "ok",
      method: "identity",
      path: t.path,
      range: { start: t.start_line, end: t.end_line },
      excerpt: then,
      commentIds: [],
    },
  ];
  for (let i = 0; i < tl.targets.length; i++) {
    const target = tl.targets[i]!;
    const p = tl.points[i]!;
    steps.push({
      index: i + 1,
      kind: target.isNow ? "now" : "version",
      label: target.label,
      sha: target.sha,
      version: target.version?.number ?? null,
      state: p.state,
      method: p.step.method,
      reason: p.step.reason,
      path: p.spec?.path ?? null,
      range: p.spec ? { start: p.spec.start, end: p.spec.end } : null,
      excerpt: p.spec ? await excerptAt(ctx, target.sha, p.spec.path, p.spec.start, p.spec.end) : null,
      commentIds: [],
    });
  }

  const rows = commentRows(ctx, [t.id]);
  const stepOf = assignSteps(rows, rows[0]!.id, steps, versionNumbers);
  const seen =
    ctx.store.db.query<{ seen_seq: number }, [string, number]>("SELECT seen_seq FROM reads WHERE reader = ? AND thread_id = ?").get(readerOf(ctx), t.id)?.seen_seq ?? 0;
  const restores = restoresOf(ctx, rows.map((c) => c.id));
  const comments = rows.map((c) => commentDto(ctx, c, versionNumbers, stepOf.get(c.id) ?? 0, seen, restores));
  for (const c of comments) steps[c.step]!.commentIds.push(c.id);

  const lastStep = steps[steps.length - 1]!;
  const now = lastStep.index === 0 ? then : lastStep.excerpt;
  const interdiff = now && lastStep.index > 0 ? await regionInterdiff(ctx, steps[0]!, lastStep) : null;
  const events = ctx.store.db
    .query<{ type: string; role: Role; created_at: string }, [number]>(
      "SELECT type, role, created_at FROM events WHERE thread_id = ? AND type IN ('thread.resolved', 'thread.reopened') ORDER BY seq",
    )
    .all(t.id)
    .map((e) => ({ type: e.type === "thread.resolved" ? ("resolved" as const) : ("reopened" as const), role: e.role, at: e.created_at }));
  return { thread: summary!, comments, events, timeline: steps, code: { then, now, interdiff } };
}

async function regionInterdiff(ctx: Ctx, from: TimelineStepDto, to: TimelineStepDto): Promise<string | null> {
  if (!from.path || !from.range || !to.path || !to.range) return null;
  const a = await linesAt(ctx.repo.cwd, from.sha, from.path);
  const b = await linesAt(ctx.repo.cwd, to.sha, to.path);
  if (!a || !b) return null;
  const patch = structuredPatch(
    `${from.path}@${from.label}`,
    `${to.path}@${to.label}`,
    a.join("\n") + "\n",
    b.join("\n") + "\n",
    undefined,
    undefined,
    { context: EXCERPT_CONTEXT },
  );
  const overlaps = (start: number, count: number, r: { start: number; end: number }) =>
    start <= r.end && start + Math.max(count, 1) - 1 >= r.start;
  patch.hunks = patch.hunks.filter((h) => overlaps(h.oldStart, h.oldLines, from.range!) || overlaps(h.newStart, h.newLines, to.range!));
  if (patch.hunks.length === 0) return null;
  return formatPatch(patch);
}

export async function placementsAt(
  ctx: Ctx,
  review: ReviewRow,
  sha: string,
  path: string | null,
  opts: { pinnedNow?: string | null; ids?: number[] } = {},
): Promise<{ threadId: number; path: string; range: { start: number; end: number }; state: AnchorState }[]> {
  const versions = versionRows(ctx, review.id);
  const placer = makePlacer(ctx, versions, opts.pinnedNow ?? null);
  const v = versions.find((x) => x.snapshot === sha) ?? null;
  const target: Target =
    placer.now && (placer.now.sha === sha || sha === opts.pinnedNow) ? placer.now : { sha, label: v ? `v${v.number}` : short(sha), version: v, isNow: false };
  const out: { threadId: number; path: string; range: { start: number; end: number }; state: AnchorState }[] = [];
  const want = opts.ids ? new Set(opts.ids) : null;
  for (const t of visibleThreadRows(ctx, review, true)) {
    if (t.side !== "new" || (want && !want.has(t.id))) continue;
    const p = await placer.place(t, target);
    if (p.state === "outdated" || !p.spec || (path !== null && p.spec.path !== path)) continue;
    out.push({ threadId: t.id, path: p.spec.path, range: { start: p.spec.start, end: p.spec.end }, state: p.state });
  }
  return out;
}

const imageInfos = new Lru<ImageInfo>(1024);

async function imageInfo(ctx: Ctx, blob: string, path: string): Promise<ImageInfo | null> {
  if (NULL_BLOB.test(blob)) return null;
  const hit = imageInfos.get(blob);
  if (hit) return hit;
  const { bytes } = await readBlobById(ctx.repo.cwd, blob);
  const size = sizeOf(path, bytes);
  const info = { w: size?.w ?? null, h: size?.h ?? null, bytes: bytes.length };
  imageInfos.set(blob, info);
  return info;
}

/** Writes the PNGs of a thread on an image under .git/stet/shots for the agent to open; the image itself when the browser made none. */
export async function imageFiles(ctx: Ctx, review: ReviewRow, id: number): Promise<ImageFiles | null> {
  const t = visibleThread(ctx, review, id);
  if (!t.region) return null;
  const dir = join(ctx.repo.commonDir, "stet", "shots");
  mkdirSync(dir, { recursive: true });
  const row = ctx.store.db.query<{ full: Uint8Array; crop: Uint8Array | null }, [number]>("SELECT full, crop FROM shots WHERE thread_id = ?").get(id);
  if (row) {
    const shot = join(dir, `thread-${id}.png`);
    writeFileSync(shot, row.full);
    const crop = row.crop ? join(dir, `thread-${id}-crop.png`) : null;
    if (crop) writeFileSync(crop, row.crop!);
    return { shot, crop };
  }
  const blob = await blobIdAt(ctx.repo.cwd, t.anchor_sha, t.path);
  if (!blob) return null;
  const shot = join(dir, `thread-${id}${t.path.slice(t.path.lastIndexOf("."))}`);
  writeFileSync(shot, (await readBlobById(ctx.repo.cwd, blob)).bytes);
  return { shot, crop: null };
}

export async function compare(
  ctx: Ctx,
  review: ReviewRow,
  fromRef: string,
  toRef: string,
  opts: { pinnedNow?: string | null } = {},
): Promise<CompareDto> {
  let from: ResolvedRef;
  let to: ResolvedRef;
  if (fromRef === "base" && toRef !== "base") {
    to = await resolveRef(ctx, review, toRef, opts);
    from = await resolveRef(ctx, review, fromRef, { ...opts, baseFor: to.sha });
  } else {
    from = await resolveRef(ctx, review, fromRef, opts);
    to = await resolveRef(ctx, review, toRef, toRef === "base" ? { ...opts, baseFor: from.sha } : opts);
  }
  const raw = await diffTreeRaw(ctx.repo.cwd, from.sha, to.sha);
  const stats = await numstat(ctx.repo.cwd, from.sha, to.sha);
  const statByPath = new Map(stats.map((s) => [s.newPath, s]));
  const files: CompareFile[] = raw.map((c) => {
    const s = statByPath.get(c.newPath);
    return {
      path: c.newPath,
      oldPath: c.status === "A" ? null : c.oldPath,
      status: (["A", "M", "D", "R", "T"].includes(c.status) ? c.status : "M") as CompareFile["status"],
      additions: s?.additions ?? null,
      deletions: s?.deletions ?? null,
      binary: s ? s.additions === null : false,
    };
  });
  for (const [i, c] of raw.entries()) {
    if (imageType(c.newPath)) files[i]!.image = { old: c.status === "A" ? null : await imageInfo(ctx, c.oldBlob, c.oldPath), new: c.status === "D" ? null : await imageInfo(ctx, c.newBlob, c.newPath) };
  }
  const newPaths = new Set(files.filter((f) => f.status !== "D").map((f) => f.path));
  const oldPaths = new Set(files.filter((f) => f.oldPath !== null).map((f) => f.oldPath!));

  const versions = versionRows(ctx, review.id);
  const placer = makePlacer(ctx, versions, to.isNow ? to.sha : from.isNow ? from.sha : null);
  const toTarget: Target = to.isNow && placer.now ? placer.now : { sha: to.sha, label: to.label, version: to.version, isNow: false };
  const fromTarget: Target = from.isNow && placer.now ? placer.now : { sha: from.sha, label: from.label, version: from.version, isNow: false };

  const threads = visibleThreadRows(ctx, review, true);
  const placements: ComparePlacement[] = [];
  const outside: number[] = [];
  for (const t of threads) {
    if (t.side === "new") {
      const p = await placer.place(t, toTarget);
      if (p.state !== "outdated" && p.spec && newPaths.has(p.spec.path)) {
        placements.push({ threadId: t.id, side: "additions", path: p.spec.path, range: { start: p.spec.start, end: p.spec.end }, state: p.state });
        continue;
      }
    }
    const q = await placer.place(t, fromTarget);
    if (q.state !== "outdated" && q.spec && oldPaths.has(q.spec.path)) {
      const file = files.find((f) => f.oldPath === q.spec!.path)!;
      const pNew = t.side === "new" ? await placer.place(t, toTarget) : null;
      placements.push({
        threadId: t.id,
        side: "deletions",
        path: file.path,
        range: { start: q.spec.start, end: q.spec.end },
        state: pNew ? pNew.state : q.state,
      });
      continue;
    }
    outside.push(t.id);
  }
  return {
    from: { ref: fromRef, sha: from.sha, label: from.label },
    to: { ref: toRef, sha: to.sha, label: to.label },
    files,
    placements,
    outside,
  };
}

function eventDto(e: EventRow & { verdict: Verdict | null }, versionNumbers: Map<number, number>): EventDto {
  return {
    seq: e.seq,
    type: e.type,
    role: e.role,
    threadId: e.thread_id,
    commentId: e.comment_id,
    version: e.version_id === null ? null : (versionNumbers.get(e.version_id) ?? null),
    submissionId: e.submission_id,
    ...(e.verdict ? { verdict: e.verdict } : {}),
    createdAt: e.created_at,
  };
}

export function eventsSince(ctx: Ctx, review: ReviewRow, since: number, limit = 1000): EventDto[] {
  const versionNumbers = new Map(versionRows(ctx, review.id).map((v) => [v.id, v.number]));
  return ctx.store.db
    .query<EventRow & { verdict: Verdict | null }, [number, number, number]>(
      `SELECT e.*, s.verdict FROM events e LEFT JOIN submissions s ON s.id = e.submission_id AND e.type = 'review.submitted'
       WHERE e.review_id = ? AND e.seq > ? ORDER BY e.seq LIMIT ?`,
    )
    .all(review.id, since, limit)
    .filter((e) => e.type !== "draft.changed" || e.role === ctx.role)
    .map((e) => eventDto(e, versionNumbers));
}

/**
 * Threads the reviewer resolved with a message (`go`) after the agent's latest version, with that message: the agent
 * does as it says in its next version. A version made after it settles them for good.
 */
function settledMessages(ctx: Ctx, review: ReviewRow): Map<number, CommentRow> {
  const rows = ctx.store.db
    .query<CommentRow, [number, number]>(
      `SELECT c.* FROM threads t JOIN comments c ON c.id = (
         SELECT id FROM comments WHERE thread_id = t.id AND resolves = 1 AND published_seq IS NOT NULL ORDER BY published_seq DESC LIMIT 1)
       WHERE t.review_id = ? AND t.status = 'resolved' AND t.resolve_reason = 'go'
         AND c.published_seq > (SELECT coalesce(max(seq), 0) FROM events WHERE review_id = ? AND type = 'version.created')
       ORDER BY t.id`,
    )
    .all(review.id, review.id);
  return new Map(rows.map((c) => [c.thread_id, c]));
}

export function settledThreads(ctx: Ctx, review: ReviewRow): number[] {
  return [...settledMessages(ctx, review).keys()];
}

export async function status(ctx: Ctx, review: ReviewRow, opts: { pinnedNow?: string | null } = {}): Promise<StatusDto> {
  const versions = versionRows(ctx, review.id);
  const latest = versions[versions.length - 1] ?? null;
  let now: StatusDto["now"] = null;
  let nowTree: string | null = null;
  try {
    const snap = opts.pinnedNow ? { sha: opts.pinnedNow, tree: snapshotTree(ctx, opts.pinnedNow), excluded: [] as string[] } : await takeNow(ctx, review, { keep: false });
    nowTree = snap.tree;
    now = {
      sha: snap.sha,
      changedSinceLatest: latest ? snapshotTree(ctx, latest.snapshot) !== snap.tree : true,
      excluded: snap.excluded,
    };
  } catch {
    now = null;
  }
  const submissions = submissionTimes(ctx, review.id);
  const last = submissions[submissions.length - 1] ?? null;
  const judged = last ? (versions.find((v) => v.number === last.version) ?? null) : null;
  const changedAfter = judged ? judged.number !== latest?.number ||(nowTree !== null && snapshotTree(ctx, judged.snapshot) !== nowTree) : versions.length > 0;
  const all = await threadSummaries(ctx, review, { includeDrafts: true, pinnedNow: now?.sha ?? null });
  const published = all.filter((t) => !t.draft);
  const drafts = listDrafts(ctx, review).length;
  const messages = settledMessages(ctx, review);
  const settled: SettledDto[] = published
    .filter((t) => messages.has(t.id))
    .map((t) => {
      const m = messages.get(t.id)!;
      return { id: t.id, path: t.anchor.path ?? t.path, range: t.anchor.range, title: t.title, message: m.body, by: m.author, at: t.resolvedAt ?? m.created_at };
    });
  return {
    review: reviewDto(review),
    versions: versions.length,
    latest: latest ? versionDto(latest) : null,
    now,
    counts: {
      open: published.filter((t) => t.status === "open").length,
      resolved: published.filter((t) => t.status === "resolved").length,
      outdated: published.filter((t) => t.status === "open" && t.anchor.state === "outdated").length,
      changed: published.filter((t) => t.status === "open" && t.anchor.state === "changed").length,
      drafts,
      needsAgent: published.filter((t) => t.needsReply === "agent").length,
      needsReviewer: published.filter((t) => t.needsReply === "reviewer").length,
      unread: published.filter((t) => t.unread).length,
      settled: settled.length,
    },
    settled,
    lastSubmission: last ? { ...last, changedAfter } : null,
    guide: guideWanted(ctx, review.id),
    lastSeq: ctx.store.maxSeq(review.id),
  };
}

export type WaitKind = "review" | "reply" | "version" | "any";

export interface WaitResult {
  reason: "pending" | "approved" | "event" | "timeout";
  events: EventDto[];
  threads: number[];
  cursor: number;
  /** With `approved`: the version the reviewer approved. */
  version?: number | null;
  /** With `--for review`: threads the reviewer resolved with a message for you to act on, as `.settled` in `stet status`. */
  settled: number[];
  /** Whether the next version gets a guide, as `stet status` says. */
  guide: GuideWanted;
}

/** The reviewer's latest submission when it approves the latest version, with the threads it published. */
function standingApproval(ctx: Ctx, review: ReviewRow): { version: number | null; threads: number[] } | null {
  const last = ctx.store.db
    .query<SubmissionRow, [number]>("SELECT * FROM submissions WHERE review_id = ? AND role = 'reviewer' ORDER BY id DESC LIMIT 1")
    .get(review.id);
  const latest = latestVersion(ctx, review.id);
  if (!last || last.verdict !== "approved" || last.version_id !== (latest?.id ?? null)) return null;
  const threads = ctx.store.db
    .query<{ thread_id: number }, [number]>("SELECT DISTINCT thread_id FROM comments WHERE submission_id = ? ORDER BY thread_id")
    .all(last.id)
    .map((r) => r.thread_id);
  return { version: latest?.number ?? null, threads };
}

function pendingThreads(ctx: Ctx, review: ReviewRow, kind: WaitKind): number[] {
  if (kind !== "review" && kind !== "reply") return [];
  const wantRole: Role = kind === "review" ? "reviewer" : "agent";
  const rows = ctx.store.db
    .query<{ id: number; last_role: Role; last_seq: number; seen: number | null }, [string, number]>(
      `SELECT t.id,
         (SELECT role FROM comments WHERE thread_id = t.id AND published_seq IS NOT NULL ORDER BY published_seq DESC LIMIT 1) AS last_role,
         (SELECT max(published_seq) FROM comments WHERE thread_id = t.id) AS last_seq,
         (SELECT seen_seq FROM reads WHERE thread_id = t.id AND reader = ?) AS seen
       FROM threads t WHERE t.review_id = ? AND t.status = 'open'`,
    )
    .all(ctx.role, review.id);
  return rows
    .filter((r) => r.last_role === wantRole && (kind === "review" || (r.last_seq ?? 0) > (r.seen ?? 0)))
    .map((r) => r.id);
}

export async function waitFor(
  ctx: Ctx,
  review: ReviewRow,
  kind: WaitKind,
  opts: { since?: number; timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<WaitResult> {
  const start = Date.now();
  const since = opts.since ?? ctx.store.maxSeq(review.id);
  const poll = opts.pollMs ?? 300;
  const matches = (e: EventDto) => {
    if (e.role === ctx.role) return false;
    if (kind === "any") return e.type !== "draft.changed";
    if (kind === "version") return e.type === "version.created";
    if (kind === "review") return e.type === "review.submitted" || e.type === "comment.published";
    return e.type === "comment.published";
  };
  while (true) {
    const approval = kind === "review" ? standingApproval(ctx, review) : null;
    const pending = pendingThreads(ctx, review, kind);
    const settled = kind === "review" ? settledThreads(ctx, review) : [];
    const events = eventsSince(ctx, review, since).filter(matches);
    const cursor = ctx.store.maxSeq(review.id);
    const guide = () => guideWanted(ctx, review.id);
    if (approval) return { reason: "approved", events, threads: approval.threads, cursor, version: approval.version, settled, guide: guide() };
    if ((pending.length > 0 || settled.length > 0) && (kind === "review" || kind === "reply")) {
      return { reason: "pending", events, threads: pending, cursor, settled, guide: guide() };
    }
    if (events.length > 0 && kind !== "review" && kind !== "reply") {
      return { reason: "event", events, threads: [...new Set(events.map((e) => e.threadId).filter((x): x is number => x !== null))], cursor, settled, guide: guide() };
    }
    if (opts.signal?.aborted || (opts.timeoutMs !== undefined && Date.now() - start >= opts.timeoutMs)) {
      return { reason: "timeout", events: [], threads: [], cursor, settled: [], guide: guide() };
    }
    await Bun.sleep(poll);
  }
}
