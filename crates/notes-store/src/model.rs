use serde::{Deserialize, Serialize};

/// A notebook, folder or note. Mirrors `packages/shared/src/types.ts`
/// field-for-field, because the same JSON crosses the IPC boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub kind: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub content: String,
    pub position: i64,
    pub content_hash: String,
    pub local_version: i64,
    pub base_version: i64,
    pub sync_state: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub conflict_of: Option<String>,
    pub conflict_recorded_at: Option<String>,
}

impl Node {
    /// Validates the invariants the desktop core can check on its own. The full
    /// rule set (parent kinds, cycles) lives in the shared TypeScript domain
    /// layer; this is the last line of defence before bytes hit the disk.
    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.kind.as_str(), "notebook" | "folder" | "note") {
            return Err(format!("unknown node kind: {}", self.kind));
        }
        if self.kind != "notebook" && self.parent_id.is_none() {
            return Err(format!("a {} must have a parent", self.kind));
        }
        if self.kind == "notebook" && self.parent_id.is_some() {
            return Err("a notebook must be a top-level item".to_string());
        }
        if self.kind != "note" && !self.content.is_empty() {
            return Err(format!("a {} cannot hold Markdown content", self.kind));
        }
        if self.id.trim().is_empty() || self.title.trim().is_empty() {
            return Err("nodes need a stable id and a title".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentMeta {
    pub id: String,
    pub note_id: Option<String>,
    pub filename: String,
    pub mime: String,
    pub ext: String,
    pub size: i64,
    pub sha256: String,
    pub created_at: String,
    pub sync_state: String,
    pub base_version: i64,
}

/// A queued local change. `payload` stays an opaque JSON value here: the shape
/// is owned by the shared TypeScript layer, and the native side only stores and
/// returns it so the two cannot drift.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedOp {
    pub op_id: String,
    pub entity_id: String,
    #[serde(rename = "type")]
    pub op_type: String,
    pub base_version: i64,
    #[serde(default)]
    pub pushed_hashes: Vec<String>,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub next_attempt_at: Option<String>,
    pub created_at: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaEntry {
    pub key: String,
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInfo {
    /// SQLite on a real filesystem is durable; the flag mirrors the browser
    /// adapter's shape so the UI can render both without special cases.
    pub persistent: Option<bool>,
    pub usage_bytes: Option<i64>,
    pub quota_bytes: Option<i64>,
    pub location: Option<String>,
}
