use crate::error::Result;
use rusqlite::Connection;

/// Versioned, explicit migrations. Each entry runs exactly once inside a
/// transaction, and the applied version is recorded in `schema_migrations`, so
/// an upgrade is repeatable and inspectable.
///
/// The desktop core is the source of truth for its own schema; it does **not**
/// assume the D1 schema in `cloudflare/migrations` is identical (D1 has no
/// long-lived transactions and different constraints).
pub const MIGRATIONS: &[&str] = &[
    // v1 — nodes, attachment metadata, the durable change queue and metadata.
    r#"
    CREATE TABLE nodes (
      id                  TEXT PRIMARY KEY,
      kind                TEXT NOT NULL CHECK (kind IN ('notebook','folder','note')),
      parent_id           TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      title               TEXT NOT NULL,
      content             TEXT NOT NULL DEFAULT '',
      position            INTEGER NOT NULL DEFAULT 0,
      content_hash        TEXT NOT NULL,
      local_version       INTEGER NOT NULL DEFAULT 1,
      base_version        INTEGER NOT NULL DEFAULT 0,
      sync_state          TEXT NOT NULL DEFAULT 'local-only',
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      deleted_at          TEXT,
      conflict_recorded_at TEXT
    );
    CREATE INDEX idx_nodes_parent ON nodes(parent_id);
    CREATE INDEX idx_nodes_kind ON nodes(kind);
    CREATE INDEX idx_nodes_updated ON nodes(updated_at);

    CREATE TABLE attachments (
      id           TEXT PRIMARY KEY,
      note_id      TEXT REFERENCES nodes(id) ON DELETE SET NULL,
      filename     TEXT NOT NULL,
      mime         TEXT NOT NULL,
      ext          TEXT NOT NULL,
      size         INTEGER NOT NULL,
      sha256       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      sync_state   TEXT NOT NULL DEFAULT 'local-only',
      base_version INTEGER NOT NULL DEFAULT 0,
      path         TEXT NOT NULL
    );
    CREATE INDEX idx_attachments_note ON attachments(note_id);

    CREATE TABLE sync_queue (
      op_id           TEXT PRIMARY KEY,
      entity_id       TEXT NOT NULL,
      type            TEXT NOT NULL,
      base_version    INTEGER NOT NULL DEFAULT 0,
      pushed_hashes   TEXT NOT NULL DEFAULT '[]',
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      next_attempt_at TEXT,
      created_at      TEXT NOT NULL,
      payload         TEXT NOT NULL
    );
    CREATE INDEX idx_queue_entity ON sync_queue(entity_id);

    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    "#,
    // v2 — conflict provenance, so a conflict copy is identifiable after a
    // restart and after it has synced to another device.
    r#"
    ALTER TABLE nodes ADD COLUMN conflict_of TEXT;
    "#,
];

pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

pub fn apply(conn: &Connection) -> Result<i64> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           version    INTEGER PRIMARY KEY,
           applied_at TEXT NOT NULL
         );",
    )?;

    let current: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    for (index, migration) in MIGRATIONS.iter().enumerate() {
        let version = (index + 1) as i64;
        if version <= current {
            continue;
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(migration)?;
        tx.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
            rusqlite::params![version, crate::repo::now_iso()],
        )?;
        tx.commit()?;
    }

    Ok(current.max(SCHEMA_VERSION))
}
