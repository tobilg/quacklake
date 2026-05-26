#!/usr/bin/env bash
set -euo pipefail

worker_url="${QUACKLAKE_URL:-${WORKER:-${WORKER_URL:-}}}"
admin_token="${QUACKLAKE_ADMIN_TOKEN:-${ADMIN_TOKEN:-}}"
catalog_id="${CATALOG_ID:-personal}"
personal_scope="${PERSONAL_SCOPE:-catalog.admin}"
jwt_ttl_seconds="${JWT_TTL_SECONDS:-31536000}"
output_file="${OUTPUT_FILE:-}"

usage() {
  cat <<'EOF'
Usage: scripts/create-jwt.sh [options]

Creates a first-party quacklake JWT credential for personal use and installs
a catalog policy that allows table CRUD plus querying all tables. If the catalog
already exists, the script issues another credential and replaces that catalog's
auth policy with the personal-use policy.

The application must already be deployed.

Required input:
  --worker-url URL      Deployed Worker base URL. Env: QUACKLAKE_URL, WORKER, or WORKER_URL.
  --admin-token TOKEN   Admin API bearer token. Env: QUACKLAKE_ADMIN_TOKEN or ADMIN_TOKEN.

Options:
  --catalog-id ID       Catalog id to create or use. Default: personal.
  --scope SCOPE         JWT scope and policy principal scope. Default: catalog.admin.
  --ttl-seconds SECONDS JWT validity in seconds. Default: 31536000 (365 days).
  --output-file PATH    Write a JSON summary including the one-time-visible JWT and DuckLake SQL.
  -h, --help            Show this help.

Examples:
  QUACKLAKE_URL=https://quacklake.example.workers.dev \
  ADMIN_TOKEN=... \
  scripts/create-jwt.sh

  scripts/create-jwt.sh \
    --worker-url https://quacklake.example.workers.dev \
    --admin-token ... \
    --catalog-id personal \
    --output-file /tmp/quacklake-personal.json
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

normalize_worker_url() {
  node -e "let raw = process.argv[1] || ''; if (!raw) process.exit(0); if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw; const url = new URL(raw); url.pathname = ''; url.search = ''; url.hash = ''; process.stdout.write(url.toString().replace(/\/$/, ''));" "$1"
}

quack_uri_from_worker_url() {
  node -e "const url = new URL(process.argv[1]); const port = url.port || (url.protocol === 'https:' ? '443' : '80'); process.stdout.write('quack:' + url.hostname + ':' + port);" "$1"
}

url_encode() {
  node -e "process.stdout.write(encodeURIComponent(process.argv[1] || ''));" "$1"
}

json_field() {
  local field_path="$1"
  node -e '
const fieldPath = process.argv[1];
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
  let value = data;
  for (const part of fieldPath.split(".")) {
    if (!part) continue;
    value = value?.[part];
  }
  if (value !== undefined && value !== null) {
    process.stdout.write(String(value));
  }
});
' "${field_path}"
}

catalog_data_path() {
  local catalog_id="$1"
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
  const catalog = (data.catalogs ?? []).find((entry) => entry?.catalogId === catalogId);
  if (catalog?.dataPath) {
    process.stdout.write(String(catalog.dataPath));
  }
});
' "${catalog_id}"
}

sql_literal() {
  node -e "process.stdout.write(\"'\" + String(process.argv[1] ?? '').replaceAll(\"'\", \"''\") + \"'\");" "$1"
}

credential_payload() {
  node - "$catalog_id" "$personal_scope" "$jwt_ttl_seconds" <<'NODE'
const catalogId = process.argv[2];
const scope = process.argv[3];
const expiresInSeconds = Number(process.argv[4]);
if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
  throw new Error("JWT_TTL_SECONDS must be a positive number");
}
process.stdout.write(JSON.stringify({
  catalogId,
  scopes: [scope],
  expiresInSeconds,
}));
NODE
}

credential_only_payload() {
  node - "$personal_scope" "$jwt_ttl_seconds" <<'NODE'
const scope = process.argv[2];
const expiresInSeconds = Number(process.argv[3]);
if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
  throw new Error("JWT_TTL_SECONDS must be a positive number");
}
process.stdout.write(JSON.stringify({
  scopes: [scope],
  expiresInSeconds,
}));
NODE
}

policy_payload() {
  node - "$personal_scope" <<'NODE'
const scope = process.argv[2];
process.stdout.write(JSON.stringify({
  version: 1,
  defaultEffect: "deny",
  rules: [
    {
      ruleId: "personal-table-crud-and-query-all",
      effect: "allow",
      principal: {
        scopesAny: [scope],
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
    },
  ],
}));
NODE
}

json_summary() {
  node - "$catalog_id" "$personal_scope" "$jwt_ttl_seconds" "$credential_id" "$expires_at" "$worker_url" "$quack_uri" "$data_path" "$jwt" "$duckdb_secret_sql" "$ducklake_attach_sql" <<'NODE'
const [catalogId, scope, ttlSeconds, credentialId, expiresAt, workerUrl, quackUri, dataPath, jwt, secretSql, attachSql] = process.argv.slice(2);
process.stdout.write(JSON.stringify({
  catalogId,
  scope,
  ttlSeconds: Number(ttlSeconds),
  credentialId,
  expiresAt,
  workerUrl,
  quackUri,
  dataPath,
  jwt,
  duckdb: {
    secretSql,
  },
  ducklake: {
    attachSql,
  },
}, null, 2));
process.stdout.write("\n");
NODE
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
    --scope)
      [[ $# -ge 2 ]] || fail "--scope requires a value"
      personal_scope="$2"
      shift 2
      ;;
    --ttl-seconds)
      [[ $# -ge 2 ]] || fail "--ttl-seconds requires a value"
      jwt_ttl_seconds="$2"
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

[[ -n "${worker_url}" ]] || fail "set QUACKLAKE_URL, WORKER, or pass --worker-url"
[[ -n "${admin_token}" ]] || fail "set QUACKLAKE_ADMIN_TOKEN, ADMIN_TOKEN, or pass --admin-token"
[[ "${catalog_id}" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$ ]] || fail "catalog id must be 1-128 chars using letters, digits, underscore, dot, colon, or dash"
[[ -n "${personal_scope}" ]] || fail "scope must not be empty"
[[ "${personal_scope}" =~ ^[^[:space:]]+$ ]] || fail "scope must not contain whitespace"
[[ "${jwt_ttl_seconds}" =~ ^[0-9]+$ ]] || fail "ttl seconds must be a positive integer"

worker_url="$(normalize_worker_url "${worker_url}")"
quack_uri="$(quack_uri_from_worker_url "${worker_url}")"
encoded_catalog_id="$(url_encode "${catalog_id}")"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/quacklake-standup.XXXXXX")"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

create_response="${tmp_dir}/create-catalog.json"
credential_response="${tmp_dir}/credential.json"
policy_response="${tmp_dir}/policy.json"
catalogs_response="${tmp_dir}/catalogs.json"

printf 'Creating first-party credential for catalog %s...\n' "${catalog_id}"
create_status="$(request POST "${worker_url}/admin/catalogs" "$(credential_payload)" "${create_response}")"

if [[ "${create_status}" == "201" ]]; then
  cp "${create_response}" "${credential_response}"
  data_path="$(json_field catalog.dataPath <"${create_response}")"
  if [[ -z "${data_path}" ]]; then
    data_path="$(json_field ducklake.dataPath <"${create_response}")"
  fi
elif [[ "${create_status}" == "409" ]]; then
  printf 'Catalog already exists; issuing another first-party credential...\n'
  credential_status="$(request POST "${worker_url}/admin/catalogs/${encoded_catalog_id}/credentials" "$(credential_only_payload)" "${credential_response}")"
  if [[ "${credential_status}" != "201" ]]; then
    fail "credential creation failed with HTTP ${credential_status}: $(head -c 1000 "${credential_response}")"
  fi
  catalogs_status="$(request GET "${worker_url}/admin/catalogs" "" "${catalogs_response}")"
  if [[ ! "${catalogs_status}" =~ ^2[0-9][0-9]$ ]]; then
    fail "catalog lookup failed with HTTP ${catalogs_status}: $(head -c 1000 "${catalogs_response}")"
  fi
  data_path="$(catalog_data_path "${catalog_id}" <"${catalogs_response}")"
else
  fail "catalog creation failed with HTTP ${create_status}: $(head -c 1000 "${create_response}")"
fi

jwt="$(json_field jwt <"${credential_response}")"
credential_id="$(json_field credentialId <"${credential_response}")"
expires_at="$(json_field credential.expiresAt <"${credential_response}")"
[[ -n "${jwt}" ]] || fail "credential response did not contain jwt: $(head -c 1000 "${credential_response}")"
[[ -n "${credential_id}" ]] || fail "credential response did not contain credentialId: $(head -c 1000 "${credential_response}")"
[[ -n "${data_path}" ]] || fail "catalog did not contain a planned dataPath"

duckdb_secret_sql="CREATE OR REPLACE SECRET quacklake_${catalog_id//[^A-Za-z0-9_]/_} (TYPE quack, TOKEN $(sql_literal "${jwt}"), SCOPE $(sql_literal "${quack_uri}"));"
ducklake_attach_sql="ATTACH $(sql_literal "ducklake:${quack_uri}") AS lake (DATA_PATH $(sql_literal "${data_path}"));"

printf 'Installing personal CRUD/read policy for catalog %s...\n' "${catalog_id}"
policy_status="$(request PUT "${worker_url}/admin/catalogs/${encoded_catalog_id}/auth-policy" "$(policy_payload)" "${policy_response}")"
if [[ ! "${policy_status}" =~ ^2[0-9][0-9]$ ]]; then
  fail "policy update failed with HTTP ${policy_status}: $(head -c 1000 "${policy_response}")"
fi

if [[ -n "${output_file}" ]]; then
  json_summary >"${output_file}"
  chmod 600 "${output_file}" 2>/dev/null || true
fi

printf '\nStandup complete.\n'
printf 'Catalog: %s\n' "${catalog_id}"
printf 'Credential ID: %s\n' "${credential_id}"
printf 'Scope: %s\n' "${personal_scope}"
printf 'Expires at: %s\n' "${expires_at}"
printf 'Worker URL: %s\n' "${worker_url}"
printf 'Quack URI: %s\n' "${quack_uri}"
printf 'DuckLake DATA_PATH: %s\n' "${data_path}"
printf '\nJWT:\n%s\n' "${jwt}"
printf '\nDuckDB secret:\n'
printf '%s\n' "${duckdb_secret_sql}"
printf '\nDuckLake attach:\n'
printf '%s\n' "${ducklake_attach_sql}"
if [[ -n "${output_file}" ]]; then
  printf '\nWrote JSON summary to %s\n' "${output_file}"
fi
