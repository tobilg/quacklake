# quacklake

`quacklake` is a Cloudflare Workers / Durable Objects service that speaks DuckDB's experimental Quack HTTP protocol and stores DuckLake catalog metadata in Durable Object SQLite storage.

The Worker exposes one public Quack endpoint at `/quack`. Clients authenticate by sending a JWT as the Quack auth string. A valid JWT resolves to one catalog Durable Object and one normalized principal, then quacklake applies the catalog's server-side authorization policy before executing catalog SQL.

## Status

This is an alpha implementation. It is useful for protocol integration work, local Worker tests, and R2-backed DuckLake metadata smoke tests. It is not a full DuckDB server.

Implemented:

- Quack binary request/response transport through `POST /quack`.
- `CONNECTION_REQUEST`, `PREPARE_REQUEST`, `FETCH_REQUEST`, `APPEND_REQUEST`, and `DISCONNECT_MESSAGE`.
- JWT-only catalog authentication.
- First-party HS256 quacklake JWT credentials.
- Third-party OIDC JWT verification through configured providers and JWKS.
- Catalog auth mappings that select a catalog for verified OIDC principals.
- Catalog auth policies that authorize SQL and append requests before execution.
- SQLite-backed query execution with DuckDB-style compatibility rewrites.
- Planned R2-backed DuckLake `DATA_PATH` assignment and enforcement per catalog.
- R2-backed DuckLake file discovery for orphan cleanup.
- Optional trusted-client R2 data leases for catalogs created with `dataAccessMode: "trusted_client"`.
- Result materialization into Quack `DataChunk`s using `@quack-protocol/sdk`.
- Basic explicit transaction emulation with snapshot restore on `ROLLBACK`.
- Worker integration tests through the published `@quack-protocol/sdk` client.
- OpenAPI v3 Admin API document at `GET /api-docs`.

Not implemented as full DuckDB semantics:

- Complete DuckDB SQL parser or optimizer behavior.
- Arbitrary DuckDB functions and table functions.
- Cross-session transactional conflict detection.
- Complete DuckLake test-suite coverage.
- OPA/Rego policy execution.
- A server-side data gateway. Trusted-client leases grant raw R2 object access under the catalog data path and do not enforce row or column policy at the storage layer.

## Guides

The README is intentionally a short project entry point. Detailed operational docs live in `guides/`:

- [Getting Started Guide](./guides/getting-started.md): simplest production-style Cloudflare deployment with one R2 bucket, first-party JWT auth, default `catalog_only` access, and a DuckDB CLI smoke query.
- [Authn/Authz Guide](./guides/authn-authz.md): JWT-only authentication, first-party credentials, OIDC providers, catalog mappings, catalog policies, policy cookbook, explain output, and troubleshooting.
- [Cognito End-To-End Guide](./guides/cognito-e2e.md): Cognito user-pool setup, group-based permission profiles, catalog mapping, row and column policy examples, and end-user DuckLake querying.
- [Microsoft Entra ID End-To-End Guide](./guides/entraid-e2e-md): Entra app registration, group and app-role permission profiles, catalog mapping, row and column policy examples, and end-user DuckLake querying.
- [Quack, DuckLake, And R2 Guide](./guides/quack-ducklake.md): DuckDB Quack secrets, SDK usage, DuckLake attachment, planned R2 `DATA_PATH` enforcement, trusted-client R2 leases, R2 bucket listing, diagnostics, and file inventory endpoints.
- [Local Development And Configuration Guide](./guides/local-development.md): dependencies, Wrangler configuration, local secrets, development commands, local Worker health checks, and OpenAPI discovery.

The machine-readable Admin API reference is served by a running Worker:

```sh
curl http://localhost:8787/api-docs
```

## Architecture

There are two Durable Object classes:

- `CatalogRegistry`: global registry for catalog ids, first-party credential metadata, OIDC providers, catalog auth mappings, and catalog auth policies.
- `QuackCatalogObject`: one SQLite-backed Durable Object database per catalog.

Request flow:

1. A client sends a Quack `CONNECTION_REQUEST` with a JWT auth string.
2. The Worker asks `CatalogRegistry` to verify and resolve the JWT.
3. The JWT resolves to one catalog id, one `QuackCatalogObject`, one normalized principal, and the current catalog policy version.
4. The catalog object opens a session and stores the auth context.
5. The Worker signs `{ catalogId, sessionId }` into the public Quack `connection_id`.
6. Later Quack messages include that signed connection id and route directly to the catalog Durable Object.
7. `PREPARE_REQUEST` and `APPEND_REQUEST` are authorized against the stored session principal and policy before execution.

## Project Layout

- `src/index.ts`: Worker fetch handler, `/quack`, CORS, `/api-docs`, and `/admin/*` routes.
- `src/openapi.ts`: OpenAPI v3 Admin API document.
- `src/registry.ts`: catalog, credential, OIDC provider, mapping, and policy registry Durable Object.
- `src/auth.ts`: shared authentication, mapping, policy, and session auth types.
- `src/authz.ts`: SQL classification and internal policy evaluator.
- `src/catalog.ts`: Quack protocol Durable Object and per-session auth enforcement.
- `src/sql-compat.ts`: SQL execution orchestration, session state, schema tracking, transactions, and result chunking.
- `src/ducklake-metadata.ts`: DuckLake-specific catalog query and migration shims that SQLite cannot execute directly.
- `src/sql-rewrite.ts`: DuckDB-to-SQLite SQL text rewrites and column-definition parsing.
- `src/sql-names.ts`: schema-qualified identifier normalization helpers.
- `src/sql-types.ts`: shared SQL execution, result, schema, and transaction snapshot types.
- `src/quack-values.ts`: value and logical type conversion between SQLite and Quack.
- `src/crypto.ts`: signed connection ids and constant-time comparisons.
- `test/quack-worker.test.ts`: Worker integration tests through `QuackClient`.
- `test/auth.test.ts`: JWT, OIDC, mapping, policy, protocol, OpenAPI, and explain tests.
- `test/authz.test.ts`: SQL authorization classifier and policy evaluator tests.
- `test/file-listing.test.ts`: R2/file-listing helper tests.
- `test/quack-values.test.ts`: Quack value and logical type conversion tests.
- `guides/`: focused operator and developer guides.
- `scripts/create-jwt.sh`: creates a first-party personal JWT and installs a broad personal catalog policy.
- `scripts/setup-cognito.sh`: creates Cognito user-pool resources for OIDC smoke tests and registration.
- `scripts/register-cognito-idp.sh`: registers Cognito as a quacklake OIDC provider and installs group-based mapping/policy rules.
- `wrangler.example.jsonc`: tracked Worker, Durable Object, R2, migration, and runtime configuration template.

## Quick Start

Install dependencies:

```sh
pnpm install
```

Create `.dev.vars` for local development:

```dotenv
ADMIN_TOKEN=admin-test-token
QUACKLAKE_JWT_SECRET=replace-with-long-random-local-jwt-secret
CONNECTION_SIGNING_SECRET=replace-with-long-random-local-signing-secret
```

Run checks:

```sh
pnpm run typecheck
pnpm run test
pnpm run test:coverage
```

Run the Worker locally:

```sh
pnpm run dev
```

Health check:

```sh
curl http://localhost:8787/
```

Expected shape:

```json
{
  "name": "quacklake",
  "protocol": "quack",
  "endpoint": "/quack",
  "apiDocs": "/api-docs"
}
```

Create a local catalog and first-party JWT credential:

```sh
curl -s -X POST http://localhost:8787/admin/catalogs \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"catalogId":"default","scopes":["catalog.admin"]}'
```

Install a permissive bootstrap policy for local setup:

```sh
curl -s -X PUT http://localhost:8787/admin/catalogs/default/auth-policy \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"defaultEffect":"allow","rules":[]}'
```

For production policies, OIDC, and troubleshooting, use [Authn/Authz Guide](./guides/authn-authz.md).

## Configuration Summary

`wrangler.example.jsonc` shows the Worker configuration shape. Copy it to `wrangler.jsonc` and edit the local copy before running Wrangler commands.

Important runtime vars:

- `QUACK_FETCH_ROWS_PER_CHUNK`: default `1024`.
- `QUACK_FETCH_CHUNKS_PER_BATCH`: default `12`.
- `QUACKLAKE_JWT_ISSUER`: first-party JWT issuer, default `quacklake`.
- `QUACKLAKE_JWT_AUDIENCE`: first-party JWT audience, default `quacklake:quack`.
- `QUACKLAKE_JWT_DEFAULT_TTL_SECONDS`: first-party credential lifetime, default one year.
- `DUCKLAKE_R2_BINDINGS`: JSON map from DuckLake bucket name to Worker R2 binding name, for example `{"<bucket-name>":"DUCKLAKE_R2"}`. Every usable DuckLake data bucket must also appear in `wrangler.jsonc` `r2_buckets`.

Trusted-client lease vars, only needed when using `dataAccessMode: "trusted_client"`:

- `DUCKLAKE_R2_DATA_LEASE_TTL_SECONDS`: trusted-client R2 data lease TTL, clamped to 30-120 seconds. Default `60`.
- `R2_ACCOUNT_ID`: Cloudflare account id used when locally signing R2 temporary credentials.
- `R2_ENDPOINT`: S3-compatible R2 endpoint, for example `https://<account-id>.r2.cloudflarestorage.com`.

Runtime secrets:

- `ADMIN_TOKEN`: bearer secret required for every `/admin/*` route.
- `QUACKLAKE_JWT_SECRET`: HS256 signing key for first-party quacklake JWT credentials.
- `CONNECTION_SIGNING_SECRET`: HMAC secret used to sign Quack connection ids.
- `R2_ACCESS_KEY_ID`: parent R2 S3 access key id used only when issuing trusted-client data leases.
- `R2_SECRET_ACCESS_KEY`: parent R2 S3 secret access key used only when issuing trusted-client data leases.

For a deployed Worker using the default name:

```sh
pnpm exec wrangler secret put ADMIN_TOKEN --name quacklake
pnpm exec wrangler secret put QUACKLAKE_JWT_SECRET --name quacklake
pnpm exec wrangler secret put CONNECTION_SIGNING_SECRET --name quacklake
```

If you enable `dataAccessMode: "trusted_client"` for any catalog, also set the parent R2 S3 credentials used for local temporary-credential signing:

```sh
pnpm exec wrangler secret put R2_ACCESS_KEY_ID --name quacklake
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY --name quacklake
```

The value passed to admin calls, including `scripts/create-jwt.sh --admin-token`, must exactly match the deployed `ADMIN_TOKEN` secret.

See [Local Development And Configuration Guide](./guides/local-development.md) for local and deployed secret setup.

## Client Usage Summary

Use a JWT as the Quack secret token value:

```sql
CREATE OR REPLACE SECRET quacklake_catalog (
  TYPE quack,
  TOKEN '<jwt>',
  SCOPE 'quack:<worker-host>:443'
);
```

`POST /admin/catalogs` assigns the catalog a planned `DATA_PATH` of `r2://<bucket>/catalogs/<catalogId>/` and returns `ducklake.secretSql` and `ducklake.attachSql` for copy/paste bootstrap. `ducklake.secretSql` contains the one-time-visible JWT and must be treated as secret material.

For DuckLake, create a separate storage secret scoped to the planned bucket and prefix:

```sql
CREATE OR REPLACE SECRET lake_r2 (
  TYPE s3,
  PROVIDER config,
  KEY_ID '<r2-access-key-id>',
  SECRET '<r2-secret-access-key>',
  ENDPOINT '<account-id>.r2.cloudflarestorage.com',
  URL_STYLE 'path',
  REGION 'auto',
  SCOPE 'r2://<bucket>/catalogs/<catalogId>/'
);

ATTACH 'ducklake:quack:<worker-host>:443' AS lake (
  DATA_PATH 'r2://<bucket>/catalogs/<catalogId>/'
);
```

Manual storage secrets are still the default `catalog_only` setup. For trusted clients, create the catalog with `dataAccessMode: "trusted_client"` and call `POST /catalog/data-lease` with the same catalog JWT to receive short-lived R2 credentials for the planned catalog `DATA_PATH`.

For server-side DuckLake maintenance paths such as `read_blob()` orphan discovery, and for validating trusted-client lease paths, the Worker also needs an R2 bucket binding mapped through `DUCKLAKE_R2_BINDINGS`. See [Quack, DuckLake, And R2 Guide](./guides/quack-ducklake.md) for Worker R2 binding setup, client storage secrets, trusted-client leases, R2 bucket listing, diagnostics, and file inventory examples.

## Notes

- Keep one catalog id per independent DuckLake `DATA_PATH`.
- Additional credentials for a catalog are credential rotations or app-specific credentials; they do not create a new metadata store.
- Signed connection ids depend on `CONNECTION_SIGNING_SECRET`; rotating it invalidates all active client sessions.
- First-party credentials depend on `QUACKLAKE_JWT_SECRET`; rotating it requires credential reissue.
- OPA/Rego is intentionally not implemented in v1, but the internal explain input/output shape is OPA-compatible enough to support a future OPA Wasm backend.
