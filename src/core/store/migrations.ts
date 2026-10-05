export const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE reviews(
    id INTEGER PRIMARY KEY,
    branch TEXT NOT NULL,
    base_ref TEXT,
    worktree_hint TEXT,
    state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','closed')),
    created_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE UNIQUE INDEX reviews_active ON reviews(branch) WHERE state = 'active';

  CREATE TABLE snapshots(
    sha TEXT PRIMARY KEY,
    tree TEXT NOT NULL,
    parent TEXT,
    worktree TEXT,
    kept INTEGER NOT NULL DEFAULT 0,
    excluded TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX snapshots_tree_parent ON snapshots(tree, parent);

  CREATE TABLE versions(
    id INTEGER PRIMARY KEY,
    review_id INTEGER NOT NULL REFERENCES reviews(id),
    number INTEGER NOT NULL,
    snapshot TEXT NOT NULL REFERENCES snapshots(sha),
    base_sha TEXT,
    label TEXT,
    role TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(review_id, number)
  );

  CREATE TABLE submissions(
    id INTEGER PRIMARY KEY,
    review_id INTEGER NOT NULL REFERENCES reviews(id),
    role TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT,
    version_id INTEGER REFERENCES versions(id),
    submitted_at TEXT NOT NULL
  );

  CREATE TABLE threads(
    id INTEGER PRIMARY KEY,
    review_id INTEGER NOT NULL REFERENCES reviews(id),
    path TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'new' CHECK(side IN ('new','old')),
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL CHECK(end_line >= start_line),
    anchor_sha TEXT NOT NULL REFERENCES snapshots(sha),
    anchor_lines TEXT NOT NULL,
    ctx_before TEXT NOT NULL,
    ctx_after TEXT NOT NULL,
    version_id INTEGER REFERENCES versions(id),
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
    resolve_reason TEXT CHECK(resolve_reason IN ('fixed','wontfix','answered')),
    resolved_by TEXT,
    resolved_at TEXT,
    origin TEXT NOT NULL DEFAULT 'stet',
    origin_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX threads_review ON threads(review_id);
  CREATE UNIQUE INDEX threads_origin ON threads(review_id, origin, origin_id) WHERE origin_id IS NOT NULL;

  CREATE TABLE comments(
    id INTEGER PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES comments(id),
    role TEXT NOT NULL CHECK(role IN ('reviewer','agent')),
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    intent TEXT CHECK(intent IN ('fixed','answered','disagree','question')),
    snapshot TEXT REFERENCES snapshots(sha),
    version_id INTEGER REFERENCES versions(id),
    submission_id INTEGER REFERENCES submissions(id),
    published_seq INTEGER,
    origin TEXT NOT NULL DEFAULT 'stet',
    origin_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE INDEX comments_thread ON comments(thread_id);

  CREATE TABLE events(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    role TEXT NOT NULL,
    thread_id INTEGER,
    comment_id INTEGER,
    version_id INTEGER,
    submission_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX events_review ON events(review_id, seq);

  CREATE TABLE reads(
    reader TEXT NOT NULL,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    seen_seq INTEGER NOT NULL,
    PRIMARY KEY(reader, thread_id)
  );

  CREATE TABLE anchor_cache(key TEXT PRIMARY KEY, result TEXT NOT NULL);
  `,
  `
  ALTER TABLE reviews ADD COLUMN source TEXT NOT NULL DEFAULT 'worktree' CHECK(source IN ('worktree','index'));
  `,
  `
  CREATE TABLE cursors(
    review_id INTEGER NOT NULL REFERENCES reviews(id),
    reader TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(review_id, reader, key)
  );

  CREATE TABLE viewed(
    review_id INTEGER NOT NULL REFERENCES reviews(id),
    reader TEXT NOT NULL,
    file_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(review_id, reader, file_key)
  );
  `,
  `
  ALTER TABLE threads ADD COLUMN region TEXT;

  CREATE TABLE shots(
    thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
    full BLOB NOT NULL,
    crop BLOB,
    created_at TEXT NOT NULL
  );
  `,
  `
  DROP INDEX threads_origin;
  ALTER TABLE threads DROP COLUMN origin;
  ALTER TABLE threads DROP COLUMN origin_id;
  ALTER TABLE comments DROP COLUMN origin;
  ALTER TABLE comments DROP COLUMN origin_id;
  `,
  `
  ALTER TABLE submissions ADD COLUMN verdict TEXT NOT NULL DEFAULT 'changes' CHECK(verdict IN ('changes','approved'));
  `,
];
