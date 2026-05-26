import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { polyglotSqlSdkWorkersPlugin } from "./vite-plugin-polyglot-sql-sdk";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    polyglotSqlSdkWorkersPlugin({ workerBuild: true })
  ],
  build: {
    target: "es2024",
    outDir: ".wrangler-build",
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: {
      entry: resolve(root, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js"
    },
    rollupOptions: {
      external: ["cloudflare:workers"],
      output: {
        entryFileNames: "index.js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]"
      }
    }
  }
});
