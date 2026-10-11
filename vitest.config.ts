import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

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
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["packages/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "tests/e2e/**"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["packages/*/src/**"],
    },
  },
});
