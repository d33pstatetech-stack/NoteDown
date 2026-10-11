import type { Env } from "./env";
import { nowIso } from "./http";

/**
 * Assigns the next value of the per-user monotonic `serverVersion`.
 *
 * A compare-and-set update is used rather than a read-then-write, so two
 * concurrent pushes cannot hand out the same version. D1 has no long-lived
 * transactions across Worker code, which is exactly why the counter is bumped
 * with a guarded UPDATE and retried on contention.
 */
export async function assignVersion(env: Env, userId: string): Promise<number> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await env.DB.prepare(
      "INSERT INTO user_versions (user_id, version) VALUES (?1, 0) ON CONFLICT(user_id) DO NOTHING",
    )
      .bind(userId)
      .run();

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

/** Called after a batch that already bumped the version. */
export function staleCheckpointResponse(): never {
  throw new Error("stale_checkpoint");
}

export { nowIso };
