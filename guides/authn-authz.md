# Authn/Authz Guide

JWTs are supplied as the Quack auth string, including DuckDB `CREATE SECRET (TYPE quack, TOKEN '<jwt>')` usage. A valid JWT resolves to one catalog Durable Object and one normalized principal. quacklake then evaluates the catalog's server-side authorization policy before executing catalog SQL or append requests.

## Authentication Model

There are two accepted JWT classes:

- First-party quacklake credentials, issued by `POST /admin/catalogs` or `POST /admin/catalogs/:catalogId/credentials`.
- Third-party OIDC JWTs from configured providers such as Entra ID or Cognito.

All valid JWTs normalize into this principal shape:

```ts
interface AuthPrincipal {
  issuer: string;
  subject: string;
  audience: string[];
  scopes: string[];
  groups: string[];
  roles: string[];
  claims: Record<string, unknown>;
  credentialId?: string;
  providerId: string;
  authMode: "first_party_jwt" | "oidc_jwt";
}
```

Provider trust, catalog selection, and authorization are separate:

- OIDC provider config decides whether an external JWT is authentic.
- Catalog auth mappings decide which verified external principals may select a catalog.
- Catalog auth policies decide what a principal may do inside the selected catalog.

First-party quacklake JWTs include:

```json
{
  "iss": "quacklake",
  "aud": "quacklake:quack",
  "sub": "credential:<credentialId>",
  "jti": "<credentialId>",
  "catalog_id": "<catalogId>",
  "scope": "catalog.admin",
  "iat": 1760000000,
  "exp": 1791536000
}
```

The registry stores credential metadata and revocation state. It never stores raw JWTs.

## JWT Claims To Policy Matching

Authorization policies do not evaluate raw JWTs directly. quacklake first verifies the JWT, normalizes it into `AuthPrincipal`, then evaluates each policy rule's `principal` block against that normalized principal.

First-party credentials issued by quacklake map like this:

| JWT claim or registry field | Normalized principal field | Notes |
| --- | --- | --- |
| `iss` | `principal.issuer` | Must match `QUACKLAKE_JWT_ISSUER`, default `quacklake`. |
| `sub` | `principal.subject` | Must be `credential:<credentialId>`. |
| `aud` | `principal.audience[]` | Must match `QUACKLAKE_JWT_AUDIENCE`, default `quacklake:quack`. |
| `scope` | `principal.scopes[]` | Space-separated string in the JWT, such as `catalog.admin alice.read`. |
| `jti` | `principal.credentialId` | Must exist in the registry and must not be revoked. |
| `catalog_id` | Catalog selection | Must match the stored credential's catalog id. |
| whole payload | `principal.claims` | Includes first-party claims such as `catalog_id`, `scope`, `jti`, `iss`, `sub`, and `aud`. |

OIDC JWTs use the provider's `claimMapping` before policy evaluation:

| Provider `claimMapping` key | Normalized principal field | Default source |
| --- | --- | --- |
| `subject` | `principal.subject` | `sub` |
| `scopes` | `principal.scopes[]` | `scope`, then fallback to `scp` |
| `groups` | `principal.groups[]` | `groups` |
| `roles` | `principal.roles[]` | `roles` |
| Any other key, such as `tenantId` | `principal.claims.<key>` | The configured source claim path. |

Claim mapping sources can use dot paths for nested claims, for example `"tenantId": "custom.tenant_id"`. Scope, group, and role values may be arrays or strings. String scopes are split on whitespace, so `"read write"` becomes `["read", "write"]`.

A policy rule's `principal` block is an AND across the match properties that are present:

```json
{
  "principal": {
    "subjectsAny": ["credential:..."],
    "issuersAny": ["quacklake"],
    "scopesAny": ["alice.read", "catalog.admin"],
    "groupsAll": ["finance", "eu"],
    "rolesAny": ["ducklake-maintainer"],
    "claims": {
      "tenantId": "tenant-a"
    }
  }
}
```

Match semantics:

- `subjectsAny` matches `principal.subject`.
- `issuersAny` matches `principal.issuer`.
- `scopesAny`, `groupsAny`, and `rolesAny` require at least one listed value.
- `scopesAll`, `groupsAll`, and `rolesAll` require every listed value.
- `claims` requires exact equality against `principal.claims` values by key.
- If `principal` is omitted or `{}`, the rule applies to any authenticated principal that reaches that catalog.

Resource and action checks happen after principal matching. A rule must match the principal, the required action, and the required resource. Deny rules are evaluated before allow rules, so a matching deny overrides matching allow rules.

Row predicates also reference normalized claims. A rule with:

```json
{
  "rowPredicate": "tenant_id = ${claims.tenantId}"
}
```

only matches when `principal.claims.tenantId` is present. In v1 this is a catalog-side authorization gate; storage credentials still need to be scoped separately for data-file protection.

## Configuration Checklist

For a production deployment, configure these pieces in order:

1. Set `ADMIN_TOKEN`, `QUACKLAKE_JWT_SECRET`, and `CONNECTION_SIGNING_SECRET`.
2. Set `QUACKLAKE_JWT_ISSUER` and `QUACKLAKE_JWT_AUDIENCE` to stable deployment-specific values before issuing first-party credentials.
3. Create one quacklake catalog per independent DuckLake `DATA_PATH`.
4. Install a catalog auth policy before handing credentials to users or applications. Missing policy denies all catalog SQL and append requests.
5. For first-party credentials, distribute only the returned `jwt` value. It is shown once.
6. For OIDC, create one provider record per trusted issuer, then create catalog auth mappings that select exactly one catalog per matching principal.
7. Scope object-storage credentials separately. quacklake authorizes catalog metadata operations; it does not prevent a client with broad R2/S3 keys from reading or writing data files directly.

First-party JWT issuer and audience are part of credential validation. If either changes after credentials are issued, those credentials stop working and must be reissued. `CONNECTION_SIGNING_SECRET` signs active Quack session ids; rotating it invalidates active sessions but does not change stored credential records.

For the default deployed Worker name, configure the required secrets with:

```sh
pnpm exec wrangler secret put ADMIN_TOKEN --name quacklake
pnpm exec wrangler secret put QUACKLAKE_JWT_SECRET --name quacklake
pnpm exec wrangler secret put CONNECTION_SIGNING_SECRET --name quacklake
```

The admin token is not created by `scripts/create-jwt.sh`. The script only sends the bearer value to `/admin/*`; that value must exactly match the deployed `ADMIN_TOKEN` secret. Use a long random value, store it in a secret manager, and rotate it if it appears in shell history, logs, or chat.

## Admin Authentication

All `/admin/*` routes require:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

The complete machine-readable Admin API is available from:

```sh
curl http://localhost:8787/api-docs
```

## Personal JWT Script

For an already deployed Worker, `scripts/create-jwt.sh` creates a first-party quacklake JWT for personal use and installs a matching catalog auth policy. It does not configure OIDC providers or mappings.

Default behavior:

- Uses `CATALOG_ID=personal`.
- Creates the catalog with `POST /admin/catalogs` when it does not exist.
- If the catalog already exists, issues another independently revocable credential with `POST /admin/catalogs/:catalogId/credentials`.
- Issues a JWT with `expiresInSeconds: 31536000`, which is 365 days.
- Uses `PERSONAL_SCOPE=catalog.admin` for both the JWT scope and the policy principal match.
- Replaces the catalog's auth policy with a personal-use policy.
- Prints the one-time-visible JWT, a DuckDB `CREATE SECRET` statement, and a DuckLake `ATTACH` statement with the catalog's planned `DATA_PATH`.

Run it with environment variables:

```sh
QUACKLAKE_URL=https://<worker-host> \
ADMIN_TOKEN=<admin-token> \
scripts/create-jwt.sh
```

Or pass explicit flags:

```sh
scripts/create-jwt.sh \
  --worker-url https://<worker-host> \
  --admin-token <admin-token> \
  --catalog-id personal \
  --output-file /tmp/quacklake-personal.json
```

The `--output-file` value receives a JSON document containing the catalog id, scope, credential id, expiry, Worker URL, Quack URI, planned DuckLake `DATA_PATH`, raw JWT, and generated SQL. Treat that file as a secret:

```json
{
  "catalogId": "personal",
  "scope": "catalog.admin",
  "ttlSeconds": 31536000,
  "credentialId": "...",
  "expiresAt": "2027-05-19T...",
  "workerUrl": "https://<worker-host>",
  "quackUri": "quack:<worker-host>:443",
  "dataPath": "r2://<bucket>/catalogs/personal/",
  "jwt": "<jwt>",
  "duckdb": {
    "secretSql": "CREATE OR REPLACE SECRET quacklake_personal (TYPE quack, TOKEN '<jwt>', SCOPE 'quack:<worker-host>:443');"
  },
  "ducklake": {
    "attachSql": "ATTACH 'ducklake:quack:<worker-host>:443' AS lake (DATA_PATH 'r2://<bucket>/catalogs/personal/');"
  }
}
```

The installed policy is intentionally broad for a trusted personal credential. It uses `defaultEffect: "deny"` and one allow rule for the configured scope. The allow rule grants:

- Schema read/create/drop.
- Table read/create/insert/update/delete/drop.
- Column read/alter.
- `catalog.admin` for DuckLake metadata maintenance operations that quacklake classifies as catalog administration.

Equivalent policy:

```json
{
  "version": 1,
  "defaultEffect": "deny",
  "rules": [
    {
      "ruleId": "personal-table-crud-and-query-all",
      "effect": "allow",
      "principal": {
        "scopesAny": ["catalog.admin"]
      },
      "actions": [
        "schema.read",
        "schema.create",
        "schema.drop",
        "table.read",
        "table.create",
        "table.insert",
        "table.update",
        "table.delete",
        "table.drop",
        "column.read",
        "column.alter",
        "catalog.admin"
      ],
      "resource": {
        "schema": "*",
        "table": "*",
        "column": "*"
      }
    }
  ]
}
```

Create the DuckDB Quack secret from the script output:

```sql
CREATE OR REPLACE SECRET quacklake_personal (
  TYPE quack,
  TOKEN '<jwt>',
  SCOPE 'quack:<worker-host>:443'
);
```

For DuckDB's Quack extension, `SCOPE` is the Quack URI used by `ATTACH` and `TOKEN` is the JWT. The extension does not accept an `ENDPOINT` parameter for `TYPE quack`.

Useful overrides:

```sh
scripts/create-jwt.sh \
  --worker-url https://<worker-host> \
  --admin-token <admin-token> \
  --catalog-id alice \
  --scope personal.admin \
  --ttl-seconds 31536000
```

Changing `--scope` changes both the issued JWT scope and the policy's `scopesAny` match. Changing `--catalog-id` selects or creates a different quacklake catalog and therefore a different DuckLake metadata store.

## End-To-End First-Party Setup

This flow creates a new catalog, installs a bootstrap admin policy, and connects with the returned quacklake JWT.

Set shell variables:

```sh
WORKER=http://localhost:8787
ADMIN_TOKEN=admin-test-token
CATALOG_ID=finance
```

Create the catalog and first credential:

```sh
CREATE_RESPONSE="$(
  curl -s -X POST "$WORKER/admin/catalogs" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{
      \"catalogId\": \"$CATALOG_ID\",
      \"scopes\": [\"catalog.admin\"],
      \"expiresInSeconds\": 31536000
    }"
)"

echo "$CREATE_RESPONSE"
```

Extract and store the JWT in your application secret manager:

```sh
QUACK_JWT="$(printf '%s' "$CREATE_RESPONSE" | jq -r '.jwt')"
```

Install a permissive bootstrap policy for initial DuckLake catalog setup:

```sh
curl -s -X PUT "$WORKER/admin/catalogs/$CATALOG_ID/auth-policy" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 1,
    "defaultEffect": "allow",
    "rules": []
  }'
```

After the catalog is initialized, replace the permissive policy with a narrower policy from the cookbook below.

Create the Quack secret in DuckDB:

```sql
CREATE OR REPLACE SECRET quacklake_finance (
  TYPE quack,
  TOKEN '<jwt>',
  SCOPE 'quack:<worker-host>:443'
);
```

For application code using the Quack SDK:

```ts
import { QuackClient } from "@quack-protocol/sdk";

const client = await QuackClient.connect("https://<worker-host>", {
  authToken: process.env.QUACK_JWT
});

const result = await client.query("SELECT 1");
await client.disconnect();
```

## First-Party Credential Routes

Create a catalog:

```sh
curl -s -X POST http://localhost:8787/admin/catalogs \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"catalogId":"default","scopes":["catalog.admin"]}'
```

Response includes the only copy of the raw JWT:

```json
{
  "catalog": {
    "catalogId": "default",
    "objectName": "catalog:default",
    "createdAt": "...",
    "updatedAt": "..."
  },
  "credential": {
    "credentialId": "...",
    "catalogId": "default",
    "issuer": "quacklake",
    "subject": "credential:...",
    "scopes": ["catalog.admin"],
    "createdAt": "...",
    "expiresAt": "..."
  },
  "credentialId": "...",
  "jwt": "<jwt>"
}
```

Creating the same `catalogId` again returns `409 Conflict`. Use the credential endpoint when you intentionally want another independently revocable JWT for the same catalog.

List catalogs:

```sh
curl -s http://localhost:8787/admin/catalogs \
  -H 'Authorization: Bearer admin-test-token'
```

Create another credential for an existing catalog:

```sh
curl -s -X POST http://localhost:8787/admin/catalogs/default/credentials \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"scopes":["catalog.admin"],"expiresInSeconds":31536000}'
```

This does not create a fresh DuckLake catalog. The returned JWT still routes to `catalog:default`, including any existing DuckLake metadata and stored `DATA_PATH`.

List credentials:

```sh
curl -s http://localhost:8787/admin/catalogs/default/credentials \
  -H 'Authorization: Bearer admin-test-token'
```

This returns credential ids and metadata, not raw JWT values.

Revoke a credential:

```sh
curl -s -X DELETE http://localhost:8787/admin/catalogs/default/credentials/<credentialId> \
  -H 'Authorization: Bearer admin-test-token'
```

Revocation prevents new sessions with that JWT. Existing signed Quack sessions are not revoked mid-session.

## OIDC Providers

Provider routes:

- `POST /admin/oidc/providers`
- `GET /admin/oidc/providers`
- `GET /admin/oidc/providers/:providerId`
- `PUT /admin/oidc/providers/:providerId`
- `DELETE /admin/oidc/providers/:providerId`

Deleting a provider returns `409 Conflict` while any catalog auth mapping references it.

Create an Entra ID provider:

```sh
curl -s -X POST http://localhost:8787/admin/oidc/providers \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "providerId": "entra-prod",
    "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
    "jwksUri": "https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys",
    "audiences": ["api://quacklake"],
    "algorithms": ["RS256"],
    "clockToleranceSeconds": 60,
    "claimMapping": {
      "subject": "sub",
      "scopes": "scp",
      "groups": "groups",
      "roles": "roles",
      "tenantId": "tid"
    }
  }'
```

Entra ID notes:

- Use the tenant-specific v2 issuer: `https://login.microsoftonline.com/<tenant-id>/v2.0`.
- The JWKS URI is normally `https://login.microsoftonline.com/<tenant-id>/discovery/v2.0/keys`.
- `scp` is the usual delegated-scope claim. Application roles usually appear in `roles`.
- Group claims use object ids and may require group-claim configuration in the app registration.
- The `audiences` entry must match the API/application ID URI or client id in the token's `aud` claim.

For a full operator walkthrough with Entra app registration, permission profiles, row and column policy examples, and end-user DuckLake queries, see [Microsoft Entra ID End-To-End Guide](./entraid-e2e-md).

Create a Cognito provider:

```sh
curl -s -X POST http://localhost:8787/admin/oidc/providers \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "providerId": "cognito-prod",
    "issuer": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE",
    "jwksUri": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE/.well-known/jwks.json",
    "audiences": ["4exampleclientid9example"],
    "algorithms": ["RS256"],
    "clockToleranceSeconds": 60,
    "claimMapping": {
      "subject": "sub",
      "scopes": "scope",
      "groups": "cognito:groups",
      "roles": "cognito:roles",
      "tenantId": "custom:tenant_id"
    }
  }'
```

Cognito notes:

- The issuer is `https://cognito-idp.<region>.amazonaws.com/<user-pool-id>`.
- The JWKS URI appends `/.well-known/jwks.json` to the issuer.
- quacklake verifies the standard JWT `aud` claim. The helper scripts below use Cognito ID tokens because their `aud` is the app client id. If you use Cognito access tokens instead, make sure the token has the intended API audience in `aud`, not only `client_id`.
- Cognito groups are commonly in `cognito:groups`.
- Custom attributes use the `custom:<name>` claim form, such as `custom:tenant_id`.
- ID tokens are authentication tokens. The examples below authorize them through Cognito groups and quacklake catalog policy, not OAuth scopes.

## AWS Cognito Helper Scripts

The repository includes two helper scripts for a Cognito-backed OIDC setup:

- `scripts/setup-cognito.sh`: uses the AWS CLI to create or reuse Cognito resources.
- `scripts/setup-cognito-user.sh`: uses the AWS CLI to create/update one user and add or remove that user from one Cognito group.
- `scripts/register-cognito-idp.sh`: calls the quacklake Admin API to register that Cognito user pool, map Cognito groups to a catalog, and install generated policy rules.

For a full operator walkthrough with permission profiles, row and column policy examples, and end-user DuckLake queries, see [Cognito End-To-End Guide](./cognito-e2e.md).

The split keeps AWS account changes separate from quacklake registry changes. The Cognito setup script does not need the quacklake admin token, and the quacklake registration script does not need AWS credentials.

The scripts use AWS CLI Cognito user-pool operations such as `create-user-pool`, `create-user-pool-client`, `create-group`, `admin-create-user`, `admin-set-user-password`, `admin-add-user-to-group`, and `initiate-auth`. AWS documents these commands in the AWS CLI Cognito command reference:

- <https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/create-user-pool.html>
- <https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/create-user-pool-client.html>
- <https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/create-group.html>
- <https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/admin-create-user.html>
- <https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/admin-set-user-password.html>
- <https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/admin-add-user-to-group.html>
- <https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/initiate-auth.html>

### 1. Create Cognito Resources

Create a user pool, an app client without a client secret, and the default quacklake groups:

```sh
scripts/setup-cognito.sh \
  --region us-east-1 \
  --pool-name quacklake-prod \
  --client-name quacklake-quack \
  --readers-group quacklake-readers \
  --admins-group quacklake-admins \
  --output-file quacklake-cognito.json
```

The app client enables `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_USER_SRP_AUTH`, and `ALLOW_REFRESH_TOKEN_AUTH`. It is created without a client secret so local smoke tests can use `aws cognito-idp initiate-auth` without computing a `SECRET_HASH`.

The output file is not a secret by itself. It contains identifiers that the registration script needs:

```json
{
  "region": "us-east-1",
  "userPoolName": "quacklake-prod",
  "userPoolId": "us-east-1_EXAMPLE",
  "issuer": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE",
  "jwksUri": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE/.well-known/jwks.json",
  "appClientName": "quacklake-quack",
  "appClientId": "4exampleclientid9example",
  "audience": "4exampleclientid9example",
  "tokenType": "id_token",
  "readersGroup": "quacklake-readers",
  "adminsGroup": "quacklake-admins",
  "createdUserPool": true
}
```

For a quick smoke test while creating the pool, `scripts/setup-cognito.sh` can also create a permanent-password test user:

```sh
scripts/setup-cognito.sh \
  --region us-east-1 \
  --pool-name quacklake-prod \
  --test-username reader@example.com \
  --test-password 'ChangeMe123!' \
  --test-user-group readers \
  --output-file quacklake-cognito.json
```

Use `--test-user-group admins` for an admin test user, or `--test-user-group both` for a user that should match both generated quacklake rules. For production, create users and group membership through your normal IAM/IaC workflow instead of committing usernames or passwords to scripts.

To add or remove users later without changing pool, client, or provider setup, use the focused user helper:

```sh
scripts/setup-cognito-user.sh \
  --region us-east-1 \
  --user-pool-id us-east-1_EXAMPLE \
  --username reader@example.com \
  --password 'ChangeMe123!' \
  --group quacklake-readers
```

Remove a user from a group without deleting the user:

```sh
scripts/setup-cognito-user.sh \
  --region us-east-1 \
  --user-pool-id us-east-1_EXAMPLE \
  --username reader@example.com \
  --group quacklake-readers \
  --action delete
```

To reuse an existing pool instead of creating a new one:

```sh
scripts/setup-cognito.sh \
  --region us-east-1 \
  --user-pool-id us-east-1_EXAMPLE \
  --client-name quacklake-quack \
  --readers-group quacklake-readers \
  --admins-group quacklake-admins \
  --output-file quacklake-cognito.json
```

### 2. Ensure The Catalog Exists

`scripts/register-cognito-idp.sh` intentionally fails when the target quacklake catalog does not exist. Create the catalog first with either `scripts/create-jwt.sh` or the Admin API:

```sh
scripts/create-jwt.sh \
  --worker-url https://<worker-host> \
  --admin-token <admin-token> \
  --catalog-id finance \
  --output-file /tmp/quacklake-finance-admin.json
```

### 3. Register Cognito With quacklake

Register the Cognito user pool as an OIDC provider, then merge a Cognito group mapping and two generated policy rules into the catalog:

```sh
scripts/register-cognito-idp.sh \
  --worker-url https://<worker-host> \
  --admin-token <admin-token> \
  --catalog-id finance \
  --cognito-file quacklake-cognito.json \
  --output-file quacklake-cognito-registration.json
```

Equivalent explicit form without the setup JSON file:

```sh
scripts/register-cognito-idp.sh \
  --worker-url https://<worker-host> \
  --admin-token <admin-token> \
  --catalog-id finance \
  --region us-east-1 \
  --user-pool-id us-east-1_EXAMPLE \
  --app-client-id 4exampleclientid9example \
  --readers-group quacklake-readers \
  --admins-group quacklake-admins
```

By default, the registration script creates or updates this provider config:

```json
{
  "providerId": "cognito-finance",
  "issuer": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE",
  "jwksUri": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE/.well-known/jwks.json",
  "audiences": ["4exampleclientid9example"],
  "algorithms": ["RS256"],
  "clockToleranceSeconds": 60,
  "claimMapping": {
    "subject": "sub",
    "scopes": "scope",
    "groups": "cognito:groups",
    "roles": "cognito:roles",
    "tenantId": "custom:tenant_id"
  }
}
```

It then adds one catalog mapping rule that allows either Cognito group to select the catalog:

```json
{
  "mappingId": "cognito-finance-groups",
  "providerId": "cognito-finance",
  "priority": 100,
  "match": {
    "groupsAny": ["quacklake-readers", "quacklake-admins"]
  }
}
```

Catalog mapping is only for catalog selection. The actual permissions come from the catalog policy. The script preserves unrelated existing policy rules and replaces only these generated rule ids:

```json
[
  {
    "ruleId": "cognito-finance-read-only",
    "effect": "allow",
    "principal": {
      "groupsAny": ["quacklake-readers"]
    },
    "actions": ["schema.read", "table.read", "column.read"],
    "resource": {
      "schema": "*",
      "table": "*",
      "column": "*"
    }
  },
  {
    "ruleId": "cognito-finance-admin",
    "effect": "allow",
    "principal": {
      "groupsAny": ["quacklake-admins"]
    },
    "actions": [
      "schema.read",
      "schema.create",
      "schema.drop",
      "table.read",
      "table.create",
      "table.insert",
      "table.update",
      "table.delete",
      "table.drop",
      "column.read",
      "column.alter",
      "catalog.admin"
    ],
    "resource": {
      "schema": "*",
      "table": "*",
      "column": "*"
    }
  }
]
```

You can override ids and group names:

```sh
scripts/register-cognito-idp.sh \
  --worker-url https://<worker-host> \
  --admin-token <admin-token> \
  --catalog-id finance \
  --cognito-file quacklake-cognito.json \
  --provider-id cognito-prod \
  --mapping-id cognito-prod-finance \
  --readers-group finance-readers \
  --admins-group finance-admins \
  --read-rule-id finance-cognito-readers \
  --admin-rule-id finance-cognito-admins
```

### 4. Fetch An ID Token

Authenticate a Cognito user and capture the ID token:

```sh
ID_TOKEN="$(
  aws cognito-idp initiate-auth \
    --region us-east-1 \
    --auth-flow USER_PASSWORD_AUTH \
    --client-id 4exampleclientid9example \
    --auth-parameters USERNAME='reader@example.com',PASSWORD='ChangeMe123!' \
    --query 'AuthenticationResult.IdToken' \
    --output text
)"
```

Use the ID token as the Quack `TOKEN` value:

```sql
CREATE OR REPLACE SECRET quacklake_finance_cognito (
  TYPE quack,
  TOKEN '<cognito-id-token>',
  SCOPE 'quack:<worker-host>:443'
);
```

For DuckLake:

```sql
ATTACH 'ducklake:quack:<worker-host>:443' AS lake (
  DATA_PATH 'r2://<bucket>/<prefix>/'
);
```

Validate authentication and policy before opening DuckDB:

```sh
curl -s -X POST https://<worker-host>/admin/authz/explain \
  -H "Authorization: Bearer <admin-token>" \
  -H 'Content-Type: application/json' \
  -d "{
    \"authString\": \"$ID_TOKEN\",
    \"catalogId\": \"finance\",
    \"sql\": \"SELECT * FROM main.example LIMIT 1\"
  }"
```

Useful JWT claims to inspect when debugging:

- `iss` must equal the configured Cognito issuer.
- `aud` must equal one of the configured provider `audiences`; with the helper scripts this is the app client id from the ID token.
- `cognito:groups` must contain `quacklake-readers`, `quacklake-admins`, or your overridden group names.
- `kid` must exist in the Cognito JWKS at `/.well-known/jwks.json`.

ID tokens expire. Fetch a fresh token when DuckDB connections start failing with an expired-token authentication error.

## Catalog Auth Mapping

Catalog mappings apply only to verified OIDC principals. First-party credentials already carry their catalog id.

Mapping routes:

- `PUT /admin/catalogs/:catalogId/auth-mapping`
- `GET /admin/catalogs/:catalogId/auth-mapping`
- `DELETE /admin/catalogs/:catalogId/auth-mapping`

An OIDC JWT must match exactly one catalog. Zero matches or matches across multiple catalogs deny authentication. `priority` is metadata for explain/debugging in v1 and does not resolve ambiguity.

When designing mappings, make catalog selection mutually exclusive. If the same OIDC principal is intentionally allowed to use multiple catalogs, require different scopes or claims per catalog, such as `ducklake.finance.connect` and `ducklake.hr.connect`.

Entra group and scope mapping:

```sh
curl -s -X PUT http://localhost:8787/admin/catalogs/finance/auth-mapping \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "mappings": [
      {
        "mappingId": "entra-finance-readers",
        "providerId": "entra-prod",
        "priority": 100,
        "match": {
          "groupsAny": ["9a4f1c4e-..."],
          "scopesAny": ["ducklake.finance"]
        }
      }
    ]
  }'
```

Cognito group mapping:

```sh
curl -s -X PUT http://localhost:8787/admin/catalogs/finance/auth-mapping \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "mappings": [
      {
        "mappingId": "cognito-finance-apps",
        "providerId": "cognito-prod",
        "priority": 100,
        "match": {
          "groupsAny": ["finance-apps"],
          "scopesAll": ["ducklake.finance.connect"]
        }
      }
    ]
  }'
```

Tenant-specific mapping using a mapped claim:

```sh
curl -s -X PUT http://localhost:8787/admin/catalogs/tenant_a_finance/auth-mapping \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "mappings": [
      {
        "mappingId": "tenant-a-finance",
        "providerId": "cognito-prod",
        "match": {
          "claims": {
            "tenantId": "tenant-a"
          },
          "groupsAny": ["finance"]
        }
      }
    ]
  }'
```

## Catalog Auth Policy

Policy routes:

- `PUT /admin/catalogs/:catalogId/auth-policy`
- `GET /admin/catalogs/:catalogId/auth-policy`
- `DELETE /admin/catalogs/:catalogId/auth-policy`
- `POST /admin/authz/explain`

Each catalog has one active policy document. `PUT /admin/catalogs/:catalogId/auth-policy` replaces that whole document and increments its `policyVersion`. To support multiple users, applications, groups, or service accounts on the same catalog, put multiple principal-specific rules in that one policy document and issue each principal a credential or OIDC token with matching identity facts.

For first-party credentials, the common pattern is:

- One catalog.
- Many credentials for that catalog.
- Different scopes per credential, such as `alice.read`, `bob.write`, or `catalog.admin`.
- One policy document with multiple rules that match those scopes.

Policies are server-side JSON documents:

```json
{
  "version": 1,
  "defaultEffect": "deny",
  "rules": [
    {
      "ruleId": "finance-readers",
      "effect": "allow",
      "principal": {
        "groupsAny": ["finance-readers"]
      },
      "actions": ["schema.read", "table.read", "column.read"],
      "resource": {
        "schema": "finance",
        "table": "*",
        "columns": ["id", "tenant_id", "amount", "created_at"]
      },
      "rowPredicate": "tenant_id = ${claims.tenantId}"
    },
    {
      "ruleId": "finance-writers",
      "effect": "allow",
      "principal": {
        "scopesAny": ["ducklake.finance.write"]
      },
      "actions": ["table.insert", "table.update", "table.delete"],
      "resource": {
        "schema": "finance",
        "table": "*"
      }
    }
  ]
}
```

Example with multiple first-party users on the same catalog:

```json
{
  "version": 1,
  "defaultEffect": "deny",
  "rules": [
    {
      "ruleId": "alice-read-all",
      "effect": "allow",
      "principal": {
        "scopesAny": ["alice.read"]
      },
      "actions": ["schema.read", "table.read", "column.read"],
      "resource": {
        "schema": "*",
        "table": "*",
        "column": "*"
      }
    },
    {
      "ruleId": "bob-crud-main",
      "effect": "allow",
      "principal": {
        "scopesAny": ["bob.write"]
      },
      "actions": ["schema.read", "table.read", "column.read", "table.insert", "table.update", "table.delete"],
      "resource": {
        "schema": "main",
        "table": "*",
        "column": "*"
      }
    },
    {
      "ruleId": "admins",
      "effect": "allow",
      "principal": {
        "scopesAny": ["catalog.admin"]
      },
      "actions": ["*"],
      "resource": {
        "schema": "*",
        "table": "*",
        "column": "*"
      }
    }
  ]
}
```

Issue matching credentials for the same catalog:

```sh
curl -s -X POST http://localhost:8787/admin/catalogs/default/credentials \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"scopes":["alice.read"],"expiresInSeconds":31536000}'

curl -s -X POST http://localhost:8787/admin/catalogs/default/credentials \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"scopes":["bob.write"],"expiresInSeconds":31536000}'
```

Decision rules:

- Missing policy denies catalog SQL and append requests.
- `defaultEffect: "deny"` requires matching allow rules.
- `defaultEffect: "allow"` is a permissive bootstrap mode.
- Deny rules override allow rules.
- If SQL cannot be classified confidently, quacklake denies before execution.
- Row predicates are catalog-gated in v1. A rule with `rowPredicate` only matches when referenced claims are present.

Supported actions:

- `schema.read`, `schema.create`, `schema.drop`
- `table.read`, `table.create`, `table.insert`, `table.update`, `table.delete`, `table.drop`
- `column.read`, `column.alter`
- `catalog.admin`

## Policy Cookbook

Bootstrap policy for initial setup:

Use this only while creating the DuckLake metadata tables or during local development.

```json
{
  "version": 1,
  "defaultEffect": "allow",
  "rules": []
}
```

Catalog admin policy:

```json
{
  "version": 1,
  "defaultEffect": "deny",
  "rules": [
    {
      "ruleId": "first-party-admin",
      "effect": "allow",
      "principal": {
        "scopesAny": ["catalog.admin"]
      },
      "actions": ["*"],
      "resource": {
        "schema": "*",
        "table": "*",
        "column": "*"
      }
    }
  ]
}
```

Read-only catalog policy:

This allows metadata and table reads for principals with a read scope or reader group. It denies all create, insert, update, delete, drop, and alter actions by omission.

```json
{
  "version": 1,
  "defaultEffect": "deny",
  "rules": [
    {
      "ruleId": "readers-by-scope",
      "effect": "allow",
      "principal": {
        "scopesAny": ["ducklake.finance.read"]
      },
      "actions": ["schema.read", "table.read", "column.read"],
      "resource": {
        "schema": "*",
        "table": "*",
        "column": "*"
      }
    },
    {
      "ruleId": "readers-by-group",
      "effect": "allow",
      "principal": {
        "groupsAny": ["finance-readers"]
      },
      "actions": ["schema.read", "table.read", "column.read"],
      "resource": {
        "schema": "*",
        "table": "*",
        "column": "*"
      }
    }
  ]
}
```

Column-limited read policy:

This allows reads from `finance.invoices`, but only for the listed columns. `SELECT *` requires `column.read` on `*`, so it will be denied by this policy.

```json
{
  "version": 1,
  "defaultEffect": "deny",
  "rules": [
    {
      "ruleId": "invoice-safe-columns",
      "effect": "allow",
      "principal": {
        "groupsAny": ["finance-readers"]
      },
      "actions": ["table.read", "column.read"],
      "resource": {
        "schema": "finance",
        "table": "invoices",
        "columns": ["id", "tenant_id", "amount", "created_at"]
      },
      "rowPredicate": "tenant_id = ${claims.tenantId}"
    }
  ]
}
```

Writer policy:

This separates read and write scopes. Writers can insert, update, and delete rows, but table creation and drops still require another rule.

```json
{
  "version": 1,
  "defaultEffect": "deny",
  "rules": [
    {
      "ruleId": "finance-read",
      "effect": "allow",
      "principal": {
        "scopesAny": ["ducklake.finance.read", "ducklake.finance.write"]
      },
      "actions": ["schema.read", "table.read", "column.read"],
      "resource": {
        "schema": "finance",
        "table": "*",
        "column": "*"
      }
    },
    {
      "ruleId": "finance-write",
      "effect": "allow",
      "principal": {
        "scopesAny": ["ducklake.finance.write"]
      },
      "actions": ["table.insert", "table.update", "table.delete"],
      "resource": {
        "schema": "finance",
        "table": "*"
      }
    }
  ]
}
```

Explicit deny for sensitive columns:

Deny rules override allow rules. This example allows broad reads, then blocks `salary` from `finance.employees` for everyone who matches the deny principal.

```json
{
  "version": 1,
  "defaultEffect": "deny",
  "rules": [
    {
      "ruleId": "deny-salary-to-general-readers",
      "effect": "deny",
      "principal": {
        "groupsAny": ["finance-readers"]
      },
      "actions": ["column.read"],
      "resource": {
        "schema": "finance",
        "table": "employees",
        "column": "salary"
      }
    },
    {
      "ruleId": "allow-general-finance-read",
      "effect": "allow",
      "principal": {
        "groupsAny": ["finance-readers", "finance-admins"]
      },
      "actions": ["schema.read", "table.read", "column.read"],
      "resource": {
        "schema": "finance",
        "table": "*",
        "column": "*"
      }
    }
  ]
}
```

DuckLake metadata maintenance policy:

Some DuckLake metadata writes are classified as catalog administration. Use this for trusted services that manage catalog metadata, not for read-only consumers.

```json
{
  "version": 1,
  "defaultEffect": "deny",
  "rules": [
    {
      "ruleId": "ducklake-maintainers",
      "effect": "allow",
      "principal": {
        "rolesAny": ["ducklake-maintainer"]
      },
      "actions": ["catalog.admin", "schema.read", "table.read", "column.read"],
      "resource": {
        "schema": "*",
        "table": "*",
        "column": "*"
      }
    }
  ]
}
```

Install any policy with:

```sh
curl -s -X PUT "$WORKER/admin/catalogs/$CATALOG_ID/auth-policy" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d @policy.json
```

## Explain Authz

Explain example:

```sh
curl -s -X POST http://localhost:8787/admin/authz/explain \
  -H 'Authorization: Bearer admin-test-token' \
  -H 'Content-Type: application/json' \
  -d '{"authString":"<jwt>","catalogId":"default","sql":"SELECT id FROM items"}'
```

Explain returns the normalized principal, resolved catalog, required actions, classified statements, matched rules, and the final decision. Use it before testing with DuckDB when you need to distinguish authentication failures from policy failures.

## End-To-End OIDC Setup

This flow configures a third-party OIDC token to select a catalog through a mapping and then pass catalog policy.

Set shell variables:

```sh
WORKER=http://localhost:8787
ADMIN_TOKEN=admin-test-token
CATALOG_ID=finance
```

Create the catalog. The first-party JWT returned here is only for administrative bootstrap:

```sh
curl -s -X POST "$WORKER/admin/catalogs" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"catalogId\": \"$CATALOG_ID\",
    \"scopes\": [\"catalog.admin\"]
  }"
```

Create the provider. Use either the Entra or Cognito examples above.

Create a mapping from the provider to the catalog:

```sh
curl -s -X PUT "$WORKER/admin/catalogs/$CATALOG_ID/auth-mapping" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "mappings": [
      {
        "mappingId": "finance-oidc-connect",
        "providerId": "entra-prod",
        "match": {
          "groupsAny": ["<finance-group-object-id>"],
          "scopesAny": ["ducklake.finance"]
        }
      }
    ]
  }'
```

Install a policy that grants that same principal read access:

```sh
curl -s -X PUT "$WORKER/admin/catalogs/$CATALOG_ID/auth-policy" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 1,
    "defaultEffect": "deny",
    "rules": [
      {
        "ruleId": "oidc-finance-read",
        "effect": "allow",
        "principal": {
          "groupsAny": ["<finance-group-object-id>"],
          "scopesAny": ["ducklake.finance"]
        },
        "actions": ["schema.read", "table.read", "column.read"],
        "resource": {
          "schema": "*",
          "table": "*",
          "column": "*"
        }
      }
    ]
  }'
```

Use the IdP-issued JWT as the Quack token:

```sql
CREATE OR REPLACE SECRET quacklake_finance_oidc (
  TYPE quack,
  TOKEN '<oidc-access-token>',
  SCOPE 'quack:<worker-host>:443'
);
```

Validate the token and policy with explain:

```sh
curl -s -X POST "$WORKER/admin/authz/explain" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"authString\": \"<oidc-access-token>\",
    \"catalogId\": \"$CATALOG_ID\",
    \"sql\": \"SELECT id FROM finance.invoices\"
  }"
```

Expected successful shape:

```json
{
  "allowed": true,
  "reason": "all required actions allowed",
  "principal": {
    "authMode": "oidc_jwt",
    "providerId": "entra-prod"
  },
  "catalog": {
    "catalogId": "finance",
    "policyVersion": 1
  },
  "requiredActions": [
    {
      "action": "table.read",
      "resource": {
        "schema": "finance",
        "table": "invoices"
      }
    }
  ]
}
```

## Troubleshooting

| Symptom | Likely cause | How to check | Fix |
|---------|--------------|--------------|-----|
| `/admin/*` returns `503` with `{"error":"ADMIN_TOKEN is not configured"}` | The deployed Worker has no `ADMIN_TOKEN` secret bound | `pnpm exec wrangler secret list --name quacklake` lists secret names without values | Set or rotate it with `pnpm exec wrangler secret put ADMIN_TOKEN --name quacklake`, then retry the admin request |
| `Invalid auth JWT` on connect with a first-party credential | Malformed JWT, expired JWT, wrong issuer, wrong audience, wrong `catalog_id`, revoked `jti`, or changed `QUACKLAKE_JWT_SECRET` | Decode the JWT header/payload locally and check `iss`, `aud`, `exp`, `jti`, and `catalog_id`; list credential metadata with `GET /admin/catalogs/:catalogId/credentials` | Reissue the credential, restore issuer/audience config, or stop using a revoked credential |
| `Invalid auth JWT` on connect with OIDC | Provider verification failed: wrong issuer, wrong audience, wrong algorithm, unknown key, expired token, or JWKS unavailable | `GET /admin/oidc/providers/:providerId`; inspect JWT `iss`, `aud`, `alg`, and `kid` | Update provider config or request a token for the configured API audience |
| OIDC token verifies at the IdP but quacklake still rejects it | No catalog mapping matched, or mappings for more than one catalog matched | Use `POST /admin/authz/explain` with the token; check catalog mappings for the provider | Add a matching mapping or make mappings mutually exclusive with scopes, groups, or claims |
| Provider delete returns `409 Conflict` | At least one catalog auth mapping references the provider | Search mappings with `GET /admin/catalogs/:catalogId/auth-mapping` | Delete or replace those mappings first |
| Connect succeeds but SQL returns `Authorization denied: missing catalog auth policy` | The catalog has no policy | `GET /admin/catalogs/:catalogId/auth-policy` returns only `policyVersion: 0` | Install a policy with `PUT /admin/catalogs/:catalogId/auth-policy` |
| SQL returns `Authorization denied: no allow rule for table.read` | The policy default is deny and no matching allow rule covers the table read | Run explain for the same JWT and SQL | Add a matching `table.read` rule for the principal and resource |
| SQL returns `Authorization denied: no allow rule for column.read` | The table read is allowed but projected columns are not | Run explain and inspect `requiredActions` for column names | Add `column.read` for the needed column, `columns`, or `column: "*"` |
| `SELECT *` is denied by a column-limited policy | Star projection requires wildcard column permission | Run explain and look for `column: "*"` | Query explicit allowed columns, or grant `column.read` on `*` |
| Writes are denied even for readers | Read actions do not imply write actions | Explain an `INSERT`, `UPDATE`, `DELETE`, or `APPEND_REQUEST` | Add `table.insert`, `table.update`, or `table.delete` for writer principals |
| DuckLake maintenance SQL is denied | Metadata mutations may require `catalog.admin` | Explain the failing SQL | Grant `catalog.admin` only to trusted maintainers |
| Row-predicate rule does not match | The JWT is missing a claim referenced by `${claims.<name>}` | Explain and inspect `principal.claims` | Add the claim in the IdP token or remove/change the row predicate |
| Existing sessions survive credential revocation | Revocation is checked when opening new sessions; signed connection ids are not revoked mid-session | Check active clients using old signed connection ids | Rotate `CONNECTION_SIGNING_SECRET` to invalidate active sessions if needed |
