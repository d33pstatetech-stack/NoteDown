# Architecture — Local-First Markdown Notes (Cloudflare Edition)

Status: **Phase 1 (local-only) implemented**. Phases 2–4 are specified in this
document and are not yet built. See `docs/STATUS.md` for exactly what runs today.

## 1. Goals and non-goals

Local-first note taking with a hierarchical notebook/folder/note tree, Markdown
editing with rendered preview, inline images, full ZIP export/import, and
eventual multi-device sync through Cloudflare.

* **Local writes never depend on the network.** A save is complete once it is in
  SQLite (desktop) or IndexedDB (web).
* **Markdown is the canonical interchange format.** Export produces ordinary
  `.md` files readable by any text editor, plus a relative `attachments/` tree.
* **No collaboration, CRDTs, or operational transforms in the MVP.** Divergent
  edits are preserved as conflict copies instead of being merged silently.
* **No Supabase/PocketBase/Firebase and no separately managed server.** The
  hosted backend is Cloudflare Workers + D1 + R2.
* Supabase/PocketBase/Firebase are excluded by request; the only third-party
  backend service is Cloudflare plus the authentication library.

## 2. Runtime topology

```
                    ┌──────────────────────── apps/web (Vite + React) ────────────────┐
                    │  packages/ui  (tree · editor pane · preview · status bar)      │
                    │  packages/editor (CodeMirror 6 + react-markdown)               │
                    │  packages/markdown (portable refs, ZIP export/import)          │
                    │  packages/storage  ──► IndexedDbStore                          │
                    │  packages/sync     ──► SyncEngine ⇄ RemoteSyncClient (HTTP)    │
                    └────────────────────────────────────────────────────────────────┘
                              ▲ identical frontend bundle, two shells
    apps/desktop (Tauri 2) ───┘
      src-tauri/src/commands.rs ──► crates/notes-store (rusqlite, SQLite on disk)
      storage adapter: TauriStore (invoke) — same `Store` interface

                    ┌──────────────────── cloudflare/worker (Phase 2/3) ─────────────┐
                    │  Workers: /api/* authenticated JSON + sync change feed          │
                    │  Better Auth (email+password session, bearer for desktop)     │
                    │  D1: users, nodes, attachments, sync_ops, tombstones           │
                    │  R2: users/<uid>/notes/<note-id>.md, users/<uid>/attachments/…  │
                    └────────────────────────────────────────────────────────────────┘
```

The desktop app bundles the **same** `apps/web` production build
(`frontendDist: "../web/dist"`), so UI and domain logic are literally shared.

## 3. Repository layout

```
apps/
  web/            Vite + React application (the only frontend app; also what desktop bundles)
  desktop/        Tauri 2 shell (src-tauri) around the shared frontend
packages/
  shared/         Domain types, errors, IDs, hashing, Store/Repository interfaces, search
  markdown/       Portable attachment refs, ZIP export/import, path validation
  storage/        Store adapters: memory, IndexedDB, Tauri/SQLite bridge
  sync/           LocalChangeQueue, RemoteSyncClient, SyncEngine, conflict detection
  editor/         CodeMirror 6 editor + react-markdown preview components
  ui/             Application UI (sidebar tree, editor pane, dialogs, theme, status)
crates/
  notes-store/    Pure Rust SQLite core behind a narrow interface (rusqlite, migrations, tests)
cloudflare/
  worker/         Workers API (Phase 2/3)
  migrations/     Versioned D1 SQL migrations
tests/
  integration/    Cross-package tests (storage + markdown + sync against a mock remote)
  e2e/            Playwright specs (browser + desktop)
docs/             Architecture, sync protocol, data locations, deployment, security, status
```

Platform-specific code (SQLite, IndexedDB, HTTP) is behind interfaces in
`packages/shared`; nothing in `packages/ui` imports a database or `fetch`.

## 4. Domain model

One unified node table keeps the tree and move operations simple and provably
consistent (a note *is* a tree node whose `kind` is `note`).

| Object      | kind       | can be a parent | holds content |
|-------------|------------|-----------------|---------------|
| Notebook    | `notebook` | yes             | no            |
| Folder      | `folder`   | yes             | no            |
| Note        | `note`     | no              | yes           |

```
Node {
  id: UUID            // stable identity; never derived from title or path
  kind: 'notebook' | 'folder' | 'note'
  parentId: UUID | null    // null only for notebooks
  title: string
  content: string          // Markdown; empty for notebooks/folders
  position: number         // sibling order
  contentHash: string      // sha-256 hex of content (only meaningful for notes)
  localVersion: number     // incremented on every local write
  baseVersion: number      // last server version this local edit was based on
  syncState: 'local-only' | 'pending' | 'synced' | 'conflict' | 'deleted'
  createdAt / updatedAt: ISO-8601 UTC
  deletedAt: ISO-8601 | null   // tombstone
}
```

Rules enforced in code (and tested):

* A notebook has `parentId === null`; folders/notes must have a parent whose
  kind is `notebook` or `folder`.
* A note cannot receive children.
* Renaming or moving never changes `id`, `createdAt`, or sync history.
* Deletion is a tombstone (`deletedAt` + `syncState: 'deleted'`), so a delete can
  be replicated and can never be confused with "not yet downloaded".

## 5. Storage abstraction

```ts
interface Store {                     // packages/shared/src/store.ts
  init(): Promise<void>;
  listNodes(): Promise<Node[]>;       // live nodes only
  getNode(id): Promise<Node | null>;
  createNode(input): Promise<Node>;
  updateNode(id, patch, expectedLocalVersion): Promise<Node>;
  moveNode(id, parentId, position): Promise<Node>;
  deleteNode(id, opts): Promise<void>;          // tombstones the subtree
  search(query): Promise<Node[]>;
  putAttachment(meta, bytes): Promise<Attachment>;
  getAttachment(id): Promise<{ meta, bytes } | null>;
  listAttachments(): Promise<Attachment[]>;
  enqueue(op): Promise<void>;         // durable local change queue
  listQueue(): Promise<QueuedOp[]>;
  ackQueue(ids): Promise<void>;
  checkpoint(): Promise<string | null>;  // sync checkpoint token
  setCheckpoint(token): Promise<void>;
  exportAll(): Promise<Snapshot>;        // for export/backup
  importSnapshot(snapshot): Promise<ImportReport>;
}
```

Optimistic concurrency is exposed on `updateNode` via `expectedLocalVersion`:
a stale write throws `VersionConflictError` rather than clobbering, which is what
protects the UI from losing an unsaved editor buffer.

Implementations:

* `MemoryStore` — deterministic, used by unit tests.
* `IndexedDbStore` — browser. DB `localnotes`, stores `nodes`, `attachments`,
  `queue`, `meta`. Indexes on `parentId`, `kind`, `updatedAt`, `title`.
* `TauriStore` — desktop. Thin `invoke()` proxy to the Rust core.
* Rust `crates/notes-store` — SQLite (WAL, foreign keys on, explicit migrations),
  transactions per mutation, and a `sync_queue`/`deletions` table set.

### Desktop data locations

| OS      | Database                                  | Attachments                                        |
|---------|-------------------------------------------|----------------------------------------------------|
| Linux   | `~/.local/share/com.notedown.app/notes.sqlite3` | `~/.local/share/com.notedown.app/attachments/<id>.<ext>` |
| Windows | `%APPDATA%\com.notedown.app\notes.sqlite3`      | `%APPDATA%\com.notedown.app\attachments\<id>.<ext>`      |
| macOS   | `~/Library/Application Support/com.notedown.app/notes.sqlite3` | same directory |

Attachment strategy (chosen): **metadata in SQLite, bytes on disk** in the
app-managed `attachments/` directory. The `AttachmentRepository` interface does
not expose either representation, so bytes can move into SQLite later without
touching callers. Rationale in `docs/DECISIONS.md`.

### Browser storage caveat

IndexedDB is requested as persistent via `navigator.storage.persist()`, and the
UI warns when it is denied or when storage is not persistent. **Browser storage
is not a filesystem backup** and can be evicted; the UI tells users to export
regularly. See `docs/DATA-LOCATIONS.md`.

## 6. Markdown portability

Canonical in-app reference (portable, no host paths, no `blob:` URLs):

```
![Architecture diagram](attachments/6f1c…-4a2b-9d31-0c8e…png)
```

On export, references are rewritten **relative to the note's own location**:

```markdown
notes:  notebooks/Work/Design/architecture.md
image:  attachments/6f1c….png
written reference:  ../../attachments/6f1c….png
```

On import, every `attachments/…` reference is resolved against the archive root,
extensions/MIME are validated, and entries are rejected if they escape the
target directory (`..`, absolute paths, drive letters, UNC, symlinks, NUL bytes,
or over the size limit). Round-trips preserve IDs via an optional, documented
`.localnotes/metadata.json`; without it, a fresh import creates new stable IDs
and reports what was remapped.

## 7. Synchronization (Phase 3 design, protocol in `docs/SYNC-PROTOCOL.md`)

`SyncEngine` orchestrates; `LocalChangeQueue` persists pending operations;
`RemoteSyncClient` is an HTTP port that is fully mocked in tests.

```
edit ─► Store.updateNode (local commit) ─► enqueue(upsert note) ─► SyncEngine.run()
                                                                    │
       ┌────────────────────────────────────────────────────────────┘
       ▼
  1. push: send queued ops with `baseVersion` + `contentHash`
  2. pull: GET /sync/changes?since=<checkpoint>  (incremental)
  3. apply: remote wins only if local is clean; otherwise create conflict copy
  4. ack:  only after a durable local apply (never lose a local edit)
```

Idempotency is by operation `opId` (UUID) plus server version checks: the server
ignores an `opId` it has already stored, and rejects a write whose `baseVersion`
is stale with `409` + the current server version. A failed upload never discards
a local edit — the queue entry stays until acked.

## 8. Backend responsibilities (Phase 2)

* **Workers** — `/api/me`, `/api/notebooks`, `/api/nodes`, `/api/attachments/*`,
  `/api/sync/manifest`, `/api/sync/changes`, `/api/sync/push`. Every handler
  derives the user from the verified session; a client-supplied user id is never
  trusted. Ownership is enforced in the SQL `WHERE user_id = ?`.
* **D1** — structured metadata only: `user`, `session`, `account`, `verification`
  (Better Auth), `notebooks/nodes`, `attachments`, `sync_ops`, `tombstones`,
  with foreign keys, indexes and ownership columns; versioned SQL migrations.
* **R2** — private buckets, keys `users/<uid>/notes/<note-id>.md` and
  `users/<uid>/attachments/<attachment-id>.<ext>`; never public. Uploads are
  staged: metadata row first (`pending`), object second, then commit.
* **Auth** — Better Auth on D1 (`database: env.DB`), cookies for the browser and
  the bearer plugin for desktop; see `docs/SECURITY.md` and `docs/STATUS.md` for
  the exact versions verified.

## 9. Testing strategy

| Layer | Tool | What it covers |
|-------|------|----------------|
| Unit | Vitest | hierarchy ops, hashing/versions, queue durability & retry, conflict detection, tombstones, export/import, path-traversal rejection, markdown rendering |
| Component | Vitest + RTL + jsdom | tree interactions, autosave debounce, unsaved-edit protection on note switch, delete confirmation, a11y labels, empty states |
| Native | `cargo test` | SQLite migrations, transactions/rollback, subtree tombstoning, search, attachment bytes |
| Integration | Vitest, mock remote | offline edit → queue → flush → ack; duplicate op delivery; partial upload failure; two-client divergence → conflict copy |
| E2E | Playwright (scaffolded) | browser app: create/edit/reload/export; two contexts syncing |

## 10. Accessibility, theming, error handling

* Semantic landmarks (`nav`, `main`, `tree`/`treeitem`/`group` ARIA roles with
  `aria-expanded`, `aria-selected`, `aria-level`), full keyboard operation, focus
  visible, `aria-live` save indicator, `role="alert"` for errors.
* Light/dark themes via `data-theme` plus `prefers-color-scheme`, no layout shift.
* Explicit error types with recovery paths; toasts carry a retry action where a
  retry can succeed.
