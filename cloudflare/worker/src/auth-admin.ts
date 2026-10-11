import { getMigrations } from "better-auth/db/migration";
import { getAuth } from "./auth";
import type { Ctx } from "./env";
import { apiError, json } from "./http";

/**
 * POST /api/auth/migrate — creates the Better Auth tables in D1.
 *
 * Better Auth's CLI cannot reach a D1 binding, so the documented Cloudflare flow
 * is to run `getMigrations(auth.options)` and `runMigrations()` from a Worker.
 * The route is protected by `AUTH_MIGRATION_TOKEN` and should be disabled (or
 * removed) once the schema exists in production.
 */
export async function handleAuthMigration(ctx: Ctx): Promise<Response> {
  const token = ctx.env.AUTH_MIGRATION_TOKEN;
  const provided = ctx.request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    return apiError("forbidden", "AUTH_MIGRATION_TOKEN is not configured, so this route is closed");
  }
  if (provided !== token) return apiError("unauthorized", "A valid migration token is required");

  const auth = getAuth(ctx.env);
  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  return json({
    ok: true,
    created: migrations.toBeCreated.map((entry) => entry.table),
    added: migrations.toBeAdded.map((entry) => entry.table),
    indexes: migrations.toBeAddedIndexes.map((entry) => entry.name),
    unsafeChanges: migrations.unsafeChanges,
    schemaProblems: migrations.schemaProblems,
  });
}
