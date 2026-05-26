#!/usr/bin/env bash
set -euo pipefail

worker_url="${QUACKLAKE_URL:-${WORKER:-${WORKER_URL:-}}}"
admin_token="${QUACKLAKE_ADMIN_TOKEN:-${ADMIN_TOKEN:-}}"
catalog_id="${CATALOG_ID:-}"
cognito_file="${COGNITO_FILE:-}"
region="${COGNITO_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
user_pool_id="${COGNITO_USER_POOL_ID:-}"
issuer="${COGNITO_ISSUER:-}"
jwks_uri="${COGNITO_JWKS_URI:-}"
app_client_id="${COGNITO_APP_CLIENT_ID:-}"
audiences="${COGNITO_AUDIENCES:-}"
provider_id="${COGNITO_PROVIDER_ID:-}"
mapping_id="${COGNITO_MAPPING_ID:-}"
readers_group="${COGNITO_READERS_GROUP:-quacklake-readers}"
admins_group="${COGNITO_ADMINS_GROUP:-quacklake-admins}"
read_rule_id="${COGNITO_READ_RULE_ID:-}"
admin_rule_id="${COGNITO_ADMIN_RULE_ID:-}"
output_file="${OUTPUT_FILE:-}"

usage() {
  cat <<'EOF'
Usage: scripts/register-cognito-idp.sh [options]

Registers an AWS Cognito user pool as a quacklake OIDC provider, maps its
read-only/admin groups to one catalog, and installs generated read-only/admin
policy rules. The target catalog must already exist.

Required input:
  --worker-url URL       Deployed Worker base URL. Env: QUACKLAKE_URL, WORKER, or WORKER_URL.
  --admin-token TOKEN    Admin API bearer token. Env: QUACKLAKE_ADMIN_TOKEN or ADMIN_TOKEN.
  --catalog-id ID        Existing catalog id to map. Env: CATALOG_ID.

Provide Cognito settings either as:
  --cognito-file PATH    JSON output from scripts/setup-cognito.sh.

Or explicit settings:
  --region REGION
  --user-pool-id ID
  --app-client-id ID     Cognito app client id. Used as the ID-token aud.

Options:
  --provider-id ID       quacklake provider id. Default: cognito-<catalog-id>.
  --mapping-id ID        Mapping id. Default: cognito-<catalog-id>-groups.
  --issuer URL           Override issuer. Default derives from region and user pool id.
  --jwks-uri URL         Override JWKS URI. Default derives from issuer.
  --audience VALUE       JWT audience. Repeat or comma-separate. Default: app client id.
  --readers-group NAME   Cognito group granted read-only policy. Default: quacklake-readers.
  --admins-group NAME    Cognito group granted admin policy. Default: quacklake-admins.
  --read-rule-id ID      Generated read-only rule id. Default: <provider-id>-read-only.
  --admin-rule-id ID     Generated admin rule id. Default: <provider-id>-admin.
  --output-file PATH     Write registration summary JSON.
  -h, --help             Show this help.

Examples:
  scripts/register-cognito-idp.sh \
    --worker-url https://quacklake.example.workers.dev \
    --admin-token "$ADMIN_TOKEN" \
    --catalog-id finance \
    --cognito-file quacklake-cognito.json
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

normalize_worker_url() {
  node -e "let raw = process.argv[1] || ''; if (!raw) process.exit(0); if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw; const url = new URL(raw); url.pathname = ''; url.search = ''; url.hash = ''; process.stdout.write(url.toString().replace(/\/$/, ''));" "$1"
}

url_encode() {
  node -e "process.stdout.write(encodeURIComponent(process.argv[1] || ''));" "$1"
}

json_file_field() {
  local file="$1"
  local field_path="$2"
  node -e '
const fs = require("fs");
const [file, fieldPath] = process.argv.slice(1);
let data;
try {
  data = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  process.exit(0);
}
let value = data;
for (const part of fieldPath.split(".")) {
  if (!part) continue;
  value = value?.[part];
}
if (value !== undefined && value !== null) {
  process.stdout.write(String(value));
}
' "${file}" "${field_path}"
}

request() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local response_file="$4"
  local status
  : >"${response_file}"
  if [[ -n "${body}" ]]; then
    status="$(
      curl -sS -o "${response_file}" -w "%{http_code}" \
        -X "${method}" "${url}" \
        -H "Authorization: Bearer ${admin_token}" \
        -H "Content-Type: application/json" \
        -d "${body}"
    )"
  else
    status="$(
      curl -sS -o "${response_file}" -w "%{http_code}" \
        -X "${method}" "${url}" \
        -H "Authorization: Bearer ${admin_token}"
    )"
  fi
  printf '%s' "${status}"
}

provider_payload() {
  node - "$provider_id" "$issuer" "$jwks_uri" "$audiences" <<'NODE'
const [providerId, issuer, jwksUri, rawAudiences] = process.argv.slice(2);
const audiences = rawAudiences.split(",").map((value) => value.trim()).filter(Boolean);
process.stdout.write(JSON.stringify({
  providerId,
  issuer,
  jwksUri,
  audiences,
  algorithms: ["RS256"],
  clockToleranceSeconds: 60,
  claimMapping: {
    subject: "sub",
    scopes: "scope",
    groups: "cognito:groups",
    roles: "cognito:roles",
    tenantId: "custom:tenant_id",
  },
}));
NODE
}

catalog_exists_in_response() {
  node -e '
const catalogId = process.argv[1];
let body = "";
process.stdin.on("data", (chunk) => {
  body += chunk;
});
process.stdin.on("end", () => {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    process.exit(0);
  }
  const exists = (data.catalogs || []).some((catalog) => catalog.catalogId === catalogId);
  if (exists) process.stdout.write("yes");
});
' "${catalog_id}"
}

mapping_payload() {
  node -e '
const [providerId, mappingId, readersGroup, adminsGroup] = process.argv.slice(1);
let body = "";
process.stdin.on("data", (chunk) => {
  body += chunk;
});
process.stdin.on("end", () => {
  let current;
  try {
    current = JSON.parse(body || "{}");
  } catch {
    current = {};
  }
  const groups = [...new Set([readersGroup, adminsGroup].filter(Boolean))];
  const mappings = (current.mappings || []).filter((mapping) => mapping.mappingId !== mappingId);
  mappings.push({
    mappingId,
    providerId,
    priority: 100,
    match: {
      groupsAny: groups,
    },
  });
  process.stdout.write(JSON.stringify({ mappings }));
});
' "${provider_id}" "${mapping_id}" "${readers_group}" "${admins_group}"
}

policy_payload() {
  node -e '
const [readRuleId, adminRuleId, readersGroup, adminsGroup] = process.argv.slice(1);
let body = "";
process.stdin.on("data", (chunk) => {
  body += chunk;
});
process.stdin.on("end", () => {
  let current;
  try {
    current = JSON.parse(body || "{}");
  } catch {
    current = {};
  }
  const policy = current.policy || { version: 1, defaultEffect: "deny", rules: [] };
  policy.version = 1;
  policy.defaultEffect = policy.defaultEffect || "deny";
  policy.rules = (policy.rules || []).filter((rule) => rule.ruleId !== readRuleId && rule.ruleId !== adminRuleId);
  policy.rules.push({
    ruleId: readRuleId,
    effect: "allow",
    principal: {
      groupsAny: [readersGroup],
    },
    actions: ["schema.read", "table.read", "column.read"],
    resource: {
      schema: "*",
      table: "*",
      column: "*",
    },
  });
  policy.rules.push({
    ruleId: adminRuleId,
    effect: "allow",
    principal: {
      groupsAny: [adminsGroup],
    },
    actions: [
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
      "catalog.admin",
    ],
    resource: {
      schema: "*",
      table: "*",
      column: "*",
    },
  });
  process.stdout.write(JSON.stringify(policy));
});
' "${read_rule_id}" "${admin_rule_id}" "${readers_group}" "${admins_group}"
}

summary_json() {
  node - "$worker_url" "$catalog_id" "$provider_id" "$issuer" "$jwks_uri" "$audiences" "$mapping_id" "$readers_group" "$admins_group" "$read_rule_id" "$admin_rule_id" <<'NODE'
const [
  workerUrl,
  catalogId,
  providerId,
  issuer,
  jwksUri,
  rawAudiences,
  mappingId,
  readersGroup,
  adminsGroup,
  readRuleId,
  adminRuleId,
] = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  workerUrl,
  catalogId,
  providerId,
  issuer,
  jwksUri,
  audiences: rawAudiences.split(",").map((value) => value.trim()).filter(Boolean),
  tokenType: "id_token",
  mappingId,
  readersGroup,
  adminsGroup,
  readRuleId,
  adminRuleId,
  updatedAt: new Date().toISOString(),
}, null, 2));
process.stdout.write("\n");
NODE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --worker-url)
      [[ $# -ge 2 ]] || fail "--worker-url requires a value"
      worker_url="$2"
      shift 2
      ;;
    --admin-token)
      [[ $# -ge 2 ]] || fail "--admin-token requires a value"
      admin_token="$2"
      shift 2
      ;;
    --catalog-id)
      [[ $# -ge 2 ]] || fail "--catalog-id requires a value"
      catalog_id="$2"
      shift 2
      ;;
    --cognito-file)
      [[ $# -ge 2 ]] || fail "--cognito-file requires a value"
      cognito_file="$2"
      shift 2
      ;;
    --region)
      [[ $# -ge 2 ]] || fail "--region requires a value"
      region="$2"
      shift 2
      ;;
    --user-pool-id)
      [[ $# -ge 2 ]] || fail "--user-pool-id requires a value"
      user_pool_id="$2"
      shift 2
      ;;
    --app-client-id)
      [[ $# -ge 2 ]] || fail "--app-client-id requires a value"
      app_client_id="$2"
      shift 2
      ;;
    --provider-id)
      [[ $# -ge 2 ]] || fail "--provider-id requires a value"
      provider_id="$2"
      shift 2
      ;;
    --mapping-id)
      [[ $# -ge 2 ]] || fail "--mapping-id requires a value"
      mapping_id="$2"
      shift 2
      ;;
    --issuer)
      [[ $# -ge 2 ]] || fail "--issuer requires a value"
      issuer="$2"
      shift 2
      ;;
    --jwks-uri)
      [[ $# -ge 2 ]] || fail "--jwks-uri requires a value"
      jwks_uri="$2"
      shift 2
      ;;
    --audience)
      [[ $# -ge 2 ]] || fail "--audience requires a value"
      if [[ -n "${audiences}" ]]; then
        audiences="${audiences},$2"
      else
        audiences="$2"
      fi
      shift 2
      ;;
    --readers-group)
      [[ $# -ge 2 ]] || fail "--readers-group requires a value"
      readers_group="$2"
      shift 2
      ;;
    --admins-group)
      [[ $# -ge 2 ]] || fail "--admins-group requires a value"
      admins_group="$2"
      shift 2
      ;;
    --read-rule-id)
      [[ $# -ge 2 ]] || fail "--read-rule-id requires a value"
      read_rule_id="$2"
      shift 2
      ;;
    --admin-rule-id)
      [[ $# -ge 2 ]] || fail "--admin-rule-id requires a value"
      admin_rule_id="$2"
      shift 2
      ;;
    --output-file)
      [[ $# -ge 2 ]] || fail "--output-file requires a value"
      output_file="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

require_command curl
require_command node

if [[ -n "${cognito_file}" ]]; then
  [[ -f "${cognito_file}" ]] || fail "cognito file not found: ${cognito_file}"
  [[ -n "${region}" ]] || region="$(json_file_field "${cognito_file}" region)"
  [[ -n "${user_pool_id}" ]] || user_pool_id="$(json_file_field "${cognito_file}" userPoolId)"
  [[ -n "${issuer}" ]] || issuer="$(json_file_field "${cognito_file}" issuer)"
  [[ -n "${jwks_uri}" ]] || jwks_uri="$(json_file_field "${cognito_file}" jwksUri)"
  [[ -n "${app_client_id}" ]] || app_client_id="$(json_file_field "${cognito_file}" appClientId)"
  [[ -n "${audiences}" ]] || audiences="$(json_file_field "${cognito_file}" audience)"
  if [[ "${readers_group}" == "quacklake-readers" ]]; then
    file_readers_group="$(json_file_field "${cognito_file}" readersGroup)"
    [[ -z "${file_readers_group}" ]] || readers_group="${file_readers_group}"
  fi
  if [[ "${admins_group}" == "quacklake-admins" ]]; then
    file_admins_group="$(json_file_field "${cognito_file}" adminsGroup)"
    [[ -z "${file_admins_group}" ]] || admins_group="${file_admins_group}"
  fi
fi

[[ -n "${worker_url}" ]] || fail "set QUACKLAKE_URL, WORKER, or pass --worker-url"
[[ -n "${admin_token}" ]] || fail "set QUACKLAKE_ADMIN_TOKEN, ADMIN_TOKEN, or pass --admin-token"
[[ -n "${catalog_id}" ]] || fail "set CATALOG_ID or pass --catalog-id"
[[ "${catalog_id}" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$ ]] || fail "catalog id must be 1-128 chars using letters, digits, underscore, dot, colon, or dash"
[[ -n "${region}" ]] || fail "set region via --region, AWS_REGION, or --cognito-file"
[[ -n "${user_pool_id}" ]] || fail "set user pool id via --user-pool-id or --cognito-file"
[[ -n "${app_client_id}" ]] || fail "set app client id via --app-client-id or --cognito-file"
[[ -n "${readers_group}" ]] || fail "readers group must not be empty"
[[ -n "${admins_group}" ]] || fail "admins group must not be empty"

worker_url="$(normalize_worker_url "${worker_url}")"
if [[ -z "${issuer}" ]]; then
  issuer="https://cognito-idp.${region}.amazonaws.com/${user_pool_id}"
fi
if [[ -z "${jwks_uri}" ]]; then
  jwks_uri="${issuer}/.well-known/jwks.json"
fi
if [[ -z "${audiences}" ]]; then
  audiences="${app_client_id}"
fi
if [[ -z "${provider_id}" ]]; then
  provider_id="cognito-${catalog_id}"
fi
if [[ -z "${mapping_id}" ]]; then
  mapping_id="cognito-${catalog_id}-groups"
fi
if [[ -z "${read_rule_id}" ]]; then
  read_rule_id="${provider_id}-read-only"
fi
if [[ -z "${admin_rule_id}" ]]; then
  admin_rule_id="${provider_id}-admin"
fi
[[ "${provider_id}" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$ ]] || fail "provider id must be 1-128 chars using letters, digits, underscore, dot, colon, or dash"
[[ "${mapping_id}" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$ ]] || fail "mapping id must be 1-128 chars using letters, digits, underscore, dot, colon, or dash"

encoded_catalog_id="$(url_encode "${catalog_id}")"
encoded_provider_id="$(url_encode "${provider_id}")"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/quacklake-register-cognito.XXXXXX")"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

catalogs_response="${tmp_dir}/catalogs.json"
provider_response="${tmp_dir}/provider.json"
mapping_response="${tmp_dir}/mapping.json"
policy_response="${tmp_dir}/policy.json"
update_response="${tmp_dir}/update.json"

printf 'Checking catalog %s...\n' "${catalog_id}"
catalogs_status="$(request GET "${worker_url}/admin/catalogs" "" "${catalogs_response}")"
if [[ ! "${catalogs_status}" =~ ^2[0-9][0-9]$ ]]; then
  fail "catalog list failed with HTTP ${catalogs_status}: $(head -c 1000 "${catalogs_response}")"
fi
if [[ "$(catalog_exists_in_response <"${catalogs_response}")" != "yes" ]]; then
  fail "catalog ${catalog_id} does not exist; create it before registering Cognito"
fi

printf 'Upserting OIDC provider %s...\n' "${provider_id}"
provider_get_status="$(request GET "${worker_url}/admin/oidc/providers/${encoded_provider_id}" "" "${provider_response}")"
if [[ "${provider_get_status}" == "200" ]]; then
  provider_status="$(request PUT "${worker_url}/admin/oidc/providers/${encoded_provider_id}" "$(provider_payload)" "${update_response}")"
elif [[ "${provider_get_status}" == "404" ]]; then
  provider_status="$(request POST "${worker_url}/admin/oidc/providers" "$(provider_payload)" "${update_response}")"
else
  fail "provider lookup failed with HTTP ${provider_get_status}: $(head -c 1000 "${provider_response}")"
fi
if [[ ! "${provider_status}" =~ ^2[0-9][0-9]$ ]]; then
  fail "provider upsert failed with HTTP ${provider_status}: $(head -c 1000 "${update_response}")"
fi

printf 'Merging Cognito catalog mapping %s...\n' "${mapping_id}"
mapping_get_status="$(request GET "${worker_url}/admin/catalogs/${encoded_catalog_id}/auth-mapping" "" "${mapping_response}")"
if [[ ! "${mapping_get_status}" =~ ^2[0-9][0-9]$ ]]; then
  fail "mapping fetch failed with HTTP ${mapping_get_status}: $(head -c 1000 "${mapping_response}")"
fi
mapping_status="$(request PUT "${worker_url}/admin/catalogs/${encoded_catalog_id}/auth-mapping" "$(mapping_payload <"${mapping_response}")" "${update_response}")"
if [[ ! "${mapping_status}" =~ ^2[0-9][0-9]$ ]]; then
  fail "mapping update failed with HTTP ${mapping_status}: $(head -c 1000 "${update_response}")"
fi

printf 'Merging read-only/admin policy rules...\n'
policy_get_status="$(request GET "${worker_url}/admin/catalogs/${encoded_catalog_id}/auth-policy" "" "${policy_response}")"
if [[ ! "${policy_get_status}" =~ ^2[0-9][0-9]$ ]]; then
  fail "policy fetch failed with HTTP ${policy_get_status}: $(head -c 1000 "${policy_response}")"
fi
policy_status="$(request PUT "${worker_url}/admin/catalogs/${encoded_catalog_id}/auth-policy" "$(policy_payload <"${policy_response}")" "${update_response}")"
if [[ ! "${policy_status}" =~ ^2[0-9][0-9]$ ]]; then
  fail "policy update failed with HTTP ${policy_status}: $(head -c 1000 "${update_response}")"
fi

summary="$(summary_json)"
if [[ -n "${output_file}" ]]; then
  printf '%s\n' "${summary}" >"${output_file}"
fi

printf '\nCognito registration complete.\n'
printf 'Catalog: %s\n' "${catalog_id}"
printf 'Provider ID: %s\n' "${provider_id}"
printf 'Issuer: %s\n' "${issuer}"
printf 'Audience: %s\n' "${audiences}"
printf 'Mapping ID: %s\n' "${mapping_id}"
printf 'Read-only group: %s\n' "${readers_group}"
printf 'Admin group: %s\n' "${admins_group}"
if [[ -n "${output_file}" ]]; then
  printf 'Wrote registration summary to %s\n' "${output_file}"
fi

printf '\nUse an ID token from this app client as the Quack TOKEN value.\n'
