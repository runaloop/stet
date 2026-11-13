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
  `
  CREATE TABLE restores(
    comment_id INTEGER PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
    version_id INTEGER REFERENCES versions(id),
    path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL CHECK(end_line >= start_line),
    text TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE guides(
    version_id INTEGER PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,
    title TEXT,
    intro TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE guide_steps(
    version_id INTEGER NOT NULL REFERENCES guides(version_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK(position >= 1),
    text TEXT NOT NULL,
    PRIMARY KEY(version_id, position)
  );

  CREATE TABLE guide_refs(
    version_id INTEGER NOT NULL,
    step INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 1),
    path TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    PRIMARY KEY(version_id, step, position),
    FOREIGN KEY(version_id, step) REFERENCES guide_steps(version_id, position) ON DELETE CASCADE,
    CHECK((start_line IS NULL) = (end_line IS NULL)),
    CHECK(start_line IS NULL OR (start_line >= 1 AND end_line >= start_line))
  );
  `,
  `
  ALTER TABLE submissions ADD COLUMN guide INTEGER NOT NULL DEFAULT 0 CHECK(guide IN (0,1));
  `,
  `
  CREATE TABLE threads_go(
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
    resolve_reason TEXT CHECK(resolve_reason IN ('fixed','wontfix','answered','go')),
    resolved_by TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    region TEXT
  );
  INSERT INTO threads_go(id, review_id, path, side, start_line, end_line, anchor_sha, anchor_lines, ctx_before, ctx_after,
      version_id, status, resolve_reason, resolved_by, resolved_at, created_at, region)
    SELECT id, review_id, path, side, start_line, end_line, anchor_sha, anchor_lines, ctx_before, ctx_after,
      version_id, status, resolve_reason, resolved_by, resolved_at, created_at, region FROM threads;
  DROP TABLE threads;
  ALTER TABLE threads_go RENAME TO threads;
  CREATE INDEX threads_review ON threads(review_id);

  ALTER TABLE comments ADD COLUMN resolves INTEGER NOT NULL DEFAULT 0 CHECK(resolves IN (0,1));
  `,
  // Counters the server streams to open pages as `event: store`, bumped by triggers so that every writer counts,
  // older builds included. Settings in meta belong to the repository, not a review: they count under review 0.
  // A migration that rebuilds one of these tables drops its triggers and must create them again.
  `
  CREATE TABLE changes(
    review_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY(review_id, kind)
  );

  CREATE TRIGGER reads_changes_insert AFTER INSERT ON reads BEGIN
    INSERT INTO changes(review_id, kind, n) SELECT review_id, 'reads', 1 FROM threads WHERE id = NEW.thread_id
      ON CONFLICT(review_id, kind) DO UPDATE SET n = n + 1;
  END;
  CREATE TRIGGER reads_changes_update AFTER UPDATE ON reads WHEN NEW.seen_seq IS NOT OLD.seen_seq BEGIN
    INSERT INTO changes(review_id, kind, n) SELECT review_id, 'reads', 1 FROM threads WHERE id = NEW.thread_id
      ON CONFLICT(review_id, kind) DO UPDATE SET n = n + 1;
  END;
  CREATE TRIGGER reads_changes_delete AFTER DELETE ON reads BEGIN
    INSERT INTO changes(review_id, kind, n) SELECT review_id, 'reads', 1 FROM threads WHERE id = OLD.thread_id
      ON CONFLICT(review_id, kind) DO UPDATE SET n = n + 1;
  END;

  CREATE TRIGGER viewed_changes_insert AFTER INSERT ON viewed BEGIN
    INSERT INTO changes(review_id, kind, n) VALUES (NEW.review_id, 'viewed', 1) ON CONFLICT(review_id, kind) DO UPDATE SET n = n + 1;
  END;
  CREATE TRIGGER viewed_changes_update AFTER UPDATE ON viewed BEGIN
    INSERT INTO changes(review_id, kind, n) VALUES (NEW.review_id, 'viewed', 1) ON CONFLICT(review_id, kind) DO UPDATE SET n = n + 1;
  END;
  CREATE TRIGGER viewed_changes_delete AFTER DELETE ON viewed BEGIN
    INSERT INTO changes(review_id, kind, n) VALUES (OLD.review_id, 'viewed', 1) ON CONFLICT(review_id, kind) DO UPDATE SET n = n + 1;
  END;

  CREATE TRIGGER cursors_changes_insert AFTER INSERT ON cursors BEGIN
    INSERT INTO changes(review_id, kind, n) VALUES (NEW.review_id, 'cursors', 1) ON CONFLICT(review_id, kind) DO UPDATE SET n = n + 1;
  END;
  CREATE TRIGGER cursors_changes_update AFTER UPDATE ON cursors WHEN NEW.value IS NOT OLD.value BEGIN
    INSERT INTO changes(review_id, kind, n) VALUES (NEW.review_id, 'cursors', 1) ON CONFLICT(review_id, kind) DO UPDATE SET n = n + 1;
  END;
  CREATE TRIGGER cursors_changes_delete AFTER DELETE ON cursors BEGIN
    INSERT INTO changes(review_id, kind, n) VALUES (OLD.review_id, 'cursors', 1) ON CONFLICT(review_id, kind) DO UPDATE SET n = n + 1;
  END;

  CREATE TRIGGER meta_changes_insert AFTER INSERT ON meta BEGIN
    INSERT INTO changes(review_id, kind, n) VALUES (0, 'config', 1) ON CONFLICT(review_id, kind) DO UPDATE SET n = n + 1;
  END;
  CREATE TRIGGER meta_changes_update AFTER UPDATE ON meta WHEN NEW.value IS NOT OLD.value BEGIN
    INSERT INTO changes(review_id, kind, n) VALUES (0, 'config', 1) ON CONFLICT(review_id, kind) DO UPDATE SET n = n + 1;
  END;
  CREATE TRIGGER meta_changes_delete AFTER DELETE ON meta BEGIN
    INSERT INTO changes(review_id, kind, n) VALUES (0, 'config', 1) ON CONFLICT(review_id, kind) DO UPDATE SET n = n + 1;
  END;
  `,
  `
  CREATE TABLE publication_state(
    review_id INTEGER PRIMARY KEY REFERENCES reviews(id),
    revision INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1))
  );
  INSERT INTO publication_state(review_id) SELECT id FROM reviews;
  CREATE TRIGGER publication_review_insert AFTER INSERT ON reviews BEGIN
    INSERT INTO publication_state(review_id) VALUES (NEW.id);
  END;
  CREATE TRIGGER publication_review_update AFTER UPDATE ON reviews
    WHEN NEW.state IS NOT OLD.state OR NEW.branch IS NOT OLD.branch OR NEW.source IS NOT OLD.source
      OR NEW.base_ref IS NOT OLD.base_ref OR NEW.worktree_hint IS NOT OLD.worktree_hint BEGIN
    UPDATE publication_state SET revision = revision + 1 WHERE review_id = NEW.id;
  END;
  CREATE TRIGGER publication_review_event AFTER INSERT ON events
    WHEN NEW.type = 'version.created' OR NEW.type IN ('thread.reopened', 'thread.resolved')
      OR (NEW.role = 'reviewer' AND NEW.type IN ('comment.published', 'review.submitted')) BEGIN
    UPDATE publication_state SET revision = revision + 1 WHERE review_id = NEW.review_id;
  END;

  CREATE TABLE publication_plans(
    id TEXT PRIMARY KEY,
    review_id INTEGER NOT NULL REFERENCES reviews(id),
    version_id INTEGER NOT NULL REFERENCES versions(id),
    digest TEXT NOT NULL UNIQUE,
    document TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX publication_plans_review ON publication_plans(review_id, created_at);
  CREATE TRIGGER publication_plan_insert AFTER INSERT ON publication_plans BEGIN
    UPDATE publication_state SET revision = revision + 1 WHERE review_id = NEW.review_id;
  END;
  CREATE TABLE publication_grants(
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES publication_plans(id),
    document TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX publication_grants_plan ON publication_grants(plan_id);
  CREATE TABLE publication_executions(
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL UNIQUE REFERENCES publication_plans(id),
    grant_id TEXT NOT NULL REFERENCES publication_grants(id),
    state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','confirmed','blocked','failed','outcome_unknown')),
    result_commit TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    detail TEXT
  );
  `,
];
