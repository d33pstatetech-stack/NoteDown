use std::fmt;

/// Errors surfaced across the Tauri command boundary. `Display` is what the
/// TypeScript `TauriBackend` turns into a `StorageError`, so the messages are
/// written for a user to read.
#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    Json(serde_json::Error),
    Invalid(String),
    /// Data-integrity failure: the bytes do not match their claimed digest.
    Integrity(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Sqlite(error) => write!(f, "database error: {error}"),
            StoreError::Io(error) => write!(f, "file error: {error}"),
            StoreError::Json(error) => write!(f, "invalid JSON payload: {error}"),
            StoreError::Invalid(message) => write!(f, "{message}"),
            StoreError::Integrity(message) => write!(f, "integrity check failed: {message}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Sqlite(error)
    }
}

impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        StoreError::Io(error)
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        StoreError::Json(error)
    }
}

impl From<StoreError> for String {
    fn from(error: StoreError) -> Self {
        error.to_string()
    }
}
