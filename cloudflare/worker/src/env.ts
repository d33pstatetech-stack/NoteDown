/** Bindings and variables available to the Worker. */
export interface Env {
  /** D1: structured metadata, sync versions and the change feed. */
  DB: D1Database;
  /** R2: private attachment objects and the Markdown mirror. */
  FILES: R2Bucket;
  /** Origin the browser app is served from; used for CORS and CSRF checks. */
  APP_ORIGIN: string;
  /** ≥32 random bytes. Set with `wrangler secret put BETTER_AUTH_SECRET`. */
  BETTER_AUTH_SECRET?: string;
  /** Bearer token that authorises the one-off Better Auth table migration. */
  AUTH_MIGRATION_TOKEN?: string;
  BETTER_AUTH_URL?: string;
}

/** Per-request context passed to every handler. */
export interface Ctx {
  env: Env;
  request: Request;
  /** Attached by the router after the session is verified. */
  userId: string;
  /** Hono-free convenience: the parsed URL. */
  url: URL;
}
