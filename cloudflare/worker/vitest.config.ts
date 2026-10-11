import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const { fileURLToPath } = await import("node:url");

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("../migrations/", import.meta.url)),
  );
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      globals: true,
    poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              BETTER_AUTH_SECRET:
                "test-secret-that-is-at-least-32-random-bytes-long-0123456789abcdef",
              AUTH_MIGRATION_TOKEN: "test-migration-token",
              APP_ORIGIN: "http://localhost:3000",
              FILES: {
                buckets: [{ name: "localnotes-files" }],
              },
            },
          },
        },
      },
    },
  };
});
