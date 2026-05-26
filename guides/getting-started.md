# Getting Started Guide

This guide walks through the smallest production-style quacklake deployment:
one deployed Cloudflare Worker named `quacklake`, one R2 bucket, first-party
quacklake JWT auth, default `catalog_only` data access, and a DuckDB CLI
client that uses its own R2 S3 API credentials for DuckLake data files.

It intentionally does not cover local development, OIDC, trusted-client data
leases, multiple buckets, or advanced policy design. Use the
[Local Development And Configuration Guide](./local-development.md),
[Authn/Authz Guide](./authn-authz.md), and
[Quack, DuckLake, And R2 Guide](./quack-ducklake.md) for those workflows.

## Prerequisites

- A Cloudflare account.
- Node.js 22 or newer and `pnpm`.
- DuckDB CLI with access to `httpfs` and the `core_nightly` builds of the
  `quack` and `ducklake` extensions. The stable extension builds may be missing
  bugfixes required by this guide.
- `jq` for the shell examples.
- One Cloudflare R2 bucket for DuckLake data files.
- An R2 S3 API token for the DuckDB client. This is separate from Worker
  secrets and should be scoped as narrowly as your Cloudflare setup allows.

The guide assumes these shell variables:

```sh
export R2_BUCKET=quacklake-lake
export CATALOG_ID=getting_started
export QUACKLAKE_URL=https://quacklake.<your-subdomain>.workers.dev
export ADMIN_TOKEN=<long-random-admin-token>
export R2_ACCOUNT_ID=<cloudflare-account-id>
export R2_ACCESS_KEY_ID=<client-r2-access-key-id>
export R2_SECRET_ACCESS_KEY=<client-r2-secret-access-key>
```

`ADMIN_TOKEN`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` are secret values.
Do not commit them, paste them into tickets, or leave generated temp files in
shared locations.

## Deploy The Worker

Install dependencies:

```sh
pnpm install
```

Copy the tracked Wrangler template:

```sh
cp wrangler.example.jsonc wrangler.jsonc
```

Create the R2 bucket:

```sh
pnpm exec wrangler r2 bucket create "$R2_BUCKET"
```

If you intentionally want a jurisdiction-restricted bucket, create it with the
same jurisdiction you will put in `wrangler.jsonc`, for example:

```sh
pnpm exec wrangler r2 bucket create "$R2_BUCKET" --jurisdiction eu
```

Edit `wrangler.jsonc` so `DUCKLAKE_R2_BINDINGS` and `r2_buckets[0].bucket_name`
use the bucket you created:

```jsonc
{
  "name": "quacklake",
  "vars": {
    "DUCKLAKE_R2_BINDINGS": "{\"quacklake-lake\":\"DUCKLAKE_R2\"}"
  },
  "r2_buckets": [
    {
      "binding": "DUCKLAKE_R2",
      "bucket_name": "quacklake-lake"
    }
  ]
}
```

Remove the example `jurisdiction` line unless the bucket was created with that
same jurisdiction. A mismatch points the Worker binding at a different R2
location than the DuckDB client is using.

Set the required Worker secrets. Each command prompts for the value:

```sh
pnpm exec wrangler secret put ADMIN_TOKEN --name quacklake
pnpm exec wrangler secret put QUACKLAKE_JWT_SECRET --name quacklake
pnpm exec wrangler secret put CONNECTION_SIGNING_SECRET --name quacklake
```

Use the same `ADMIN_TOKEN` value in your shell and in the deployed Worker secret.
Use long random values for `QUACKLAKE_JWT_SECRET` and
`CONNECTION_SIGNING_SECRET`.

Deploy:

```sh
pnpm run deploy
```

Verify the Worker health endpoint:

```sh
curl -s "$QUACKLAKE_URL/" | jq .
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

Verify the Worker can see the configured R2 bucket binding:

```sh
curl -s "$QUACKLAKE_URL/admin/r2-buckets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq .
```

The bucket entry for `$R2_BUCKET` should report `available: true`.

## Create The Catalog And Policy

Create the catalog first and keep the Admin API response. This response contains
the only copy of the first JWT, plus generated DuckLake bootstrap SQL whose
paths must match the catalog planned `DATA_PATH`.

Because this guide configures exactly one R2 bucket, the create request does not
need an explicit `r2Bucket`. Because this guide uses the default `catalog_only`
mode, it also does not set `dataAccessMode`.

```sh
CREATE_RESPONSE_FILE="/tmp/quacklake-$CATALOG_ID-create.json"

curl -sS -X POST "$QUACKLAKE_URL/admin/catalogs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$(jq -n --arg catalogId "$CATALOG_ID" '{
    catalogId: $catalogId,
    scopes: ["catalog.admin"],
    expiresInSeconds: 31536000
  }')" > "$CREATE_RESPONSE_FILE"

chmod 600 "$CREATE_RESPONSE_FILE"
```

Inspect only non-secret fields:

```sh
jq '{
  catalog,
  credential: {
    credentialId: .credentialId,
    expiresAt: .credential.expiresAt
  },
  ducklake: {
    secretName: .ducklake.secretName,
    quackScope: .ducklake.quackScope,
    dataPath: .ducklake.dataPath
  }
}' "$CREATE_RESPONSE_FILE"
```

Extract the generated SQL and data path into local temp files:

```sh
SECRET_SQL_FILE="/tmp/quacklake-$CATALOG_ID-secret.sql"
ATTACH_SQL_FILE="/tmp/quacklake-$CATALOG_ID-attach.sql"
DATA_PATH_FILE="/tmp/quacklake-$CATALOG_ID-data-path.txt"

jq -r '.ducklake.secretSql' "$CREATE_RESPONSE_FILE" > "$SECRET_SQL_FILE"
jq -r '.ducklake.attachSql' "$CREATE_RESPONSE_FILE" > "$ATTACH_SQL_FILE"
jq -r '.catalog.dataPath' "$CREATE_RESPONSE_FILE" > "$DATA_PATH_FILE"

chmod 600 "$SECRET_SQL_FILE" "$ATTACH_SQL_FILE" "$DATA_PATH_FILE"
```

Treat `ducklake.secretSql`, `ducklake.attachSql`, raw JWTs, and these temp files
as secret material. `secretSql` contains a one-time-visible JWT. `attachSql`
contains the exact catalog path and should stay with the same protected setup
files.

Install the broad bootstrap policy and preserve a generated credential summary:

```sh
JWT_SUMMARY_FILE="/tmp/quacklake-$CATALOG_ID.json"

scripts/create-jwt.sh \
  --worker-url "$QUACKLAKE_URL" \
  --admin-token "$ADMIN_TOKEN" \
  --catalog-id "$CATALOG_ID" \
  --output-file "$JWT_SUMMARY_FILE"

chmod 600 "$JWT_SUMMARY_FILE"
```

`scripts/create-jwt.sh` creates the catalog if needed. In this guide the catalog
was created first on purpose, because the initial `POST /admin/catalogs`
response includes generated `ducklake.secretSql` and `ducklake.attachSql`.
Because the catalog already exists, the script issues another credential and
replaces the catalog policy with a broad `catalog.admin` policy suitable for this
single-operator walkthrough. The terminal output and `$JWT_SUMMARY_FILE` contain
raw JWT material.

If the catalog already existed before you started this guide, use the
`CREATE SECRET` and `ATTACH` statements printed by `scripts/create-jwt.sh`. The
script looks up the stored planned path from `GET /admin/catalogs` before
printing the `ATTACH` statement. To inspect that path manually:

```sh
curl -s "$QUACKLAKE_URL/admin/catalogs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq -r --arg catalogId "$CATALOG_ID" \
    '.catalogs[] | select(.catalogId == $catalogId) | .dataPath'
```

The generated attach statement has this shape:

```sql
ATTACH 'ducklake:quack:<worker-host>:443' AS lake (
  DATA_PATH 'r2://<bucket>/catalogs/<catalogId>/'
);
```

## Connect From DuckDB

Start the DuckDB CLI:

```sh
duckdb
```

Install and load the required extensions. Use `core_nightly` for `quack` and
`ducklake`; those builds contain bugfixes that quacklake currently depends on:

```sql
INSTALL httpfs;
FORCE INSTALL quack FROM core_nightly;
FORCE INSTALL ducklake FROM core_nightly;

LOAD httpfs;
LOAD quack;
LOAD ducklake;
```

From a shell, print the generated Quack secret from `$SECRET_SQL_FILE`, then
paste it into DuckDB when using the first catalog credential:

```sh
cat "$SECRET_SQL_FILE"
```

It will look like this:

```sql
CREATE OR REPLACE SECRET quacklake_getting_started (
  TYPE quack,
  TOKEN '<jwt>',
  SCOPE 'quack:<worker-host>:443'
);
```

From a shell, print the generated catalog data path:

```sh
cat "$DATA_PATH_FILE"
```

In DuckDB, create the client-side R2 storage secret with that value as `SCOPE`:

```sql
CREATE OR REPLACE SECRET lake_r2 (
  TYPE r2,
  KEY_ID '<client-r2-access-key-id>',
  SECRET '<client-r2-secret-access-key>',
  ACCOUNT_ID '<cloudflare-account-id>',
  SCOPE 'r2://<bucket>/catalogs/<catalogId>/'
);
```

These R2 S3 API credentials belong to the DuckDB client. Do not configure them
as Worker secrets for this `catalog_only` setup.

From a shell, print the generated DuckLake attachment from `$ATTACH_SQL_FILE`,
then paste it into DuckDB so the attached `DATA_PATH` exactly matches
quacklake's planned path:

```sh
cat "$ATTACH_SQL_FILE"
```

It will look like this:

```sql
ATTACH 'ducklake:quack:<worker-host>:443' AS lake (
  DATA_PATH 'r2://<bucket>/catalogs/<catalogId>/'
);
```

## Run A Smoke Query

Create a schema and a small table:

```sql
CREATE SCHEMA lake.getting_started;

CREATE TABLE lake.getting_started.items (
  id INTEGER,
  label VARCHAR
);

INSERT INTO lake.getting_started.items VALUES
  (1, 'alpha'),
  (2, 'bravo'),
  (3, 'charlie');

SELECT * FROM lake.getting_started.items ORDER BY id;
```

Flush inlined DuckLake data so the client writes data files under the scoped R2
path:

```sql
CALL ducklake_flush_inlined_data('lake');
```

Create a table from a public Parquet file:

```sql
CREATE TABLE lake.getting_started.cloud_provider_ip_ranges AS
SELECT *
FROM read_parquet('https://raw.githubusercontent.com/tobilg/public-cloud-provider-ip-ranges/main/data/providers/all.parquet');
```

Verify the table shape and row count:

```sql
DESCRIBE lake.getting_started.cloud_provider_ip_ranges;

SELECT COUNT(*) AS ip_range_count
FROM lake.getting_started.cloud_provider_ip_ranges;
```

Optionally flush again after the larger insert:

```sql
CALL ducklake_flush_inlined_data('lake');
```

At this point quacklake is authorizing DuckLake metadata operations through
the first-party JWT and catalog policy, while DuckDB is reading and writing data
files directly through its own scoped R2 credentials.
