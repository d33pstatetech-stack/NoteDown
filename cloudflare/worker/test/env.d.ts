import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env as WorkerEnv } from "../src/env";

/**
 * Declares the bindings `cloudflare:test` exposes inside a test.
 *
 * `@cloudflare/vitest-plugin` types `env` as `Cloudflare.Env`, so that is the
 * interface to augment. Declaring it as a global namespace augmentation — rather
 * than re-exporting this package's `Env` — is what makes `env.DB`, `env.FILES`
 * and `env.APP_ORIGIN` visible to every test. (Augmenting `ProvidedEnv`, as the
 * older pool-workers package required, has no effect here: `Env` would resolve to
 * the global interface `@cloudflare/workers-types` declares, not this package's.)
 *
 * `TEST_MIGRATIONS` is supplied by `vitest.config.ts` and carries the parsed SQL
 * for `applyD1Migrations`.
 */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
