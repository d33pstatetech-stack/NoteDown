import { LIMITS, sha256Hex } from "@localnotes/shared";
import type { Ctx, Env } from "./env";
import { apiError, json, makeCheckpoint, nowIso, parseCheckpoint, readJson } from "./http";
import { assignVersion, currentVersion } from "./versions";

export interface WireNode {
  id: string;
  kind: string;
  parentId: string | null;
  title: string;
  content: string;
  position: number;
  contentHash: string;
  serverVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  conflictOf?: string | null;
}

interface NodeRow {
  id: string;
  kind: string;
  parent_id: string | null;
  title: string;
  content: string;
  position: number;
  content_hash: string;
  server_version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  conflict_of: string | null;
}

const SELECT_NODE = `SELECT id, kind, parent_id, title, content, position, content_hash,
  server_version, created_at, updated_at, deleted_at, conflict_of FROM nodes`;

function toWire(row: NodeRow): WireNode {
  return {
    id: row.id,
    kind: row.kind,
    parentId: row.parent_id,
    title: row.title,
    content: row.kind === "note" ? row.content : "",
    position: row.position,
    contentHash: row.content_hash,
    serverVersion: row.server_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    conflictOf: row.conflict_of,
  };
}

/** GET /api/sync/manifest — ids, versions and hashes only; no note bodies. */
export async function handleManifest(ctx: Ctx): Promise<Response> {
  const rows = await ctx.env.DB.prepare(
    `${SELECT_NODE} WHERE user_id = ?1 ORDER BY server_version`,
  )
    .bind(ctx.userId)
    .all<Omit<NodeRow, "content">>();
  const version = await currentVersion(ctx.env, ctx.userId);
  return json({
    nodes: (rows.results ?? []).map((row) => ({
      id: row.id,
      kind: row.kind,
      parentId: row.parent_id,
      title: row.title,
      position: row.position,
      contentHash: row.content_hash,
      serverVersion: row.server_version,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
    })),
    checkpoint: makeCheckpoint(version, ctx.userId),
  });
}

/**
 * GET /api/sync/changes?since=<checkpoint>&limit=<n>
 *
 * Incremental: a single per-user counter means one integer is a complete
 * cursor, and pages are ordered by that counter so a client can loop until
 * `hasMore` is false and persist `nextCheckpoint` once, after everything in the
 * page has been applied locally.
 *
 * Both streams (nodes and attachments) share that one counter, so they must be
 * paged together: the returned checkpoint is the *lowest* watermark of the two,
 * never the highest. Advancing to the highest would let an attachment that
 * arrived at version 900 skip over node changes 500–899 that were never sent,
 * and those would be unrecoverable — the client would never ask for them again.
 */
export async function handleChanges(ctx: Ctx): Promise<Response> {
  const sinceParam = ctx.url.searchParams.get("since");
  const limitParam = Number(ctx.url.searchParams.get("limit") ?? "200");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 200;

  const since = parseCheckpoint(sinceParam)?.version ?? 0;
  const retention = await oldestRetainedTombstoneVersion(ctx.env, ctx.userId);
  if (since > 0 && since < retention) {
    // A device that has been offline past the tombstone horizon must resync from
    // scratch rather than believe that missing rows were deleted.
    return apiError("stale_checkpoint", "This device has been offline too long; re-run a full sync", {
      oldestRetainedVersion: retention,
    });
  }

  const nodeRows = await ctx.env.DB.prepare(
    `${SELECT_NODE} WHERE user_id = ?1 AND server_version > ?2 ORDER BY server_version LIMIT ?3`,
  )
    .bind(ctx.userId, since, limit + 1)
    .all<NodeRow>();
  const nodes = nodeRows.results ?? [];
  const page = nodes.slice(0, limit);
  const nodesHaveMore = nodes.length > limit;

  const attachmentRows = await ctx.env.DB.prepare(
    `SELECT id, note_id, mime, ext, size, sha256, server_version FROM attachments
     WHERE user_id = ?1 AND status = 'ready' AND server_version > ?2
     ORDER BY server_version LIMIT ?3`,
  )
    .bind(ctx.userId, since, limit + 1)
    .all<{
      id: string;
      note_id: string | null;
      mime: string;
      ext: string;
      size: number;
      sha256: string;
      server_version: number;
    }>();
  const attachments = attachmentRows.results ?? [];
  const attachmentPage = attachments.slice(0, limit);
  const attachmentsHaveMore = attachments.length > limit;

  // Watermark. A stream only constrains the cursor when it still has undelivered
  // rows: then the cursor must stop at the last version this page carried, or
  // those rows would be skipped forever. A stream that is exhausted contributes
  // nothing, so the cursor is free to advance on the other stream's evidence.
  //
  // When both are exhausted the page is simply the current head of the feed, so
  // the cursor moves to the account's current version. `since` is the floor in
  // every case, so the cursor never moves backwards.
  const hasMore = nodesHaveMore || attachmentsHaveMore;
  const highest = hasMore
    ? Math.max(
        since,
        Math.min(
          ...[
            nodesHaveMore
              ? Math.max(since, ...page.map((row) => row.server_version))
              : Number.POSITIVE_INFINITY,
            attachmentsHaveMore
              ? Math.max(since, ...attachmentPage.map((row) => row.server_version))
              : Number.POSITIVE_INFINITY,
          ],
        ),
      )
    : await currentVersion(ctx.env, ctx.userId);

  return json({
    changes: page.map(toWire),
    attachments: attachmentPage.map((row) => ({
      id: row.id,
      noteId: row.note_id,
      mime: row.mime,
      ext: row.ext,
      size: row.size,
      sha256: row.sha256,
      serverVersion: row.server_version,
    })),
    nextCheckpoint: makeCheckpoint(highest, ctx.userId),
    hasMore,
  });
}

export interface WireOp {
  opId: string;
  type: string;
  entityId: string;
  baseVersion: number;
  payload: Record<string, unknown>;
}

export interface PushOutcome {
  opId: string;
  status: "applied" | "duplicate" | "conflict" | "rejected";
  serverVersion?: number;
  server?: WireNode;
  error?: string;
}

/**
 * POST /api/sync/push
 *
 * Conditional writes. An op whose `baseVersion` is stale is **never** applied:
 * the server returns `conflict` with its current row and the client decides how
 * to preserve both versions. `opId` is recorded in `sync_ops`, so a retried
 * batch is idempotent.
 */
export async function handlePush(ctx: Ctx): Promise<Response> {
  let body: { ops?: WireOp[] };
  try {
    body = await readJson<{ ops?: WireOp[] }>(ctx.request);
  } catch {
    return apiError("invalid_request", "The request body must be JSON");
  }
  const ops = Array.isArray(body.ops) ? body.ops : null;
  if (!ops) return apiError("invalid_request", "`ops` must be an array");
  if (ops.length > 200) return apiError("invalid_request", "At most 200 operations per push");

  const results: PushOutcome[] = [];
  for (const op of ops) {
    if (!op || typeof op.opId !== "string" || typeof op.entityId !== "string") {
      results.push({ opId: op?.opId ?? "unknown", status: "rejected", error: "malformed operation" });
      continue;
    }

    const seen = await ctx.env.DB.prepare(
      "SELECT status FROM sync_ops WHERE user_id = ?1 AND op_id = ?2",
    )
      .bind(ctx.userId, op.opId)
      .first<{ status: string }>();
    if (seen) {
      results.push({ opId: op.opId, status: "duplicate" });
      continue;
    }

    if (op.type === "upsert_node") {
      results.push(await applyUpsert(ctx, op));
      continue;
    }
    if (op.type === "delete_node") {
      results.push(await applyDelete(ctx, op));
      continue;
    }
    if (op.type === "put_attachment") {
      // Bytes are uploaded through /api/attachments/:id; by the time this op
      // arrives the row exists and the write is a no-op acknowledgement.
      const existing = await ctx.env.DB.prepare(
        "SELECT server_version FROM attachments WHERE user_id = ?1 AND id = ?2",
      )
        .bind(ctx.userId, op.entityId)
        .first<{ server_version: number }>();
      if (existing) {
        await recordOp(ctx, op.opId, "applied", op.entityId);
        results.push({ opId: op.opId, status: "applied", serverVersion: existing.server_version });
      } else {
        results.push({
          opId: op.opId,
          status: "rejected",
          error: "upload the attachment bytes before announcing them",
        });
      }
      continue;
    }
    if (op.type === "delete_attachment") {
      // The extension is needed to build the object key, so it is read before
      // the row disappears.
      const existing = await ctx.env.DB.prepare(
        "SELECT ext FROM attachments WHERE user_id = ?1 AND id = ?2",
      )
        .bind(ctx.userId, op.entityId)
        .first<{ ext: string }>();
      if (!existing) {
        // Already gone server-side: idempotent success, and no version is spent
        // so the checkpoint is not pushed past this op for nothing.
        await recordOp(ctx, op.opId, "applied", op.entityId);
        results.push({ opId: op.opId, status: "applied" });
        continue;
      }
      const version = await assignVersion(ctx.env, ctx.userId);
      await ctx.env.DB.batch([
        ctx.env.DB.prepare("DELETE FROM attachments WHERE user_id = ?1 AND id = ?2").bind(
          ctx.userId,
          op.entityId,
        ),
        insertOp(ctx, op.opId, "applied", op.entityId),
      ]);
      try {
        await ctx.env.FILES.delete(`users/${ctx.userId}/attachments/${op.entityId}.${existing.ext}`);
      } catch (error) {
        // The row is already gone; an orphaned object is reclaimable, so this
        // is logged rather than turned into a client-visible failure.
        console.error("Failed to delete R2 attachment object", error);
      }
      results.push({ opId: op.opId, status: "applied", serverVersion: version });
      continue;
    }

    results.push({ opId: op.opId, status: "rejected", error: `unknown operation: ${op.type}` });
  }

  const version = await currentVersion(ctx.env, ctx.userId);
  return json({ results, checkpoint: makeCheckpoint(version, ctx.userId) });
}

async function applyUpsert(ctx: Ctx, op: WireOp): Promise<PushOutcome> {
  const payload = op.payload as {
    kind?: string;
    parentId?: string | null;
    title?: string;
    content?: string;
    position?: number;
    contentHash?: string;
    conflictOf?: string | null;
  };

  if (payload.kind !== "notebook" && payload.kind !== "folder" && payload.kind !== "note") {
    return { opId: op.opId, status: "rejected", error: "unknown node kind" };
  }
  if (typeof payload.title !== "string" || payload.title.trim().length === 0) {
    return { opId: op.opId, status: "rejected", error: "a title is required" };
  }
  if (payload.kind !== "note" && (payload.content ?? "") !== "") {
    return { opId: op.opId, status: "rejected", error: `a ${payload.kind} cannot hold content` };
  }

  // Parent rules are enforced here as well as by the composite foreign key, so
  // a client that sends another account's id (or a note as a parent) gets a
  // clear rejection instead of an opaque constraint error. Ownership comes from
  // the session, never from the payload.
  const parentId = payload.parentId ?? null;
  if (parentId !== null) {
    if (parentId === op.entityId) {
      return { opId: op.opId, status: "rejected", error: "a node cannot be its own parent" };
    }
    const parent = await ctx.env.DB.prepare(
      "SELECT kind FROM nodes WHERE user_id = ?1 AND id = ?2 AND deleted_at IS NULL",
    )
      .bind(ctx.userId, parentId)
      .first<{ kind: string }>();
    if (!parent) {
      return { opId: op.opId, status: "rejected", error: "the parent node does not exist" };
    }
    if (parent.kind === "note") {
      return { opId: op.opId, status: "rejected", error: "a note cannot contain other nodes" };
    }
    if (payload.kind === "notebook") {
      return { opId: op.opId, status: "rejected", error: "a notebook must be top level" };
    }
  } else if (payload.kind !== "notebook") {
    return { opId: op.opId, status: "rejected", error: `a ${payload.kind} needs a parent` };
  }

  // Content is bounded here as well as on the client: a note body is the one
  // field big enough to matter, and D1 rows have a hard size limit.
  const content = payload.kind === "note" ? (payload.content ?? "") : "";
  if (new TextEncoder().encode(content).length > LIMITS.contentBytes) {
    return { opId: op.opId, status: "rejected", error: "the note body is too large" };
  }
  if (payload.title.length > LIMITS.titleChars) {
    return { opId: op.opId, status: "rejected", error: "the title is too long" };
  }

  // The stored digest is recomputed, never taken from the client. Every
  // conflict decision on every device is made by comparing this value, so a
  // wrong one would either hide a real conflict or invent a phantom one.
  const contentHash = await sha256Hex(content);

  const current = await ctx.env.DB.prepare(
    `${SELECT_NODE} WHERE user_id = ?1 AND id = ?2`,
  )
    .bind(ctx.userId, op.entityId)
    .first<NodeRow>();

  if (current && current.server_version !== op.baseVersion) {
    return {
      opId: op.opId,
      status: "conflict",
      serverVersion: current.server_version,
      server: toWire(current),
    };
  }

  // A tombstone is a decision, not a cache entry: an upsert that did not see
  // the delete (a stale baseVersion is already rejected above) must not
  // resurrect the node. Both versions are preserved instead — the client keeps
  // its text locally and the server row stays deleted.
  if (current?.deleted_at) {
    return {
      opId: op.opId,
      status: "conflict",
      serverVersion: current.server_version,
      server: toWire(current),
    };
  }

  const version = await assignVersion(ctx.env, ctx.userId);
  const timestamp = nowIso();
  const createdAt = current?.created_at ?? timestamp;

  await ctx.env.DB.batch([
    // Ownership is in the predicate, so a cross-account parent cannot be used
    // even if the client sends one.
    ctx.env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
    ctx.env.DB.prepare(
      `INSERT INTO nodes (user_id, id, kind, parent_id, title, content, position, content_hash,
         server_version, deleted_at, conflict_of, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, ?12)
       ON CONFLICT(user_id, id) DO UPDATE SET
         kind = excluded.kind,
         parent_id = excluded.parent_id,
         title = excluded.title,
         content = excluded.content,
         position = excluded.position,
         content_hash = excluded.content_hash,
         server_version = excluded.server_version,
         deleted_at = NULL,
         conflict_of = excluded.conflict_of,
         updated_at = excluded.updated_at`,
    ).bind(
      ctx.userId,
      op.entityId,
      payload.kind,
      parentId,
      payload.title,
      content,
      Number.isFinite(payload.position) ? Math.trunc(payload.position as number) : 0,
      contentHash,
      version,
      payload.conflictOf ?? null,
      createdAt,
      timestamp,
    ),
    insertOp(ctx, op.opId, "applied", op.entityId),
  ]);

  // Mirror the Markdown into R2 at the documented key. Best-effort: the D1 row
  // is authoritative for sync, and a failed mirror only affects backups.
  await mirrorMarkdown(ctx.env, ctx.userId, op.entityId, payload.kind, content);

  return { opId: op.opId, status: "applied", serverVersion: version };
}

async function applyDelete(ctx: Ctx, op: WireOp): Promise<PushOutcome> {
  const payload = op.payload as { deletedAt?: string };
  const current = await ctx.env.DB.prepare(`${SELECT_NODE} WHERE user_id = ?1 AND id = ?2`)
    .bind(ctx.userId, op.entityId)
    .first<NodeRow>();

  if (!current) {
    // Deleting something the server never had is a no-op, not an error.
    await recordOp(ctx, op.opId, "applied", op.entityId);
    return { opId: op.opId, status: "applied" };
  }
  if (current.server_version !== op.baseVersion) {
    return {
      opId: op.opId,
      status: "conflict",
      serverVersion: current.server_version,
      server: toWire(current),
    };
  }
  // Already a tombstone: re-deleting is idempotent and must not burn a version,
  // or a client retrying would push the checkpoint past its own change feed.
  if (current.deleted_at) {
    await recordOp(ctx, op.opId, "applied", op.entityId);
    return { opId: op.opId, status: "applied", serverVersion: current.server_version };
  }

  const version = await assignVersion(ctx.env, ctx.userId);
  const deletedAt = payload.deletedAt ?? nowIso();
  await ctx.env.DB.batch([
    // A node can only be tombstoned while its parent still exists; deferring
    // lets the client's op ordering (children may arrive first) settle here.
    ctx.env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
    ctx.env.DB.prepare(
      `UPDATE nodes SET deleted_at = ?3, server_version = ?4, updated_at = ?3
       WHERE user_id = ?1 AND id = ?2`,
    ).bind(ctx.userId, op.entityId, deletedAt, version),
    insertOp(ctx, op.opId, "applied", op.entityId),
  ]);
  await deleteMirroredMarkdown(ctx.env, ctx.userId, op.entityId);
  return { opId: op.opId, status: "applied", serverVersion: version };
}

function insertOp(ctx: Ctx, opId: string, status: string, entityId: string): D1PreparedStatement {
  return ctx.env.DB.prepare(
    "INSERT OR REPLACE INTO sync_ops (user_id, op_id, status, entity_id, applied_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).bind(ctx.userId, opId, status, entityId, nowIso());
}

async function recordOp(ctx: Ctx, opId: string, status: string, entityId: string): Promise<void> {
  await insertOp(ctx, opId, status, entityId).run();
}

/**
 * Tombstones are retained for 30 days. A device whose checkpoint predates the
 * oldest retained tombstone cannot tell "deleted" from "not downloaded yet", so
 * it is asked to resync instead of guessing.
 */
export const TOMBSTONE_RETENTION_DAYS = 30;

/**
 * Tombstones are retained for 30 days; a device whose cursor predates the
 * oldest tombstone still held cannot tell "deleted" from "never downloaded" and
 * is asked to resync instead of guessing.
 *
 * The previous implementation computed this from tombstones *older* than the
 * window, which is backwards: those are exactly the rows a reaper removes, and
 * on an account whose rows have not been reaped the query returned NULL, so the
 * check never fired. It also mixed in the minimum version across all rows, which
 * made a fresh device that simply had not synced yet look stale.
 *
 * Nothing is reaped today (there is no scheduled job), so every change is still
 * in the feed and no cursor is ever too old. The invariant is asserted rather
 * than approximated: a device is only ever told to resync when a tombstone it
 * could still need has actually been dropped.
 */
async function oldestRetainedTombstoneVersion(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT MIN(server_version) AS version FROM nodes
     WHERE user_id = ?1 AND deleted_at IS NOT NULL AND deleted_at >= ?2`,
  )
    .bind(userId, new Date(Date.now() - TOMBSTONE_RETENTION_DAYS * 86_400_000).toISOString())
    .first<{ version: number | null }>();
  // No live tombstone ⇒ nothing has been reaped ⇒ every cursor is still servable.
  return row?.version ?? 0;
}

async function mirrorMarkdown(
  env: Env,
  userId: string,
  noteId: string,
  kind: string,
  content: string,
): Promise<void> {
  if (kind !== "note") return;
  try {
    await env.FILES.put(markdownKey(userId, noteId), content, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
  } catch {
    // A mirror failure must not fail the sync write.
  }
}

/**
 * Removes the R2 mirror for a deleted note. Best-effort for the same reason as
 * the write: the D1 tombstone is authoritative, and a leftover object is
 * reclaimable while a failed write is not.
 */
async function deleteMirroredMarkdown(env: Env, userId: string, noteId: string): Promise<void> {
  try {
    await env.FILES.delete(markdownKey(userId, noteId));
  } catch {
    // ignored on purpose; see above
  }
}

function markdownKey(userId: string, noteId: string): string {
  return `users/${userId}/notes/${noteId}.md`;
}
