import { defineConfig } from "vite";

// Tauri expects a fixed dev server port and serves the built frontend from dist/.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "esnext",
  },
});
