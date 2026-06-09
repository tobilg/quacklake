# Cognito End-To-End Guide

This guide shows how to use Amazon Cognito as an OIDC identity provider for quacklake, how Cognito groups become quacklake principals, how catalog mappings select a DuckLake catalog, how catalog policies create permission profiles, and how end users query the published DuckLake data from DuckDB.

The examples use one catalog named `finance`, one Cognito user pool, and Cognito ID tokens. quacklake verifies the token, maps Cognito claims into an `AuthPrincipal`, resolves the token to exactly one catalog, and evaluates the catalog policy before executing metadata SQL through the Quack catalog.

## What Gets Enforced

There are three separate layers:

| Layer | Configured in | Purpose |
| --- | --- | --- |
| Provider trust | `/admin/oidc/providers` | Verifies Cognito token issuer, audience, algorithm, signature, and expiry. |
| Catalog mapping | `/admin/catalogs/:catalogId/auth-mapping` | Decides whether a verified Cognito principal may select this quacklake catalog. |
| Catalog policy | `/admin/catalogs/:catalogId/auth-policy` | Decides which SQL actions and resources that principal may use inside the selected catalog. |

Cognito does not directly grant table access. Cognito emits identity facts such as `sub`, `aud`, `cognito:groups`, and `custom:tenant_id`. quacklake maps those facts into one normalized principal and evaluates server-side catalog policy rules.

Important limits for v1:

- Each catalog has one active policy document. Multiple permission profiles are multiple rules in that one document.
- Catalog mapping must resolve an OIDC token to exactly one catalog. Zero matches or matches across multiple catalogs deny authentication.
- Column policies are enforced at quacklake's SQL authorization layer.
- `rowPredicate` is currently a catalog-side authorization guard that requires referenced claims to be present. It is not a complete data-file gateway or storage-level row filter.
- DuckDB still needs object-storage credentials to read DuckLake data files. Scope those R2/S3 credentials separately because broad storage credentials can bypass catalog decisions.

## Example Permission Profiles

This guide uses Cognito groups as permission profiles:

| Cognito group | quacklake profile | Intended access |
| --- | --- | --- |
| `finance-readers` | Reader | Read a safe column set from published finance tables. No writes. |
| `finance-analysts` | Analyst | Read a broader column set, including analytics fields. No writes. |
| `finance-tenant-users` | Tenant user | Read tenant-scoped columns when `custom:tenant_id` is present. |
| `finance-writers` | Writer | Read and mutate rows in finance tables. No schema drops. |
| `finance-admins` | Catalog admin | Manage schemas, tables, columns, and DuckLake metadata maintenance. |

Cognito group precedence is not used by quacklake for authorization. quacklake reads the full `cognito:groups` array from the token and then evaluates `groupsAny` and `groupsAll` rules. If a user belongs to `finance-readers` and `finance-admins`, both groups are visible to quacklake, and the admin allow rule can match.

## Prerequisites

You need:

- A deployed quacklake Worker.
- Worker secrets set for `ADMIN_TOKEN`, `QUACKLAKE_JWT_SECRET`, and `CONNECTION_SIGNING_SECRET`.
- AWS CLI configured with permissions to manage Cognito user pools, app clients, groups, and users.
- DuckDB with `core_nightly` DuckLake and Quack extension support. The stable
  extension builds may be missing bugfixes required by this workflow.
- R2 or S3 credentials for the DuckLake data path, scoped to the published bucket and prefix.

Set common shell variables:

```sh
export WORKER_URL="https://<worker-host>"
export ADMIN_TOKEN="<quacklake-admin-token>"
export CATALOG_ID="finance"
export AWS_REGION="us-east-1"
```

## 1. Create The quacklake Catalog

Create the catalog and a first-party admin credential for bootstrap:

```sh
scripts/create-jwt.sh \
  --worker-url "$WORKER_URL" \
  --admin-token "$ADMIN_TOKEN" \
  --catalog-id "$CATALOG_ID" \
  --output-file /tmp/quacklake-finance-admin.json
```

The generated first-party JWT is only needed for catalog bootstrap and maintenance. Cognito end users will use Cognito-issued ID tokens instead.

## 2. Create Cognito Resources

Create or reuse a Cognito user pool and create an app client without a client secret:

```sh
scripts/setup-cognito.sh \
  --region "$AWS_REGION" \
  --pool-name quacklake-finance \
  --client-name quacklake-quack \
  --readers-group finance-readers \
  --admins-group finance-admins \
  --output-file quacklake-cognito.json
```

The helper creates:

- A user pool with email usernames.
- An app client whose ID token `aud` claim is the app client id.
- The reader and admin groups requested with `--readers-group` and `--admins-group`.
- For a newly-created user pool, a custom string attribute named `tenant_id`, emitted as `custom:tenant_id`.

If you reuse an existing user pool and want tenant-scoped rules, make sure the pool has the `tenant_id` custom attribute. Add it before setting it on users:

```sh
aws cognito-idp add-custom-attributes \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --custom-attributes Name=tenant_id,AttributeDataType=String,DeveloperOnlyAttribute=false,Mutable=true,Required=false,StringAttributeConstraints="{MinLength=1,MaxLength=128}"
```

Add the extra groups used by this guide:

```sh
USER_POOL_ID="$(node -e 'const fs = require("fs"); const data = JSON.parse(fs.readFileSync("quacklake-cognito.json", "utf8")); process.stdout.write(data.userPoolId);')"

aws cognito-idp create-group \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --group-name finance-analysts \
  --description "quacklake finance analyst readers"

aws cognito-idp create-group \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --group-name finance-tenant-users \
  --description "quacklake finance tenant-scoped users"

aws cognito-idp create-group \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --group-name finance-writers \
  --description "quacklake finance table writers"
```

If a group already exists, the AWS CLI returns an error. That is safe; skip that create command and continue with the existing group.

## 3. Create Users And Assign Profiles

Create a reader:

```sh
aws cognito-idp admin-create-user \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username reader@example.com \
  --user-attributes Name=email,Value=reader@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --temporary-password 'ChangeMe123!'

aws cognito-idp admin-set-user-password \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username reader@example.com \
  --password 'ChangeMe123!' \
  --permanent

aws cognito-idp admin-add-user-to-group \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username reader@example.com \
  --group-name finance-readers
```

Create a tenant-scoped user with `custom:tenant_id`:

```sh
aws cognito-idp admin-create-user \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username tenant-a@example.com \
  --user-attributes \
    Name=email,Value=tenant-a@example.com \
    Name=email_verified,Value=true \
    Name=custom:tenant_id,Value=tenant-a \
  --message-action SUPPRESS \
  --temporary-password 'ChangeMe123!'

aws cognito-idp admin-set-user-password \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username tenant-a@example.com \
  --password 'ChangeMe123!' \
  --permanent

aws cognito-idp admin-add-user-to-group \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username tenant-a@example.com \
  --group-name finance-tenant-users
```

Update an existing user's tenant claim:

```sh
aws cognito-idp admin-update-user-attributes \
  --region "$AWS_REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --username tenant-a@example.com \
  --user-attributes Name=custom:tenant_id,Value=tenant-a
```

Add or remove groups as users change roles. The user must get a fresh token before quacklake sees changed group membership or custom attributes.

## 4. Register Cognito With quacklake

For a simple reader/admin setup, the helper script can register Cognito and install two generated policy rules:

```sh
scripts/register-cognito-idp.sh \
  --worker-url "$WORKER_URL" \
  --admin-token "$ADMIN_TOKEN" \
  --catalog-id "$CATALOG_ID" \
  --cognito-file quacklake-cognito.json \
  --provider-id cognito-finance \
  --mapping-id cognito-finance-groups \
  --readers-group finance-readers \
  --admins-group finance-admins
```

The rest of this guide installs a richer mapping and policy. The helper-created provider is still useful, but the mapping and policy are replaced below.

The provider config created by the helper looks like this:

```json
{
  "providerId": "cognito-finance",
  "issuer": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE",
  "jwksUri": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE/.well-known/jwks.json",
  "audiences": ["<cognito-app-client-id>"],
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

The key mapping is `groups: "cognito:groups"`. After token verification, quacklake sets:

```json
{
  "principal": {
    "issuer": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE",
    "subject": "<cognito-sub>",
    "audience": ["<cognito-app-client-id>"],
    "groups": ["finance-readers"],
    "claims": {
      "tenantId": "tenant-a"
    },
    "providerId": "cognito-finance",
    "authMode": "oidc_jwt"
  }
}
```

## 5. Replace The Catalog Mapping

Catalog mapping answers only one question: can this verified Cognito principal select the `finance` catalog?

Write a mapping document:

```sh
cat >/tmp/finance-auth-mapping.json <<'JSON'
{
  "mappings": [
    {
      "mappingId": "cognito-finance-profiles",
      "providerId": "cognito-finance",
      "priority": 100,
      "match": {
        "groupsAny": [
          "finance-readers",
          "finance-analysts",
          "finance-tenant-users",
          "finance-writers",
          "finance-admins"
        ]
      }
    }
  ]
}
JSON
```

Install it:

```sh
curl -s -X PUT "$WORKER_URL/admin/catalogs/$CATALOG_ID/auth-mapping" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d @/tmp/finance-auth-mapping.json
```

Why this matters:

- If a token has none of those groups, it does not select this catalog.
- If the same token maps to another catalog too, authentication is denied as ambiguous.
- `priority` is metadata in v1. It does not break ties.
- This mapping does not grant read or write access. It only routes the token to the catalog.

For tenant-specific catalogs, make mapping rules mutually exclusive by combining group and claim matches:

```json
{
  "mappingId": "cognito-tenant-a-finance",
  "providerId": "cognito-finance",
  "match": {
    "groupsAny": ["finance-tenant-users"],
    "claims": {
      "tenantId": "tenant-a"
    }
  }
}
```

Use that pattern only when each tenant has a separate quacklake catalog. For one shared catalog, keep catalog mapping broad and enforce tenant restrictions in the catalog policy.

## 6. Install Permission Profiles

Write a policy document with multiple profile rules:

```sh
cat >/tmp/finance-auth-policy.json <<'JSON'
{
  "version": 1,
  "defaultEffect": "deny",
  "rules": [
    {
      "ruleId": "finance-readers-safe-columns",
      "effect": "allow",
      "principal": {
        "groupsAny": ["finance-readers"]
      },
      "actions": ["schema.read", "table.read", "column.read"],
      "resource": {
        "schema": "finance",
        "table": "*",
        "columns": ["id", "tenant_id", "amount", "created_at"]
      }
    },
    {
      "ruleId": "finance-analysts-expanded-columns",
      "effect": "allow",
      "principal": {
        "groupsAny": ["finance-analysts"]
      },
      "actions": ["schema.read", "table.read", "column.read"],
      "resource": {
        "schema": "finance",
        "table": "*",
        "columns": ["id", "tenant_id", "customer_id", "amount", "status", "created_at", "updated_at"]
      }
    },
    {
      "ruleId": "finance-tenant-users-tenant-columns",
      "effect": "allow",
      "principal": {
        "groupsAny": ["finance-tenant-users"]
      },
      "actions": ["schema.read", "table.read", "column.read"],
      "resource": {
        "schema": "finance",
        "table": "invoices",
        "columns": ["id", "tenant_id", "amount", "status", "created_at"]
      },
      "rowPredicate": "tenant_id = ${claims.tenantId}"
    },
    {
      "ruleId": "finance-writers-table-crud",
      "effect": "allow",
      "principal": {
        "groupsAny": ["finance-writers"]
      },
      "actions": [
        "schema.read",
        "table.read",
        "table.insert",
        "table.update",
        "table.delete",
        "column.read"
      ],
      "resource": {
        "schema": "finance",
        "table": "*",
        "column": "*"
      }
    },
    {
      "ruleId": "finance-admins-catalog-admin",
      "effect": "allow",
      "principal": {
        "groupsAny": ["finance-admins"]
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
    },
    {
      "ruleId": "deny-reader-secret-columns",
      "effect": "deny",
      "principal": {
        "groupsAny": ["finance-readers", "finance-analysts", "finance-tenant-users"]
      },
      "actions": ["column.read"],
      "resource": {
        "schema": "finance",
        "table": "employees",
        "columns": ["salary", "ssn"]
      }
    }
  ]
}
JSON
```

Install it:

```sh
curl -s -X PUT "$WORKER_URL/admin/catalogs/$CATALOG_ID/auth-policy" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d @/tmp/finance-auth-policy.json
```

How evaluation works:

- `defaultEffect: "deny"` denies anything that no allow rule covers.
- Deny rules override allow rules.
- A rule must match principal, action, and resource.
- `groupsAny` matches any Cognito group in `principal.groups`.
- `groupsAll` can require a user to be in multiple groups.
- `claims` can require exact normalized claim values, for example `{ "tenantId": "tenant-a" }`.
- `columns` allows only listed projected columns. `SELECT *` requires `column.read` on `*`, so it is denied unless the rule grants `column: "*"` or `columns: ["*"]`.
- `rowPredicate` only matches when referenced claims are present. In this example, a tenant user without `custom:tenant_id` does not match the tenant rule.
- For hard row isolation in v1, combine catalog policy with tenant-specific data layout, scoped storage credentials, separate catalogs, or published views/materialized subsets.

## 7. Validate With Explain

Get an ID token for a user:

```sh
APP_CLIENT_ID="$(node -e 'const fs = require("fs"); const data = JSON.parse(fs.readFileSync("quacklake-cognito.json", "utf8")); process.stdout.write(data.appClientId);')"

ID_TOKEN="$(
  aws cognito-idp initiate-auth \
    --region "$AWS_REGION" \
    --auth-flow USER_PASSWORD_AUTH \
    --client-id "$APP_CLIENT_ID" \
    --auth-parameters USERNAME='reader@example.com',PASSWORD='ChangeMe123!' \
    --query 'AuthenticationResult.IdToken' \
    --output text
)"
```

Ask quacklake to explain the decision:

```sh
curl -s -X POST "$WORKER_URL/admin/authz/explain" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"authString\": \"$ID_TOKEN\",
    \"catalogId\": \"$CATALOG_ID\",
    \"sql\": \"SELECT id, tenant_id, amount, created_at FROM finance.invoices LIMIT 10\"
  }"
```

Expected success indicators:

- `principal.authMode` is `oidc_jwt`.
- `principal.providerId` is `cognito-finance`.
- `principal.groups` contains the expected Cognito group.
- `catalog.catalogId` is `finance`.
- `decision.allowed` is `true`.
- `matchedRules` includes a rule such as `finance-readers-safe-columns`.

Try a denied query:

```sh
curl -s -X POST "$WORKER_URL/admin/authz/explain" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"authString\": \"$ID_TOKEN\",
    \"catalogId\": \"$CATALOG_ID\",
    \"sql\": \"SELECT * FROM finance.invoices\"
  }"
```

A reader is expected to be denied because `SELECT *` requires wildcard column access.

## 8. End User DuckDB Setup

End users need two secrets:

- A Quack secret with their Cognito ID token.
- A storage secret for DuckLake data files.

Create the Quack secret:

```sql
CREATE OR REPLACE SECRET quacklake_finance (
  TYPE quack,
  TOKEN '<cognito-id-token>',
  SCOPE 'quack:<worker-host>:443'
);
```

Create a scoped R2 storage secret. Use credentials that are limited to the bucket and prefix that this user should be able to read or write:

```sql
CREATE OR REPLACE SECRET finance_lake_r2 (
  TYPE r2,
  KEY_ID '<r2-access-key-id>',
  SECRET '<r2-secret-access-key>',
  ACCOUNT_ID '<cloudflare-account-id>',
  SCOPE 'r2://<bucket>/<prefix>/'
);
```

If your DuckDB build uses the generic S3 secret path for R2:

```sql
CREATE OR REPLACE SECRET finance_lake_s3 (
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

Attach the DuckLake catalog through Quack:

```sql
ATTACH 'ducklake:quack:<worker-host>:443' AS finance_lake (
  DATA_PATH 'r2://<bucket>/<prefix>/'
);
```

Reader query:

```sql
SELECT id, tenant_id, amount, created_at
FROM finance_lake.finance.invoices
LIMIT 10;
```

Analyst query:

```sql
SELECT tenant_id, status, sum(amount) AS total_amount
FROM finance_lake.finance.invoices
GROUP BY tenant_id, status
ORDER BY total_amount DESC;
```

Writer query:

```sql
INSERT INTO finance_lake.finance.adjustments (id, tenant_id, amount, created_at)
VALUES (1001, 'tenant-a', 42.50, now());
```

Queries that exceed the user's profile fail before execution against the catalog. Examples:

- Reader tries `SELECT * FROM finance_lake.finance.invoices`.
- Reader tries `INSERT INTO finance_lake.finance.invoices ...`.
- Analyst tries to read `finance.employees.salary`.
- Tenant user lacks `custom:tenant_id` and tries a tenant-scoped query.

## 9. How Cognito Groups Become Query Permissions

The full path is:

1. User signs in to Cognito.
2. Cognito returns an ID token.
3. The ID token contains `iss`, `aud`, `sub`, `token_use`, expiry claims, and group membership in `cognito:groups`.
4. DuckDB sends the token as the Quack auth string.
5. quacklake verifies the token against the registered provider:
   - `iss` equals the Cognito issuer.
   - `aud` equals the app client id in provider `audiences`.
   - `alg` is `RS256`.
   - `kid` resolves in the Cognito JWKS.
   - `exp` and `nbf` are valid within clock tolerance.
6. quacklake applies `claimMapping`:
   - `sub` becomes `principal.subject`.
   - `cognito:groups` becomes `principal.groups`.
   - `custom:tenant_id` becomes `principal.claims.tenantId`.
7. quacklake scans catalog auth mappings for this provider.
8. Exactly one catalog mapping must match.
9. The catalog Durable Object stores the principal in the session.
10. Every prepared SQL statement is classified into required actions and resources.
11. The catalog policy decides allow or deny before execution.

## 10. Operational Patterns

Use groups for stable profiles:

- `finance-readers`
- `finance-analysts`
- `finance-writers`
- `finance-admins`

Use custom claims for per-user or per-tenant facts:

- `custom:tenant_id` mapped to `claims.tenantId`.
- `custom:department` mapped to `claims.department` if you add it to the provider `claimMapping`.

Use one catalog policy per catalog:

- Add profile rules to the same policy document.
- Keep generated rule ids stable so updates can replace a known profile rule.
- Use deny rules for high-risk columns.
- Keep `defaultEffect: "deny"` outside local bootstrap workflows.

Use `POST /admin/authz/explain` before handing a profile to users:

- Test a known allowed read.
- Test a known denied column.
- Test `SELECT *` when the profile should be column-limited.
- Test a mutation when the profile should be read-only.
- Test a tenant user with and without `custom:tenant_id`.

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Invalid auth JWT` | Wrong issuer, audience, signing key, algorithm, expiry, or JWKS. | Check provider config and decode token headers/claims. |
| Token verifies but no catalog resolves | Catalog auth mapping does not match token groups or claims. | Inspect `principal.groups` with `/admin/authz/explain`; update mapping. |
| Authentication denied as ambiguous | The same Cognito token matches mappings on more than one catalog. | Make mappings mutually exclusive by group, claim, or scope. |
| Query denied for `column.read` | Policy does not grant the projected column, or the query uses `SELECT *`. | Select explicit allowed columns or update policy. |
| Tenant rule does not match | `custom:tenant_id` is missing from the token or the provider mapping. | Set the custom attribute, fetch a fresh ID token, and verify `claims.tenantId`. |
| Group change not reflected | User is still using an old token. | Sign in again or refresh the token. |
| DuckDB can still read files directly | Storage credentials are broader than the catalog policy. | Issue narrower R2/S3 credentials or separate data prefixes/catalogs. |
| DuckLake cleanup cannot list or delete data files | The DuckDB client's R2/S3 storage secret is missing, too narrow, or points at the wrong endpoint or bucket. | Recreate the client storage secret with a scope that prefixes the catalog `DATA_PATH`. |

## 12. Security Checklist

- Use ID tokens with this guide because the Cognito app client id appears in the ID token `aud` claim.
- Do not use `cognito:groups` as the only tenant boundary if users can be in multiple tenant groups. Prefer a tenant claim and mutually exclusive catalog mapping, or separate catalogs.
- Keep the quacklake admin token out of user machines.
- Keep R2/S3 data credentials scoped to the least privilege needed for the user profile.
- Prefer separate storage prefixes or buckets when data-file isolation matters.
- Re-run `/admin/authz/explain` after every policy change.
- Rotate Cognito tokens by signing in again after changing group membership or custom attributes.

## Sources

- Amazon Cognito user-pool groups include group membership in the `cognito:groups` token claim and can be managed from the console, APIs, or CLI: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-user-groups.html>
- Amazon Cognito ID tokens include an `aud` claim for the app client and identity claims used by this guide: <https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html>
- AWS CLI custom attributes can add a `tenant_id` schema attribute that appears in tokens as `custom:tenant_id`: <https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/add-custom-attributes.html>
- AWS CLI Cognito command reference for creating user pools, app clients, groups, users, and initiating auth: <https://docs.aws.amazon.com/cli/latest/reference/cognito-idp/>
