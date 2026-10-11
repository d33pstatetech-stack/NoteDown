/**
 * Applies the D1 schema migration and the Better Auth tables once per worker
 * isolate. The migrations run before the first test, and Miniflare's
 * isolatedStorage moves that state into each test's storage (a clean copy per
 * file), so no test can see another test's account.
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";
import { getMigrations } from "better-auth/db/migration";
import { getAuth } from "../src/auth";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

  // Apply Better Auth tables directly (same SQL the /api/auth/migrate endpoint
  // would run) so the test suite doesn't depend on SELF being available in the
  // setup context. Create the tables BEFORE calling getAuth() so Better Auth's
  // schema introspection sees them.
  const authOptions = {
    database: env.DB,
    baseURL: env.BETTER_AUTH_URL ?? env.APP_ORIGIN,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [],
    trustedOrigins: [env.APP_ORIGIN],
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: env.APP_ORIGIN.startsWith("https://"),
      },
    },
  };
  const migrations = await getMigrations(authOptions);
  if (migrations.toBeCreated.length || migrations.toBeAdded.length || migrations.toBeAddedIndexes.length) {
    const sql = await migrations.compileMigrations();
    // D1's exec() reports success but doesn't always populate sqlite_master in
    // miniflare, so run each DDL statement individually.
    const statements = sql.split(";").map((s: string) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      if (stmt) await env.DB.prepare(stmt).run();
    }
  }

  // Pre-warm the auth instance so the first test request doesn't pay the
  // cold-start cost and the schema is already validated against the tables we
  // just created.
  getAuth(env);
}, 30_000);
