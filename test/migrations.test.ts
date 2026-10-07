import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store/db.ts";
import { MIGRATIONS } from "../src/core/store/migrations.ts";

const columns = (db: Database, table: string) =>
  db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name);

const before = (marker: string) => MIGRATIONS.findIndex((sql) => sql.includes(marker));

test("dropping origin columns keeps threads and comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "stet-mig-"));
  const path = join(dir, "review.db");
  try {
    const old = new Database(path, { create: true, strict: true });
    const at = before("DROP COLUMN origin");
    for (const sql of MIGRATIONS.slice(0, at)) old.exec(sql);
    old.exec(`PRAGMA user_version = ${at}`);
    old.exec(`
      INSERT INTO reviews(id, branch, created_at) VALUES (1, 'feat', 't');
      INSERT INTO snapshots(sha, tree, created_at) VALUES ('s', 't', 't');
      INSERT INTO threads(id, review_id, path, side, start_line, end_line, anchor_sha, anchor_lines, ctx_before, ctx_after, origin, origin_id, created_at)
        VALUES (1, 1, 'f.txt', 'new', 2, 3, 's', 'x', 'a', 'b', 'adt', 'ext-1', 't');
      INSERT INTO comments(id, thread_id, role, author, body, origin, created_at)
        VALUES (1, 1, 'reviewer', 'alice', 'hello', 'adt', 't');
    `);
    old.close();

    const store = new Store(path);
    expect(columns(store.db, "threads")).not.toContain("origin");
    expect(columns(store.db, "threads")).not.toContain("origin_id");
    expect(columns(store.db, "comments")).not.toContain("origin");
    expect(columns(store.db, "comments")).not.toContain("origin_id");
    expect(store.db.query("SELECT path, start_line, end_line, anchor_lines, status FROM threads").all()).toEqual([
      { path: "f.txt", start_line: 2, end_line: 3, anchor_lines: "x", status: "open" },
    ]);
    expect(store.db.query("SELECT thread_id, role, author, body FROM comments").all()).toEqual([
      { thread_id: 1, role: "reviewer", author: "alice", body: "hello" },
    ]);
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("submissions made before verdicts existed count as requests for changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "stet-mig-"));
  const path = join(dir, "review.db");
  try {
    const old = new Database(path, { create: true, strict: true });
    const at = before("ADD COLUMN verdict");
    for (const sql of MIGRATIONS.slice(0, at)) old.exec(sql);
    old.exec(`PRAGMA user_version = ${at}`);
    old.exec(`
      INSERT INTO reviews(id, branch, created_at) VALUES (1, 'feat', 't');
      INSERT INTO submissions(id, review_id, role, author, submitted_at) VALUES (1, 1, 'reviewer', 'alice', 't');
    `);
    old.close();

    const store = new Store(path);
    expect(store.db.query("SELECT id, verdict FROM submissions").all()).toEqual([{ id: 1, verdict: "changes" }]);
    expect(() => store.db.run("UPDATE submissions SET verdict = 'maybe'")).toThrow();
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore requests come to a database that has comments, and go with a discarded comment", () => {
  const dir = mkdtempSync(join(tmpdir(), "stet-mig-"));
  const path = join(dir, "review.db");
  try {
    const old = new Database(path, { create: true, strict: true });
    const at = before("CREATE TABLE restores");
    for (const sql of MIGRATIONS.slice(0, at)) old.exec(sql);
    old.exec(`PRAGMA user_version = ${at}`);
    old.exec(`
      INSERT INTO reviews(id, branch, created_at) VALUES (1, 'feat', 't');
      INSERT INTO snapshots(sha, tree, created_at) VALUES ('s', 't', 't');
      INSERT INTO threads(id, review_id, path, start_line, end_line, anchor_sha, anchor_lines, ctx_before, ctx_after, created_at)
        VALUES (1, 1, 'f.txt', 2, 3, 's', 'x', 'a', 'b', 't');
      INSERT INTO comments(id, thread_id, role, author, body, created_at) VALUES (1, 1, 'reviewer', 'alice', 'hello', 't');
    `);
    old.close();

    const store = new Store(path);
    expect(columns(store.db, "restores")).toEqual(["comment_id", "version_id", "path", "start_line", "end_line", "text"]);
    expect(store.db.query("SELECT id, body FROM comments").all()).toEqual([{ id: 1, body: "hello" }]);
    store.db.run("INSERT INTO restores(comment_id, version_id, path, start_line, end_line, text) VALUES (1, NULL, 'f.txt', 2, 3, 'old')");
    expect(() => store.db.run("INSERT INTO restores(comment_id, path, start_line, end_line, text) VALUES (1, 'f.txt', 3, 2, 'x')")).toThrow();
    store.db.run("DELETE FROM comments WHERE id = 1");
    expect(store.db.query("SELECT count(*) AS n FROM restores").get()).toEqual({ n: 0 });
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guides come to a database that has versions, and go with their version", () => {
  const dir = mkdtempSync(join(tmpdir(), "stet-mig-"));
  const path = join(dir, "review.db");
  try {
    const old = new Database(path, { create: true, strict: true });
    const at = before("CREATE TABLE guides");
    for (const sql of MIGRATIONS.slice(0, at)) old.exec(sql);
    old.exec(`PRAGMA user_version = ${at}`);
    old.exec(`
      INSERT INTO reviews(id, branch, created_at) VALUES (1, 'feat', 't');
      INSERT INTO snapshots(sha, tree, created_at) VALUES ('s', 't', 't');
      INSERT INTO versions(id, review_id, number, snapshot, role, author, created_at) VALUES (1, 1, 1, 's', 'agent', 'claude', 't');
    `);
    old.close();

    const store = new Store(path);
    expect(columns(store.db, "guides")).toEqual(["version_id", "title", "intro", "created_at"]);
    expect(columns(store.db, "guide_refs")).toEqual(["version_id", "step", "position", "path", "start_line", "end_line"]);
    expect(store.db.query("SELECT number FROM versions").all()).toEqual([{ number: 1 }]);
    store.db.run("INSERT INTO guides(version_id, title, created_at) VALUES (1, 'T', 't')");
    store.db.run("INSERT INTO guide_steps(version_id, position, text) VALUES (1, 1, 'step')");
    store.db.run("INSERT INTO guide_refs(version_id, step, position, path, start_line, end_line) VALUES (1, 1, 1, 'a.ts', 2, 3)");
    store.db.run("INSERT INTO guide_refs(version_id, step, position, path) VALUES (1, 1, 2, 'b.ts')");
    expect(() => store.db.run("INSERT INTO guide_refs(version_id, step, position, path, start_line) VALUES (1, 1, 3, 'c.ts', 2)")).toThrow();
    expect(() => store.db.run("INSERT INTO guide_refs(version_id, step, position, path, start_line, end_line) VALUES (1, 1, 3, 'c.ts', 3, 2)")).toThrow();
    expect(() => store.db.run("INSERT INTO guide_refs(version_id, step, position, path) VALUES (1, 2, 1, 'c.ts')")).toThrow();
    store.db.run("DELETE FROM versions WHERE id = 1");
    for (const t of ["guides", "guide_steps", "guide_refs"]) expect(store.db.query(`SELECT count(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a database with guides keeps its reviews when submissions learn to ask for one", () => {
  const dir = mkdtempSync(join(tmpdir(), "stet-mig-"));
  const path = join(dir, "review.db");
  try {
    const old = new Database(path, { create: true, strict: true });
    const at = before("ADD COLUMN guide");
    for (const sql of MIGRATIONS.slice(0, at)) old.exec(sql);
    old.exec(`PRAGMA user_version = ${at}`);
    old.exec(`
      INSERT INTO reviews(id, branch, created_at) VALUES (1, 'feat', 't');
      INSERT INTO submissions(id, review_id, role, author, submitted_at, verdict) VALUES (1, 1, 'reviewer', 'alice', 't', 'changes');
    `);
    old.close();

    const store = new Store(path);
    expect(store.db.query("SELECT id, verdict, guide FROM submissions").all()).toEqual([{ id: 1, verdict: "changes", guide: 0 }]);
    expect(store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
    store.db.run("UPDATE submissions SET guide = 1");
    expect(() => store.db.run("UPDATE submissions SET guide = 2")).toThrow();
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("threads learn the go reason without losing their comments, reads and shots", () => {
  const dir = mkdtempSync(join(tmpdir(), "stet-mig-"));
  const path = join(dir, "review.db");
  try {
    const old = new Database(path, { create: true, strict: true });
    const at = before("CREATE TABLE threads_go");
    for (const sql of MIGRATIONS.slice(0, at)) old.exec(sql);
    old.exec(`PRAGMA user_version = ${at}`);
    old.exec(`
      INSERT INTO reviews(id, branch, created_at) VALUES (1, 'feat', 't');
      INSERT INTO snapshots(sha, tree, created_at) VALUES ('s', 't', 't');
      INSERT INTO versions(id, review_id, number, snapshot, role, author, created_at) VALUES (1, 1, 1, 's', 'agent', 'claude', 't');
      INSERT INTO threads(id, review_id, path, side, start_line, end_line, anchor_sha, anchor_lines, ctx_before, ctx_after, version_id,
          status, resolve_reason, resolved_by, resolved_at, created_at, region)
        VALUES (7, 1, 'f.txt', 'old', 2, 3, 's', 'x', 'a', 'b', 1, 'resolved', 'wontfix', 'alice', 't2', 't', NULL),
               (8, 1, 'i.png', 'new', 1, 1, 's', 'y', '[]', '[]', 1, 'open', NULL, NULL, NULL, 't', '{"x":1}');
      INSERT INTO comments(id, thread_id, role, author, body, created_at) VALUES (1, 7, 'reviewer', 'alice', 'hello', 't');
      INSERT INTO comments(id, thread_id, parent_id, role, author, body, intent, created_at) VALUES (2, 7, 1, 'agent', 'claude', 'no', 'disagree', 't');
      INSERT INTO reads(reader, thread_id, seen_seq) VALUES ('agent', 7, 5);
      INSERT INTO shots(thread_id, full, created_at) VALUES (8, x'89', 't');
    `);
    old.close();

    const store = new Store(path);
    expect(store.db.query("SELECT * FROM threads ORDER BY id").all()).toEqual([
      { id: 7, review_id: 1, path: "f.txt", side: "old", start_line: 2, end_line: 3, anchor_sha: "s", anchor_lines: "x", ctx_before: "a", ctx_after: "b",
        version_id: 1, status: "resolved", resolve_reason: "wontfix", resolved_by: "alice", resolved_at: "t2", created_at: "t", region: null },
      { id: 8, review_id: 1, path: "i.png", side: "new", start_line: 1, end_line: 1, anchor_sha: "s", anchor_lines: "y", ctx_before: "[]", ctx_after: "[]",
        version_id: 1, status: "open", resolve_reason: null, resolved_by: null, resolved_at: null, created_at: "t", region: '{"x":1}' },
    ]);
    expect(store.db.query("SELECT id, thread_id, resolves FROM comments ORDER BY id").all()).toEqual([
      { id: 1, thread_id: 7, resolves: 0 },
      { id: 2, thread_id: 7, resolves: 0 },
    ]);
    expect(store.db.query("SELECT count(*) AS n FROM reads").get()).toEqual({ n: 1 });
    expect(store.db.query("SELECT count(*) AS n FROM shots").get()).toEqual({ n: 1 });
    expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(store.db.query("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'threads'").all()).toEqual([{ name: "threads_review" }]);

    store.db.run("UPDATE threads SET resolve_reason = 'go' WHERE id = 7");
    expect(() => store.db.run("UPDATE threads SET resolve_reason = 'maybe' WHERE id = 7")).toThrow();
    expect(() => store.db.run("UPDATE comments SET resolves = 2 WHERE id = 1")).toThrow();
    expect(() => store.db.run("INSERT INTO comments(thread_id, role, author, body, created_at) VALUES (99, 'agent', 'claude', 'x', 't')")).toThrow();
    store.db.run("DELETE FROM threads WHERE id = 7");
    expect(store.db.query("SELECT count(*) AS n FROM comments").get()).toEqual({ n: 0 });
    expect(store.db.query("SELECT count(*) AS n FROM reads").get()).toEqual({ n: 0 });
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh database has no origin columns", () => {
  const store = new Store(":memory:");
  for (const table of ["threads", "comments"]) {
    expect(columns(store.db, table)).not.toContain("origin");
    expect(columns(store.db, table)).not.toContain("origin_id");
  }
});
