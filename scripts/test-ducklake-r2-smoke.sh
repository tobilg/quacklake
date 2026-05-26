#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

sql_literal() {
  node -e "const value = process.argv[1] ?? ''; process.stdout.write(\"'\" + value.replaceAll(\"'\", \"''\") + \"'\");" "$1"
}

json_token() {
  node -e "let body = ''; process.stdin.on('data', chunk => body += chunk); process.stdin.on('end', () => { const parsed = JSON.parse(body); process.stdout.write(parsed.jwt || parsed.token || ''); });"
}

json_data_path() {
  node -e "let body = ''; process.stdin.on('data', chunk => body += chunk); process.stdin.on('end', () => { const parsed = JSON.parse(body); process.stdout.write(parsed.catalog?.dataPath || parsed.ducklake?.dataPath || ''); });"
}

normalize_worker_url() {
  node -e "let raw = process.argv[1]; if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw; const url = new URL(raw); url.pathname = ''; url.search = ''; url.hash = ''; process.stdout.write(url.toString().replace(/\/$/, ''));" "$1"
}

quack_uri_from_worker_url() {
  node -e "const url = new URL(process.argv[1]); const port = url.port || (url.protocol === 'https:' ? '443' : '80'); process.stdout.write('quack:' + url.hostname + ':' + port);" "$1"
}

curl_checked() {
  local error_file
  local body_file
  local status
  local curl_exit
  error_file="$(mktemp "/tmp/quacklake-r2-smoke-curl.XXXXXX.log")"
  body_file="$(mktemp "/tmp/quacklake-r2-smoke-curl.XXXXXX.body")"
  status="$(curl -sS -o "${body_file}" -w "%{http_code}" "$@" 2>"${error_file}")"
  curl_exit=$?
  if [[ "${curl_exit}" -ne 0 || ! "${status}" =~ ^2[0-9][0-9]$ ]]; then
    local detail=""
    if [[ -s "${body_file}" ]]; then
      detail=" body=$(head -c 500 "${body_file}")"
    elif [[ -s "${error_file}" ]]; then
      detail=" error=$(head -c 500 "${error_file}")"
    fi
    rm -f "${error_file}" "${body_file}"
    fail "request to deployed Worker failed with HTTP ${status}${detail}"
  fi
  cat "${body_file}"
  rm -f "${error_file}" "${body_file}"
}

dotenv_value() {
  node - "$@" <<'NODE'
const fs = require("fs");
const names = process.argv.slice(2);
if (!fs.existsSync(".dev.vars")) {
  process.exit(0);
}
const values = new Map();
for (const rawLine of fs.readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) {
    continue;
  }
  const match =
    line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/) ??
    line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/);
  if (!match) {
    continue;
  }
  let value = match[2] ?? "";
  const commentIndex = value.search(/\s#/);
  if (commentIndex >= 0 && !/^['"]/.test(value.trimStart())) {
    value = value.slice(0, commentIndex);
  }
  value = value.trim();
  if (value.endsWith(",")) {
    value = value.slice(0, -1).trim();
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  values.set(match[1], value);
}
for (const name of names) {
  const value = values.get(name);
  if (value) {
    process.stdout.write(value);
    break;
  }
}
NODE
}

value_from_env_or_dev_vars() {
  for name in "$@"; do
    if [[ -n "${!name:-}" ]]; then
      printf '%s' "${!name}"
      return
    fi
  done
  dotenv_value "$@"
}

first_binding_bucket() {
  node -e "const raw = process.argv[1] || ''; try { const parsed = JSON.parse(raw); const key = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed)[0] : ''; process.stdout.write(key || ''); } catch {}" "$1"
}

bucket_from_wrangler_config() {
  node - "$@" <<'NODE'
const fs = require("fs");
const placeholders = /<|replace-with-/;
for (const path of process.argv.slice(2)) {
  if (!fs.existsSync(path)) {
    continue;
  }
  try {
    const config = JSON.parse(fs.readFileSync(path, "utf8"));
    const map = JSON.parse(config.vars?.DUCKLAKE_R2_BINDINGS || "{}");
    const fromMap = map && typeof map === "object" && !Array.isArray(map) ? Object.keys(map)[0] : "";
    if (fromMap && !placeholders.test(fromMap)) {
      process.stdout.write(fromMap);
      process.exit(0);
    }
    const fromBinding = Array.isArray(config.r2_buckets)
      ? config.r2_buckets.map((entry) => entry?.bucket_name).find((value) => typeof value === "string" && value && !placeholders.test(value))
      : "";
    if (fromBinding) {
      process.stdout.write(fromBinding);
      process.exit(0);
    }
  } catch {}
}
NODE
}

admin_token="$(value_from_env_or_dev_vars QUACKLAKE_ADMIN_TOKEN ADMIN_TOKEN)"
[[ -n "${admin_token}" ]] || fail "set QUACKLAKE_ADMIN_TOKEN or ADMIN_TOKEN"

r2_access_key_id="$(value_from_env_or_dev_vars R2_ACCESS_KEY_ID AWS_ACCESS_KEY_ID)"
r2_secret_access_key="$(value_from_env_or_dev_vars R2_SECRET_ACCESS_KEY AWS_SECRET_ACCESS_KEY)"
r2_account_id="$(value_from_env_or_dev_vars R2_ACCOUNT_ID CLOUDFLARE_ACCOUNT_ID)"
r2_endpoint="$(value_from_env_or_dev_vars R2_ENDPOINT AWS_ENDPOINT_URL_S3 AWS_ENDPOINT_URL)"
[[ -n "${r2_access_key_id}" ]] || fail "set R2_ACCESS_KEY_ID or AWS_ACCESS_KEY_ID"
[[ -n "${r2_secret_access_key}" ]] || fail "set R2_SECRET_ACCESS_KEY or AWS_SECRET_ACCESS_KEY"
[[ -n "${r2_account_id}" ]] || fail "set R2_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID"
if [[ -z "${r2_endpoint}" ]]; then
  r2_endpoint="${r2_account_id}.r2.cloudflarestorage.com"
fi

quacklake_url="$(value_from_env_or_dev_vars QUACKLAKE_URL)"
[[ -n "${quacklake_url}" ]] || fail "set QUACKLAKE_URL, for example https://<worker-host>"
worker_url="$(normalize_worker_url "${quacklake_url}")"
quack_uri="$(value_from_env_or_dev_vars QUACK_URI)"
quack_uri="${quack_uri:-$(quack_uri_from_worker_url "${worker_url}")}"
r2_bucket="$(value_from_env_or_dev_vars R2_BUCKET R2_BUCKET_NAME)"
if [[ -z "${r2_bucket}" ]]; then
  r2_binding_map="$(value_from_env_or_dev_vars DUCKLAKE_R2_BINDINGS)"
  r2_bucket="$(first_binding_bucket "${r2_binding_map}")"
fi
if [[ -z "${r2_bucket}" ]]; then
  r2_bucket="$(bucket_from_wrangler_config wrangler.jsonc wrangler.example.jsonc)"
fi
[[ -n "${r2_bucket}" ]] || fail "set R2_BUCKET, R2_BUCKET_NAME, DUCKLAKE_R2_BINDINGS, or copy wrangler.example.jsonc to wrangler.jsonc and set bucket_name"
catalog_id="$(value_from_env_or_dev_vars CATALOG_ID)"
catalog_id="${catalog_id:-r2_smoke_$(date +%s)}"
sql_file="$(mktemp "/tmp/quacklake-r2-smoke.XXXXXX.sql")"

cleanup() {
  rm -f "${sql_file}"
}
trap cleanup EXIT

printf 'Checking deployed Worker health endpoint...\n'
curl_checked "${worker_url}/" >/dev/null

printf 'Creating catalog %s...\n' "${catalog_id}"
catalog_json="$(
  curl_checked -X POST "${worker_url}/admin/catalogs" \
    -H "Authorization: Bearer ${admin_token}" \
    -H "Content-Type: application/json" \
    -d "{\"catalogId\":\"${catalog_id}\",\"r2Bucket\":\"${r2_bucket}\"}"
)"
token="$(printf '%s' "${catalog_json}" | json_token)"
[[ -n "${token}" ]] || fail "catalog creation did not return a jwt"
data_path="$(printf '%s' "${catalog_json}" | json_data_path)"
[[ -n "${data_path}" ]] || fail "catalog creation did not return catalog.dataPath"
source_path="${data_path}external/source.parquet"
orphan_path="${data_path}analytics/events/orphan.parquet"
r2_scope="${data_path}"

token_sql="$(sql_literal "${token}")"
r2_access_key_id_sql="$(sql_literal "${r2_access_key_id}")"
r2_secret_access_key_sql="$(sql_literal "${r2_secret_access_key}")"
r2_account_id_sql="$(sql_literal "${r2_account_id}")"
r2_endpoint_sql="$(sql_literal "${r2_endpoint}")"
r2_scope_sql="$(sql_literal "${r2_scope}")"
attach_uri_sql="$(sql_literal "ducklake:${quack_uri}")"
data_path_sql="$(sql_literal "${data_path}")"
source_path_sql="$(sql_literal "${source_path}")"
orphan_path_sql="$(sql_literal "${orphan_path}")"

cat >"${sql_file}" <<SQL
INSTALL httpfs;
INSTALL quack FROM core_nightly;
INSTALL ducklake FROM core_nightly;
LOAD httpfs;
LOAD quack;
LOAD ducklake;

CREATE OR REPLACE SECRET quacklake_catalog (
  TYPE quack,
  TOKEN ${token_sql}
);

CREATE OR REPLACE SECRET quacklake_r2 (
  TYPE r2,
  KEY_ID ${r2_access_key_id_sql},
  SECRET ${r2_secret_access_key_sql},
  ACCOUNT_ID ${r2_account_id_sql},
  ENDPOINT ${r2_endpoint_sql},
  SCOPE ${r2_scope_sql}
);

ATTACH ${attach_uri_sql} AS lake (
  DATA_PATH ${data_path_sql},
  DATA_INLINING_ROW_LIMIT 10,
  METADATA_CATALOG 'meta'
);

CALL lake.set_option('per_thread_output', 'false');
CREATE SCHEMA lake.analytics;
CREATE TABLE lake.analytics.events(id INTEGER, label VARCHAR);
INSERT INTO lake.analytics.events VALUES
  (1, 'alpha'),
  (2, 'bravo'),
  (3, 'charlie');

SELECT CASE WHEN (SELECT COUNT(*) FROM lake.analytics.events) = 3
  THEN 'ok'
  ELSE error('initial insert/read failed')
END AS initial_insert_assertion;

SELECT CASE WHEN (SELECT COUNT(*) FROM lake.snapshots()) >= 1
  THEN 'ok'
  ELSE error('snapshot listing returned no rows')
END AS snapshots_assertion;

CALL ducklake_flush_inlined_data('lake');
INSERT INTO lake.analytics.events VALUES
  (4, 'delta'),
  (5, 'echo'),
  (6, 'foxtrot');
CALL ducklake_flush_inlined_data('lake');

CREATE TABLE lake.analytics.added_events(id INTEGER, label VARCHAR);
CREATE TEMP TABLE source_for_add AS
  SELECT i::INTEGER AS id, ('added-' || i::VARCHAR) AS label
  FROM range(10, 13) tbl(i);
COPY source_for_add TO ${source_path_sql} (FORMAT PARQUET);

SELECT CASE WHEN (SELECT COUNT(*) FROM read_parquet(${source_path_sql})) = 3
  THEN 'ok'
  ELSE error('DuckDB could not read the R2 source Parquet file')
END AS source_read_r2_assertion;

CREATE TEMP TABLE add_files_result AS
SELECT *
FROM ducklake_add_data_files(
  'lake',
  'added_events',
  ${source_path_sql},
  schema => 'analytics'
);

SELECT * FROM add_files_result;

SELECT CASE WHEN (SELECT COUNT(*) FROM lake.analytics.added_events) = 3
  THEN 'ok'
  ELSE error('R2 ducklake_add_data_files did not add expected rows')
END AS add_files_r2_assertion;

COPY (SELECT 999::INTEGER AS id, 'orphan' AS label)
TO ${orphan_path_sql} (FORMAT PARQUET);

CREATE TEMP TABLE orphan_dry_run AS
  SELECT path
  FROM ducklake_delete_orphaned_files('lake', cleanup_all => true, dry_run => true);

SELECT CASE WHEN (SELECT COUNT(*) FROM orphan_dry_run) = 1
    AND EXISTS (SELECT 1 FROM orphan_dry_run WHERE ends_with(path, 'orphan.parquet'))
  THEN 'ok'
  ELSE error('R2 orphan discovery did not find exactly the expected orphan')
END AS orphan_r2_discovery_assertion;

CREATE TEMP TABLE orphan_cleanup AS
  SELECT path
  FROM ducklake_delete_orphaned_files('lake', cleanup_all => true);

SELECT CASE WHEN (SELECT COUNT(*) FROM orphan_cleanup) = 1
  THEN 'ok'
  ELSE error('R2 orphan cleanup did not remove the expected orphan')
END AS orphan_r2_cleanup_assertion;

CREATE TEMP TABLE merge_result AS
  SELECT schema_name, table_name, files_processed, files_created
  FROM ducklake_merge_adjacent_files('lake', 'events', schema => 'analytics');

SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM merge_result
    WHERE schema_name = 'analytics'
      AND table_name = 'events'
      AND files_processed >= 2
      AND files_created >= 1
  )
  THEN 'ok'
  ELSE error('R2 ducklake_merge_adjacent_files did not merge expected files')
END AS merge_r2_assertion;

SELECT CASE WHEN (SELECT COUNT(*) FROM lake.analytics.events) = 6
  THEN 'ok'
  ELSE error('unexpected row count after R2 merge')
END AS rows_after_merge_assertion;

SELECT 'quacklake_r2_smoke_ok' AS status;
SQL

printf 'Running DuckDB R2 smoke test with DATA_PATH %s...\n' "${data_path}"
duckdb -batch -f "${sql_file}"
printf 'R2 smoke test completed for catalog %s\n' "${catalog_id}"
