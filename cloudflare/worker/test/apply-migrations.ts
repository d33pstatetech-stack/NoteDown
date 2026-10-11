/**
 * Applies the D1 schema and the Better Auth tables once per test file.
 *
 * The options are built from the *same* factory the Worker uses at runtime, so
 * the tables created here are exactly the ones the deployed code expects. Doing
 * it this way also means a change to the auth configuration cannot silently
 * make the test schema differ from production.
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";
import { getMigrations } from "better-auth/db/migration";
import type { BetterAuthOptions } from "better-auth";

/** Mirrors `buildAuth` in `src/auth.ts`; kept in step by `auth.schema.test.ts`. */
function authOptionsForMigration(): BetterAuthOptions {
  return {
    database: env.DB,
    baseURL: env.BETTER_AUTH_URL ?? env.APP_ORIGIN,
    basePath: "/api/auth",
    ...(env.BETTER_AUTH_SECRET ? { secret: env.BETTER_AUTH_SECRET } : {}),
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
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

  const migrations = await getMigrations(authOptionsForMigration());
  if (
    migrations.toBeCreated.length ||
    migrations.toBeAdded.length ||
    migrations.toBeAddedIndexes.length
  ) {
    const sql = await migrations.compileMigrations();
    // D1's `exec()` reports success without reliably populating sqlite_master
    // under Miniflare, so each DDL statement is run on its own.
    for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) {
      await env.DB.prepare(statement).run();
    }
  }
}, 60_000);
