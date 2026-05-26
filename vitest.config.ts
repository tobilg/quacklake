import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { polyglotSqlSdkWorkersPlugin } from "./vite-plugin-polyglot-sql-sdk";

const testR2BucketName = process.env.R2_BUCKET ?? "test-ducklake-r2";

export default defineConfig({
  plugins: [
    polyglotSqlSdkWorkersPlugin(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.example.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "admin-test-token",
          QUACKLAKE_JWT_SECRET: "jwt-secret-test",
          QUACKLAKE_JWT_ISSUER: "quacklake",
          QUACKLAKE_JWT_AUDIENCE: "quacklake:quack",
          CONNECTION_SIGNING_SECRET: "connection-secret-test",
          DUCKLAKE_R2_BINDINGS: JSON.stringify({ [testR2BucketName]: "DUCKLAKE_R2" }),
          R2_ACCESS_KEY_ID: "test-r2-access-key",
          R2_SECRET_ACCESS_KEY: "test-r2-secret-key",
          R2_ACCOUNT_ID: "test-account",
          R2_ENDPOINT: "https://test-account.r2.cloudflarestorage.com"
        }
      }
    })
  ],
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["external-projects/**", "node_modules/**"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/quack-imports.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 87,
        branches: 74,
        functions: 97,
        lines: 87,
        "src/authz.ts": {
          statements: 93,
          branches: 84,
          functions: 100,
          lines: 93
        },
        "src/catalog.ts": {
          statements: 87,
          branches: 67,
          functions: 94,
          lines: 87
        },
        "src/crypto.ts": {
          statements: 90,
          branches: 77,
          functions: 100,
          lines: 90
        },
        "src/ducklake-data-path.ts": {
          statements: 94,
          branches: 88,
          functions: 100,
          lines: 93
        },
        "src/ducklake-metadata.ts": {
          statements: 87,
          branches: 67,
          functions: 100,
          lines: 87
        },
        "src/file-listing.ts": {
          statements: 100,
          branches: 94,
          functions: 100,
          lines: 100
        },
        "src/index.ts": {
          statements: 83,
          branches: 73,
          functions: 100,
          lines: 83
        },
        "src/openapi.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100
        },
        "src/quack-values.ts": {
          statements: 86,
          branches: 80,
          functions: 100,
          lines: 85
        },
        "src/registry.ts": {
          statements: 90,
          branches: 67,
          functions: 92,
          lines: 90
        },
        "src/sql-compat.ts": {
          statements: 86,
          branches: 69,
          functions: 94,
          lines: 86
        },
        "src/sql-names.ts": {
          statements: 91,
          branches: 75,
          functions: 100,
          lines: 91
        },
        "src/sql-rewrite.ts": {
          statements: 81,
          branches: 69,
          functions: 96,
          lines: 81
        },
        "src/sql-text.ts": {
          statements: 74,
          branches: 72,
          functions: 100,
          lines: 73
        }
      }
    }
  }
});
