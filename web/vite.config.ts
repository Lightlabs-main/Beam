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
        creator: resolve(import.meta.dirname, "creator.html"),
        studio: resolve(import.meta.dirname, "studio.html"),
        earnings: resolve(import.meta.dirname, "earnings.html"),
        watch: resolve(import.meta.dirname, "watch.html"),
        setup: resolve(import.meta.dirname, "setup.html"),
      },
    },
  },
  server: {
    // BEAM_API=https://testnet.beamstreams.xyz previews the frontend against a live backend.
    proxy: {
      "/api": { target: process.env.BEAM_API ?? "http://localhost:8787", changeOrigin: true },
      "/ws": { target: (process.env.BEAM_API ?? "http://localhost:8787").replace(/^http/, "ws"), ws: true, changeOrigin: true },
    },
  },
});
