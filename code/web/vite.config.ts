import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "."),
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, rollupOptions: { input: {
    main: resolve(import.meta.dirname, "index.html"),
    setup: resolve(import.meta.dirname, "setup.html")
  } } },
  esbuild: { jsx: "automatic" }
});
