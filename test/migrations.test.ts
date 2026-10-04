import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store/db.ts";
import { MIGRATIONS } from "../src/core/store/migrations.ts";

const columns = (db: Database, table: string) =>
  db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name);

test("dropping origin columns keeps threads and comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "stet-mig-"));
  const path = join(dir, "review.db");
  try {
    const old = new Database(path, { create: true, strict: true });
    for (const sql of MIGRATIONS.slice(0, -1)) old.exec(sql);
    old.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
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

test("a fresh database has no origin columns", () => {
  const store = new Store(":memory:");
  for (const table of ["threads", "comments"]) {
    expect(columns(store.db, table)).not.toContain("origin");
    expect(columns(store.db, table)).not.toContain("origin_id");
  }
});
