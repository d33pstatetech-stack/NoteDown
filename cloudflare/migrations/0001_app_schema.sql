-- Local-First Markdown Notes — D1 application schema (v1)
--
-- D1 holds structured metadata and the sync change feed. Markdown bodies live
-- here as well as in R2 (see cloudflare/README.md for the rationale): D1 is the
-- single source for an incremental change feed, and R2 keeps a durable,
-- exportable object at the stable key users/<uid>/notes/<note-id>.md.
--
-- Every table is scoped by `user_id`, and every query in the Worker binds it
-- from the *verified session* — never from the request body.
--
-- Authentication tables (user, session, account, verification) are NOT defined
-- here: Better Auth owns them and generates them. See cloudflare/README.md for
-- the migration flow, which cannot use the Better Auth CLI against D1.

CREATE TABLE IF NOT EXISTS nodes (
  user_id        TEXT    NOT NULL,
  id             TEXT    NOT NULL,
  kind           TEXT    NOT NULL CHECK (kind IN ('notebook', 'folder', 'note')),
  parent_id      TEXT,
  title          TEXT    NOT NULL,
  content        TEXT    NOT NULL DEFAULT '',
  position       INTEGER NOT NULL DEFAULT 0,
  content_hash   TEXT    NOT NULL DEFAULT '',
  -- Per-user monotonic version, assigned by the server on every accepted write.
  server_version INTEGER NOT NULL,
  deleted_at     TEXT,
  conflict_of    TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  PRIMARY KEY (user_id, id),
  -- A composite self-reference makes it impossible to parent a node under
  -- another account's node. Parent-first ordering inside a batch is handled with
  -- PRAGMA defer_foreign_keys in the Worker.
  FOREIGN KEY (user_id, parent_id) REFERENCES nodes (user_id, id) ON DELETE CASCADE,
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_user_version ON nodes (user_id, server_version);
-- Supports the tombstone reaper without a full scan.
CREATE INDEX IF NOT EXISTS idx_nodes_user_deleted ON nodes (user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_nodes_user_parent ON nodes (user_id, parent_id);

-- One row per user: the monotonic counter behind `serverVersion` and checkpoints.
CREATE TABLE IF NOT EXISTS user_versions (
  user_id TEXT    PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);

-- Idempotency ledger: an `opId` is stored with its outcome, so a retried push
-- can never apply twice.
CREATE TABLE IF NOT EXISTS sync_ops (
  user_id    TEXT NOT NULL,
  op_id      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('applied', 'conflict', 'rejected')),
  entity_id  TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (user_id, op_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_ops_entity ON sync_ops (user_id, entity_id);

-- Attachment metadata. Bytes live in R2; `status = 'staging'` until the object
-- has been verified and committed, so a half-uploaded image is never visible to
-- another device.
CREATE TABLE IF NOT EXISTS attachments (
  user_id            TEXT    NOT NULL,
  id                 TEXT    NOT NULL,
  note_id            TEXT,
  filename           TEXT    NOT NULL,
  mime               TEXT    NOT NULL,
  ext                TEXT    NOT NULL,
  size               INTEGER NOT NULL,
  sha256             TEXT    NOT NULL,
  status             TEXT    NOT NULL CHECK (status IN ('staging', 'ready')),
  staging_id         TEXT,
  staging_expires_at TEXT,
  server_version     INTEGER NOT NULL,
  created_at         TEXT    NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, note_id) REFERENCES nodes (user_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_user_version ON attachments (user_id, server_version);
CREATE INDEX IF NOT EXISTS idx_attachments_staging ON attachments (status, staging_expires_at);
