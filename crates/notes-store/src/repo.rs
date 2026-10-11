use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::error::{Result, StoreError};
use crate::model::{AttachmentMeta, MetaEntry, Node, QueuedOp, StoreInfo};
use crate::schema;

/// Matches `LIMITS.attachmentBytes` in `packages/shared/src/validate.ts`.
pub const MAX_ATTACHMENT_BYTES: usize = 5 * 1024 * 1024;

/// UTC ISO-8601 with milliseconds, without a date-formatting dependency.
pub fn now_iso() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format_iso(seconds)
}

/// Days-from-civil (Howard Hinnant) inverted, so no chrono/time dependency is
/// needed for the single timestamp format this app stores.
pub fn format_iso(epoch_seconds: u64) -> String {
    let days = (epoch_seconds / 86_400) as i64;
    let seconds_of_day = epoch_seconds % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    let hour = seconds_of_day / 3600;
    let minute = (seconds_of_day % 3600) / 60;
    let second = seconds_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

/// True when a value is safe to embed in a filename. Attachment ids and
/// extensions come from the app, but nothing that becomes a path is trusted.
pub fn is_path_safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// The native store: a SQLite database plus an application-managed attachment
/// directory. All policy lives in the shared TypeScript layer; this type only
/// guarantees that whole-row reads and batch writes are correct and atomic.
pub struct NoteStore {
    conn: Connection,
    attachments_dir: PathBuf,
    location: String,
}

impl NoteStore {
    /// Opens (creating if needed) the database and applies pending migrations.
    pub fn open(db_path: impl AsRef<Path>) -> Result<Self> {
        let db_path = db_path.as_ref().to_path_buf();
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let attachments_dir = db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("attachments");
        fs::create_dir_all(&attachments_dir)?;

        let conn = Connection::open(&db_path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_millis(5_000))?;
        schema::apply(&conn)?;

        Ok(Self {
            conn,
            attachments_dir,
            location: db_path.to_string_lossy().to_string(),
        })
    }

    /// Opens an in-memory database; used by the tests.
    pub fn open_in_memory(attachment_dir: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(attachment_dir.as_ref())?;
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        schema::apply(&conn)?;
        Ok(Self {
            conn,
            attachments_dir: attachment_dir.as_ref().to_path_buf(),
            location: "memory".to_string(),
        })
    }

    pub fn schema_version(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0))
    }

    pub fn location(&self) -> &str {
        &self.location
    }

    // ── nodes ────────────────────────────────────────────────────────────

    pub fn read_nodes(&self) -> Result<Vec<Node>> {
        let mut statement = self.conn.prepare(
            "SELECT id, kind, parent_id, title, content, position, content_hash, local_version,
                    base_version, sync_state, created_at, updated_at, deleted_at, conflict_of,
                    conflict_recorded_at
             FROM nodes",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Node {
                id: row.get(0)?,
                kind: row.get(1)?,
                parent_id: row.get(2)?,
                title: row.get(3)?,
                content: row.get(4)?,
                position: row.get(5)?,
                content_hash: row.get(6)?,
                local_version: row.get(7)?,
                base_version: row.get(8)?,
                sync_state: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
                deleted_at: row.get(12)?,
                conflict_of: row.get(13)?,
                conflict_recorded_at: row.get(14)?,
            })
        })?;
        let mut nodes = Vec::new();
        for node in rows {
            nodes.push(node?);
        }
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(nodes)
    }

    /// Applies a batch atomically: either every upsert and delete lands or none
    /// does. Foreign keys are deferred inside the transaction so the order of
    /// rows in the batch cannot matter.
    pub fn write_nodes(&mut self, nodes: &[Node], deleted_ids: &[String]) -> Result<()> {
        for node in nodes {
            node.validate().map_err(StoreError::Invalid)?;
        }

        let tx = self.conn.transaction()?;
        tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
        {
            let mut statement = tx.prepare(
                "INSERT INTO nodes (
                   id, kind, parent_id, title, content, position, content_hash, local_version,
                   base_version, sync_state, created_at, updated_at, deleted_at, conflict_of,
                   conflict_recorded_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                 ON CONFLICT(id) DO UPDATE SET
                   kind = excluded.kind,
                   parent_id = excluded.parent_id,
                   title = excluded.title,
                   content = excluded.content,
                   position = excluded.position,
                   content_hash = excluded.content_hash,
                   local_version = excluded.local_version,
                   base_version = excluded.base_version,
                   sync_state = excluded.sync_state,
                   updated_at = excluded.updated_at,
                   deleted_at = excluded.deleted_at,
                   conflict_of = excluded.conflict_of,
                   conflict_recorded_at = excluded.conflict_recorded_at",
            )?;
            for node in nodes {
                statement.execute(rusqlite::params![
                    node.id,
                    node.kind,
                    node.parent_id,
                    node.title,
                    node.content,
                    node.position,
                    node.content_hash,
                    node.local_version,
                    node.base_version,
                    node.sync_state,
                    node.created_at,
                    node.updated_at,
                    node.deleted_at,
                    node.conflict_of,
                    node.conflict_recorded_at,
                ])?;
            }
        }
        {
            let mut statement = tx.prepare("DELETE FROM nodes WHERE id = ?1")?;
            for id in deleted_ids {
                statement.execute(rusqlite::params![id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ── attachments ──────────────────────────────────────────────────────

    pub fn read_attachments(&self) -> Result<Vec<AttachmentMeta>> {
        let mut statement = self.conn.prepare(
            "SELECT id, note_id, filename, mime, ext, size, sha256, created_at, sync_state,
                    base_version
             FROM attachments",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(AttachmentMeta {
                id: row.get(0)?,
                note_id: row.get(1)?,
                filename: row.get(2)?,
                mime: row.get(3)?,
                ext: row.get(4)?,
                size: row.get(5)?,
                sha256: row.get(6)?,
                created_at: row.get(7)?,
                sync_state: row.get(8)?,
                base_version: row.get(9)?,
            })
        })?;
        let mut metas = Vec::new();
        for meta in rows {
            metas.push(meta?);
        }
        metas.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(metas)
    }

    /// Writes the file first and the row second: after a crash the worst case is
    /// an orphaned byte file, never a row that points at nothing.
    pub fn write_attachment(&mut self, meta: &AttachmentMeta, bytes: &[u8]) -> Result<()> {
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(StoreError::Invalid(format!(
                "attachment exceeds {} bytes",
                MAX_ATTACHMENT_BYTES
            )));
        }
        if !is_path_safe_component(&meta.id) || !is_path_safe_component(&meta.ext) {
            return Err(StoreError::Invalid(
                "attachment id or extension is not a safe filename component".to_string(),
            ));
        }
        let digest = hex(&Sha256::digest(bytes));
        if !meta.sha256.is_empty() && meta.sha256 != digest {
            return Err(StoreError::Integrity(format!(
                "attachment {} claimed {} but hashes to {}",
                meta.id, meta.sha256, digest
            )));
        }

        let relative = format!("attachments/{}.{}", meta.id, meta.ext);
        let absolute = self.attachments_dir.join(format!("{}.{}", meta.id, meta.ext));
        fs::write(&absolute, bytes)?;

        self.conn.execute(
            "INSERT INTO attachments (
               id, note_id, filename, mime, ext, size, sha256, created_at, sync_state,
               base_version, path
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
               note_id = excluded.note_id,
               filename = excluded.filename,
               mime = excluded.mime,
               ext = excluded.ext,
               size = excluded.size,
               sha256 = excluded.sha256,
               sync_state = excluded.sync_state,
               base_version = excluded.base_version,
               path = excluded.path",
            rusqlite::params![
                meta.id,
                meta.note_id,
                meta.filename,
                meta.mime,
                meta.ext,
                bytes.len() as i64,
                digest,
                meta.created_at,
                meta.sync_state,
                meta.base_version,
                relative,
            ],
        )?;
        Ok(())
    }

    pub fn read_attachment_bytes(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let path: Option<String> = self
            .conn
            .query_row(
                "SELECT path FROM attachments WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(relative) = path else {
            return Ok(None);
        };
        let file = self
            .attachments_dir
            .join(relative.trim_start_matches("attachments/"));
        match fs::read(&file) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(StoreError::Io(error)),
        }
    }

    pub fn read_attachment_base64(&self, id: &str) -> Result<Option<String>> {
        Ok(self
            .read_attachment_bytes(id)?
            .map(|bytes| BASE64.encode(bytes)))
    }

    pub fn delete_attachments(&mut self, ids: &[String]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for id in ids {
            let path: Option<String> = tx
                .query_row(
                    "SELECT path FROM attachments WHERE id = ?1",
                    rusqlite::params![id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(relative) = path {
                let file = self
                    .attachments_dir
                    .join(relative.trim_start_matches("attachments/"));
                match fs::remove_file(&file) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(StoreError::Io(error)),
                }
            }
            tx.execute("DELETE FROM attachments WHERE id = ?1", rusqlite::params![id])?;
        }
        tx.commit()?;
        Ok(())
    }

    // ── change queue ─────────────────────────────────────────────────────

    pub fn read_queue(&self) -> Result<Vec<QueuedOp>> {
        let mut statement = self.conn.prepare(
            "SELECT op_id, entity_id, type, base_version, pushed_hashes, attempts, last_error,
                    next_attempt_at, created_at, payload
             FROM sync_queue",
        )?;
        let rows = statement.query_map([], |row| {
            let pushed_hashes: String = row.get(4)?;
            let payload: String = row.get(9)?;
            Ok(QueuedOp {
                op_id: row.get(0)?,
                entity_id: row.get(1)?,
                op_type: row.get(2)?,
                base_version: row.get(3)?,
                pushed_hashes: serde_json::from_str(&pushed_hashes).unwrap_or_default(),
                attempts: row.get(5)?,
                last_error: row.get(6)?,
                next_attempt_at: row.get(7)?,
                created_at: row.get(8)?,
                payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
            })
        })?;
        let mut ops = Vec::new();
        for op in rows {
            ops.push(op?);
        }
        // FIFO, which is what makes per-entity coalescing order-stable.
        ops.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.op_id.cmp(&b.op_id)));
        Ok(ops)
    }

    pub fn write_ops(&mut self, ops: &[QueuedOp], acked_op_ids: &[String]) -> Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut statement = tx.prepare(
                "INSERT INTO sync_queue (
                   op_id, entity_id, type, base_version, pushed_hashes, attempts, last_error,
                   next_attempt_at, created_at, payload
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(op_id) DO UPDATE SET
                   base_version = excluded.base_version,
                   pushed_hashes = excluded.pushed_hashes,
                   attempts = excluded.attempts,
                   last_error = excluded.last_error,
                   next_attempt_at = excluded.next_attempt_at,
                   payload = excluded.payload",
            )?;
            for op in ops {
                statement.execute(rusqlite::params![
                    op.op_id,
                    op.entity_id,
                    op.op_type,
                    op.base_version,
                    serde_json::to_string(&op.pushed_hashes)?,
                    op.attempts,
                    op.last_error,
                    op.next_attempt_at,
                    op.created_at,
                    serde_json::to_string(&op.payload)?,
                ])?;
            }
        }
        {
            let mut statement = tx.prepare("DELETE FROM sync_queue WHERE op_id = ?1")?;
            for op_id in acked_op_ids {
                statement.execute(rusqlite::params![op_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ── metadata ─────────────────────────────────────────────────────────

    pub fn read_meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn write_meta(&mut self, entries: &[MetaEntry]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for entry in entries {
            match &entry.value {
                Some(value) => {
                    tx.execute(
                        "INSERT INTO meta (key, value) VALUES (?1, ?2)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        rusqlite::params![entry.key, value],
                    )?;
                }
                None => {
                    tx.execute("DELETE FROM meta WHERE key = ?1", rusqlite::params![entry.key])?;
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn clear(&mut self) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM sync_queue", [])?;
        tx.execute("DELETE FROM attachments", [])?;
        tx.execute("DELETE FROM nodes", [])?;
        tx.execute("DELETE FROM meta", [])?;
        tx.commit()?;
        if self.attachments_dir.exists() {
            for entry in fs::read_dir(&self.attachments_dir)? {
                let entry = entry?;
                if entry.path().is_file() {
                    fs::remove_file(entry.path())?;
                }
            }
        }
        Ok(())
    }

    pub fn info(&self) -> Result<StoreInfo> {
        let usage: i64 = self
            .conn
            .query_row("SELECT COALESCE(SUM(size), 0) FROM attachments", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);
        Ok(StoreInfo {
            persistent: Some(true),
            usage_bytes: Some(usage),
            quota_bytes: None,
            location: Some(self.location.clone()),
        })
    }
}

pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
