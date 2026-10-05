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

test("a fresh database has no origin columns", () => {
  const store = new Store(":memory:");
  for (const table of ["threads", "comments"]) {
    expect(columns(store.db, table)).not.toContain("origin");
    expect(columns(store.db, table)).not.toContain("origin_id");
  }
});
