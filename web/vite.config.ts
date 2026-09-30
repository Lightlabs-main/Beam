import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        overlay: resolve(import.meta.dirname, "overlay.html"),
        gift: resolve(import.meta.dirname, "gift.html"),
        wallet: resolve(import.meta.dirname, "wallet.html"),
        claim: resolve(import.meta.dirname, "claim.html"),
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
