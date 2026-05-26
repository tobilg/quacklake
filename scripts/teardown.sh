#!/usr/bin/env bash
set -euo pipefail

worker_name="${WORKER_NAME:-quacklake}"
compatibility_date="${COMPATIBILITY_DATE:-2026-05-14}"
do_delete_tag="${DO_DELETE_TAG:-delete-quacklake-do-data-2026-05-19}"
r2_bucket="${R2_BUCKET:-quacklake}"
r2_jurisdiction="${R2_JURISDICTION:-eu}"

force=0
dry_run=0
skip_do_migration=0
delete_r2_bucket=0

usage() {
  cat <<'EOF'
Usage: scripts/teardown.sh [options]

Deletes the deployed quacklake Worker and, by default, first deploys a
temporary Worker config that applies a Durable Object delete migration for:
  - CatalogRegistry
  - QuackCatalogObject

This script intentionally does not support Wrangler environments and never
passes --env.

Options:
  --force              Skip the interactive confirmation.
  --dry-run            Build/check the delete migration and dry-run Worker deletion.
  --skip-do-migration  Delete the Worker without applying the DO delete migration.
  --delete-r2-bucket   Also delete the R2 bucket after Worker teardown.
  --worker-name NAME   Worker name to delete. Default: quacklake.
  --r2-bucket NAME     R2 bucket to delete with --delete-r2-bucket. Default: quacklake.
  --r2-jurisdiction J  R2 bucket jurisdiction. Default: eu.
  -h, --help           Show this help.

Environment overrides:
  WORKER_NAME, COMPATIBILITY_DATE, DO_DELETE_TAG, R2_BUCKET, R2_JURISDICTION
  WRANGLER="npx wrangler" can override the Wrangler command. Default: pnpm exec wrangler
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

wrangler() {
  if [[ -n "${WRANGLER:-}" ]]; then
    # Allow callers to provide a command with arguments, for example:
    # WRANGLER="npx wrangler" scripts/teardown.sh
    # shellcheck disable=SC2086
    ${WRANGLER} "$@"
  else
    pnpm exec wrangler "$@"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      force=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --skip-do-migration)
      skip_do_migration=1
      shift
      ;;
    --delete-r2-bucket)
      delete_r2_bucket=1
      shift
      ;;
    --worker-name)
      [[ $# -ge 2 ]] || fail "--worker-name requires a value"
      worker_name="$2"
      shift 2
      ;;
    --r2-bucket)
      [[ $# -ge 2 ]] || fail "--r2-bucket requires a value"
      r2_bucket="$2"
      shift 2
      ;;
    --r2-jurisdiction)
      [[ $# -ge 2 ]] || fail "--r2-jurisdiction requires a value"
      r2_jurisdiction="$2"
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

if [[ "${dry_run}" -eq 1 ]]; then
  printf 'Dry run: no remote resources will be deleted.\n'
fi

printf 'Remote teardown target:\n'
printf '  Worker: %s\n' "${worker_name}"
if [[ "${skip_do_migration}" -eq 0 ]]; then
  printf '  Durable Object delete migration tag: %s\n' "${do_delete_tag}"
  printf '  Durable Object classes: CatalogRegistry, QuackCatalogObject\n'
else
  printf '  Durable Object delete migration: skipped\n'
fi
if [[ "${delete_r2_bucket}" -eq 1 ]]; then
  printf '  R2 bucket: %s (%s)\n' "${r2_bucket}" "${r2_jurisdiction}"
else
  printf '  R2 bucket deletion: skipped\n'
fi

if [[ "${force}" -eq 0 && "${dry_run}" -eq 0 ]]; then
  printf '\nThis will delete deployed Cloudflare resources. Type "%s" to continue: ' "${worker_name}"
  read -r confirmation
  [[ "${confirmation}" == "${worker_name}" ]] || fail "confirmation did not match; aborting"
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/quacklake-teardown.XXXXXX")"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

teardown_worker="${tmp_dir}/teardown-worker.mjs"
teardown_config="${tmp_dir}/wrangler.teardown.jsonc"

cat >"${teardown_worker}" <<'EOF'
export default {
  async fetch() {
    return new Response("quacklake teardown deployment\n", { status: 410 });
  },
};
EOF

cat >"${teardown_config}" <<EOF
{
  "name": "${worker_name}",
  "main": "teardown-worker.mjs",
  "compatibility_date": "${compatibility_date}",
  "compatibility_flags": ["nodejs_compat"],
  "migrations": [
    {
      "tag": "v1"
    },
    {
      "tag": "${do_delete_tag}",
      "deleted_classes": ["CatalogRegistry", "QuackCatalogObject"]
    }
  ]
}
EOF

printf '\nChecking Wrangler authentication...\n'
wrangler whoami

if [[ "${skip_do_migration}" -eq 0 ]]; then
  if [[ "${dry_run}" -eq 1 ]]; then
    printf '\nChecking temporary delete-migration deployment with Wrangler dry run...\n'
    wrangler deploy --dry-run --config "${teardown_config}" --cwd "${tmp_dir}"
  else
    printf '\nDeploying temporary Worker to apply Durable Object delete migration...\n'
    wrangler deploy --config "${teardown_config}" --cwd "${tmp_dir}"
  fi
fi

printf '\nDeleting Worker %s...\n' "${worker_name}"
if [[ "${dry_run}" -eq 1 ]]; then
  wrangler delete "${worker_name}" --dry-run
else
  wrangler delete "${worker_name}"
fi

if [[ "${delete_r2_bucket}" -eq 1 ]]; then
  printf '\nDeleting R2 bucket %s...\n' "${r2_bucket}"
  if [[ "${dry_run}" -eq 1 ]]; then
    printf 'Dry run: would run wrangler r2 bucket delete %s --jurisdiction %s\n' "${r2_bucket}" "${r2_jurisdiction}"
  else
    wrangler r2 bucket delete "${r2_bucket}" --jurisdiction "${r2_jurisdiction}"
  fi
fi

printf '\nTeardown complete.\n'
