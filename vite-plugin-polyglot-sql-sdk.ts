import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

export interface PolyglotSqlSdkWorkersPluginOptions {
  workerBuild?: boolean;
  wasmFileName?: string;
}

const wasmModuleId = "polyglot-sql-sdk-workers-wasm";
const require = createRequire(import.meta.url);
const sdkDist = dirname(require.resolve("@polyglot-sql/sdk"));
const sdkEntry = resolve(sdkDist, "index.js");
const sdkWasm = resolve(sdkDist, "polyglot_sql_wasm_bg.wasm");

export function polyglotSqlSdkWorkersPlugin(options: PolyglotSqlSdkWorkersPluginOptions = {}): Plugin {
  const { workerBuild = false, wasmFileName = "polyglot_sql_wasm_bg.wasm" } = options;
  let config: ResolvedConfig | undefined;

  return {
    name: "polyglot-sql-sdk-workers",
    enforce: "pre",

    configResolved(resolved) {
      config = resolved;
    },

    resolveId(id) {
      if (workerBuild && id === wasmModuleId) {
        return { id: `./${wasmFileName}`, external: true };
      }
      return null;
    },

    transform(code, id) {
      if (!isPolyglotSqlSdkEntry(id)) {
        return null;
      }
      const wasmImport = workerBuild ? wasmModuleId : sdkWasm;
      return {
        code: transformPolyglotSqlSdk(code, wasmImport),
        map: null
      };
    },

    writeBundle(options) {
      if (!workerBuild || !config) {
        return;
      }
      const targetDir = workerOutputDir(config, options.dir);
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(sdkWasm, join(targetDir, wasmFileName));
    }
  };
}

function isPolyglotSqlSdkEntry(id: string): boolean {
  const path = id.split("?")[0]?.replaceAll("\\", "/") ?? id;
  return path === sdkEntry.replaceAll("\\", "/") ||
    path.endsWith("/node_modules/@polyglot-sql/sdk/dist/index.js") ||
    path.includes("/node_modules/.pnpm/@polyglot-sql+sdk@");
}

function transformPolyglotSqlSdk(code: string, wasmImport: string): string {
  const lines = code.split("\n");
  if (lines[0]?.includes("node:fs") && lines[0]?.includes("node:url")) {
    lines.shift();
  }
  let transformed = lines.join("\n");
  const wasmInitPattern = /const __vite__initWasm = async \(opts = \{\}, url\) => \{[\s\S]*?\n\};\n\n\/\*\*/;
  if (!wasmInitPattern.test(transformed)) {
    throw new Error("Unable to transform @polyglot-sql/sdk; expected initWasm marker was not found");
  }
  transformed = transformed.replace(
    wasmInitPattern,
    `const __vite__initWasm = async (opts = {}) => {
    const instance = await WebAssembly.instantiate(__polyglotWasmModule, opts);
    return "exports" in instance ? instance.exports : instance.instance.exports;
};

/**`
  );

  const wasmUrlPattern = /const __vite__wasmUrl = new URL\("\.\/polyglot_sql_wasm_bg\.wasm",\s*import\.meta\.url\)\.href;/;
  if (!wasmUrlPattern.test(transformed)) {
    throw new Error("Unable to transform @polyglot-sql/sdk; expected wasm URL marker was not found");
  }
  transformed = transformed.replace(wasmUrlPattern, `const __vite__wasmUrl = "";`);

  if (!transformed.includes("URL = globalThis.URL;")) {
    throw new Error("Unable to transform @polyglot-sql/sdk; expected URL assignment marker was not found");
  }
  transformed = transformed.replace("URL = globalThis.URL;", "globalThis.URL = globalThis.URL;");

  return `import __polyglotWasmModule from ${JSON.stringify(wasmImport)};\n${transformed}`;
}

function workerOutputDir(config: ResolvedConfig, outputDir: string | undefined): string {
  if (outputDir) {
    return outputDir;
  }
  const baseOutDir = resolve(config.root, config.build.outDir);
  if (existsSync(baseOutDir)) {
    for (const entry of readdirSync(baseOutDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const indexPath = join(baseOutDir, entry.name, "index.js");
        if (existsSync(indexPath)) {
          return join(baseOutDir, entry.name);
        }
      }
    }
  }
  return baseOutDir;
}

export default polyglotSqlSdkWorkersPlugin;
