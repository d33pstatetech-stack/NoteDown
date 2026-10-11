# Synchronization protocol (specified before implementation)

Status: **specification**. Implemented in Phase 3; Phase 1 ships the local
change queue and the `RemoteSyncClient` port with a mock implementation.

## Vocabulary

* **node** — notebook, folder or note (see `docs/ARCHITECTURE.md` §4).
* **localVersion** — monotonically increasing integer, bumped on every local write.
* **baseVersion** — the server version the local copy was last based on (0 = never synced).
* **serverVersion** — assigned by the server on every accepted write; total order per node.
* **checkpoint** — opaque per-user sync cursor (`<serverVersion>:<userId>`), stored locally.
* **opId** — UUID of a queued operation; the idempotency key.

## 1. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/sync/manifest` | Node ids + versions + `contentHash` only (no content). Cheap "what changed" probe. |
| GET | `/api/sync/changes?since=<checkpoint>&limit=200` | Page of changed nodes (with Markdown), tombstones, and attachment metadata. Returns `nextCheckpoint` and `hasMore`. |
| POST | `/api/sync/push` | Batch of local operations against known `baseVersion`s. |
| POST | `/api/attachments/:id/init` | Begins a staged attachment upload; returns an upload target + `stagingId`. |
| PUT | `/api/attachments/:id/commit` | Commits a staged object (idempotent by `stagingId`). |
| GET | `/api/attachments/:id` | Authorized download; `ETag`/`If-None-Match` supported. |

All responses are `application/json`; errors are
`{ error: { code, message, details? } }` with stable codes
(`unauthorized`, `forbidden`, `not_found`, `version_conflict`, `lease_expired`,
`quota_exceeded`, `invalid_request`). Identity always comes from the server-side
session; `user_id` in a body is ignored.

## 2. Fetching changes since a checkpoint

```
GET /api/sync/changes?since=4211:usr_123&limit=200
→ 200 {
    "changes": [
      { "id": "…", "kind": "note", "parentId": "…", "title": "…", "content": "# …",
        "position": 3, "contentHash": "…", "serverVersion": 4212, "updatedAt": "…",
        "deletedAt": null }
    ],
    "attachments": [ { "id": "…", "noteId": "…", "mime": "image/png",
                       "size": 20481, "sha256": "…", "serverVersion": 4213 } ],
    "nextCheckpoint": "4213:usr_123",
    "hasMore": false
  }
```

* `serverVersion` is a single per-user monotonic counter, so a checkpoint is one
  integer; no per-node cursors are needed and pages are consistent.
* The listed node payload is content-complete for notes, so a normal pull needs
  no R2 round trip. R2 remains the durable object store and the source for
  attachment bytes and for a full rebuild.
* `hasMore` drives pagination; clients loop until `false` and then persist
  `nextCheckpoint`. Checkpoints are only advanced after a **durable local apply**.

## 3. Submitting changes

```
POST /api/sync/push
{ "ops": [ { "opId": "uuid", "nodeId": "uuid", "type": "upsert_node",
             "baseVersion": 41, "payload": { "title": "…", "content": "…",
             "parentId": null, "position": 1, "contentHash": "…" } },
           { "opId": "uuid", "nodeId": "uuid", "type": "delete_node",
             "baseVersion": 42 } ] }
→ 200 { "results": [ { "opId": "…", "status": "applied", "serverVersion": 43 },
                      { "opId": "…", "status": "conflict", "serverVersion": 44,
                        "server": { …current node… } },
                      { "opId": "…", "status": "duplicate" } ],
        "checkpoint": "44:usr_123" }
```

Per-op outcomes:

* `applied` — version matched, new `serverVersion` assigned.
* `duplicate` — `opId` already recorded; ignored, safe to re-send forever.
* `conflict` — `baseVersion` is stale; the server returns its current node and
  **does not** overwrite. The client resolves per §5.
* `rejected` — validation failure (bad parent, kind mismatch, size limit); the
  op stays in the queue with an error state and is surfaced in the UI, never to
  be dropped silently.

Each accepted op is written in a single `db.batch()` (D1 sequential transaction)
together with its `sync_ops` idempotency row and the version counter update.

## 4. Retries and partial failure

* Every op is retried with its original `opId`; retry is therefore idempotent.
* Batches are idempotent at the op level, so a client that crashes mid-batch and
  replays the whole batch is safe.
* Retry schedule: exponential backoff 1s → 2s → 4s … capped at 5 min, with jitter;
  a manual "Sync now" resets the backoff.
* A failed op never discards a local edit: the queue entry is only removed after
  an `applied`/`duplicate` response, or after an explicit user discard.
* `401` → keep queue, prompt re-auth; local editing continues offline.
* `409` is *not* an error condition for the queue; it triggers §5.

## 5. Conflict handling (preserve both versions)

Detect divergence when **both** are true:

1. the server has a row with `serverVersion > baseVersion`, and
2. the local copy has unsynced edits (`localVersion > baseVersion` or the node
   is not yet cleared from the queue).

Resolution:

1. Re-check whether the incoming remote content is a no-op: if
   `remote.contentHash === local.contentHash`, mark the local copy synced
   (a rename/move race resolves this way).
2. Otherwise **do not** pick a winner. Keep the local text in place, clear its
   queue entry to `applied` semantics, and create a sibling node
   `<title> (conflict copy YYYY-MM-DD HH:mm)` containing the **remote** text with
   its own fresh `id`, `baseVersion = serverVersion`, and `syncState: 'pending'`.
3. Record the previous local text in the conflict copy's metadata
   (`conflictOf`, `conflictRecordedAt`) so the pre-conflict revision is recoverable.
4. Show a non-blocking banner: “2 conflict copies created — review”.

Removing the copy is a normal note deletion, so the resolution is auditable.

## 6. Attachments and staged uploads

R2 writes cannot join a D1 transaction, so attachments use a two-phase commit:

1. `POST /api/attachments/:id/init` → D1 row (`status = 'staging'`,
   `staging_id`, `staging_expires_at = now + 15 min`, expected `sha256`, `size`).
2. Upload bytes (`PUT` to the Worker route, streamed to R2; size and MIME
   re-validated server-side, never trusting client headers or filename).
3. `PUT /api/attachments/:id/commit` → re-hash the stored object, then a single
   `db.batch()` flips `status` to `ready` and bumps the user version counter.
   Idempotent by `stagingId`.
4. Clients see only `ready` attachments in `/sync/changes`; a note may reference
   an attachment that is not yet ready, which the UI renders as a "pending image"
   placeholder rather than a broken image.
5. A reaper deletes `staging` objects older than `staging_expires_at` and any R2
   object whose D1 row no longer exists (metadata-first, then object).

Markdown never contains a machine-specific path or a `blob:` URL — only
`attachments/<attachment-id>.<ext>` (see `docs/ARCHITECTURE.md` §6).

## 7. Tombstones and cleanup

* `deleteNode` writes a tombstone (`deleted_at`, `serverVersion`) and enqueues a
  `delete_node` op; the subtree is tombstoned in one transaction.
* Tombstones are served by `/sync/changes` for `TOMBSTONE_TTL = 30 days`.
* The client drops a tombstone once its own checkpoint exceeds the tombstone's
  `serverVersion` (i.e. it has already applied the delete).
* Server GC after the TTL: delete the tombstone row and the note's R2 object.
  A device offline longer than the TTL must do a **full resync** (§8).
* “Missing locally” is never a delete signal — only an explicit tombstone is.

## 8. Offline for a long time / full resync

* If `checkpoint` is older than the server's tombstone horizon
  (`serverVersion < oldest_retained_tombstone`) the server responds `409`
  `stale_checkpoint`; the client clears its checkpoint and performs a manifest
  diff: every local `synced` node absent from the manifest is marked
  `local-only` (kept, never deleted), then pulls all changes from checkpoint 0.
* If the local database is intact but the account changed, the client refuses to
  attach: it requires explicit **Link account** or **Import** (see
  `docs/SECURITY.md` §4).

## 9. Status reporting

`SyncEngine` exposes `{ state: 'idle'|'syncing'|'offline'|'error', pending,
lastSyncedAt, error, conflicts }` to the UI, which renders "Saved locally",
"Pending sync (n)", "Synced ✓", or an error with a Retry action.
