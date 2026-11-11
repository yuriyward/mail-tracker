import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;

/**
 * Builds the dashboard into web/dist/app, which wrangler.toml binds as ASSETS; the Worker
 * serves it at /app after the Access check. The CSP allows only same-origin files, so
 * nothing is inlined as a data: URI and no inline script is emitted.
 */
export default defineConfig({
  base: "/app/",
  build: {
    assetsInlineLimit: 0,
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    outDir: path.resolve(root, "dist/app"),
  },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(root, "src") } },
  root,
});
