use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use notes_store::{schema, NoteStore, StoreError};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// A unique, cleaned-up temporary directory per test (no external test deps).
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "notes-store-{label}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        TempDir(path)
    }

    fn store(&self) -> NoteStore {
        NoteStore::open(self.0.join("notes.sqlite3")).expect("open store")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn node(id: &str, kind: &str, parent: Option<&str>, title: &str) -> notes_store::Node {
    notes_store::Node {
        id: id.to_string(),
        kind: kind.to_string(),
        parent_id: parent.map(str::to_string),
        title: title.to_string(),
        content: if kind == "note" { "body".to_string() } else { String::new() },
        position: 0,
        content_hash: format!("hash-{id}"),
        local_version: 1,
        base_version: 0,
        sync_state: "local-only".to_string(),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        updated_at: "2026-01-01T00:00:00.000Z".to_string(),
        deleted_at: None,
        conflict_of: None,
        conflict_recorded_at: None,
    }
}

#[test]
fn applies_every_migration_once_and_records_them() {
    let temp = TempDir::new("migrations");
    let store = temp.store();
    assert_eq!(store.schema_version().unwrap(), schema::SCHEMA_VERSION);

    // The v2 column exists, which proves the upgrade path ran.
    let node = node("n1", "notebook", None, "Work");
    store_round_trip_conflict_of(&temp, node);

    // Reopening does not re-apply migrations.
    let again = temp.store();
    assert_eq!(again.schema_version().unwrap(), schema::SCHEMA_VERSION);
}

fn store_round_trip_conflict_of(temp: &TempDir, node: notes_store::Node) {
    let mut store = temp.store();
    store.write_nodes(&[node], &[]).unwrap();
    let read = store.read_nodes().unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].conflict_of, None);
}

#[test]
fn round_trips_every_node_field() {
    let temp = TempDir::new("nodes");
    let mut store = temp.store();
    let mut note = node("child", "note", Some("nb"), "Note");
    note.content = "# Heading\n\ntext".to_string();
    note.position = 7;
    note.deleted_at = Some("2026-02-01T00:00:00.000Z".to_string());
    note.conflict_of = Some("parent-note".to_string());
    note.conflict_recorded_at = Some("2026-02-01T00:00:00.000Z".to_string());
    note.local_version = 5;
    note.base_version = 4;
    note.sync_state = "deleted".to_string();

    store
        .write_nodes(&[node("nb", "notebook", None, "Work"), note.clone()], &[])
        .unwrap();

    let read = store.read_nodes().unwrap();
    let stored = read.iter().find(|candidate| candidate.id == "child").unwrap();
    assert_eq!(stored, &note);
}

#[test]
fn a_failed_batch_writes_nothing_at_all() {
    let temp = TempDir::new("atomic");
    let mut store = temp.store();

    // The second row violates the `kind` CHECK constraint.
    let good = node("nb", "notebook", None, "Work");
    let mut bad = node("n1", "note", Some("nb"), "Note");
    bad.kind = "bogus".to_string();

    let result = store.write_nodes(&[good, bad], &[]);
    assert!(matches!(result, Err(StoreError::Invalid(_))), "expected Invalid, got {result:?}");
    assert!(store.read_nodes().unwrap().is_empty());
}

#[test]
fn validates_domain_invariants_before_touching_disk() {
    let temp = TempDir::new("validate");
    let mut store = temp.store();

    let orphan = node("orphan", "note", None, "No parent");
    assert!(matches!(
        store.write_nodes(&[orphan], &[]),
        Err(StoreError::Invalid(_))
    ));

    let nested_notebook = node("nested", "notebook", Some("other"), "Nested");
    assert!(matches!(
        store.write_nodes(&[nested_notebook], &[]),
        Err(StoreError::Invalid(_))
    ));

    let folder_with_content = {
        let mut value = node("f", "folder", Some("nb"), "Folder");
        value.content = "not allowed".to_string();
        value
    };
    assert!(matches!(
        store.write_nodes(&[node("nb", "notebook", None, "Work"), folder_with_content], &[]),
        Err(StoreError::Invalid(_))
    ));
    assert!(store.read_nodes().unwrap().is_empty());
}

#[test]
fn foreign_keys_are_enforced_and_deferred_inside_the_batch() {
    let temp = TempDir::new("fk");
    let mut store = temp.store();

    // A dangling parent is rejected...
    let dangling = node("child", "folder", Some("missing"), "Child");
    assert!(store.write_nodes(&[dangling], &[]).is_err());
    assert!(store.read_nodes().unwrap().is_empty());

    // ...but the order of rows inside one batch does not matter, because
    // foreign keys are deferred for the duration of the transaction.
    let child = node("child", "folder", Some("nb"), "Child");
    let parent = node("nb", "notebook", None, "Work");
    store.write_nodes(&[child, parent], &[]).unwrap();
    assert_eq!(store.read_nodes().unwrap().len(), 2);

    // Hard deletes cascade to children.
    store.write_nodes(&[], &["nb".to_string()]).unwrap();
    assert!(store.read_nodes().unwrap().is_empty());
}

#[test]
fn persists_the_change_queue_with_payloads_and_hashes() {
    let temp = TempDir::new("queue");
    let mut store = temp.store();

    let op = notes_store::QueuedOp {
        op_id: "op-1".to_string(),
        entity_id: "note-1".to_string(),
        op_type: "upsert_node".to_string(),
        base_version: 3,
        pushed_hashes: vec!["a".to_string(), "b".to_string()],
        attempts: 2,
        last_error: Some("offline".to_string()),
        next_attempt_at: Some("2026-01-01T00:05:00.000Z".to_string()),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        payload: serde_json::json!({
            "kind": "note",
            "parentId": "nb",
            "title": "Title",
            "content": "text",
            "position": 1,
            "contentHash": "hash",
        }),
    };

    store.write_ops(&[op.clone()], &[]).unwrap();
    let read = store.read_queue().unwrap();
    assert_eq!(read, vec![op.clone()]);

    // Queue changes survive a reopen: pending work is never lost on restart.
    let mut reopened = temp.store();
    assert_eq!(reopened.read_queue().unwrap(), vec![op.clone()]);

    reopened.write_ops(&[], &["op-1".to_string()]).unwrap();
    assert!(reopened.read_queue().unwrap().is_empty());
}

#[test]
fn writes_metadata_and_removes_it_on_null() {
    let temp = TempDir::new("meta");
    let mut store = temp.store();
    store
        .write_meta(&[
            notes_store::MetaEntry {
                key: "sync.checkpoint".to_string(),
                value: Some("42:user_1".to_string()),
            },
            notes_store::MetaEntry {
                key: "account.localOwnerId".to_string(),
                value: Some("user_1".to_string()),
            },
        ])
        .unwrap();
    assert_eq!(
        store.read_meta("sync.checkpoint").unwrap().as_deref(),
        Some("42:user_1")
    );

    store
        .write_meta(&[notes_store::MetaEntry {
            key: "account.localOwnerId".to_string(),
            value: None,
        }])
        .unwrap();
    assert_eq!(store.read_meta("account.localOwnerId").unwrap(), None);
    assert_eq!(store.read_meta("missing").unwrap(), None);
}

fn sample_attachment(bytes: &[u8]) -> notes_store::AttachmentMeta {
    notes_store::AttachmentMeta {
        id: "6f1c1f9a-4a2b-4d31-9c8e-0a1b2c3d4e5f".to_string(),
        note_id: None,
        filename: "diagram.png".to_string(),
        mime: "image/png".to_string(),
        ext: "png".to_string(),
        size: bytes.len() as i64,
        sha256: notes_store::repo::hex(&<sha2::Sha256 as sha2::Digest>::digest(bytes)),
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        sync_state: "local-only".to_string(),
        base_version: 0,
    }
}

#[test]
fn stores_attachment_bytes_on_disk_and_reads_them_back() {
    let temp = TempDir::new("attachments");
    let mut store = temp.store();
    let bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
    let meta = sample_attachment(&bytes);

    store.write_attachment(&meta, &bytes).unwrap();
    let on_disk = temp
        .0
        .join("attachments")
        .join(format!("{}.png", meta.id));
    assert!(on_disk.exists(), "bytes should live in the app-managed directory");

    assert_eq!(store.read_attachment_bytes(&meta.id).unwrap(), Some(bytes.clone()));
    let encoded = store.read_attachment_base64(&meta.id).unwrap().unwrap();
    assert_eq!(
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded).unwrap(),
        bytes
    );

    let metas = store.read_attachments().unwrap();
    assert_eq!(metas.len(), 1);
    assert_eq!(metas[0].id, meta.id);
    assert_eq!(store.info().unwrap().usage_bytes, Some(bytes.len() as i64));

    store.delete_attachments(&[meta.id.to_string()]).unwrap();
    assert!(!on_disk.exists());
    assert_eq!(store.read_attachment_bytes(&meta.id).unwrap(), None);
    assert!(store.read_attachments().unwrap().is_empty());
}

#[test]
fn refuses_attachments_that_are_tampered_with_or_misnamed() {
    let temp = TempDir::new("attachment-integrity");
    let mut store = temp.store();
    let bytes = vec![0x89, 0x50, 0x4e, 0x47];

    // Declared digest does not match the bytes: refuse rather than store.
    let mut lying = sample_attachment(&bytes);
    lying.sha256 = "0".repeat(64);
    assert!(matches!(
        store.write_attachment(&lying, &bytes),
        Err(StoreError::Integrity(_))
    ));
    assert!(store.read_attachments().unwrap().is_empty());

    // An id that could escape the attachments directory is refused outright.
    let mut traversal = sample_attachment(&bytes);
    traversal.id = "../escape".to_string();
    assert!(matches!(
        store.write_attachment(&traversal, &bytes),
        Err(StoreError::Invalid(_))
    ));

    let mut bad_ext = sample_attachment(&bytes);
    bad_ext.ext = "../../etc/passwd".to_string();
    assert!(matches!(
        store.write_attachment(&bad_ext, &bytes),
        Err(StoreError::Invalid(_))
    ));

    // Oversized attachments are refused before any bytes are written.
    let mut big = sample_attachment(&bytes);
    big.sha256 = String::new();
    let oversized = vec![0u8; notes_store::repo::MAX_ATTACHMENT_BYTES + 1];
    assert!(matches!(
        store.write_attachment(&big, &oversized),
        Err(StoreError::Invalid(_))
    ));
}

#[test]
fn clears_every_table_and_the_attachment_directory() {
    let temp = TempDir::new("clear");
    let mut store = temp.store();
    let bytes = vec![1, 2, 3];
    let meta = sample_attachment(&bytes);
    store.write_nodes(&[node("nb", "notebook", None, "Work")], &[]).unwrap();
    store.write_attachment(&meta, &bytes).unwrap();
    store
        .write_meta(&[notes_store::MetaEntry {
            key: "k".to_string(),
            value: Some("v".to_string()),
        }])
        .unwrap();

    store.clear().unwrap();
    assert!(store.read_nodes().unwrap().is_empty());
    assert!(store.read_attachments().unwrap().is_empty());
    assert_eq!(store.read_meta("k").unwrap(), None);
    let leftover = std::fs::read_dir(temp.0.join("attachments")).unwrap().count();
    assert_eq!(leftover, 0);
}

#[test]
fn reports_its_location_and_persists_across_reopen() {
    let temp = TempDir::new("persistence");
    {
        let mut store = temp.store();
        store
            .write_nodes(&[node("nb", "notebook", None, "Work")], &[])
            .unwrap();
    }
    let store = temp.store();
    assert_eq!(store.read_nodes().unwrap().len(), 1);
    assert!(store.location().ends_with("notes.sqlite3"));
    assert_eq!(store.info().unwrap().persistent, Some(true));
}
