# Quack, DuckLake, And R2 Guide

This guide covers client-facing Quack usage, DuckLake attachment, R2-backed data-path requirements, trusted-client R2 data leases, and operational R2 diagnostics.

## Quack Secret

Use a quacklake JWT as the Quack secret token value expected by DuckDB's Quack extension:

```sql
CREATE OR REPLACE SECRET quacklake_catalog (
  TYPE quack,
  TOKEN '<jwt>',
  SCOPE 'quack:<worker-host>:443'
);
```

The Quack extension accepts `TOKEN` and optional `SCOPE` for `TYPE quack` secrets. It does not accept an `ENDPOINT` parameter. Use the Quack URI form in the scope and in DuckLake attachments; for a deployed HTTPS Worker, that is usually `quack:<worker-host>:443`.

The token can be either:

- A first-party quacklake JWT returned by the Admin API.
- A third-party OIDC access token that verifies against a configured provider and maps to exactly one catalog.

See [Authn/Authz Guide](./authn-authz.md) for credential issuance, OIDC setup, catalog mappings, policies, and troubleshooting.

## SDK Usage

Application code can use the published Quack SDK:

```ts
import { QuackClient } from "@quack-protocol/sdk";

const client = await QuackClient.connect("https://<worker-host>", {
  authToken: process.env.QUACK_JWT
});

try {
  const result = await client.query("SELECT 1 AS value");
  console.log(result.rows());
} finally {
  await client.disconnect();
}
```

## DuckLake Attachment

For DuckLake, create one Quack secret per catalog credential. `POST /admin/catalogs` returns `ducklake.secretSql` and `ducklake.attachSql` with the correct Quack scope and planned data path. `ducklake.secretSql` contains the one-time-visible JWT and must be treated as secret material.

In the default `catalog_only` mode, also create a separate storage secret for the planned data path:

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

quacklake authenticates and authorizes metadata-catalog operations. The DuckDB/DuckLake client still reads and writes data files with its own object-store credentials. Scope those storage credentials to the intended bucket and prefix.

## Client R2 Credentials

DuckDB needs R2 S3 API credentials for normal DuckLake data-file reads and writes. These credentials are client-side credentials; quacklake does not receive or store them.

Create a scoped R2 S3 API token in Cloudflare, then keep these values in your local shell, `.dev.vars`, CI secret store, or application secret manager:

```dotenv
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_BUCKET=<bucket>
R2_PREFIX=<prefix/>
```

`R2_ENDPOINT` is optional. If omitted, the smoke script uses `<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`.

```dotenv
R2_ENDPOINT=<account-id>.r2.cloudflarestorage.com
```

The R2 smoke script also accepts AWS-compatible aliases:

| quacklake variable | Alias | Used for |
|------------------------|-------|----------|
| `R2_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` | DuckDB `KEY_ID` for the `TYPE r2` or `TYPE s3` storage secret. |
| `R2_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` | DuckDB `SECRET` for the storage secret. |
| `R2_ACCOUNT_ID` | `CLOUDFLARE_ACCOUNT_ID` | Default R2 endpoint construction. |
| `R2_ENDPOINT` | `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL` | Explicit R2 S3 API endpoint. |
| `R2_BUCKET` | `R2_BUCKET_NAME` | Bucket used for `DATA_PATH` in smoke workflows. |

Example DuckDB storage secret using the same values:

```sql
CREATE OR REPLACE SECRET lake_r2 (
  TYPE r2,
  KEY_ID '<r2-access-key-id>',
  SECRET '<r2-secret-access-key>',
  ACCOUNT_ID '<cloudflare-account-id>',
  SCOPE 'r2://<bucket>/<prefix>/'
);
```

If your DuckDB build uses the generic S3 secret path instead of `TYPE r2`, use:

```sql
CREATE OR REPLACE SECRET lake_r2 (
  TYPE s3,
  PROVIDER config,
  KEY_ID '<r2-access-key-id>',
  SECRET '<r2-secret-access-key>',
  ENDPOINT '<account-id>.r2.cloudflarestorage.com',
  URL_STYLE 'path',
  REGION 'auto',
  SCOPE 'r2://<bucket>/<prefix>/'
);
```

Do not configure these R2 S3 API keys as Worker secrets for `read_blob()`. The Worker-side `read_blob()` path below uses an R2 binding instead. Configure parent R2 S3 keys as Worker secrets only when using trusted-client leases.

## Trusted-Client R2 Data Leases

`catalog_only` is the default catalog mode. In that mode, quacklake never vends raw R2 credentials and DuckDB clients must create their own storage secret as shown above.

For trusted clients, create the catalog with `dataAccessMode: "trusted_client"`:

```sh
curl -s -X POST https://<worker-host>/admin/catalogs \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"catalogId":"finance","dataAccessMode":"trusted_client","scopes":["catalog.admin"]}'
```

The catalog response includes `catalog.dataPath` and `ducklake.dataPath`. Before or after DuckLake initializes metadata, a client can request a short-lived R2 lease for that planned path with the same token used by the `TYPE quack` secret:

```sh
curl -s -X POST https://<worker-host>/catalog/data-lease \
  -H "Authorization: Bearer $QUACK_JWT" \
  -H "Content-Type: application/json" \
  -d '{"access":"read_write","reason":"execute"}'
```

The request body must not include `catalogId`, `dataPath`, or `ttlSeconds`. The bearer token resolves the catalog. quacklake uses the planned catalog path before metadata initialization; after metadata exists, the stored DuckLake `data_path` must exactly match the planned path. The lease TTL is server-configured.

The response returns secret material once under `credentials`; `duckdb` contains only non-sensitive hints:

```json
{
  "catalogId": "finance",
  "expiresAt": "2026-05-26T12:34:56.000Z",
  "ttlSeconds": 60,
  "dataPath": "r2://finance-lake/catalogs/finance/",
  "access": "read_write",
  "r2": {
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "bucket": "finance-lake",
    "prefix": "catalogs/finance/"
  },
  "credentials": {
    "accessKeyId": "...",
    "secretAccessKey": "...",
    "sessionToken": "..."
  },
  "duckdb": {
    "secretType": "s3",
    "scope": "r2://finance-lake/catalogs/finance/",
    "urlStyle": "path",
    "region": "auto"
  },
  "warning": "These credentials grant raw R2 object access under the catalog data path and do not enforce catalog row or column policies at the storage layer."
}
```

Lease authorization is separate from SQL authz. The resolved principal must have `catalog.admin` or `lake.raw`. A catalog that was not created with `dataAccessMode: "trusted_client"` rejects lease requests even for admin credentials.

Trusted-client lease signing requires these Worker settings:

- `R2_ACCOUNT_ID`: Cloudflare account id.
- `R2_ENDPOINT`: S3-compatible R2 endpoint, for example `https://<account-id>.r2.cloudflarestorage.com`.
- `DUCKLAKE_R2_DATA_LEASE_TTL_SECONDS`: optional lease lifetime in seconds, clamped to 30-120. Default `60`.
- `R2_ACCESS_KEY_ID`: parent R2 S3 access key id, configured as a Worker secret.
- `R2_SECRET_ACCESS_KEY`: parent R2 S3 secret access key, configured as a Worker secret.

For a deployed Worker:

```sh
pnpm exec wrangler secret put R2_ACCESS_KEY_ID --name quacklake
pnpm exec wrangler secret put R2_SECRET_ACCESS_KEY --name quacklake
```

The Worker R2 binding and `DUCKLAKE_R2_BINDINGS` are required. They are the runtime source of truth for bucket listing, planned catalog data path generation, path validation, file listing, and trusted-client leases.

## Planned DATA_PATH Enforcement

Every new catalog receives a fixed planned DuckLake `DATA_PATH`:

```text
r2://<bucket>/catalogs/<catalogId>/
```

If `DUCKLAKE_R2_BINDINGS` contains exactly one bucket, `POST /admin/catalogs` uses it automatically. If multiple buckets are configured, pass `r2Bucket` in the create request. Unknown buckets and buckets whose Worker binding is missing are rejected.

quacklake rejects DuckLake metadata writes that introduce a `data_path` different from the catalog's planned path.

Important vars:

- `DUCKLAKE_R2_BINDINGS`: JSON map from DuckLake bucket name to Worker R2 binding name, for example `{"<bucket-name>":"DUCKLAKE_R2"}`. Every usable DuckLake data bucket must also appear in `wrangler.jsonc` `r2_buckets`.
- `DUCKLAKE_R2_DATA_LEASE_TTL_SECONDS`: trusted-client R2 data lease lifetime in seconds, clamped to 30-120. Default `60`.
- `DUCKLAKE_FILE_LIST_ENDPOINT`: optional sidecar endpoint for local or non-R2 file listing workflows.
- `DUCKLAKE_FILE_LIST_TOKEN`: optional bearer token sent to the file-list sidecar endpoint.

## Worker R2 Access For `read_blob()`

Some DuckLake maintenance functions execute metadata SQL that reads object-store listings through `read_blob()`, for example orphan-file discovery during cleanup. With a Quack catalog, that metadata SQL runs inside quacklake, so the deployed Worker must be able to list the same R2 bucket used by the DuckLake `DATA_PATH`.

For `read_blob()` specifically, Worker-side access is not configured with `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, or `R2_ENDPOINT`. It uses a Cloudflare Workers R2 bucket binding in `wrangler.jsonc`. Trusted-client leases additionally use the parent R2 S3 credentials described above for temporary credential signing.

Create or choose an R2 bucket:

```sh
pnpm exec wrangler r2 bucket create <bucket>
```

For jurisdiction-restricted buckets, use the same jurisdiction when creating the bucket and when binding it:

```sh
pnpm exec wrangler r2 bucket create <bucket> --jurisdiction eu
```

Configure the deployed Worker with a binding and a quacklake bucket-to-binding map:

```jsonc
{
  "vars": {
    "DUCKLAKE_R2_BINDINGS": "{\"<bucket>\":\"DUCKLAKE_R2\"}",
    "R2_ACCOUNT_ID": "<cloudflare-account-id>",
    "R2_ENDPOINT": "https://<cloudflare-account-id>.r2.cloudflarestorage.com"
  },
  "r2_buckets": [
    {
      "binding": "DUCKLAKE_R2",
      "bucket_name": "<bucket>",
      "jurisdiction": "eu"
    }
  ]
}
```

Remove `jurisdiction` when the bucket is not jurisdiction-restricted. `DUCKLAKE_R2_BINDINGS` is required because it is the explicit runtime bucket registry and supports multiple buckets:

```jsonc
{
  "vars": {
    "DUCKLAKE_R2_BINDINGS": "{\"finance-lake\":\"FINANCE_R2\",\"ops-lake\":\"OPS_R2\"}"
  },
  "r2_buckets": [
    { "binding": "FINANCE_R2", "bucket_name": "finance-lake", "jurisdiction": "eu" },
    { "binding": "OPS_R2", "bucket_name": "ops-lake", "jurisdiction": "eu" }
  ]
}
```

After updating `wrangler.jsonc`, redeploy the Worker. Then list configured buckets:

```sh
curl -s "https://<worker-host>/admin/r2-buckets" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Each entry reports `available: true` only when the named Worker binding exists and looks like an R2 bucket binding. Then verify the Worker can see an object under the DuckLake prefix:

```sh
curl -s "https://<worker-host>/admin/r2/diagnostics?path=r2://<bucket>/<prefix>/<object>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

For `read_blob()`-backed orphan cleanup to work, the diagnostic response must show the bucket mapped to a binding. A `424` response means the bucket is not mapped to any Worker R2 binding. A `404` response means the binding exists, but the requested object key is not visible through that binding.

## R2 Diagnostics

Check Worker-side R2 binding access:

```sh
curl -s "http://localhost:8787/admin/r2/diagnostics?path=r2://<bucket>/<key>" \
  -H 'Authorization: Bearer admin-test-token'
```

Successful object response:

```json
{
  "ok": true,
  "path": "r2://bucket/path/file.parquet",
  "scheme": "r2",
  "bucket": "bucket",
  "key": "path/file.parquet",
  "bindingName": "DUCKLAKE_R2",
  "bindingSource": "DUCKLAKE_R2_BINDINGS",
  "object": {
    "exists": true,
    "size": 1234,
    "uploaded": "2026-05-19T10:00:00.000Z",
    "etag": "..."
  }
}
```

Common failure cases:

- `400`: missing `path`/`uri`, or the URI is not `r2://` or `s3://`.
- `404`: the bucket is mapped to a Worker R2 binding, but the requested key is not visible.
- `424`: the bucket is not mapped to a Worker R2 binding.

## File Inventory

Catalog-side file inventory is used by orphan-cleanup diagnostics and tests.

Replace file inventory:

```sh
curl -s -X PUT http://localhost:8787/admin/catalogs/default/files \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "files": [
      {
        "filename": "r2://bucket/lake/a.parquet",
        "lastModified": "2026-05-19T10:00:00.000Z"
      }
    ]
  }'
```

List file inventory:

```sh
curl -s http://localhost:8787/admin/catalogs/default/files \
  -H 'Authorization: Bearer admin-test-token'
```

## Operational Notes

- Keep one catalog id per independent DuckLake `DATA_PATH`.
- Additional credentials for a catalog are credential rotations or app-specific credentials; they do not create a new metadata store.
- Storage credentials must be scoped separately for true data-file protection.
- Trusted-client leases are short-lived raw R2 credentials. They do not enforce row or column policy at the storage layer.
- quacklake is not a data-file gateway.
