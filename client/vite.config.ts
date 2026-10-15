import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiPort = process.env.PORT ?? "3100";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    host: true,
    // Public dev URL via the Cloudflare tunnel (specharvest-local.app-at.casa).
    allowedHosts: [".app-at.casa"],
    // The API answers CORS itself (the browser extension calls it cross-origin); Vite's own handler would
    // answer preflights for /api without the extension's origin.
    cors: false,
    proxy: {
      // ws: the browser extension connects to /api/extension/ws.
      "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: "dist",
    // Two pages: the app, and the admin dashboard at /admin/ (src/admin — the app never imports it). The Android
    // build (`--mode app`, see cap:sync) leaves the admin page out of the APK; the app opens it in the browser.
    rollupOptions: { input: mode === "app" ? { main: "index.html" } : { main: "index.html", admin: "admin/index.html" } },
  },
}));
