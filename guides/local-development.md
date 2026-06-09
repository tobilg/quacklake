# Local Development And Configuration Guide

This guide covers local setup, Worker configuration, secrets, development commands, and API discovery.

## Requirements

- Node.js 22 or newer.
- `pnpm`.
- Cloudflare Wrangler through project dependencies.
- A Cloudflare R2 bucket for production DuckLake data files.

Install dependencies:

```sh
pnpm install
```

Run checks:

```sh
pnpm run typecheck
pnpm run test
pnpm run test:coverage
```

Build a Worker dry run:

```sh
pnpm run build
```

## Worker Configuration

`wrangler.example.jsonc` shows the Worker configuration shape. Copy it to `wrangler.jsonc` and edit the local copy before running Wrangler commands.

Important runtime vars:

- `QUACK_FETCH_ROWS_PER_CHUNK`: default `1024`.
- `QUACK_FETCH_CHUNKS_PER_BATCH`: default `12`.
- `QUACKLAKE_JWT_ISSUER`: first-party JWT issuer, default `quacklake`.
- `QUACKLAKE_JWT_AUDIENCE`: first-party JWT audience, default `quacklake:quack`.
- `QUACKLAKE_JWT_DEFAULT_TTL_SECONDS`: first-party credential lifetime, default one year.
- `DUCKLAKE_R2_BINDINGS`: JSON map from DuckLake bucket name to Worker R2 binding name, for example `{"<bucket-name>":"DUCKLAKE_R2"}`. Every usable DuckLake data bucket must also appear in `wrangler.jsonc` `r2_buckets`.

Trusted-client lease vars, only needed when using `dataAccessMode: "trusted_client"`:

- `DUCKLAKE_R2_DATA_LEASE_TTL_SECONDS`: trusted-client R2 data lease lifetime in seconds, clamped to 30-120. Default `60`.
- `R2_ACCOUNT_ID`: Cloudflare account id used when locally signing R2 temporary credentials for trusted-client leases.
- `R2_ENDPOINT`: S3-compatible R2 endpoint, for example `https://<account-id>.r2.cloudflarestorage.com`.

Runtime secrets:

- `ADMIN_TOKEN`: bearer secret required for every `/admin/*` route.
- `QUACKLAKE_JWT_SECRET`: HS256 signing key for first-party quacklake JWT credentials.
- `CONNECTION_SIGNING_SECRET`: HMAC secret used to sign Quack connection ids.
- `R2_ACCESS_KEY_ID`: parent R2 S3 access key id used only when issuing trusted-client data leases.
- `R2_SECRET_ACCESS_KEY`: parent R2 S3 secret access key used only when issuing trusted-client data leases.

For local development, create `.dev.vars`:

```dotenv
ADMIN_TOKEN=admin-test-token
QUACKLAKE_JWT_SECRET=replace-with-long-random-local-jwt-secret
CONNECTION_SIGNING_SECRET=replace-with-long-random-local-signing-secret
# Optional, only needed when testing catalogs created with dataAccessMode=trusted_client:
R2_ACCESS_KEY_ID=replace-with-r2-access-key-id
R2_SECRET_ACCESS_KEY=replace-with-r2-secret-access-key
```

For deployed Workers, set the same names as Worker secrets. The default Worker name in `wrangler.example.jsonc` is `quacklake`; omit `--name quacklake` only when your local `wrangler.jsonc` already targets the deployed Worker you want to configure.

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

Each command prompts for the secret value. `ADMIN_TOKEN` is the value that admin clients must send as `Authorization: Bearer <ADMIN_TOKEN>`, including `scripts/create-jwt.sh --admin-token <ADMIN_TOKEN>`. `QUACKLAKE_JWT_SECRET` signs first-party JWT credentials; rotating it invalidates previously issued first-party JWTs. `CONNECTION_SIGNING_SECRET` signs Quack connection ids; rotating it invalidates active client sessions. The R2 parent key secrets are needed only when using `dataAccessMode: "trusted_client"` and `POST /catalog/data-lease`.

Verify deployed secret names without printing values:

```sh
pnpm exec wrangler secret list --name quacklake
```

If a deployed `/admin/*` request returns `{"error":"ADMIN_TOKEN is not configured"}`, the deployed Worker does not have the `ADMIN_TOKEN` secret bound. Set or rotate it with `wrangler secret put`, then retry the admin call.

## Local Worker

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

## API Docs

The Admin API OpenAPI v3 document is available without admin authentication:

```sh
curl http://localhost:8787/api-docs
```

Use the OpenAPI document for exact request and response schemas. The human guides are intended to explain workflows and operational choices.

## First Local Catalog

Create a catalog and bootstrap credential:

```sh
curl -s -X POST http://localhost:8787/admin/catalogs \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"catalogId":"default","scopes":["catalog.admin"]}'
```

Install a permissive local bootstrap policy:

```sh
curl -s -X PUT http://localhost:8787/admin/catalogs/default/auth-policy \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"defaultEffect":"allow","rules":[]}'
```

For production-style auth setup, use [Authn/Authz Guide](./authn-authz.md).

## R2 And Smoke Workflows

Catalog creation assigns a planned R2 `DATA_PATH` with the fixed shape `r2://<bucket>/catalogs/<catalogId>/`. DuckLake metadata writes must use that exact path.

For deployed DuckLake catalogs, the Worker R2 bucket binding is used for catalog bucket registration, planned path validation, diagnostics, and trusted-client lease validation. DuckLake data-file reads, writes, and orphan cleanup run in the DuckDB client with its own scoped R2/S3 credentials. See [Quack, DuckLake, And R2 Guide](./quack-ducklake.md) for storage secrets, Worker R2 binding setup, trusted-client leases, `DATA_PATH` behavior, bucket listing, and diagnostics.
