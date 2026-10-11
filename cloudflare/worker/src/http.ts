import type { Env } from "./env";

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "version_conflict"
  | "stale_checkpoint"
  | "lease_expired"
  | "quota_exceeded"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  version_conflict: 409,
  stale_checkpoint: 409,
  lease_expired: 409,
  quota_exceeded: 413,
  internal: 500,
};

/**
 * Every response is JSON, including errors, with a stable machine-readable
 * code so clients never have to parse prose.
 */
export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function apiError(
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error: { code, message, ...extra } }, { status: STATUS[code] });
}

/**
 * CORS is restricted to the exact configured origin (never `*`), because the
 * browser client sends credentials. Requests from other origins get no CORS
 * headers at all, so the browser blocks them.
 */
export function corsHeaders(env: Env, request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("origin");
  if (origin && origin === env.APP_ORIGIN) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    headers.set("access-control-allow-headers", "content-type,authorization");
    // Without this the browser client could fetch an attachment but not read its
    // id/hash/version, which it needs to store the downloaded bytes.
    headers.set(
      "access-control-expose-headers",
      "etag,content-type,x-attachment-id,x-attachment-note-id,x-attachment-mime,x-attachment-ext,x-attachment-size,x-attachment-sha256,x-attachment-version",
    );
    headers.set("access-control-max-age", "600");
    headers.set("vary", "origin");
  }
  return headers;
}

export function withCors(response: Response, env: Env, request: Request): Response {
  const headers = corsHeaders(env, request);
  const merged = new Headers(response.headers);
  for (const [key, value] of headers) merged.set(key, value);
  return new Response(response.body, { status: response.status, headers: merged });
}

/**
 * CSRF protection for state-changing requests: the browser client is same-origin,
 * so a mismatch between Origin and the configured app origin means the request
 * was cross-site and is rejected outright.
 */
export function isSameOriginRequest(env: Env, request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser / native client with a bearer token
  return origin === env.APP_ORIGIN;
}

export async function readJson<T>(request: Request, limit = 4 * 1024 * 1024): Promise<T> {
  const text = await request.text();
  if (text.length > limit) throw new Error("request body is too large");
  return JSON.parse(text) as T;
}

export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}

export function parseCheckpoint(token: string | null): { version: number } | null {
  if (!token) return null;
  const [version] = token.split(":");
  const parsed = Number(version);
  return Number.isFinite(parsed) && parsed >= 0 ? { version: parsed } : null;
}

export function makeCheckpoint(version: number, userId: string): string {
  return `${version}:${userId}`;
}
