import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Resolved relative to *this* file, not the repository root: Vite resolves
// relative aliases against the config's own directory.
const root = fileURLToPath(new URL("../../", import.meta.url));
const pkg = (name: string) => `${root}packages/${name}/src/index.ts`;

/**
 * End-to-end tests that run against a **real** deployed Worker.
 *
 * These are separate from the unit/integration suite on purpose: they need a
 * live server, real D1 and real R2, so they must never run as part of `pnpm test`
 * (which stays hermetic and fast). `pnpm test:e2e` starts the Worker locally with
 * `scripts/e2e.sh` and points these tests at it.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@localnotes/shared": pkg("shared"),
      "@localnotes/markdown": pkg("markdown"),
      "@localnotes/storage": pkg("storage"),
      "@localnotes/sync": pkg("sync"),
      "@localnotes/editor": pkg("editor"),
      "@localnotes/ui": pkg("ui"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    // Signing up, hashing and R2 round-trips are slower than a unit test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Sequential on purpose: the tests share one Worker account and assert on
    // each other's effects, so parallel files would race.
    fileParallelism: false,
    pool: "forks",
  },
});
