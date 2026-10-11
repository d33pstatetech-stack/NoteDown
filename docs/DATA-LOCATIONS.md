# Where your data lives, and how to back it up

## Desktop (Tauri)

| OS | Application directory | Database | Attachments |
|---|---|---|---|
| Linux | `~/.local/share/com.notedown.app/` (`$XDG_DATA_HOME`) | `notes.sqlite3` | `attachments/<attachment-id>.<ext>` |
| Windows | `%APPDATA%\com.notedown.app\` | `notes.sqlite3` | `attachments\<attachment-id>.<ext>` |
| macOS | `~/Library/Application Support/com.notedown.app/` | `notes.sqlite3` | `attachments/<attachment-id>.<ext>` |

Files inside the application directory:

* `notes.sqlite3` — nodes (notebooks, folders, notes), attachment metadata, the
  local change queue, tombstones, sync checkpoint.
* `notes.sqlite3-wal`, `notes.sqlite3-shm` — SQLite write-ahead log; copy them
  together with the database, or use SQLite's backup API / `VACUUM INTO`.
* `attachments/` — image bytes, named by stable attachment UUID.

SQLite runs with `journal_mode = WAL`, `foreign_keys = ON`, `synchronous = NORMAL`
and `busy_timeout = 5000`. Migrations are explicit and versioned in
`crates/notes-store/src/migrations.rs` and applied on startup; the applied
version is stored in the `schema_migrations` table.

**Backup:** quit the app, then copy the whole `com.notedown.app` directory.
For a live backup use `sqlite3 notes.sqlite3 "VACUUM INTO 'backup.sqlite3'"`.
Restoring is copying the directory back. The in-app **Export** (ZIP) is the
recommended portable backup because it is Markdown and does not depend on
SQLite at all.

## Browser (web app)

Everything lives in IndexedDB under the origin you loaded the app from
(`localnotes` database, stores `nodes`, `attachments`, `queue`, `meta`).

* **IndexedDB is not a guaranteed filesystem.** Storage may be evicted under
  pressure, is cleared by "clear site data"/private browsing, and is not restored
  by uninstalling the browser.
* The app requests persistent storage (`navigator.storage.persist()`), reports
  the result in **Settings → Storage**, and shows a persistent warning when the
  origin is *best-effort* rather than *persistent*.
* Per-origin allowance, eviction policy and "persistent" behaviour differ by
  browser and are not documented here because they change; the in-app status
  panel reads the real values from `navigator.storage.estimate()`.
* **Export regularly.** Export→ZIP is the only browser backup that survives
  clearing site data, and it is the same format the desktop app reads.

## Account separation

Local data is keyed to an account only after you explicitly link it
(**Link account** or **Import**). The app never attaches an existing local
database to a different signed-in account silently; see `docs/SECURITY.md`.
