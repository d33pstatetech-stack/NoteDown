import {
  LIMITS,
  ValidationError,
  extForMime,
  safeFilename,
  sha256Hex,
  validateAttachment,
} from "@localnotes/shared";
import type { Ctx } from "./env";
import { apiError, json, nowIso, readJson } from "./http";
import { assignVersion } from "./versions";

/** Per-account ceiling for attachment bytes, to stay inside the free tier. */
export const USER_ATTACHMENT_QUOTA_BYTES = 512 * 1024 * 1024;

const STAGING_TTL_MINUTES = 15;

interface UploadBody {
  meta?: { noteId?: string | null; mime?: string; ext?: string; size?: number; sha256?: string };
  bytesBase64?: string;
}

/**
 * PUT /api/attachments/:id — staged upload.
 *
 * The type is sniffed from the bytes and the digest recomputed, so neither the
 * client's `mime` nor its filename is trusted. The row is inserted as `staging`
 * first, the object is written second, and the row is committed last: a crash or
 * a failed object write leaves an invisible staging row that a reaper can clean
 * up, never a note pointing at an object that does not exist.
 */
export async function handleAttachmentUpload(ctx: Ctx, id: string): Promise<Response> {
  let body: UploadBody;
  try {
    body = await readJson<UploadBody>(ctx.request, Math.ceil(LIMITS.attachmentBytes * 1.5) + 4096);
  } catch {
    return apiError("invalid_request", "The request body must be JSON");
  }
  if (typeof body.bytesBase64 !== "string") {
    return apiError("invalid_request", "`bytesBase64` is required");
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(body.bytesBase64);
  } catch {
    return apiError("invalid_request", "`bytesBase64` is not valid base64");
  }

  let mime: string;
  try {
    mime = validateAttachment(bytes);
  } catch (error) {
    const message = error instanceof ValidationError ? error.message : "unsupported attachment";
    return apiError("invalid_request", message);
  }

  const ext = extForMime(mime);
  if (!ext) return apiError("invalid_request", "unsupported attachment type");

  const sha256 = await sha256Hex(bytes);
  if (body.meta?.sha256 && body.meta.sha256 !== sha256) {
    return apiError("invalid_request", "the supplied digest does not match the uploaded bytes");
  }
  if (body.meta?.size !== undefined && body.meta.size !== bytes.length) {
    return apiError("invalid_request", "the supplied size does not match the uploaded bytes");
  }

  const usage = await ctx.env.DB.prepare(
    "SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE user_id = ?1 AND id <> ?2",
  )
    .bind(ctx.userId, id)
    .first<{ total: number }>();
  if ((usage?.total ?? 0) + bytes.length > USER_ATTACHMENT_QUOTA_BYTES) {
    return apiError("quota_exceeded", "Attachment storage limit reached for this account", {
      limitBytes: USER_ATTACHMENT_QUOTA_BYTES,
    });
  }

  const stagingId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + STAGING_TTL_MINUTES * 60_000).toISOString();
  const filename = safeFilename(body.meta?.mime ? `attachment.${ext}` : `attachment.${ext}`, ext);

  await ctx.env.DB.prepare(
    `INSERT INTO attachments (user_id, id, note_id, filename, mime, ext, size, sha256, status,
       staging_id, staging_expires_at, server_version, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'staging', ?9, ?10, 0, ?11)
     ON CONFLICT(user_id, id) DO UPDATE SET
       note_id = excluded.note_id, filename = excluded.filename, mime = excluded.mime,
       ext = excluded.ext, size = excluded.size, sha256 = excluded.sha256,
       status = 'staging', staging_id = excluded.staging_id,
       staging_expires_at = excluded.staging_expires_at`,
  )
    .bind(
      ctx.userId,
      id,
      body.meta?.noteId ?? null,
      filename,
      mime,
      ext,
      bytes.length,
      sha256,
      stagingId,
      expiresAt,
      nowIso(),
    )
    .run();

  await ctx.env.FILES.put(`users/${ctx.userId}/attachments/${id}.${ext}`, bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: { sha256, stagingId },
  });

  // Commit: verify what actually landed in R2, then flip the row in one write.
  const stored = await ctx.env.FILES.head(`users/${ctx.userId}/attachments/${id}.${ext}`);
  if (!stored) {
    return apiError("lease_expired", "The uploaded object could not be verified; retry the upload");
  }

  const version = await assignVersion(ctx.env, ctx.userId);
  await ctx.env.DB.prepare(
    `UPDATE attachments
     SET status = 'ready', staging_id = NULL, staging_expires_at = NULL, server_version = ?3
     WHERE user_id = ?1 AND id = ?2 AND staging_id = ?4`,
  )
    .bind(ctx.userId, id, version, stagingId)
    .run();

  return json({ id, mime, ext, size: bytes.length, sha256, serverVersion: version });
}

/** GET /api/attachments/:id — authorized download with an ETag. */
export async function handleAttachmentDownload(ctx: Ctx, id: string): Promise<Response> {
  const row = await ctx.env.DB.prepare(
    `SELECT mime, ext, size, sha256, status, note_id, server_version FROM attachments
     WHERE user_id = ?1 AND id = ?2`,
  )
    .bind(ctx.userId, id)
    .first<{
      mime: string;
      ext: string;
      size: number;
      sha256: string;
      status: string;
      note_id: string | null;
      server_version: number;
    }>();

  // Another account's id is reported as not-found, so ids are not enumerable.
  if (!row) return apiError("not_found", "Attachment not found");
  if (row.status !== "ready") {
    return apiError("lease_expired", "This attachment has not finished uploading");
  }

  const etag = `"${row.sha256}"`;
  if (ctx.request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const object = await ctx.env.FILES.get(`users/${ctx.userId}/attachments/${id}.${row.ext}`);
  if (!object) return apiError("not_found", "Attachment bytes are unavailable");

  const bytes = new Uint8Array(await object.arrayBuffer());
  // The body is the raw bytes so a browser can use the URL directly as an
  // `<img>` src; the metadata the sync client needs travels in headers (which
  // are listed in access-control-expose-headers so cross-origin JS may read
  // them). The ETag is a hash of the content, so caches stay correct.
  return new Response(bytes, {
    headers: {
      "content-type": row.mime,
      "content-length": String(bytes.length),
      etag,
      "cache-control": "private, max-age=0, must-revalidate",
      "x-attachment-id": id,
      "x-attachment-note-id": row.note_id ?? "",
      "x-attachment-mime": row.mime,
      "x-attachment-ext": row.ext,
      "x-attachment-size": String(bytes.length),
      "x-attachment-sha256": row.sha256,
      "x-attachment-version": String(row.server_version),
    },
  });
}

export async function handleAttachmentDelete(ctx: Ctx, id: string): Promise<Response> {
  const row = await ctx.env.DB.prepare(
    "SELECT ext FROM attachments WHERE user_id = ?1 AND id = ?2",
  )
    .bind(ctx.userId, id)
    .first<{ ext: string }>();
  if (!row) return apiError("not_found", "Attachment not found");

  // Metadata first, then the object: an orphaned object is recoverable, a row
  // without bytes is not.
  await ctx.env.DB.prepare("DELETE FROM attachments WHERE user_id = ?1 AND id = ?2")
    .bind(ctx.userId, id)
    .run();
  await ctx.env.FILES.delete(`users/${ctx.userId}/attachments/${id}.${row.ext}`);
  const version = await assignVersion(ctx.env, ctx.userId);
  return json({ id, deleted: true, serverVersion: version });
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
