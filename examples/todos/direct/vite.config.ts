import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const directDirectory = dirname(fileURLToPath(import.meta.url));
const exampleRoot = resolve(directDirectory, "..");

export default defineConfig({
  root: exampleRoot,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    open: "/direct/",
    port: 5173,
    strictPort: true,
  },
  build: {
    emptyOutDir: true,
    outDir: "dist-direct",
    rollupOptions: {
      input: resolve(directDirectory, "index.html"),
    },
    sourcemap: true,
  },
});
