import type { Env } from "./env";

/**
 * How many times a version assignment retries after losing the compare-and-set
 * race. Contention is per-user and per-write, so a handful of attempts is
 * already generous; exhausting them means something is genuinely wrong and the
 * caller should surface an error rather than issue a duplicate version.
 */
const VERSION_ASSIGN_ATTEMPTS = 6;

/**
 * Assigns the next value of the per-user monotonic `serverVersion`.
 *
 * A compare-and-set update is used rather than a read-then-write, so two
 * concurrent pushes cannot hand out the same version. D1 has no long-lived
 * transactions across Worker code, which is exactly why the counter is bumped
 * with a guarded UPDATE and retried on contention.
 */
export async function assignVersion(env: Env, userId: string): Promise<number> {
  // Ensure the row exists before the CAS loop: an `INSERT ... DO NOTHING` on
  // every attempt would work too, but doing it once keeps the hot path to a
  // single statement pair.
  await env.DB.prepare(
    "INSERT INTO user_versions (user_id, version) VALUES (?1, 0) ON CONFLICT(user_id) DO NOTHING",
  )
    .bind(userId)
    .run();

  for (let attempt = 0; attempt < VERSION_ASSIGN_ATTEMPTS; attempt += 1) {
    const row = await env.DB.prepare("SELECT version FROM user_versions WHERE user_id = ?1")
      .bind(userId)
      .first<{ version: number }>();
    const current = row?.version ?? 0;

    const updated = await env.DB.prepare(
      "UPDATE user_versions SET version = version + 1 WHERE user_id = ?1 AND version = ?2",
    )
      .bind(userId, current)
      .run();

    if ((updated.meta.changes ?? 0) === 1) return current + 1;
    // Lost the race: another writer bumped the counter first. Re-read and try
    // again. Crucially we do NOT return `current + 1` here — that version may
    // already have been handed to the writer that won, and issuing it twice
    // would break the "one total order" guarantee the change feed depends on.
  }
  throw new Error("could not assign a sync version after repeated contention");
}

/** The current version, without bumping it (used for checkpoints). */
export async function currentVersion(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT version FROM user_versions WHERE user_id = ?1")
    .bind(userId)
    .first<{ version: number }>();
  return row?.version ?? 0;
}
