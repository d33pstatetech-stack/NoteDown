//! Headless driver for the desktop SQLite core.
//!
//! The end-to-end tests need to exercise the *real* storage implementation that
//! ships in the desktop app — the Rust crate with its migrations, transactions
//! and on-disk attachment handling — without opening a window or depending on
//! Tauri itself. This binary speaks the same command protocol as the Tauri
//! adapter (`store_init`, `store_read_nodes`, …) over stdin/stdout, so
//! `TauriBackend` is used completely unmodified in the tests.
//!
//! It intentionally does not depend on `tauri`: keeping Tauri out of this crate
//! is what makes the tests meaningful, since they then cover the storage core
//! rather than the IPC wrapper.


use std::io::{BufRead, Write};

use notes_store::{AttachmentMeta, MetaEntry, NoteStore, Node, QueuedOp};

fn main() {
    // One long-lived process serving line-delimited JSON requests:
    //   {"command":"store_read_nodes","params":{...}}
    //   -> {"ok":true,"value":...} / {"ok":false,"error":"..."}
    // Spawning a process per call was unreliable on Windows (stdin teardown)
    // and made the suite slow, since every read/write would pay process cost.
    let mut stores: std::collections::HashMap<String, NoteStore> = std::collections::HashMap::new();

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(error) => {
                respond(Err(format!("invalid request: {error}")));
                continue;
            }
        };
        let command = request.get("command").and_then(|value| value.as_str()).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or_else(|| serde_json::json!({}));
        let dir = request.get("dir").and_then(|value| value.as_str()).unwrap_or("");
        let reply = handle(&mut stores, dir, command, &params);
        respond(reply);
    }
}

/// Opens the store for `dir` once and reuses it for every later request, so a
/// test can read and write the same open database rather than reopening it.
fn open_store<'a>(
    stores: &'a mut std::collections::HashMap<String, NoteStore>,
    dir: &str,
) -> Result<&'a mut NoteStore, String> {
    if !stores.contains_key(dir) {
        let directory = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("could not create {dir}: {error}"))?;
        let store = NoteStore::open(directory.join("notes.sqlite3"))
            .map_err(|error| error.to_string())?;
        stores.insert(dir.to_string(), store);
    }
    Ok(stores.get_mut(dir).expect("store was just inserted"))
}

fn handle(
    stores: &mut std::collections::HashMap<String, NoteStore>,
    dir: &str,
    command: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let store = match open_store(stores, dir) {
        Ok(store) => store,
        Err(error) => return Err(error),
    };
    match command {
        "store_init" => store.schema_version().map(json).map_err(text),
        "store_read_nodes" => store.read_nodes().map(json).map_err(text),
        "store_write_nodes" => store
            .write_nodes(&take::<Node>(params, "nodes"), &take::<String>(params, "deletedIds"))
            .map(|_| json(()))
            .map_err(text),
        "store_read_attachments" => store.read_attachments().map(json).map_err(text),
        "store_write_attachment" => {
            let meta: AttachmentMeta = parse(params, "meta");
            let bytes = decode_base64(&require_str(params, "bytesBase64"));
            store.write_attachment(&meta, &bytes).map(|_| json(())).map_err(text)
        }
        "store_read_attachment_bytes" | "store_read_attachment_base64" => {
            let id = require_str(params, "id");
            store.read_attachment_base64(&id).map(json).map_err(text)
        }
        "store_delete_attachments" => store
            .delete_attachments(&take::<String>(params, "ids"))
            .map(|_| json(()))
            .map_err(text),
        "store_read_queue" => store.read_queue().map(json).map_err(text),
        "store_write_ops" => store
            .write_ops(&take::<QueuedOp>(params, "ops"), &take::<String>(params, "ackedOpIds"))
            .map(|_| json(()))
            .map_err(text),
        "store_read_meta" => {
            let key = require_str(params, "key");
            store.read_meta(&key).map(json).map_err(text)
        }
        "store_write_meta" => store
            .write_meta(&take::<MetaEntry>(params, "entries"))
            .map(|_| json(()))
            .map_err(text),
        "store_clear" => store.clear().map(|_| json(())).map_err(text),
        "store_info" => store.info().map(json).map_err(text),
        other => Err(format!("unknown command: {other}")),
    }
}

/// Writes one JSON line and flushes it, so the client sees the reply immediately.
fn respond(reply: Result<serde_json::Value, String>) {
    let payload = match reply {
        Ok(value) => serde_json::json!({ "ok": true, "value": value }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    };
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{payload}");
    let _ = stdout.flush();
}

/// Aborts the process on a malformed test-side argument. Reaching this means
/// the harness sent something the storage core could never have received, so
/// there is no useful response to send back.
fn fail(message: &str) -> ! {
    println!("{}", serde_json::json!({ "ok": false, "error": message }));
    std::process::exit(2)
}

/// Serialises a successful value; the type only needs `Serialize`.
fn json<T: serde::Serialize>(value: T) -> serde_json::Value {
    serde_json::to_value(value).unwrap_or_else(|error| fail(&format!("could not serialise: {error}")))
}

fn text(error: notes_store::StoreError) -> String {
    error.to_string()
}

/// Reads a required string argument.
fn require_str(params: &serde_json::Value, key: &str) -> String {
    match params.get(key) {
        Some(serde_json::Value::String(value)) => value.clone(),
        Some(_) => fail(&format!("argument {key} must be a string")),
        None => fail(&format!("missing argument: {key}")),
    }
}

/// Reads one JSON argument, failing loudly if it is absent or the wrong shape.
fn parse<T: serde::de::DeserializeOwned>(params: &serde_json::Value, key: &str) -> T {
    let raw = require(params, key);
    serde_json::from_value(raw).unwrap_or_else(|error| fail(&format!("invalid {key}: {error}")))
}

fn require(params: &serde_json::Value, key: &str) -> serde_json::Value {
    params
        .get(key)
        .cloned()
        .unwrap_or_else(|| fail(&format!("missing argument: {key}")))
}

/// Reads an array argument. A missing key means "nothing to write", which is
/// what the commands pass when they are clearing rows rather than updating them.
fn take<T: serde::de::DeserializeOwned>(params: &serde_json::Value, key: &str) -> Vec<T> {
    match params.get(key) {
        Some(value) => serde_json::from_value(value.clone())
            .unwrap_or_else(|error| fail(&format!("invalid {key}: {error}"))),
        None => Vec::new(),
    }
}

/// Standard base64 decode. Hand-rolled rather than pulled in as a dependency
/// because this binary is a test helper; the production app has its own copy.
fn decode_base64(input: &str) -> Vec<u8> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (index, byte) in TABLE.iter().enumerate() {
        lookup[*byte as usize] = index as u8;
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in input.bytes() {
        if byte == b'=' || byte.is_ascii_whitespace() {
            continue;
        }
        let value = lookup[byte as usize];
        if value == 255 {
            continue;
        }
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}