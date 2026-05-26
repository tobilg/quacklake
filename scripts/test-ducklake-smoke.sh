#!/usr/bin/env bash
set -euo pipefail

printf 'error: local /tmp DuckLake smoke is no longer supported because catalogs now require a planned R2 DATA_PATH. Use scripts/test-ducklake-r2-smoke.sh.\n' >&2
exit 1

worker_port="${WORKER_PORT:-8795}"
sidecar_port="${FILE_LIST_PORT:-9797}"
admin_token="${ADMIN_TOKEN:-}"
if [[ -z "${admin_token}" && -f ".dev.vars" ]]; then
  admin_token="$(
    node -e "const fs = require('fs'); const line = fs.readFileSync('.dev.vars', 'utf8').split(/\r?\n/).find((entry) => entry.startsWith('ADMIN_TOKEN=')); process.stdout.write(line ? line.slice('ADMIN_TOKEN='.length).replace(/^['\"]|['\"]$/g, '') : '');"
  )"
fi
admin_token="${admin_token:-admin-test-token}"
catalog_id="smoke_$(date +%s)"
data_path="/tmp/quacklake-${catalog_id}/"
source_path="/tmp/quacklake-${catalog_id}-source.parquet"
source_dir="/tmp/quacklake-${catalog_id}-sources"
sidecar_log="/tmp/quacklake-${catalog_id}-sidecar.log"
worker_log="/tmp/quacklake-${catalog_id}-worker.log"

sidecar_pid=""
worker_pid=""

cleanup() {
  if [[ -n "${worker_pid}" ]]; then
    kill "${worker_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${sidecar_pid}" ]]; then
    kill "${sidecar_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

mkdir -p \
  "${source_dir}/path-partitioned/partition_column=2" \
  "${data_path}main/mixed_path_a" \
  "${data_path}main/mixed_path_b"

PORT="${sidecar_port}" npm run file-list-sidecar >"${sidecar_log}" 2>&1 &
sidecar_pid="$!"

npm run dev -- \
  --port "${worker_port}" \
  --inspector-port 0 \
  --var "DUCKLAKE_FILE_LIST_ENDPOINT:http://127.0.0.1:${sidecar_port}" \
  >"${worker_log}" 2>&1 &
worker_pid="$!"

for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${worker_port}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

curl -fsS "http://localhost:${worker_port}/" >/dev/null

catalog_json="$(
  curl -fsS -X POST "http://localhost:${worker_port}/admin/catalogs" \
    -H "Authorization: Bearer ${admin_token}" \
    -H "Content-Type: application/json" \
    -d "{\"catalogId\":\"${catalog_id}\"}"
)"
token="$(printf '%s' "${catalog_json}" | node -e "let body=''; process.stdin.on('data', chunk => body += chunk); process.stdin.on('end', () => process.stdout.write(JSON.parse(body).token));")"

duckdb -batch -c "
INSTALL quack FROM core_nightly;
INSTALL ducklake FROM core_nightly;
LOAD quack;
LOAD ducklake;
CREATE OR REPLACE SECRET (TYPE quack, TOKEN '${token}');
ATTACH 'ducklake:quack:localhost:${worker_port}' AS lake (
  DATA_PATH '${data_path}',
  DATA_INLINING_ROW_LIMIT 10,
  METADATA_CATALOG 'meta'
);
CREATE TABLE lake.main.items AS
  SELECT i::INTEGER AS id, ('v' || i::VARCHAR) AS label
  FROM range(0, 20) tbl(i);
INSERT INTO lake.main.items
  SELECT i::INTEGER, ('x' || i::VARCHAR)
  FROM range(20, 40) tbl(i);
CALL ducklake_flush_inlined_data('lake');
CREATE TABLE local_source AS
  SELECT i::INTEGER AS id, ('a' || i::VARCHAR) AS label
  FROM range(40, 45) tbl(i);
COPY local_source TO '${source_path}' (FORMAT PARQUET);
SELECT * FROM ducklake_add_data_files('lake', 'items', '${source_path}');
SELECT CASE WHEN (SELECT COUNT(*) FROM lake.main.items) = 45
  THEN 'ok'
  ELSE error('ducklake_add_data_files did not add the expected rows')
END AS add_files_assertion;
CREATE TABLE lake.main.glob_items(id INTEGER, label VARCHAR);
CREATE TABLE local_source_glob_a AS
  SELECT i::INTEGER AS id, ('g' || i::VARCHAR) AS label
  FROM range(100, 103) tbl(i);
CREATE TABLE local_source_glob_b AS
  SELECT i::INTEGER AS id, ('g' || i::VARCHAR) AS label
  FROM range(103, 106) tbl(i);
COPY local_source_glob_a TO '${source_dir}/part-a.parquet' (FORMAT PARQUET);
COPY local_source_glob_b TO '${source_dir}/part-b.parquet' (FORMAT PARQUET);
SELECT * FROM ducklake_add_data_files('lake', 'glob_items', '${source_dir}/*.parquet');
SELECT CASE WHEN (SELECT COUNT(*) FROM lake.main.glob_items) = 6
  THEN 'ok'
  ELSE error('ducklake_add_data_files did not load the expected rows from a glob')
END AS add_files_glob_assertion;
DELETE FROM lake.main.items WHERE id < 5;
CREATE TEMP TABLE rewrite_result AS
  SELECT schema_name, table_name, files_processed, files_created
  FROM ducklake_rewrite_data_files('lake', 'items', delete_threshold => 0);
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM rewrite_result
    WHERE schema_name = 'main' AND table_name = 'items' AND files_processed = 1 AND files_created = 1
  )
  THEN 'ok'
  ELSE error('ducklake_rewrite_data_files did not produce the expected result')
END AS rewrite_assertion;
CREATE TEMP TABLE merge_result AS
  SELECT schema_name, table_name, files_processed, files_created
  FROM ducklake_merge_adjacent_files('lake', 'items');
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM merge_result
    WHERE schema_name = 'main' AND table_name = 'items' AND files_processed = 3 AND files_created = 1
  )
  THEN 'ok'
  ELSE error('ducklake_merge_adjacent_files did not produce the expected result')
END AS merge_assertion;
SELECT CASE WHEN (SELECT COUNT(*) FROM lake.main.items) = 40
  THEN 'ok'
  ELSE error('unexpected row count after rewrite/merge')
END AS rows_after_assertion;
COPY (SELECT * FROM lake.main.items LIMIT 1)
TO '${data_path}main/items/orphan.parquet' (FORMAT PARQUET);
CREATE TEMP TABLE orphan_before AS
  SELECT path FROM ducklake_delete_orphaned_files('lake', cleanup_all => true, dry_run => true);
SELECT CASE WHEN (SELECT COUNT(*) FROM orphan_before) = 1
    AND EXISTS (SELECT 1 FROM orphan_before WHERE ends_with(path, 'orphan.parquet'))
  THEN 'ok'
  ELSE error('ducklake_delete_orphaned_files did not discover the local orphan')
END AS orphan_discovery_assertion;
SELECT CASE WHEN (
    SELECT COUNT(*) FROM ducklake_delete_orphaned_files('lake', older_than => NOW() - INTERVAL '1 week', dry_run => true)
  ) = 0
  THEN 'ok'
  ELSE error('ducklake_delete_orphaned_files older_than filter returned a recent local orphan')
END AS orphan_older_than_assertion;
CREATE TEMP TABLE orphan_deleted AS
  SELECT path FROM ducklake_delete_orphaned_files('lake', cleanup_all => true);
SELECT CASE WHEN (SELECT COUNT(*) FROM orphan_deleted) = 1
  THEN 'ok'
  ELSE error('ducklake_delete_orphaned_files did not remove the local orphan')
END AS orphan_delete_assertion;
SELECT CASE WHEN (
    SELECT COUNT(*) FROM ducklake_delete_orphaned_files('lake', cleanup_all => true, dry_run => true)
  ) = 0
  THEN 'ok'
  ELSE error('local orphan still appears after cleanup')
END AS orphan_after_cleanup_assertion;
CREATE TABLE lake.main.inlined_delete_probe AS
  SELECT i::INTEGER AS id, ('d' || i::VARCHAR) AS label
  FROM range(0, 50) tbl(i);
DELETE FROM lake.main.inlined_delete_probe WHERE id < 5;
CREATE TEMP TABLE inlined_delete_before AS
  SELECT * FROM system.main.quack_query_by_name(
    'meta',
    'SELECT COUNT(*) AS inlined_delete_rows_before_flush FROM main__ducklake_inlined_delete_3'
  );
SELECT CASE WHEN (SELECT inlined_delete_rows_before_flush FROM inlined_delete_before) = 5
  THEN 'ok'
  ELSE error('expected five inlined delete rows before flush')
END AS inlined_delete_before_assertion;
CALL ducklake_flush_inlined_data('lake');
CREATE TEMP TABLE inlined_delete_after AS
  SELECT * FROM system.main.quack_query_by_name(
    'meta',
    'SELECT COUNT(*) AS inlined_delete_rows_after_flush_commit FROM main__ducklake_inlined_delete_3'
  );
SELECT CASE WHEN (SELECT inlined_delete_rows_after_flush_commit FROM inlined_delete_after) = 0
  THEN 'ok'
  ELSE error('expected inlined delete rows to be flushed')
END AS inlined_delete_after_assertion;
SELECT CASE WHEN (SELECT COUNT(*) FROM lake.main.inlined_delete_probe) = 45
  THEN 'ok'
  ELSE error('unexpected row count after flushing inlined deletes')
END AS rows_after_flush_assertion;
CREATE TABLE lake.main.mixed_path_a(a INTEGER);
CREATE TABLE lake.main.mixed_path_b(a INTEGER);
COPY (SELECT 1::INTEGER AS a)
TO '${data_path}main/mixed_path_a/bla.parquet' (FORMAT PARQUET);
COPY (SELECT 2::INTEGER AS a)
TO '${data_path}main/mixed_path_b/bla.parquet' (FORMAT PARQUET);
COPY (SELECT 3::INTEGER AS a)
TO '${data_path}main/bla.parquet' (FORMAT PARQUET);
SELECT CASE WHEN (
    SELECT COUNT(*) FROM ducklake_delete_orphaned_files('lake', cleanup_all => true, dry_run => true)
  ) = 3
  THEN 'ok'
  ELSE error('mixed-path orphan discovery did not find the expected three files')
END AS mixed_orphan_initial_assertion;
SELECT * FROM ducklake_add_data_files(
  'lake',
  'mixed_path_a',
  '${data_path}main/mixed_path_a/bla.parquet'
);
SELECT CASE WHEN (
    SELECT COUNT(*) FROM ducklake_delete_orphaned_files('lake', cleanup_all => true, dry_run => true)
  ) = 2
  THEN 'ok'
  ELSE error('mixed-path orphan filtering did not ignore the first registered file')
END AS mixed_orphan_after_first_assertion;
SELECT * FROM ducklake_add_data_files(
  'lake',
  'mixed_path_a',
  '${data_path}main/mixed_path_b/bla.parquet'
);
SELECT CASE WHEN (
    SELECT COUNT(*) FROM ducklake_delete_orphaned_files('lake', cleanup_all => true, dry_run => true)
  ) = 1
  THEN 'ok'
  ELSE error('mixed-path orphan filtering did not ignore the second registered file')
END AS mixed_orphan_after_second_assertion;
SELECT * FROM ducklake_add_data_files(
  'lake',
  'mixed_path_b',
  '${data_path}main/bla.parquet'
);
SELECT CASE WHEN (
    SELECT COUNT(*) FROM ducklake_delete_orphaned_files('lake', cleanup_all => true, dry_run => true)
  ) = 0
  THEN 'ok'
  ELSE error('mixed-path orphan filtering still reports registered files')
END AS mixed_orphan_after_all_assertion;
CREATE TABLE lake.main.list_items(id INTEGER, label VARCHAR);
SELECT * FROM ducklake_add_data_files(
  'lake',
  'list_items',
  ['${source_dir}/part-a.parquet', '${source_dir}/part-b.parquet']
);
SELECT CASE WHEN (SELECT COUNT(*) FROM lake.main.list_items) = 6
  THEN 'ok'
  ELSE error('ducklake_add_data_files did not load the expected rows from an explicit file list')
END AS add_files_list_assertion;
CREATE TABLE lake.main.overlap_items(id INTEGER, label VARCHAR);
SELECT * FROM ducklake_add_data_files(
  'lake',
  'overlap_items',
  ['${source_dir}/*.parquet', '${source_dir}/part-a.parquet']
);
SELECT CASE WHEN (SELECT COUNT(*) FROM lake.main.overlap_items) = 6
  THEN 'ok'
  ELSE error('ducklake_add_data_files did not dedupe overlapping list/glob inputs')
END AS add_files_overlap_assertion;
CREATE TABLE lake.main.partitioned(part_key INTEGER, id INTEGER, value INTEGER);
ALTER TABLE lake.main.partitioned SET PARTITIONED BY (part_key);
INSERT INTO lake.main.partitioned VALUES (1, 1, 10), (1, 2, 20);
CALL ducklake_flush_inlined_data('lake');
INSERT INTO lake.main.partitioned VALUES (2, 1, 100), (2, 2, 200);
CALL ducklake_flush_inlined_data('lake');
CREATE TEMP TABLE partition_merge_source AS
SELECT * FROM (VALUES
  (1, 1, 15),
  (1, 3, 30),
  (2, 1, 150),
  (2, 3, 300)
) AS t(part_key, id, value);
MERGE INTO lake.main.partitioned AS target
USING partition_merge_source AS source
ON (target.part_key = source.part_key AND target.id = source.id)
WHEN MATCHED THEN UPDATE SET value = source.value
WHEN NOT MATCHED THEN INSERT *;
CALL ducklake_flush_inlined_data('lake');
SELECT CASE WHEN (
    SELECT COUNT(*) FROM lake.main.partitioned
  ) = 6
  THEN 'ok'
  ELSE error('unexpected row count before partition rewrite')
END AS partition_rows_before_assertion;
CREATE TEMP TABLE partition_rewrite_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_rewrite_data_files('lake', 'partitioned', delete_threshold => 0);
SELECT CASE WHEN (
    SELECT COUNT(*) FROM partition_rewrite_result
    WHERE table_name = 'partitioned' AND files_processed = 1 AND files_created = 1
  ) = 2
  THEN 'ok'
  ELSE error('partitioned ducklake_rewrite_data_files did not rewrite both partitions')
END AS partition_rewrite_assertion;
SELECT CASE WHEN (
    SELECT string_agg(part_key::VARCHAR || ':' || id::VARCHAR || ':' || value::VARCHAR, ',' ORDER BY part_key, id)
    FROM lake.main.partitioned
  ) = '1:1:15,1:2:20,1:3:30,2:1:150,2:2:200,2:3:300'
  THEN 'ok'
  ELSE error('partitioned table data changed after rewrite')
END AS partition_rows_after_rewrite_assertion;
CREATE TEMP TABLE partition_merge_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_merge_adjacent_files('lake', 'partitioned');
SELECT CASE WHEN (
    SELECT COUNT(*) FROM partition_merge_result
    WHERE table_name = 'partitioned' AND files_processed = 3 AND files_created = 1
  ) = 2
  THEN 'ok'
  ELSE error('partitioned ducklake_merge_adjacent_files did not merge both partitions')
END AS partition_merge_assertion;
SELECT CASE WHEN (
    SELECT string_agg(part_key::VARCHAR || ':' || id::VARCHAR || ':' || value::VARCHAR, ',' ORDER BY part_key, id)
    FROM lake.main.partitioned
  ) = '1:1:15,1:2:20,1:3:30,2:1:150,2:2:200,2:3:300'
  THEN 'ok'
  ELSE error('partitioned table data changed after merge')
END AS partition_rows_after_merge_assertion;
CREATE TABLE lake.main.sort_on_compaction(unique_id BIGINT, sort_key_1 BIGINT, sort_key_2 VARCHAR);
INSERT INTO lake.main.sort_on_compaction
  SELECT i AS unique_id, i % 2 AS sort_key_1, 'woot' || i::VARCHAR AS sort_key_2
  FROM range(0, 4) tbl(i)
  ORDER BY i DESC;
CALL ducklake_flush_inlined_data('lake');
INSERT INTO lake.main.sort_on_compaction
  SELECT i AS unique_id, i % 2 AS sort_key_1, 'woot' || i::VARCHAR AS sort_key_2
  FROM range(4, 8) tbl(i)
  ORDER BY i DESC;
CALL ducklake_flush_inlined_data('lake');
ALTER TABLE lake.main.sort_on_compaction
  SET SORTED BY (sort_key_1 ASC NULLS LAST, sort_key_2 ASC NULLS LAST);
ALTER TABLE lake.main.sort_on_compaction ADD COLUMN new_column INTEGER;
CREATE TEMP TABLE sorted_merge_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_merge_adjacent_files('lake', 'sort_on_compaction');
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM sorted_merge_result
    WHERE table_name = 'sort_on_compaction' AND files_processed = 2 AND files_created = 1
  )
  THEN 'ok'
  ELSE error('sorted ducklake_merge_adjacent_files did not merge expected files')
END AS sorted_merge_assertion;
SELECT CASE WHEN (
    SELECT string_agg(unique_id::VARCHAR, ',')
    FROM lake.main.sort_on_compaction
  ) = '0,2,4,6,1,3,5,7'
  THEN 'ok'
  ELSE error('sorted merge did not preserve expected scan order')
END AS sorted_merge_order_assertion;
CREATE TABLE lake.main.sorted_flush(i INTEGER);
INSERT INTO lake.main.sorted_flush SELECT i::INTEGER FROM range(0, 10) tbl(i);
ALTER TABLE lake.main.sorted_flush SET SORTED BY (i DESC);
CALL ducklake_flush_inlined_data('lake', table_name => 'sorted_flush');
SELECT CASE WHEN (
    SELECT string_agg(i::VARCHAR, ',')
    FROM lake.main.sorted_flush
  ) = '9,8,7,6,5,4,3,2,1,0'
  THEN 'ok'
  ELSE error('sorted ducklake_flush_inlined_data did not preserve expected scan order')
END AS sorted_flush_order_assertion;
CALL lake.set_option('target_file_size', '1KB');
CREATE TABLE lake.main.large_rewrite(key INTEGER, value VARCHAR);
INSERT INTO lake.main.large_rewrite
  SELECT i::INTEGER AS key, 'thisisastring_' || i::VARCHAR AS value
  FROM range(0, 1000) tbl(i);
CALL ducklake_flush_inlined_data('lake');
DELETE FROM lake.main.large_rewrite WHERE key < 500;
CALL ducklake_flush_inlined_data('lake');
CREATE TEMP TABLE large_rewrite_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_rewrite_data_files('lake', 'large_rewrite', delete_threshold => 0);
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM large_rewrite_result
    WHERE table_name = 'large_rewrite' AND files_processed = 1 AND files_created = 1
  )
  THEN 'ok'
  ELSE error('large-file ducklake_rewrite_data_files did not rewrite the deleted file')
END AS large_rewrite_assertion;
SELECT CASE WHEN (
    SELECT COUNT(*) FROM lake.main.large_rewrite
  ) = 500
  AND (
    SELECT MIN(key) FROM lake.main.large_rewrite
  ) = 500
  AND (
    SELECT MAX(key) FROM lake.main.large_rewrite
  ) = 999
  THEN 'ok'
  ELSE error('large-file rewrite produced incorrect rows')
END AS large_rewrite_rows_assertion;
CREATE TABLE lake.main.row_id_rewrite(a INTEGER, b INTEGER);
INSERT INTO lake.main.row_id_rewrite
  SELECT i::INTEGER AS a, (i * 10)::INTEGER AS b
  FROM range(1, 11) tbl(i);
CALL ducklake_flush_inlined_data('lake');
DELETE FROM lake.main.row_id_rewrite WHERE a % 2 = 0;
CALL ducklake_flush_inlined_data('lake');
SELECT CASE WHEN (
    SELECT string_agg(rowid::VARCHAR || ':' || a::VARCHAR || ':' || b::VARCHAR, ',' ORDER BY a)
    FROM lake.main.row_id_rewrite
  ) = '0:1:10,2:3:30,4:5:50,6:7:70,8:9:90'
  THEN 'ok'
  ELSE error('row IDs were unexpected before ducklake_rewrite_data_files')
END AS row_id_rewrite_before_assertion;
CREATE TEMP TABLE row_id_rewrite_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_rewrite_data_files('lake', 'row_id_rewrite', delete_threshold => 0);
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM row_id_rewrite_result
    WHERE table_name = 'row_id_rewrite' AND files_processed = 1 AND files_created = 1
  )
  THEN 'ok'
  ELSE error('row-id ducklake_rewrite_data_files did not rewrite the expected file')
END AS row_id_rewrite_result_assertion;
SELECT CASE WHEN (
    SELECT string_agg(rowid::VARCHAR || ':' || a::VARCHAR || ':' || b::VARCHAR, ',' ORDER BY a)
    FROM lake.main.row_id_rewrite
  ) = '0:1:10,2:3:30,4:5:50,6:7:70,8:9:90'
  THEN 'ok'
  ELSE error('row IDs changed after ducklake_rewrite_data_files')
END AS row_id_rewrite_after_assertion;
CREATE TABLE lake.main.rewrite_inlined_delete AS
  SELECT i::INTEGER AS a
  FROM range(0, 50) tbl(i);
DELETE FROM lake.main.rewrite_inlined_delete WHERE a = 25;
SELECT CASE WHEN (
    SELECT COUNT(*) FROM lake.main.rewrite_inlined_delete
  ) = 49
  THEN 'ok'
  ELSE error('unexpected row count before rewriting inlined file deletes')
END AS rewrite_inlined_delete_count_before_assertion;
CREATE TEMP TABLE rewrite_inlined_delete_files_before AS
  SELECT * FROM system.main.quack_query_by_name(
    'meta',
    'SELECT COUNT(*) AS active_delete_files_before FROM main__ducklake_delete_file WHERE end_snapshot IS NULL AND table_id = (SELECT table_id FROM main__ducklake_table WHERE table_name = ''rewrite_inlined_delete'')'
  );
SELECT CASE WHEN (
    SELECT active_delete_files_before FROM rewrite_inlined_delete_files_before
  ) = 0
  THEN 'ok'
  ELSE error('rewrite-inlined-delete setup unexpectedly created a delete file')
END AS rewrite_inlined_delete_no_file_before_assertion;
CREATE TEMP TABLE rewrite_inlined_delete_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_rewrite_data_files('lake', 'rewrite_inlined_delete', delete_threshold => 0);
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM rewrite_inlined_delete_result
    WHERE table_name = 'rewrite_inlined_delete' AND files_processed = 1 AND files_created = 1
  )
  THEN 'ok'
  ELSE error('ducklake_rewrite_data_files did not rewrite the inlined-delete file')
END AS rewrite_inlined_delete_result_assertion;
SELECT CASE WHEN (
    SELECT COUNT(*) FROM lake.main.rewrite_inlined_delete
  ) = 49
  THEN 'ok'
  ELSE error('unexpected row count after rewriting inlined file deletes')
END AS rewrite_inlined_delete_count_after_assertion;
CREATE TEMP TABLE rewrite_inlined_delete_files_after AS
  SELECT * FROM system.main.quack_query_by_name(
    'meta',
    'SELECT COUNT(*) AS active_data_files_after FROM main__ducklake_data_file WHERE end_snapshot IS NULL AND table_id = (SELECT table_id FROM main__ducklake_table WHERE table_name = ''rewrite_inlined_delete'')'
  );
SELECT CASE WHEN (
    SELECT active_data_files_after FROM rewrite_inlined_delete_files_after
  ) = 1
  THEN 'ok'
  ELSE error('rewrite-inlined-delete did not leave exactly one active data file')
END AS rewrite_inlined_delete_data_file_assertion;
CALL lake.set_option('target_file_size', '100KB');
CREATE TABLE lake.main.merge_min_size_filter(key INTEGER, data VARCHAR);
INSERT INTO lake.main.merge_min_size_filter
  SELECT i::INTEGER AS key, 'small' AS data
  FROM range(0, 11) tbl(i);
INSERT INTO lake.main.merge_min_size_filter
  SELECT (i + 11)::INTEGER AS key, 'small' AS data
  FROM range(0, 11) tbl(i);
INSERT INTO lake.main.merge_min_size_filter
  SELECT (i + 100)::INTEGER AS key, repeat('medium', 100) AS data
  FROM range(0, 100) tbl(i);
INSERT INTO lake.main.merge_min_size_filter
  SELECT (i + 200)::INTEGER AS key, repeat('medium', 100) AS data
  FROM range(0, 100) tbl(i);
CREATE TEMP TABLE merge_min_size_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_merge_adjacent_files('lake', 'merge_min_size_filter', min_file_size => 1000);
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM merge_min_size_result
    WHERE table_name = 'merge_min_size_filter' AND files_processed = 2 AND files_created = 1
  )
  THEN 'ok'
  ELSE error('min_file_size ducklake_merge_adjacent_files did not merge the expected files')
END AS merge_min_size_assertion;
SELECT CASE WHEN (
    SELECT COUNT(*) FROM lake.main.merge_min_size_filter
  ) = 222
  THEN 'ok'
  ELSE error('min_file_size merge changed table rows')
END AS merge_min_size_rows_assertion;
CREATE TABLE lake.main.merge_max_size_filter(key INTEGER, data VARCHAR);
INSERT INTO lake.main.merge_max_size_filter
  SELECT i::INTEGER AS key, 'small' AS data
  FROM range(0, 11) tbl(i);
INSERT INTO lake.main.merge_max_size_filter
  SELECT (i + 11)::INTEGER AS key, 'small' AS data
  FROM range(0, 11) tbl(i);
INSERT INTO lake.main.merge_max_size_filter
  SELECT (i + 100)::INTEGER AS key, repeat('medium', 100) AS data
  FROM range(0, 100) tbl(i);
INSERT INTO lake.main.merge_max_size_filter
  SELECT (i + 200)::INTEGER AS key, repeat('medium', 100) AS data
  FROM range(0, 100) tbl(i);
CREATE TEMP TABLE merge_max_size_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_merge_adjacent_files('lake', 'merge_max_size_filter', max_file_size => 1000);
SELECT CASE WHEN EXISTS (
    SELECT 1 FROM merge_max_size_result
    WHERE table_name = 'merge_max_size_filter' AND files_processed = 2 AND files_created = 1
  )
  THEN 'ok'
  ELSE error('max_file_size ducklake_merge_adjacent_files did not merge the expected files')
END AS merge_max_size_assertion;
SELECT CASE WHEN (
    SELECT COUNT(*) FROM lake.main.merge_max_size_filter
  ) = 222
  THEN 'ok'
  ELSE error('max_file_size merge changed table rows')
END AS merge_max_size_rows_assertion;
CREATE TABLE lake.main.alter_compaction(id INTEGER, i INTEGER);
INSERT INTO lake.main.alter_compaction VALUES (1, 10);
CALL ducklake_flush_inlined_data('lake');
INSERT INTO lake.main.alter_compaction VALUES (2, 20);
CALL ducklake_flush_inlined_data('lake');
ALTER TABLE lake.main.alter_compaction ADD COLUMN j INTEGER;
INSERT INTO lake.main.alter_compaction VALUES (3, 30, 300);
CALL ducklake_flush_inlined_data('lake');
INSERT INTO lake.main.alter_compaction VALUES (4, 40, 400);
CALL ducklake_flush_inlined_data('lake');
ALTER TABLE lake.main.alter_compaction DROP COLUMN i;
INSERT INTO lake.main.alter_compaction VALUES (5, 500);
CALL ducklake_flush_inlined_data('lake');
INSERT INTO lake.main.alter_compaction VALUES (6, 600);
CALL ducklake_flush_inlined_data('lake');
ALTER TABLE lake.main.alter_compaction ADD COLUMN i VARCHAR;
INSERT INTO lake.main.alter_compaction VALUES (7, 700, 'hello');
CALL ducklake_flush_inlined_data('lake');
INSERT INTO lake.main.alter_compaction VALUES (8, 800, 'world');
CALL ducklake_flush_inlined_data('lake');
SELECT CASE WHEN (
    SELECT string_agg(id::VARCHAR || ':' || coalesce(j::VARCHAR, 'NULL') || ':' || coalesce(i, 'NULL'), ',' ORDER BY id)
    FROM lake.main.alter_compaction
  ) = '1:NULL:NULL,2:NULL:NULL,3:300:NULL,4:400:NULL,5:500:NULL,6:600:NULL,7:700:hello,8:800:world'
  THEN 'ok'
  ELSE error('altered table rows were unexpected before compaction')
END AS alter_compaction_rows_before_assertion;
CREATE TEMP TABLE alter_compaction_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_merge_adjacent_files('lake', 'alter_compaction');
SELECT CASE WHEN (
    SELECT COUNT(*) FROM alter_compaction_result
    WHERE table_name = 'alter_compaction' AND files_processed = 2 AND files_created = 1
  ) = 4
  THEN 'ok'
  ELSE error('altered table compaction did not keep schema versions in separate merge groups')
END AS alter_compaction_merge_assertion;
SELECT CASE WHEN (
    SELECT string_agg(id::VARCHAR || ':' || coalesce(j::VARCHAR, 'NULL') || ':' || coalesce(i, 'NULL'), ',' ORDER BY id)
    FROM lake.main.alter_compaction
  ) = '1:NULL:NULL,2:NULL:NULL,3:300:NULL,4:400:NULL,5:500:NULL,6:600:NULL,7:700:hello,8:800:world'
  THEN 'ok'
  ELSE error('altered table rows changed after compaction')
END AS alter_compaction_rows_after_assertion;
CREATE TABLE hive_source(part_key INTEGER, part_key2 INTEGER, val VARCHAR);
INSERT INTO hive_source VALUES (1, 10, 'hello'), (2, 10, 'world'), (2, 20, 'abc');
COPY hive_source TO '${source_dir}/hive/' (FORMAT PARQUET, PARTITION_BY(part_key, part_key2));
CREATE TABLE lake.main.hive_items(part_key INTEGER, part_key2 INTEGER, val VARCHAR);
ALTER TABLE lake.main.hive_items SET PARTITIONED BY (part_key, part_key2);
SELECT * FROM ducklake_add_data_files(
  'lake',
  'hive_items',
  '${source_dir}/hive/**/*.parquet',
  hive_partitioning => true
);
SELECT CASE WHEN (
    SELECT string_agg(part_key::VARCHAR || ':' || part_key2::VARCHAR || ':' || val, ',' ORDER BY part_key, part_key2, val)
    FROM lake.main.hive_items
  ) = '1:10:hello,2:10:world,2:20:abc'
  THEN 'ok'
  ELSE error('hive-partitioned ducklake_add_data_files returned unexpected rows')
END AS add_files_hive_assertion;
CREATE TEMP TABLE hive_partition_values AS
  SELECT * FROM system.main.quack_query_by_name(
    'meta',
    'SELECT COUNT(*) AS partition_values FROM main__ducklake_file_partition_value WHERE table_id = (SELECT table_id FROM main__ducklake_table WHERE table_name = ''hive_items'')'
  );
SELECT CASE WHEN (
    SELECT partition_values FROM hive_partition_values
  ) = 6
  THEN 'ok'
  ELSE error('hive-partitioned ducklake_add_data_files did not write partition values')
END AS add_files_hive_metadata_assertion;
CREATE TABLE lake.main.path_partitioned_add_files(
  id INTEGER,
  partition_column INTEGER,
  other_partition_column INTEGER
);
ALTER TABLE lake.main.path_partitioned_add_files SET PARTITIONED BY (partition_column);
COPY (
  SELECT 4::INTEGER AS id,
         2::INTEGER AS other_partition_column
) TO '${source_dir}/path-partitioned/partition_column=2/file.parquet' (FORMAT PARQUET);
SELECT * FROM ducklake_add_data_files(
  'lake',
  'path_partitioned_add_files',
  '${source_dir}/path-partitioned/partition_column=2/file.parquet'
);
SELECT CASE WHEN (
    SELECT string_agg(id::VARCHAR || ':' || partition_column::VARCHAR || ':' || other_partition_column::VARCHAR, ',' ORDER BY id)
    FROM lake.main.path_partitioned_add_files
  ) = '4:2:2'
  THEN 'ok'
  ELSE error('path-partitioned ducklake_add_data_files did not infer the partition value')
END AS add_files_path_partition_assertion;
CREATE TEMP TABLE path_partition_values AS
  SELECT * FROM system.main.quack_query_by_name(
    'meta',
    'SELECT COUNT(*) AS partition_values FROM main__ducklake_file_partition_value WHERE table_id = (SELECT table_id FROM main__ducklake_table WHERE table_name = ''path_partitioned_add_files'')'
  );
SELECT CASE WHEN (
    SELECT partition_values FROM path_partition_values
  ) = 1
  THEN 'ok'
  ELSE error('path-partitioned ducklake_add_data_files did not write partition metadata')
END AS add_files_path_partition_metadata_assertion;
CREATE TABLE lake.main.missing_column_add_files(i INTEGER, j INTEGER);
COPY (
  SELECT 42::INTEGER AS j
) TO '${source_dir}/missing-column.parquet' (FORMAT PARQUET);
SELECT * FROM ducklake_add_data_files(
  'lake',
  'missing_column_add_files',
  '${source_dir}/missing-column.parquet',
  allow_missing => true
);
SELECT CASE WHEN (
    SELECT COUNT(*) FROM lake.main.missing_column_add_files
    WHERE i IS NULL AND j = 42
  ) = 1
  THEN 'ok'
  ELSE error('allow_missing ducklake_add_data_files did not load a file with a missing column')
END AS add_files_missing_column_assertion;
CREATE TABLE lake.main.missing_field_add_files(s STRUCT(i INTEGER, j INTEGER));
COPY (
  SELECT {'j': 84} AS s
) TO '${source_dir}/missing-field.parquet' (FORMAT PARQUET);
SELECT * FROM ducklake_add_data_files(
  'lake',
  'missing_field_add_files',
  '${source_dir}/missing-field.parquet',
  allow_missing => true
);
SELECT CASE WHEN (
    SELECT COUNT(*) FROM lake.main.missing_field_add_files
    WHERE s.i IS NULL AND s.j = 84
  ) = 1
  THEN 'ok'
  ELSE error('allow_missing ducklake_add_data_files did not load a file with a missing struct field')
END AS add_files_missing_field_assertion;
CREATE TABLE lake.main.extra_column_add_files(i INTEGER, j INTEGER);
COPY (
  SELECT 42::INTEGER AS j,
         84::INTEGER AS i,
         100::INTEGER AS extra_value
) TO '${source_dir}/extra-column.parquet' (FORMAT PARQUET);
BEGIN;
SELECT * FROM ducklake_add_data_files(
  'lake',
  'extra_column_add_files',
  '${source_dir}/extra-column.parquet',
  ignore_extra_columns => true
);
SELECT CASE WHEN (
    SELECT COUNT(*) FROM lake.main.extra_column_add_files
    WHERE i = 84 AND j = 42
  ) = 1
  THEN 'ok'
  ELSE error('ignore_extra_columns ducklake_add_data_files did not load the expected row')
END AS add_files_extra_column_assertion;
COMMIT;
SELECT CASE WHEN (
    SELECT COUNT(*) FROM lake.main.extra_column_add_files
    WHERE i = 84 AND j = 42
  ) = 1
  THEN 'ok'
  ELSE error('ignore_extra_columns ducklake_add_data_files row was not visible after commit')
END AS add_files_extra_column_commit_assertion;
CREATE SCHEMA lake.schema_add_files;
CREATE TABLE lake.schema_add_files.schema_target(id INTEGER, label VARCHAR);
COPY (
  SELECT 77::INTEGER AS id,
         'schema-target' AS label
) TO '${source_dir}/schema-target.parquet' (FORMAT PARQUET);
SELECT * FROM ducklake_add_data_files(
  'lake',
  'schema_target',
  '${source_dir}/schema-target.parquet',
  schema => 'schema_add_files'
);
SELECT CASE WHEN (
    SELECT string_agg(id::VARCHAR || ':' || label, ',' ORDER BY id)
    FROM lake.schema_add_files.schema_target
  ) = '77:schema-target'
  THEN 'ok'
  ELSE error('schema-qualified ducklake_add_data_files did not load the expected row')
END AS add_files_schema_assertion;
CREATE TABLE lake.main.empty_file_add_files(id INTEGER, label VARCHAR);
INSERT INTO lake.main.empty_file_add_files VALUES (100, 'existing');
COPY (
  SELECT 200::INTEGER AS id,
         'empty-source' AS label
  LIMIT 0
) TO '${source_dir}/empty-file.parquet' (FORMAT PARQUET);
BEGIN;
SELECT * FROM ducklake_add_data_files(
  'lake',
  'empty_file_add_files',
  '${source_dir}/empty-file.parquet'
);
SELECT CASE WHEN (
    SELECT string_agg(id::VARCHAR || ':' || label, ',' ORDER BY id)
    FROM lake.main.empty_file_add_files
  ) = '100:existing'
  THEN 'ok'
  ELSE error('empty-file ducklake_add_data_files changed rows inside transaction')
END AS add_files_empty_inside_assertion;
COMMIT;
SELECT CASE WHEN (
    SELECT string_agg(id::VARCHAR || ':' || label, ',' ORDER BY id)
    FROM lake.main.empty_file_add_files
  ) = '100:existing'
  THEN 'ok'
  ELSE error('empty-file ducklake_add_data_files changed rows after commit')
END AS add_files_empty_commit_assertion;
CREATE TABLE lake.main.add_files_rollback(id INTEGER, label VARCHAR);
INSERT INTO lake.main.add_files_rollback VALUES (1, 'original');
COPY (
  SELECT 200::INTEGER AS id,
         'rolled-back' AS label
) TO '${source_dir}/rollback-file.parquet' (FORMAT PARQUET);
BEGIN;
SELECT * FROM ducklake_add_data_files(
  'lake',
  'add_files_rollback',
  '${source_dir}/rollback-file.parquet'
);
ROLLBACK;
SELECT CASE WHEN (
    SELECT string_agg(id::VARCHAR || ':' || label, ',' ORDER BY id)
    FROM lake.main.add_files_rollback
  ) = '1:original'
  THEN 'ok'
  ELSE error('rolled-back ducklake_add_data_files changed table rows')
END AS add_files_rollback_rows_assertion;
SELECT CASE WHEN (
    SELECT COUNT(*) FROM GLOB('${source_dir}/rollback-file.parquet')
  ) = 1
  THEN 'ok'
  ELSE error('rolled-back ducklake_add_data_files removed the external file')
END AS add_files_rollback_file_assertion;
BEGIN;
CREATE TABLE lake.main.transaction_local_add_files(id INTEGER, label VARCHAR);
COPY (
  SELECT 300::INTEGER AS id,
         'transaction-local' AS label
) TO '${source_dir}/transaction-local-file.parquet' (FORMAT PARQUET);
SELECT * FROM ducklake_add_data_files(
  'lake',
  'transaction_local_add_files',
  '${source_dir}/transaction-local-file.parquet'
);
SELECT CASE WHEN (
    SELECT string_agg(id::VARCHAR || ':' || label, ',' ORDER BY id)
    FROM lake.main.transaction_local_add_files
  ) = '300:transaction-local'
  THEN 'ok'
  ELSE error('transaction-local ducklake_add_data_files row was not visible inside transaction')
END AS add_files_transaction_local_inside_assertion;
COMMIT;
SELECT CASE WHEN (
    SELECT string_agg(id::VARCHAR || ':' || label, ',' ORDER BY id)
    FROM lake.main.transaction_local_add_files
  ) = '300:transaction-local'
  THEN 'ok'
  ELSE error('transaction-local ducklake_add_data_files row was not visible after commit')
END AS add_files_transaction_local_commit_assertion;
COPY (
  SELECT i::INTEGER AS id,
         'ext_' || i::VARCHAR AS name,
         (i * 1.5)::DOUBLE AS score
  FROM range(0, 50) tbl(i)
) TO '${source_dir}/schema-evolution-a.parquet' (FORMAT PARQUET);
COPY (
  SELECT (i + 50)::INTEGER AS id,
         'ext_' || (i + 50)::VARCHAR AS name,
         ((i + 50) * 1.5)::DOUBLE AS score
  FROM range(0, 50) tbl(i)
) TO '${source_dir}/schema-evolution-b.parquet' (FORMAT PARQUET);
CREATE TABLE lake.main.schema_evolution_add_files(id INTEGER, name VARCHAR, score DOUBLE);
SELECT * FROM ducklake_add_data_files('lake', 'schema_evolution_add_files', '${source_dir}/schema-evolution-a.parquet');
SELECT * FROM ducklake_add_data_files('lake', 'schema_evolution_add_files', '${source_dir}/schema-evolution-b.parquet');
UPDATE lake.main.schema_evolution_add_files
SET score = score + 1000
WHERE id < 20;
DELETE FROM lake.main.schema_evolution_add_files WHERE id >= 90;
CALL ducklake_flush_inlined_data('lake');
INSERT INTO lake.main.schema_evolution_add_files
  SELECT (i + 200)::INTEGER AS id,
         'new_' || i::VARCHAR AS name,
         (i * 0.5)::DOUBLE AS score
  FROM range(0, 30) tbl(i);
CALL ducklake_flush_inlined_data('lake');
ALTER TABLE lake.main.schema_evolution_add_files ADD COLUMN category VARCHAR;
UPDATE lake.main.schema_evolution_add_files
SET category = CASE WHEN score > 500 THEN 'high' ELSE 'low' END;
CALL ducklake_flush_inlined_data('lake');
CREATE TEMP TABLE schema_evolution_merge_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_merge_adjacent_files('lake', 'schema_evolution_add_files');
SELECT CASE WHEN (SELECT COUNT(*) FROM lake.main.schema_evolution_add_files) = 120
    AND (SELECT COUNT(DISTINCT id) FROM lake.main.schema_evolution_add_files) = 120
    AND NOT EXISTS (
      SELECT id
      FROM lake.main.schema_evolution_add_files
      GROUP BY id
      HAVING COUNT(*) > 1
    )
  THEN 'ok'
  ELSE error('schema-evolution add-files merge produced duplicates or wrong row count')
END AS schema_evolution_merge_assertion;
CALL lake.set_option('data_inlining_row_limit', '0');
CALL lake.set_option('per_thread_output', 'true');
CREATE TABLE lake.main.merge_zero_output(id INTEGER, payload VARCHAR);
INSERT INTO lake.main.merge_zero_output
  SELECT range::INTEGER AS id, 'empty' AS payload
  FROM range(100)
  WHERE range < 0;
INSERT INTO lake.main.merge_zero_output
  SELECT range::INTEGER AS id, 'empty' AS payload
  FROM range(100)
  WHERE range < 0;
INSERT INTO lake.main.merge_zero_output
  SELECT range::INTEGER AS id, 'empty' AS payload
  FROM range(100)
  WHERE range < 0;
INSERT INTO lake.main.merge_zero_output
  SELECT range::INTEGER AS id, 'empty' AS payload
  FROM range(100)
  WHERE range < 0;
CREATE TEMP TABLE merge_zero_files_before AS
  SELECT * FROM system.main.quack_query_by_name(
    'meta',
    'SELECT COUNT(*) AS active_files, COALESCE(SUM(record_count), 0) AS active_rows FROM main__ducklake_data_file WHERE end_snapshot IS NULL AND table_id = (SELECT table_id FROM main__ducklake_table WHERE table_name = ''merge_zero_output'')'
  );
SELECT CASE WHEN (
    SELECT active_files = 4 AND active_rows = 0
    FROM merge_zero_files_before
  )
  THEN 'ok'
  ELSE error('zero-output merge setup did not create four empty active files')
END AS merge_zero_before_assertion;
CREATE TEMP TABLE merge_zero_result AS
  SELECT schema_name, table_name, files_processed, files_created
  FROM ducklake_merge_adjacent_files('lake', 'merge_zero_output');
SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM merge_zero_result
    WHERE schema_name = 'main'
      AND table_name = 'merge_zero_output'
      AND files_processed = 4
      AND files_created = 0
  )
  THEN 'ok'
  ELSE error('zero-output ducklake_merge_adjacent_files did not process empty files correctly')
END AS merge_zero_result_assertion;
CREATE TEMP TABLE merge_zero_files_after AS
  SELECT * FROM system.main.quack_query_by_name(
    'meta',
    'SELECT COUNT(*) AS active_files, COALESCE(SUM(record_count), 0) AS active_rows FROM main__ducklake_data_file WHERE end_snapshot IS NULL AND table_id = (SELECT table_id FROM main__ducklake_table WHERE table_name = ''merge_zero_output'')'
  );
SELECT CASE WHEN (
    SELECT active_files = 0 AND active_rows = 0
    FROM merge_zero_files_after
  )
  THEN 'ok'
  ELSE error('zero-output ducklake_merge_adjacent_files left active files behind')
END AS merge_zero_after_assertion;
SELECT CASE WHEN (SELECT COUNT(*) FROM lake.main.merge_zero_output) = 0
  THEN 'ok'
  ELSE error('zero-output merge changed table row count')
END AS merge_zero_rows_assertion;
CALL lake.set_option('per_thread_output', 'false');
CREATE SCHEMA lake.merge_options_schema;
CREATE TABLE lake.main.merge_options_main(id INTEGER, label VARCHAR);
CREATE TABLE lake.merge_options_schema.merge_options_target(id INTEGER, label VARCHAR);
INSERT INTO lake.main.merge_options_main VALUES (1, 'main-a');
INSERT INTO lake.main.merge_options_main VALUES (2, 'main-b');
INSERT INTO lake.merge_options_schema.merge_options_target VALUES (1, 'schema-a');
INSERT INTO lake.merge_options_schema.merge_options_target VALUES (2, 'schema-b');
CREATE TEMP TABLE schema_merge_options_result AS
  SELECT schema_name, table_name, files_processed, files_created
  FROM ducklake_merge_adjacent_files(
    'lake',
    'merge_options_target',
    schema => 'merge_options_schema'
  );
SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM schema_merge_options_result
    WHERE schema_name = 'merge_options_schema'
      AND table_name = 'merge_options_target'
      AND files_processed = 2
      AND files_created = 1
  )
  THEN 'ok'
  ELSE error('schema-qualified ducklake_merge_adjacent_files did not merge the requested schema table')
END AS schema_merge_options_result_assertion;
CREATE TEMP TABLE schema_merge_options_files AS
  SELECT * FROM system.main.quack_query_by_name(
    'meta',
    'SELECT t.table_name, COUNT(*) AS active_files FROM main__ducklake_data_file f JOIN main__ducklake_table t ON t.table_id = f.table_id WHERE f.end_snapshot IS NULL AND t.table_name IN (''merge_options_main'', ''merge_options_target'') GROUP BY t.table_name ORDER BY t.table_name'
  );
SELECT CASE WHEN (
    SELECT string_agg(table_name || ':' || active_files::VARCHAR, ',' ORDER BY table_name)
    FROM schema_merge_options_files
  ) = 'merge_options_main:2,merge_options_target:1'
  THEN 'ok'
  ELSE error('schema-qualified merge compacted the wrong table set')
END AS schema_merge_options_filter_assertion;
CREATE TABLE lake.main.merge_max_compacted(id INTEGER, label VARCHAR);
INSERT INTO lake.main.merge_max_compacted VALUES (1, 'a');
INSERT INTO lake.main.merge_max_compacted VALUES (2, 'b');
INSERT INTO lake.main.merge_max_compacted VALUES (3, 'c');
INSERT INTO lake.main.merge_max_compacted VALUES (4, 'd');
CREATE TEMP TABLE max_compacted_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_merge_adjacent_files(
    'lake',
    'merge_max_compacted',
    max_compacted_files => 1
  );
SELECT CASE WHEN (
    SELECT COUNT(*) = 1
      AND bool_and(table_name = 'merge_max_compacted')
      AND bool_and(files_processed >= 2)
      AND bool_and(files_created = 1)
    FROM max_compacted_result
  )
  THEN 'ok'
  ELSE error('max_compacted_files ducklake_merge_adjacent_files did not limit compaction operations')
END AS max_compacted_result_assertion;
SELECT CASE WHEN (
    SELECT string_agg(id::VARCHAR || ':' || label, ',' ORDER BY id)
    FROM lake.main.merge_max_compacted
  ) = '1:a,2:b,3:c,4:d'
  THEN 'ok'
  ELSE error('max_compacted_files merge changed table rows')
END AS max_compacted_rows_assertion;
CREATE TABLE lake.main.rewrite_threshold_options(id INTEGER, label VARCHAR);
INSERT INTO lake.main.rewrite_threshold_options
  SELECT i::INTEGER AS id, 'rewrite_' || i::VARCHAR AS label
  FROM range(0, 100) tbl(i);
DELETE FROM lake.main.rewrite_threshold_options WHERE id < 10;
CREATE TEMP TABLE rewrite_threshold_default_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_rewrite_data_files('lake', 'rewrite_threshold_options');
SELECT CASE WHEN (SELECT COUNT(*) FROM rewrite_threshold_default_result) = 0
  THEN 'ok'
  ELSE error('default ducklake_rewrite_data_files threshold rewrote too eagerly')
END AS rewrite_threshold_default_assertion;
CREATE TEMP TABLE rewrite_threshold_explicit_result AS
  SELECT table_name, files_processed, files_created
  FROM ducklake_rewrite_data_files(
    'lake',
    'rewrite_threshold_options',
    delete_threshold => 0
  );
SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM rewrite_threshold_explicit_result
    WHERE table_name = 'rewrite_threshold_options'
      AND files_processed = 1
      AND files_created = 1
  )
  THEN 'ok'
  ELSE error('explicit delete_threshold ducklake_rewrite_data_files did not rewrite the deleted file')
END AS rewrite_threshold_explicit_assertion;
SELECT CASE WHEN (
    SELECT COUNT(*) = 90
      AND MIN(id) = 10
      AND MAX(id) = 99
    FROM lake.main.rewrite_threshold_options
  )
  THEN 'ok'
  ELSE error('delete_threshold rewrite changed table rows')
END AS rewrite_threshold_rows_assertion;
"
