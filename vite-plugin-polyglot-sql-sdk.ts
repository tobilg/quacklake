import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import type { Plugin, ResolvedConfig } from "vite";

export interface PolyglotSqlSdkWorkersPluginOptions {
  workerBuild?: boolean;
  wasmFileName?: string;
}

const wasmModuleId = "polyglot-sql-sdk-workers-wasm";
const require = createRequire(import.meta.url);
const sdkDist = dirname(require.resolve("@polyglot-sql/sdk"));
const sdkEntry = resolve(sdkDist, "index.js");
const sdkWasm = resolveSdkWasm(sdkDist);

export function polyglotSqlSdkWorkersPlugin(options: PolyglotSqlSdkWorkersPluginOptions = {}): Plugin {
  const { workerBuild = false, wasmFileName = basename(sdkWasm) } = options;
  let config: ResolvedConfig | undefined;
  let transformedWasm = false;

  return {
    name: "polyglot-sql-sdk-workers",
    enforce: "pre",

    configResolved(resolved) {
      config = resolved;
    },

    buildStart() {
      transformedWasm = false;
    },

    resolveId(id) {
      // Use the browser entry in Workers, including tests. The Node entry can
      // install a filesystem-backed fetch shim for loading the Wasm asset.
      if (id === "@polyglot-sql/sdk") {
        return sdkEntry;
      }
      if (workerBuild && id === wasmModuleId) {
        return { id: `./${wasmFileName}`, external: true };
      }
      return null;
    },

    transform(code, id) {
      // Recent SDKs put the loader in a shared chunk rather than index.js.
      // Leave facade/builder modules alone and transform the actual loader.
      if (!isPolyglotSqlSdkModule(id) || !code.includes("__vite__initWasm")) {
        return null;
      }
      const wasmImport = workerBuild ? wasmModuleId : sdkWasm;
      const transformed = transformPolyglotSqlSdk(code, wasmImport);
      transformedWasm = true;
      return {
        code: transformed,
        map: null
      };
    },

    writeBundle(options) {
      if (!workerBuild || !config) {
        return;
      }
      if (!transformedWasm) {
        throw new Error("Unable to transform @polyglot-sql/sdk; no supported Wasm loader was found");
      }
      const targetDir = workerOutputDir(config, options.dir);
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(sdkWasm, join(targetDir, wasmFileName));
    }
  };
}

function isPolyglotSqlSdkModule(id: string): boolean {
  const path = id.split("?")[0]?.replaceAll("\\", "/") ?? id;
  return path.startsWith(`${sdkDist.replaceAll("\\", "/")}/`) && path.endsWith(".js");
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

  const wasmUrlPattern = /const __vite__wasmUrl = new URL\("\.\/[^"]+\.wasm",\s*import\.meta\.url\)\.href;/;
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

function resolveSdkWasm(distDir: string): string {
  for (const fileName of ["polyglot_sql_wasm_bg.wasm", "polyglot_sql.wasm"]) {
    const candidate = resolve(distDir, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const wasmFiles = readdirSync(distDir).filter((entry) => entry.endsWith(".wasm")).sort();
  if (wasmFiles[0]) {
    return resolve(distDir, wasmFiles[0]);
  }
  throw new Error(`Unable to locate @polyglot-sql/sdk wasm file in ${distDir}`);
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
