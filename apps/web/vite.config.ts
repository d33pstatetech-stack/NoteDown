import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const packageSource = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  // Relative asset URLs so the Tauri desktop build can load the same bundle
  // from a custom protocol instead of a web origin.
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@localnotes/shared": packageSource("shared"),
      "@localnotes/markdown": packageSource("markdown"),
      "@localnotes/storage": packageSource("storage"),
      "@localnotes/sync": packageSource("sync"),
      "@localnotes/editor": packageSource("editor"),
      "@localnotes/ui": packageSource("ui"),
    },
  },
  server: {
    // Port 5173 is Vite's default and is what `APP_ORIGIN` in the Worker's
    // wrangler config is set to; the two must agree or the API's CORS and CSRF
    // checks will reject the browser client.
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // Additional allowed hosts come from Vite's own
    // __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS environment variable; no hostname
    // is hardcoded here.
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
    // Vendored groups keep the cached part of the bundle stable between app
    // releases. Grouped by module id, not by package name, so it works for
    // dependencies that are only reachable through a workspace package.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/")) {
            if (id.includes("@codemirror") || id.includes("@lezer")) return "codemirror";
            if (id.includes("/react-dom/") || id.includes("/react/") || id.includes("/scheduler/")) {
              return "react";
            }
            if (
              /react-markdown|remark-|micromark|mdast|hast-|unified|unist-|vfile|fflate/.test(id) &&
              id.includes("node_modules")
            ) {
              return "markdown";
            }
          }
          return undefined;
        },
      },
    },
    chunkSizeWarningLimit: 1400,
  },
});
