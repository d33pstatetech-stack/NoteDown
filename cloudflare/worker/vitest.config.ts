import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const migrations = await readD1Migrations(
  fileURLToPath(new URL("../migrations/", import.meta.url)),
);

/**
 * Runs the Worker test suite inside workerd via Miniflare, so D1, R2 and the
 * runtime the code will actually be deployed on are all real.
 *
 * The bindings here override whatever `wrangler.jsonc` declares, because that
 * file points at a production database id that must never be touched by a test
 * run. Secrets are inline test-only values.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          BETTER_AUTH_SECRET:
            "test-secret-that-is-at-least-32-random-bytes-long-0123456789abcdef",
          AUTH_MIGRATION_TOKEN: "test-migration-token",
          BETTER_AUTH_URL: "http://api.local",
          APP_ORIGIN: "http://localhost:3000",
          FILES: {
            buckets: [{ name: "localnotes-files" }],
          },
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    globals: true,
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
