import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "./migrations.ts";

export type Role = "reviewer" | "agent";
export type Intent = "fixed" | "answered" | "disagree" | "question";
/** `go`: the reviewer's last message settles it, and the agent does as it says without asking again. */
export type ResolveReason = "fixed" | "wontfix" | "answered" | "go";
export type Verdict = "changes" | "approved";

export interface ReviewRow {
  id: number;
  branch: string;
  base_ref: string | null;
  worktree_hint: string | null;
  state: "active" | "closed";
  created_at: string;
  closed_at: string | null;
  source: "worktree" | "index";
}

export interface SnapshotRow {
  sha: string;
  tree: string;
  parent: string | null;
  worktree: string | null;
  kept: number;
  excluded: string | null;
  created_at: string;
}

export interface VersionRow {
  id: number;
  review_id: number;
  number: number;
  snapshot: string;
  base_sha: string | null;
  label: string | null;
  role: Role;
  author: string;
  created_at: string;
  /** 1 when the version has a guide; only `versionRows` reads it. */
  guide?: number;
  /** 1 when the review it answers asked for a guide; only `versionRows` reads it. */
  guide_requested?: number;
}

export interface ThreadRow {
  id: number;
  review_id: number;
  path: string;
  side: "new" | "old";
  start_line: number;
  end_line: number;
  anchor_sha: string;
  anchor_lines: string;
  ctx_before: string;
  ctx_after: string;
  version_id: number | null;
  status: "open" | "resolved";
  resolve_reason: ResolveReason | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  /** JSON Region: the thread is on an area of an image, not on lines. */
  region: string | null;
}

export interface CommentRow {
  id: number;
  thread_id: number;
  parent_id: number | null;
  role: Role;
  author: string;
  body: string;
  intent: Intent | null;
  snapshot: string | null;
  version_id: number | null;
  submission_id: number | null;
  published_seq: number | null;
  created_at: string;
  updated_at: string | null;
  /** 1 on the reviewer's message that resolves the thread (`go`) once the review is submitted. */
  resolves: number;
}

/** A comment that asks to put lines back as they were in a version (`version_id`), or in the base when it is null. */
export interface RestoreRow {
  comment_id: number;
  version_id: number | null;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
}

export interface EventRow {
  seq: number;
  review_id: number;
  type: EventType;
  role: Role;
  thread_id: number | null;
  comment_id: number | null;
  version_id: number | null;
  submission_id: number | null;
  created_at: string;
}

export type EventType =
  | "review.submitted"
  | "comment.published"
  | "thread.resolved"
  | "thread.reopened"
  | "version.created"
  | "draft.changed";

export interface SubmissionRow {
  id: number;
  review_id: number;
  role: Role;
  author: string;
  body: string | null;
  version_id: number | null;
  submitted_at: string;
  verdict: Verdict;
  /** 1 when the reviewer asked for a guide to the next version. */
  guide: number;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function tighten(path: string, mode: number): void {
  try {
    if (existsSync(path)) chmodSync(path, mode);
  } catch {
    return;
  }
}

export class Store {
  readonly db: Database;

  constructor(readonly path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    // A migration that rebuilds a table drops the old one: with foreign keys on, that would delete the rows
    // that refer to it (ON DELETE CASCADE). The pragma does nothing inside a transaction, so it is set here.
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.migrate();
    this.db.exec("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") for (const p of [path, `${path}-wal`, `${path}-shm`]) tighten(p, 0o600);
  }

  static openInCommonDir(commonDir: string): Store {
    const dir = join(commonDir, "stet");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    tighten(dir, 0o700);
    return new Store(join(dir, "review.db"));
  }

  private migrate(): void {
    const row = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    let version = row?.user_version ?? 0;
    while (version < MIGRATIONS.length) {
      const sql = MIGRATIONS[version]!;
      const next = version + 1;
      this.db.transaction(() => {
        const current = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get();
        if ((current?.user_version ?? 0) >= next) return;
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${next}`);
      }).immediate();
      version = next;
    }
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  meta(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.run("DELETE FROM meta WHERE key = ?", [key]);
    else this.db.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
  }

  addEvent(e: Omit<EventRow, "seq" | "created_at">): number {
    const r = this.db.run(
      "INSERT INTO events(review_id, type, role, thread_id, comment_id, version_id, submission_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [e.review_id, e.type, e.role, e.thread_id, e.comment_id, e.version_id, e.submission_id, nowIso()],
    );
    return Number(r.lastInsertRowid);
  }

  maxSeq(reviewId?: number): number {
    const row = reviewId === undefined
      ? this.db.query<{ m: number | null }, []>("SELECT max(seq) AS m FROM events").get()
      : this.db.query<{ m: number | null }, [number]>("SELECT max(seq) AS m FROM events WHERE review_id = ?").get(reviewId);
    return row?.m ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
