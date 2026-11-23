import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Served by the Node server: assets under /web/, the page itself at /app/* and /demo/*.
export default defineConfig({
  base: "/web/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: { outDir: "dist", assetsDir: "assets", sourcemap: false, cssCodeSplit: false },
  server: { proxy: { "/api": "http://127.0.0.1:48787", "/app/provider": "http://127.0.0.1:48787" } },
});
