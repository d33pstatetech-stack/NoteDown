import { getAuth, requireUser } from "./auth";
import { handleAuthMigration } from "./auth-admin";
import {
  handleAttachmentDelete,
  handleAttachmentDownload,
  handleAttachmentUpload,
} from "./attachments";
import type { Env } from "./env";
import { apiError, isSameOriginRequest, json, withCors } from "./http";
import { handleChanges, handleManifest, handlePush } from "./nodes";

export type { Env };

const ATTACHMENT_ROUTE = /^\/api\/attachments\/([^/]+)$/;

/**
 * The whole API surface.
 *
 * Order of operations for every request:
 *   1. CORS (exact origin only; other origins get no headers),
 *   2. health, the Better Auth handler, and the schema-migration route (all
 *      unauthenticated),
 *   3. `requireUser` — the session, never a body field, decides ownership,
 *   4. a same-origin check for state-changing requests (CSRF defence),
 *   5. the route.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), env, request);
    }

    try {
      return withCors(await route(request, env, url), env, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unexpected error";
      // The reason is logged for the operator and deliberately not returned:
      // a body that echoes internal messages is how stack and binding details
      // leak to a caller.
      console.error("Unhandled worker error", message);
      return withCors(
        apiError("internal", "The server could not complete this request"),
        env,
        request,
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/health") {
    return json({ ok: true, service: "localnotes-api", time: new Date().toISOString() });
  }

  // Better Auth owns its own routes (sign-up, sign-in, sign-out, session,
  // bearer token exchange). It must be reached before any session check,
  // because establishing a session is what the rest of the API authenticates.
  if (url.pathname.startsWith("/api/auth/") && !url.pathname.startsWith("/api/auth/migrate")) {
    return getAuth(env).handler(request);
  }

  if (!url.pathname.startsWith("/api/")) {
    return apiError("not_found", "Unknown route");
  }

  // The one-off schema migration authenticates with its own bearer secret
  // rather than a session — on a fresh database there is no `session` table,
  // and therefore no session a caller could present. It is handled before
  // `requireUser` precisely because of that.
  if (url.pathname === "/api/auth/migrate") {
    return handleAuthMigration({ env, request, userId: "", url });
  }

  const user = await requireUser(env, request);
  if (!user) return apiError("unauthorized", "Sign in to use the sync API");

  const mutating = request.method !== "GET" && request.method !== "HEAD";
  if (mutating && !isSameOriginRequest(env, request)) {
    return apiError("forbidden", "Cross-origin writes are not allowed");
  }

  const ctx = { env, request, userId: user.id, url };

  if (url.pathname === "/api/me") {
    return json({ user: { id: user.id, email: user.email } });
  }
  if (url.pathname === "/api/sync/manifest") {
    return handleManifest(ctx);
  }
  if (url.pathname === "/api/sync/changes") {
    return handleChanges(ctx);
  }
  if (url.pathname === "/api/sync/push") {
    return handlePush(ctx);
  }

  const attachment = ATTACHMENT_ROUTE.exec(url.pathname);
  if (attachment?.[1]) {
    const id = decodeURIComponent(attachment[1]);
    if (request.method === "PUT") return handleAttachmentUpload(ctx, id);
    if (request.method === "GET") return handleAttachmentDownload(ctx, id);
    if (request.method === "DELETE") return handleAttachmentDelete(ctx, id);
    return apiError("invalid_request", "Unsupported method for this route");
  }

  return apiError("not_found", "Unknown route");
}
