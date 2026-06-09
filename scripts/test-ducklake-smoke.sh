#!/usr/bin/env bash
set -euo pipefail

printf 'error: local /tmp DuckLake smoke is no longer supported because catalogs require a planned R2 DATA_PATH. Use scripts/test-ducklake-r2-smoke.sh.\n' >&2
exit 1
