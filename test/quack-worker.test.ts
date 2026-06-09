import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LogicalTypeId, QuackClient } from "@quack-protocol/sdk";
import {
  assertPlannedDuckLakeDataPath,
  createDuckLakeDataPathValidator,
  duckLakeDataPathValuesFromMetadataWrite,
  plannedDuckLakeDataPath
} from "../src/ducklake-data-path";

const adminHeaders = {
  Authorization: "Bearer admin-test-token",
  "Content-Type": "application/json"
};

const simpleParquetBase64 =
  "UEFSMRUAFRQVGCwVAhUAFQYVBgAACiQCAAAAAgEBAAAAFQAVHhUiLBUCFQAVBhUGAAAPOAIAAAACAQUAAABoZWxsbxUCGTw1ABgNZHVja2RiX3NjaGVtYRUEABUCJQIYBGNvbDElIgAVDCUCGARjb2wyJQAAFgIZHBksJgAcFQIZFQAZGARjb2wxFQIWAhY2FjomCDwYBAEAAAAYBAEAAAAWACgEAQAAABgEAQAAABERAAAAJgAcFQwZFQAZGARjb2wyFQIWAhZAFkQmQjwYBWhlbGxvGAVoZWxsbxYAKAVoZWxsbxgFaGVsbG8REQAAABZ2FgImCBZ+ACgoRHVja0RCIHZlcnNpb24gdjEuNS4yIChidWlsZCA4YTU4NTE5NzFmKRksHAAAHAAAAOoAAABQQVIx";

function testR2BucketName(): string {
  const runtimeEnv = env as unknown as { DUCKLAKE_R2_BINDINGS?: string };
  if (runtimeEnv.DUCKLAKE_R2_BINDINGS) {
    try {
      const parsed = JSON.parse(runtimeEnv.DUCKLAKE_R2_BINDINGS) as Record<string, string>;
      const firstBucket = Object.keys(parsed)[0];
      if (firstBucket) {
        return firstBucket;
      }
    } catch {
      // Fall through to the deterministic test default below.
    }
  }
  return "test-ducklake-r2";
}

function r2TestUri(key: string, scheme: "r2" | "s3" = "r2"): string {
  return `${scheme}://${testR2BucketName()}/${key}`;
}

async function createCatalogClient(prefix: string): Promise<QuackClient> {
  const { client } = await createCatalog(prefix);
  return client;
}

const clientDataPaths = new WeakMap<QuackClient, string>();

async function createCatalog(prefix: string): Promise<{ catalogId: string; jwt: string; dataPath: string; client: QuackClient }> {
  const catalogId = `${prefix}_${crypto.randomUUID().replaceAll("-", "_")}`;
  const create = await SELF.fetch("http://example.com/admin/catalogs", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ catalogId })
  });
  expect(create.status).toBe(201);
  const created = await create.json<{ jwt: string; catalog: { dataPath: string }; credential: { credentialId: string } }>();
  await putPermissivePolicy(catalogId);
  const client = await QuackClient.connect("http://example.com", {
    authToken: created.jwt,
    fetch: SELF.fetch.bind(SELF) as typeof fetch
  });
  clientDataPaths.set(client, created.catalog.dataPath);
  return { catalogId, jwt: created.jwt, dataPath: created.catalog.dataPath, client };
}

async function putPermissivePolicy(catalogId: string): Promise<void> {
  const response = await SELF.fetch(`http://example.com/admin/catalogs/${encodeURIComponent(catalogId)}/auth-policy`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({ version: 1, defaultEffect: "allow", rules: [] })
  });
  expect(response.status).toBe(200);
}

describe("durable Quack Worker", () => {
  it("keeps catalog creation distinct from adding another JWT credential", async () => {
    const catalogId = `routing_${crypto.randomUUID().replaceAll("-", "_")}`;
    const create = await SELF.fetch("http://example.com/admin/catalogs", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ catalogId })
    });
    expect(create.status).toBe(201);

    const duplicate = await SELF.fetch("http://example.com/admin/catalogs", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ catalogId })
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json<{ error: string; hint: string }>()).resolves.toMatchObject({
      error: expect.stringContaining("already exists"),
      hint: expect.stringContaining("fresh DuckLake DATA_PATH")
    });

    const credential = await SELF.fetch(`http://example.com/admin/catalogs/${encodeURIComponent(catalogId)}/credentials`, {
      method: "POST",
      headers: adminHeaders
    });
    expect(credential.status).toBe(201);
    await expect(credential.json<{ jwt: string; credentialId: string }>()).resolves.toMatchObject({
      jwt: expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/),
      credentialId: expect.any(String)
    });
  });

  it("creates a JWT-routed catalog and runs basic Quack SQL", async () => {
    const client = await createCatalogClient("test");
    try {
      await client.query("CREATE SCHEMA IF NOT EXISTS metadata");
      await client.query(`
        CREATE TABLE metadata.ducklake_metadata(
          key VARCHAR NOT NULL,
          value VARCHAR NOT NULL,
          scope VARCHAR,
          scope_id BIGINT
        )
      `);
      await client.query("INSERT INTO metadata.ducklake_metadata VALUES ('version', '1.0', NULL, NULL)");

      const exists = await client.values<bigint>(`
        SELECT COUNT(*) FROM information_schema.tables
        WHERE table_name = 'ducklake_metadata' AND table_schema = 'metadata'
      `);
      expect(exists).toEqual([1n]);

      const orderedByDuckDbOrdinal = await client.values<string>(
        "SELECT key FROM metadata.ducklake_metadata ORDER BY #1"
      );
      expect(orderedByDuckDbOrdinal).toEqual(["version"]);

      const schemas = await client.query(`
        SELECT catalog_name, schema_name
        FROM information_schema.schemata
        WHERE catalog_name NOT IN ('system', 'temp')
        ORDER BY ALL
      `);
      expect(schemas.rows()).toContainEqual({ catalog_name: "memory", schema_name: "main" });
      expect(schemas.rows()).toContainEqual({ catalog_name: "memory", schema_name: "metadata" });

      const catalogRows = await client.query(`
        SELECT schema_name, sql, 'table'
        FROM duckdb_tables()
        UNION ALL
        SELECT schema_name, view_name, 'view'
        FROM duckdb_views()
      `);
      expect(catalogRows.rows()).toContainEqual({
        schema_name: "metadata",
        sql: expect.stringContaining("ducklake_metadata"),
        "'table'": "table"
      });

      const databases = await client.query("SELECT * FROM duckdb_databases()");
      expect(databases.names).toEqual([
        "database_name",
        "database_oid",
        "path",
        "comment",
        "tags",
        "internal",
        "type",
        "readonly",
        "encrypted",
        "cipher",
        "options"
      ]);
      expect(databases.rows()).toEqual([
        {
          database_name: "memory",
          database_oid: 1n,
          path: null,
          comment: null,
          tags: [],
          internal: false,
          type: "duckdb",
          readonly: false,
          encrypted: false,
          cipher: null,
          options: []
        },
        {
          database_name: "system",
          database_oid: 0n,
          path: null,
          comment: null,
          tags: [],
          internal: true,
          type: "duckdb",
          readonly: false,
          encrypted: false,
          cipher: null,
          options: []
        },
        {
          database_name: "temp",
          database_oid: 2n,
          path: null,
          comment: null,
          tags: [],
          internal: true,
          type: "duckdb",
          readonly: false,
          encrypted: false,
          cipher: null,
          options: []
        }
      ]);
      expect(await client.values<string>("SELECT database_name FROM duckdb_databases()")).toEqual([
        "memory",
        "system",
        "temp"
      ]);

      const result = await client.query("SELECT key, value FROM metadata.ducklake_metadata WHERE key = 'version'");
      expect(result.types.map((type) => type.id)).toEqual([LogicalTypeId.VARCHAR, LogicalTypeId.VARCHAR]);
      expect(result.rows()).toEqual([{ key: "version", value: "1.0" }]);
    } finally {
      await client.disconnect();
    }
  });

  it("rejects client-side Parquet introspection queries with an explicit DuckLake add-files error", async () => {
    const client = await createCatalogClient("parquet_metadata");
    try {
      await expect(
        client.query(`
          SELECT list_transform(parquet_file_metadata, lambda x: struct_pack(file_name := x.file_name))
          FROM parquet_full_metadata('/tmp/source.parquet')
        `)
      ).rejects.toThrow(/does not execute parquet_full_metadata/i);
    } finally {
      await client.disconnect();
    }
  });

  it("enforces the planned DuckLake DATA_PATH policy", () => {
    const plannedDataPath = plannedDuckLakeDataPath(testR2BucketName(), "finance");

    expect(duckLakeDataPathValuesFromMetadataWrite(`
      INSERT INTO "main".ducklake_metadata (key, value)
      VALUES ('version', '1.0'), ('data_path', '${plannedDataPath}')
    `)).toEqual([plannedDataPath]);
    expect(duckLakeDataPathValuesFromMetadataWrite(`
      UPDATE "main".ducklake_metadata
      SET value='${r2TestUri("lake-b/", "s3")}'
      WHERE key='data_path' AND scope IS NULL
    `)).toEqual([r2TestUri("lake-b/", "s3")]);

    expect(() => createDuckLakeDataPathValidator(() => plannedDataPath)(plannedDataPath)).not.toThrow();
    expect(() => assertPlannedDuckLakeDataPath(plannedDataPath, plannedDataPath)).not.toThrow();
    expect(() => assertPlannedDuckLakeDataPath("/tmp/lake-a/", plannedDataPath)).toThrow(/must match/i);
    expect(() => assertPlannedDuckLakeDataPath(r2TestUri("lake-a/"), plannedDataPath)).toThrow(/must match/i);
  });

  it("diagnoses Worker R2 binding access through the admin API", async () => {
    const bucket = boundTestR2Bucket();
    const bytes = arrayBufferFromBase64(simpleParquetBase64);
    const key = `diagnostics/${crypto.randomUUID()}.parquet`;
    await bucket.put(key, bytes);

    const found = await SELF.fetch(`http://example.com/admin/r2/diagnostics?path=${encodeURIComponent(r2TestUri(key))}`, {
      headers: adminHeaders
    });
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toMatchObject({
      ok: true,
      bucket: testR2BucketName(),
      key,
      bindingName: "DUCKLAKE_R2",
      object: {
        exists: true,
        size: bytes.byteLength
      }
    });

    const missing = await SELF.fetch(
      `http://example.com/admin/r2/diagnostics?path=${encodeURIComponent("r2://missing-bucket/path.parquet")}`,
      { headers: adminHeaders }
    );
    expect(missing.status).toBe(424);
    await expect(missing.json()).resolves.toMatchObject({
      ok: false,
      bucket: "missing-bucket",
      error: expect.stringContaining("not mapped")
    });
  });

  it("rejects mismatched DuckLake bootstrap before creating catalog tables", async () => {
    const client = await createCatalogClient("r2_policy");
    try {
      await expect(runDuckLakeBootstrapSqlFixture(client, "/tmp/not-production/")).rejects.toThrow(/must match/i);
      await expect(
        client.values<bigint>(`
          SELECT COUNT(*) FROM information_schema.tables
          WHERE table_name = 'ducklake_metadata' AND table_schema = 'main'
        `)
      ).resolves.toEqual([0n]);
    } finally {
      await client.disconnect();
    }
  });

  it("does not execute DuckLake orphan-file read_blob probes inside quacklake", async () => {
    const { client, dataPath } = await createCatalog("r2_orphans");

    try {
      await runDuckLakeBootstrapSqlFixture(client, dataPath);
      await expect(client.query(duckLakeOrphanFilesForCleanupQuery(dataPath))).rejects.toThrow(/read_blob|no such table/i);
    } finally {
      await client.disconnect();
    }
  });

  it("rolls back explicit client transactions", async () => {
    const client = await createCatalogClient("tx");
    try {
      await client.query("CREATE TABLE items(id INTEGER, label VARCHAR)");
      await client.query("BEGIN TRANSACTION");
      await client.query("INSERT INTO items VALUES (1, 'rolled back')");
      await client.query("ROLLBACK");
      expect(await client.values<bigint>("SELECT COUNT(*) FROM items")).toEqual([0n]);
    } finally {
      await client.disconnect();
    }
  });

  it("preserves DuckLake SQLite float storage semantics behind Quack types", async () => {
    const client = await createCatalogClient("ducklake_float");
    try {
      await client.query("CREATE TABLE float_items(metric DOUBLE, ratio FLOAT, finite_value DOUBLE)");
      await client.query("INSERT INTO float_items VALUES ('NaN', 'Infinity', 0.5)");

      const storage = await client.query(`
        SELECT typeof(metric) AS metric_storage,
               typeof(ratio) AS ratio_storage,
               typeof(finite_value) AS finite_storage
        FROM float_items
      `);
      expect(storage.rows()).toEqual([{ metric_storage: "text", ratio_storage: "text", finite_storage: "text" }]);

      const tableSql = await client.query("SELECT sql FROM duckdb_tables() WHERE table_name = 'float_items'");
      expect(tableSql.rows()).toEqual([
        expect.objectContaining({
          sql: 'CREATE TABLE "main"."float_items" ("metric" DOUBLE, "ratio" FLOAT, "finite_value" DOUBLE);'
        })
      ]);

      const result = await client.query<{ metric: number; ratio: number; finite_value: number }>(
        "SELECT metric, ratio, finite_value FROM float_items"
      );
      expect(result.types.map((type) => type.id)).toEqual([LogicalTypeId.DOUBLE, LogicalTypeId.FLOAT, LogicalTypeId.DOUBLE]);
      const [row] = result.rows();
      expect(Number.isNaN(row?.metric)).toBe(true);
      expect(row?.ratio).toBe(Infinity);
      expect(row?.finite_value).toBe(0.5);

      const projected = await client.query<{ col1: number; col2: number }>(
        "SELECT finite_value AS col1, ratio AS col2 FROM float_items"
      );
      expect(projected.types.map((type) => type.id)).toEqual([LogicalTypeId.DOUBLE, LogicalTypeId.FLOAT]);
      expect(projected.rows()).toEqual([{ col1: 0.5, col2: Infinity }]);
    } finally {
      await client.disconnect();
    }
  });

  it("executes DuckLake catalog migration SQL variants", async () => {
    const client = await createCatalogClient("ducklake_migration");
    try {
      await client.query(`
        CREATE TABLE "main".ducklake_metadata(key VARCHAR NOT NULL, value VARCHAR NOT NULL);
        INSERT INTO "main".ducklake_metadata VALUES ('version', '0.3');
        CREATE TABLE "main".ducklake_snapshot(snapshot_id BIGINT PRIMARY KEY, snapshot_time TIMESTAMPTZ, schema_version BIGINT, next_catalog_id BIGINT, next_file_id BIGINT);
        INSERT INTO "main".ducklake_snapshot VALUES (1, NOW(), 1, 6, 100);
        CREATE TABLE "main".ducklake_table(table_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT);
        INSERT INTO "main".ducklake_table VALUES (5, 1, NULL);
        CREATE TABLE "main".ducklake_schema_versions(begin_snapshot BIGINT, schema_version BIGINT);
        INSERT INTO "main".ducklake_schema_versions VALUES (1, 1);
        CREATE TABLE "main".ducklake_name_mapping(mapping_id BIGINT, column_id BIGINT, source_name VARCHAR, target_field_id BIGINT, parent_column BIGINT);
        CREATE TABLE "main".ducklake_snapshot_changes(snapshot_id BIGINT PRIMARY KEY, changes_made VARCHAR);
        CREATE TABLE "main".ducklake_file_column_statistics(data_file_id BIGINT, table_id BIGINT, column_id BIGINT);
        CREATE TABLE "main".ducklake_table_column_stats(table_id BIGINT, column_id BIGINT);
        CREATE TABLE "main".ducklake_column(column_id BIGINT, table_id BIGINT, column_order BIGINT, column_name VARCHAR, parent_column BIGINT, end_snapshot BIGINT);
        INSERT INTO "main".ducklake_column VALUES
          (1, 5, 0, 'value', NULL, NULL),
          (2, 5, 1, 'payload', NULL, NULL);
        CREATE TABLE "main".ducklake_partition_column(partition_id BIGINT, table_id BIGINT, partition_key_index BIGINT, column_id BIGINT, transform VARCHAR);
        INSERT INTO "main".ducklake_partition_column VALUES
          (77, 5, 0, 0, 'identity'),
          (77, 5, 1, 1, 'identity');
        CREATE TABLE "main".ducklake_data_file(data_file_id BIGINT, table_id BIGINT, begin_snapshot BIGINT, partial_file_info VARCHAR);
        INSERT INTO "main".ducklake_data_file VALUES (42, 5, 1, 'partial_max:123');
        CREATE TABLE "main".ducklake_delete_file(delete_file_id BIGINT, table_id BIGINT, begin_snapshot BIGINT);
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS "main".ducklake_macro(schema_id BIGINT, macro_id BIGINT, macro_name VARCHAR, begin_snapshot BIGINT, end_snapshot BIGINT);
        CREATE TABLE IF NOT EXISTS "main".ducklake_macro_impl(macro_id BIGINT, impl_id BIGINT, dialect VARCHAR, sql VARCHAR, type VARCHAR);
        CREATE TABLE IF NOT EXISTS "main".ducklake_macro_parameters(macro_id BIGINT, impl_id BIGINT,column_id BIGINT, parameter_name VARCHAR, parameter_type VARCHAR, default_value VARCHAR, default_value_type VARCHAR);
        UPDATE "main".ducklake_partition_column SET column_id = (SELECT LIST(column_id ORDER BY column_order) FROM "main".ducklake_column WHERE table_id = ducklake_partition_column.table_id AND parent_column IS NULL AND end_snapshot IS NULL)[ducklake_partition_column.column_id + 1];
        ALTER TABLE "main".ducklake_column ADD COLUMN IF NOT EXISTS default_value_type VARCHAR DEFAULT 'literal';
        UPDATE "main".ducklake_column SET default_value_type = 'literal' WHERE default_value_type IS NULL;
        ALTER TABLE "main".ducklake_column ADD COLUMN IF NOT EXISTS default_value_dialect VARCHAR DEFAULT NULL;
        ALTER TABLE IF EXISTS "main".ducklake_file_column_statistics RENAME TO ducklake_file_column_stats;
        ALTER TABLE "main".ducklake_file_column_stats ADD COLUMN IF NOT EXISTS extra_stats VARCHAR DEFAULT NULL;
        ALTER TABLE "main".ducklake_table_column_stats ADD COLUMN IF NOT EXISTS extra_stats VARCHAR DEFAULT NULL;
        CREATE TABLE IF NOT EXISTS "main".ducklake_sort_info(sort_id BIGINT, table_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT);
        CREATE TABLE IF NOT EXISTS "main".ducklake_sort_expression(sort_id BIGINT, table_id BIGINT, sort_key_index BIGINT, expression VARCHAR, dialect VARCHAR, sort_direction VARCHAR, null_order VARCHAR);
        CREATE TABLE IF NOT EXISTS "main".ducklake_file_variant_stats(data_file_id BIGINT, table_id BIGINT, column_id BIGINT, variant_path VARCHAR, shredded_type VARCHAR, column_size_bytes BIGINT, value_count BIGINT, null_count BIGINT, min_value VARCHAR, max_value VARCHAR, contains_nan BOOLEAN, extra_stats VARCHAR);
        ALTER TABLE "main".ducklake_schema_versions ADD COLUMN IF NOT EXISTS table_id BIGINT;
        ALTER TABLE "main".ducklake_data_file ADD COLUMN IF NOT EXISTS partial_max BIGINT;
        ALTER TABLE "main".ducklake_delete_file ADD COLUMN IF NOT EXISTS partial_max BIGINT;
        CREATE TEMP TABLE IF NOT EXISTS __ducklake_partial_max_migration AS
        SELECT data_file_id, TRY_CAST(regexp_extract(partial_file_info, 'partial_max:(\\d+)', 1) AS BIGINT) AS partial_max
        FROM "main".ducklake_data_file
        WHERE partial_file_info IS NOT NULL AND partial_file_info LIKE '%partial_max:%';
        ALTER TABLE "main".ducklake_data_file DROP COLUMN IF EXISTS partial_file_info;
        UPDATE "main".ducklake_data_file AS df
        SET partial_max = m.partial_max
        FROM __ducklake_partial_max_migration m
        WHERE df.data_file_id = m.data_file_id;
        DROP TABLE IF EXISTS __ducklake_partial_max_migration;
        UPDATE "main".ducklake_metadata SET value = '0.4' WHERE key = 'version';
        INSERT INTO "main".ducklake_schema_versions (table_id, begin_snapshot, schema_version)
        SELECT t.table_id, sv.begin_snapshot, sv.schema_version
        FROM "main".ducklake_schema_versions sv
        JOIN "main".ducklake_table t
          ON sv.begin_snapshot BETWEEN t.begin_snapshot
                                   AND COALESCE(t.end_snapshot, sv.begin_snapshot)
        WHERE sv.table_id IS NULL;
        DELETE FROM "main".ducklake_schema_versions WHERE table_id IS NULL;
      `);

      expect((await client.query("SELECT key, value FROM \"main\".ducklake_metadata")).rows()).toContainEqual({
        key: "version",
        value: "0.4"
      });
      expect((await client.query("SELECT data_file_id, partial_max FROM \"main\".ducklake_data_file")).rows()).toEqual([
        { data_file_id: 42n, partial_max: 123n }
      ]);
      expect((await client.query("SELECT column_id, default_value_type, default_value_dialect FROM \"main\".ducklake_column ORDER BY column_id")).rows()).toEqual([
        { column_id: 1n, default_value_type: "literal", default_value_dialect: null },
        { column_id: 2n, default_value_type: "literal", default_value_dialect: null }
      ]);
      expect((await client.query("SELECT partition_key_index, column_id FROM \"main\".ducklake_partition_column ORDER BY partition_key_index")).rows()).toEqual([
        { partition_key_index: 0n, column_id: 1n },
        { partition_key_index: 1n, column_id: 2n }
      ]);
      expect(
        (await client.query("SELECT begin_snapshot, schema_version, table_id FROM \"main\".ducklake_schema_versions")).rows()
      ).toEqual([{ begin_snapshot: 1n, schema_version: 1n, table_id: 5n }]);
      expect((await client.query("SELECT extra_stats FROM \"main\".ducklake_file_column_stats")).rows()).toEqual([]);
      const tableSql = await client.query("SELECT sql FROM duckdb_tables() WHERE table_name = 'ducklake_data_file'");
      expect(tableSql.rows()[0]).toEqual(
        expect.objectContaining({
          sql: expect.not.stringContaining("partial_file_info")
        })
      );
    } finally {
      await client.disconnect();
    }
  });

  it("executes DuckLake metadata initialization and catalog load queries", async () => {
    const client = await createCatalogClient("ducklake_init");
    try {
      const secrets = await client.query("FROM duckdb_secrets()");
      expect(secrets.names).toEqual(["name", "type", "provider", "persistent", "storage", "scope", "secret_string"]);
      expect(secrets.rows()).toEqual([]);

      await runDuckLakeBootstrapSqlFixture(client);

      expect(
        await client.values<bigint>(`
          SELECT COUNT(*) FROM information_schema.tables
          WHERE table_name = 'ducklake_metadata' AND table_schema = 'main'
        `)
      ).toEqual([1n]);

      const metadata = await client.query(`
        SELECT key, value, scope, scope_id FROM "main".ducklake_metadata
      `);
      expect(metadata.rows()).toContainEqual({ key: "encrypted", value: "false", scope: null, scope_id: null });

      const latest = await client.query(`
        SELECT snapshot_id, schema_version, next_catalog_id, next_file_id
        FROM "main".ducklake_snapshot
        WHERE snapshot_id = (SELECT MAX(snapshot_id) FROM "main".ducklake_snapshot)
      `);
      expect(latest.rows()).toEqual([{ snapshot_id: 0n, schema_version: 0n, next_catalog_id: 1n, next_file_id: 0n }]);

      const schemas = await client.query(`
        SELECT schema_id, schema_uuid::VARCHAR, schema_name, path, path_is_relative
        FROM "main".ducklake_schema
        WHERE 0 >= begin_snapshot AND (0 < end_snapshot OR end_snapshot IS NULL)
      `);
      expect(schemas.rows()).toEqual([
        expect.objectContaining({ schema_id: 0n, schema_name: "main", path: "main/", path_is_relative: true })
      ]);

      expect((await client.query(duckLakeTableInfoQuery(0))).rows()).toEqual([]);
      expect((await client.query(duckLakeViewInfoQuery(0))).rows()).toEqual([]);
      expect((await client.query(duckLakeMacroInfoQuery(0))).rows()).toEqual([]);
      expect((await client.query(duckLakePartitionInfoQuery(0))).rows()).toEqual([]);
      expect((await client.query(duckLakeSortInfoQuery(0))).rows()).toEqual([]);
      expect((await client.query(duckLakeGlobalStatsQuery())).rows()).toEqual([]);
    } finally {
      await client.disconnect();
    }
  });

  it("executes DuckLake snapshot AT version and timestamp catalog queries", async () => {
    const client = await createCatalogClient("ducklake_snapshot_at");
    try {
      await runDuckLakeBootstrapSqlFixture(client);
      await client.query(`
        UPDATE "main".ducklake_snapshot
        SET snapshot_time = '2026-05-14T00:00:00.000Z'
        WHERE snapshot_id = 0;
        INSERT INTO "main".ducklake_snapshot VALUES (1, '2026-05-14T01:00:00.000Z', 1, 2, 10);
        INSERT INTO "main".ducklake_snapshot VALUES (2, '2026-05-14T02:00:00.000Z', 2, 3, 20);
      `);

      expect((await client.query(duckLakeSnapshotAtVersionQuery(1))).rows()).toEqual([
        { snapshot_id: 1n, schema_version: 1n, next_catalog_id: 2n, next_file_id: 10n }
      ]);
      expect((await client.query(duckLakeSnapshotAtTimestampQuery("<", "DESC", "2026-05-14T01:30:00.000Z"))).rows()).toEqual([
        { snapshot_id: 1n, schema_version: 1n, next_catalog_id: 2n, next_file_id: 10n }
      ]);
      expect((await client.query(duckLakeSnapshotAtTimestampQuery(">", "ASC", "2026-05-14T00:30:00.000Z"))).rows()).toEqual([
        { snapshot_id: 1n, schema_version: 1n, next_catalog_id: 2n, next_file_id: 10n }
      ]);
    } finally {
      await client.disconnect();
    }
  });

  it("executes DuckLake create-table metadata writes and table-info readback queries", async () => {
    const client = await createCatalogClient("ducklake_table");
    try {
      await runDuckLakeBootstrapSqlFixture(client);
      await client.query(`
        INSERT INTO "main".ducklake_snapshot VALUES (1, NOW(), 1, 2, 1);
        INSERT INTO "main".ducklake_table VALUES (1, UUID(), 1, NULL, 0, 'items', 'items/', true);
        INSERT INTO "main".ducklake_column VALUES
          (1, 1, NULL, 1, 1, 'id', 'int32', NULL, 'NULL', true, NULL, 'literal', 'duckdb'),
          (2, 1, NULL, 1, 2, 'label', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
        INSERT INTO "main".ducklake_tag VALUES
          (1, 1, NULL, 'comment', 'items table'),
          (2, 1, NULL, 'comment', 'items view');
        INSERT INTO "main".ducklake_column_tag VALUES
          (1, 2, 1, NULL, 'comment', 'label column');
        INSERT INTO "main".ducklake_view VALUES
          (2, UUID(), 1, NULL, 0, 'items_view', 'duckdb', 'SELECT * FROM items', '"id","label"');
        INSERT INTO "main".ducklake_macro VALUES (0, 3, 'plus_one', 1, NULL);
        INSERT INTO "main".ducklake_macro_impl VALUES (3, 1, 'duckdb', 'x + 1', 'scalar');
        INSERT INTO "main".ducklake_macro_parameters VALUES (3, 1, 1, 'x', 'INTEGER', NULL, 'literal');
        INSERT INTO "main".ducklake_partition_info VALUES (4, 1, 1, NULL);
        INSERT INTO "main".ducklake_partition_column VALUES (4, 1, 0, 1, 'identity');
        INSERT INTO "main".ducklake_sort_info VALUES (5, 1, 1, NULL);
        INSERT INTO "main".ducklake_sort_expression VALUES (5, 1, 0, 'id', 'duckdb', 'ASC', 'NULLS_LAST');
        INSERT INTO "main".ducklake_inlined_data_tables VALUES (1, 'ducklake_inlined_data_1_1', 1);
        CREATE TABLE IF NOT EXISTS "main".ducklake_inlined_data_1_1(
          row_id BIGINT,
          begin_snapshot BIGINT,
          end_snapshot BIGINT,
          id INTEGER,
          "label" VARCHAR
        );
        INSERT INTO "main".ducklake_table_stats VALUES (1, 1, 1, 0);
        INSERT INTO "main".ducklake_table_column_stats VALUES
          (1, 1, false, NULL, '1', '1', NULL),
          (1, 2, false, NULL, 'a', 'a', NULL);
        INSERT INTO "main".ducklake_inlined_data_1_1 VALUES (0, 1, NULL, 1, 'a');
        INSERT INTO "main".ducklake_schema_versions VALUES (1, 1, 1);
        INSERT INTO "main".ducklake_snapshot_changes VALUES (1, 'created_table:"main"."items",inlined_insert:1', NULL, NULL, NULL);
      `);

      const tableInfo = await client.query(duckLakeTableInfoQuery(1));
      expect(tableInfo.rows()).toEqual([
        expect.objectContaining({
          schema_id: 0n,
          table_id: 1n,
          table_name: "items",
          tag: [{ key: "comment", value: "items table" }],
          inlined_data_tables: [{ name: "ducklake_inlined_data_1_1", schema_version: 1n }],
          column_id: 1n,
          column_name: "id",
          column_type: "int32",
          nulls_allowed: true,
          default_value: "NULL",
          default_value_type: "literal"
        }),
        expect.objectContaining({
          table_id: 1n,
          table_name: "items",
          tag: [{ key: "comment", value: "items table" }],
          inlined_data_tables: [{ name: "ducklake_inlined_data_1_1", schema_version: 1n }],
          column_id: 2n,
          column_name: "label",
          column_type: "varchar",
          column_tags: [{ key: "comment", value: "label column" }]
        })
      ]);

      const viewInfo = await client.query(duckLakeViewInfoQuery(1));
      expect(viewInfo.rows()).toEqual([
        expect.objectContaining({
          view_id: 2n,
          schema_id: 0n,
          view_name: "items_view",
          dialect: "duckdb",
          sql: "SELECT * FROM items",
          column_aliases: '"id","label"',
          tag: [{ key: "comment", value: "items view" }]
        })
      ]);

      const macroInfo = await client.query(duckLakeMacroInfoQuery(1));
      expect(macroInfo.rows()).toEqual([
        expect.objectContaining({
          schema_id: 0n,
          macro_id: 3n,
          macro_name: "plus_one",
          impl: [
            {
              dialect: "duckdb",
              sql: "x + 1",
              type: "scalar",
              params: [
                {
                  parameter_name: "x",
                  parameter_type: "INTEGER",
                  default_value: null,
                  default_value_type: "literal"
                }
              ]
            }
          ]
        })
      ]);

      expect((await client.query(duckLakePartitionInfoQuery(1))).rows()).toEqual([
        { partition_id: 4n, table_id: 1n, partition_key_index: 0n, column_id: 1n, transform: "identity" }
      ]);
      expect((await client.query(duckLakeSortInfoQuery(1))).rows()).toEqual([
        {
          sort_id: 5n,
          table_id: 1n,
          sort_key_index: 0n,
          expression: "id",
          dialect: "duckdb",
          sort_direction: "ASC",
          null_order: "NULLS_LAST"
        }
      ]);

      await client.query(`
        UPDATE "main".ducklake_partition_info
        SET end_snapshot = 2
        WHERE table_id IN (1) AND end_snapshot IS NULL;
        INSERT INTO "main".ducklake_partition_info VALUES (6, 1, 2, NULL);
        INSERT INTO "main".ducklake_partition_column VALUES (6, 1, 0, 2, 'identity');

        UPDATE "main".ducklake_sort_info
        SET end_snapshot = 2
        WHERE table_id IN (1) AND end_snapshot IS NULL;
        INSERT INTO "main".ducklake_sort_info VALUES (7, 1, 2, NULL);
        INSERT INTO "main".ducklake_sort_expression VALUES (7, 1, 0, 'label', 'duckdb', 'DESC', 'NULLS_FIRST');
      `);
      expect((await client.query(duckLakePartitionInfoQuery(2))).rows()).toEqual([
        { partition_id: 6n, table_id: 1n, partition_key_index: 0n, column_id: 2n, transform: "identity" }
      ]);
      expect((await client.query(duckLakeSortInfoQuery(2))).rows()).toEqual([
        {
          sort_id: 7n,
          table_id: 1n,
          sort_key_index: 0n,
          expression: "label",
          dialect: "duckdb",
          sort_direction: "DESC",
          null_order: "NULLS_FIRST"
        }
      ]);

      const globalStats = await client.query(duckLakeGlobalStatsQuery());
      expect(globalStats.rows()).toEqual([
        expect.objectContaining({ table_id: 1n, column_id: 1n, record_count: 1n }),
        expect.objectContaining({ table_id: 1n, column_id: 2n, record_count: 1n })
      ]);

      await client.query(`
        UPDATE "main".ducklake_table_stats SET record_count=2, file_size_bytes=128, next_row_id=2 WHERE table_id=1;
        WITH new_values(tid, cid, new_contains_null, new_contains_nan, new_min, new_max, new_extra_stats) AS (
        VALUES (1, 1, false, false, '0', '9', NULL),
               (1, 2, true, NULL, 'a', 'z', '{"encoding":"plain"}')
        )
        UPDATE "main".ducklake_table_column_stats
        SET contains_null=CAST(new_contains_null AS BOOLEAN), contains_nan=CAST(new_contains_nan AS BOOLEAN), min_value=new_min, max_value=new_max, extra_stats=new_extra_stats
        FROM new_values
        WHERE table_id=tid AND column_id=cid;
      `);
      expect((await client.query(duckLakeGlobalStatsQuery())).rows()).toEqual([
        expect.objectContaining({
          table_id: 1n,
          column_id: 1n,
          record_count: 2n,
          next_row_id: 2n,
          file_size_bytes: 128n,
          contains_null: false,
          contains_nan: false,
          min_value: "0",
          max_value: "9",
          extra_stats: null
        }),
        expect.objectContaining({
          table_id: 1n,
          column_id: 2n,
          record_count: 2n,
          next_row_id: 2n,
          file_size_bytes: 128n,
          contains_null: true,
          contains_nan: null,
          min_value: "a",
          max_value: "z",
          extra_stats: '{"encoding":"plain"}'
        })
      ]);

      const inlinedData = await client.query('SELECT id, "label" FROM "main".ducklake_inlined_data_1_1');
      expect(inlinedData.rows()).toEqual([{ id: 1, label: "a" }]);

      await client.query(`
        WITH overwritten_tags(tid, key) AS (
        VALUES (1, 'comment')
        )
        UPDATE "main".ducklake_tag
        SET end_snapshot = 2
        FROM overwritten_tags
        WHERE object_id=tid AND ducklake_tag.key=overwritten_tags.key AND end_snapshot IS NULL;
        INSERT INTO "main".ducklake_tag VALUES (1, 2, NULL, 'comment', 'updated items table');

        WITH overwritten_tags(tid, cid, key) AS (
        VALUES (1, 2, 'comment')
        )
        UPDATE "main".ducklake_column_tag
        SET end_snapshot = 2
        FROM overwritten_tags
        WHERE table_id=tid AND column_id=cid AND ducklake_column_tag.key=overwritten_tags.key AND end_snapshot IS NULL;
        INSERT INTO "main".ducklake_column_tag VALUES (1, 2, 2, NULL, 'comment', 'updated label column');
      `);
      expect((await client.query("SELECT begin_snapshot, end_snapshot, value FROM \"main\".ducklake_tag WHERE object_id = 1 ORDER BY begin_snapshot")).rows()).toEqual([
        { begin_snapshot: 1n, end_snapshot: 2n, value: "items table" },
        { begin_snapshot: 2n, end_snapshot: null, value: "updated items table" }
      ]);
      expect((await client.query("SELECT begin_snapshot, end_snapshot, value FROM \"main\".ducklake_column_tag WHERE table_id = 1 AND column_id = 2 ORDER BY begin_snapshot")).rows()).toEqual([
        { begin_snapshot: 1n, end_snapshot: 2n, value: "label column" },
        { begin_snapshot: 2n, end_snapshot: null, value: "updated label column" }
      ]);
    } finally {
      await client.disconnect();
    }
  });

  it("executes DuckLake snapshot conflict and file-list catalog queries", async () => {
    const client = await createCatalogClient("ducklake_files");
    try {
      await runDuckLakeBootstrapSqlFixture(client);
      await client.query(`
        INSERT INTO "main".ducklake_snapshot VALUES (1, NOW(), 1, 3, 11);
        INSERT INTO "main".ducklake_snapshot VALUES (2, NOW(), 1, 3, 11);
        INSERT INTO "main".ducklake_snapshot_changes VALUES (1, 'created_table:"main"."items"', NULL, NULL, NULL);
        INSERT INTO "main".ducklake_snapshot_changes VALUES (2, 'deleted_file:10', NULL, NULL, NULL);
        INSERT INTO "main".ducklake_table VALUES (1, UUID(), 1, NULL, 0, 'items', 'items/', true);
        INSERT INTO "main".ducklake_column VALUES
          (1, 1, NULL, 1, 1, 'id', 'int32', NULL, 'NULL', true, NULL, 'literal', 'duckdb'),
          (2, 1, NULL, 1, 2, 'label', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
        INSERT INTO "main".ducklake_schema_versions VALUES (1, 1, 1);
        INSERT INTO "main".ducklake_table_stats VALUES (1, 5, 5, 100);
        INSERT INTO "main".ducklake_table_column_stats VALUES
          (1, 1, false, NULL, '1', '5', NULL),
          (1, 2, true, NULL, 'a', 'z', NULL);
        INSERT INTO "main".ducklake_data_file VALUES
          (10, 1, 1, NULL, 0, 'items/data.parquet', true, 'parquet', 5, 100, 12, 0, NULL, NULL, NULL, NULL);
        INSERT INTO "main".ducklake_delete_file VALUES
          (20, 1, 2, NULL, 10, 'items/delete.parquet', true, 'positional', 1, 40, 8, NULL, NULL);
      `);

      expect((await client.values<bigint>(duckLakeBeginSnapshotForTableQuery(1)))).toEqual([1n]);
      expect((await client.values<bigint>(duckLakeBeginSnapshotForSchemaVersionQuery(1, 1)))).toEqual([1n]);
      expect((await client.values<bigint>(duckLakeNextColumnIdQuery(1)))).toEqual([2n]);
      expect((await client.values<bigint>(duckLakeNetDataFileRowCountQuery(1, 2)))).toEqual([4n]);

      const files = await client.query(duckLakeFilesForTableQuery(1, 2));
      expect(files.rows()).toEqual([
        expect.objectContaining({
          data_file_id: 10n,
          data_path: "items/data.parquet",
          data_path_is_relative: true,
          data_file_size_bytes: 100n,
          data_footer_size: 12n,
          row_id_start: 0n,
          begin_snapshot: 1n,
          del_path: "items/delete.parquet",
          del_path_is_relative: true,
          del_file_size_bytes: 40n,
          del_footer_size: 8n,
          del_format: "positional"
        })
      ]);

      const extendedFiles = await client.query(duckLakeExtendedFilesForTableQuery(1, 2));
      expect(extendedFiles.rows()).toEqual([
        expect.objectContaining({
          data_file_id: 10n,
          delete_file_id: 20n,
          record_count: 5n,
          data_path: "items/data.parquet",
          data_path_is_relative: true,
          data_file_size_bytes: 100n,
          del_path: "items/delete.parquet",
          del_path_is_relative: true,
          del_format: "positional",
          begin_snapshot: 2n
        })
      ]);

      const conflict = await client.query(duckLakeSnapshotAndStatsChangesQuery(0));
      expect(conflict.rows()[0]).toEqual(
        expect.objectContaining({
          snapshot_id: 2n,
          schema_version: 1n,
          next_catalog_id: 3n,
          next_file_id: 11n,
          changes: expect.stringContaining('created_table:"main"."items"')
        })
      );
      expect(conflict.rows()).toContainEqual(
        expect.objectContaining({ table_id: 1n, column_id: 1n, record_count: 5n, file_size_bytes: 100n })
      );

      expect((await client.query(duckLakeFilesDeletedOrDroppedAfterSnapshotQuery(1))).rows()).toEqual([
        { data_file_id: 10n }
      ]);
    } finally {
      await client.disconnect();
    }
  });

  it("executes DuckLake table-change, table-size, and cleanup catalog queries", async () => {
    const client = await createCatalogClient("ducklake_changes");
    try {
      await runDuckLakeBootstrapSqlFixture(client);
      await client.query(`
        INSERT INTO "main".ducklake_snapshot VALUES (1, NOW(), 1, 3, 12);
        INSERT INTO "main".ducklake_snapshot VALUES (2, NOW(), 1, 3, 12);
        INSERT INTO "main".ducklake_snapshot_changes VALUES (1, 'created_table:"main"."items"', 'tester', 'create', NULL);
        INSERT INTO "main".ducklake_snapshot_changes VALUES (2, 'deleted_file:10', 'tester', 'delete', NULL);
        INSERT INTO "main".ducklake_table VALUES (1, UUID(), 1, NULL, 0, 'items', 'items/', true);
        INSERT INTO "main".ducklake_column VALUES
          (1, 1, NULL, 1, 1, 'id', 'int32', NULL, 'NULL', true, NULL, 'literal', 'duckdb'),
          (2, 1, NULL, 1, 2, 'label', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
        INSERT INTO "main".ducklake_schema_versions VALUES (1, 1, 1);
        INSERT INTO "main".ducklake_data_file VALUES
          (10, 1, 1, NULL, 0, 'items/data-a.parquet', true, 'parquet', 5, 100, 12, 0, NULL, NULL, NULL, NULL),
          (11, 1, 1, 2, 1, 'items/data-b.parquet', true, 'parquet', 2, 50, 10, 5, NULL, NULL, NULL, NULL);
        INSERT INTO "main".ducklake_delete_file VALUES
          (20, 1, 2, NULL, 10, 'items/delete-a.parquet', true, 'positional', 1, 40, 8, NULL, NULL);
        INSERT INTO "main".ducklake_file_partition_value VALUES
          (10, 1, 0, 'region=us'),
          (10, 1, 1, 'date=2026-05-14');
        INSERT INTO "main".ducklake_inlined_data_tables VALUES
          (1, 'ducklake_inlined_data_1_1', 1),
          (1, 'ducklake_inlined_data_1_2', 2);
        CREATE TABLE "main".ducklake_inlined_data_1_1(row_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT, id INTEGER);
        CREATE TABLE "main".ducklake_inlined_data_1_2(row_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT, id INTEGER);
        INSERT INTO "main".ducklake_inlined_data_1_2 VALUES (0, 2, NULL, 10);
        CREATE TABLE "main".ducklake_inlined_delete_1(file_id BIGINT, row_id BIGINT, begin_snapshot BIGINT);
        INSERT INTO "main".ducklake_inlined_delete_1 VALUES
          (10, 3, 2),
          (10, 4, 2),
          (11, 0, 1);
        INSERT INTO "main".ducklake_table VALUES (9, UUID(), 5, 6, 0, 'expired_items', 'expired_items/', true);
        INSERT INTO "main".ducklake_data_file VALUES
          (90, 9, 5, 6, 0, 'expired/data.parquet', true, 'parquet', 4, 44, 6, 0, NULL, NULL, NULL, NULL);
        INSERT INTO "main".ducklake_file_column_stats VALUES
          (90, 9, 1, 10, 4, 0, '1', '4', false, NULL);
        INSERT INTO "main".ducklake_file_variant_stats VALUES
          (90, 9, 1, '$.payload', 'varchar', 10, 4, 0, 'a', 'z', false, NULL);
        INSERT INTO "main".ducklake_file_partition_value VALUES
          (90, 9, 0, 'expired=true');
        INSERT INTO "main".ducklake_delete_file VALUES
          (91, 9, 5, 6, 90, 'expired/delete.parquet', true, 'positional', 1, 20, 4, NULL, NULL);
        INSERT INTO "main".ducklake_files_scheduled_for_deletion VALUES
          (99, 'items/stale.parquet', true, NOW());
      `);

      const insertions = await client.query(duckLakeTableInsertionsQuery(1, 1, 2));
      expect(insertions.rows()).toEqual([
        expect.objectContaining({
          data_path: "items/data-a.parquet",
          data_path_is_relative: true,
          data_file_size_bytes: 100n,
          data_footer_size: 12n,
          row_id_start: 0n,
          begin_snapshot: 1n,
          del_path: null
        }),
        expect.objectContaining({
          data_path: "items/data-b.parquet",
          data_file_size_bytes: 50n,
          row_id_start: 5n,
          begin_snapshot: 1n
        })
      ]);

      const deletions = await client.query(duckLakeTableDeletionsQuery(1, 2, 2));
      expect(deletions.rows()).toEqual([
        expect.objectContaining({
          data_file_id: 10n,
          data_path: "items/data-a.parquet",
          record_count: 5n,
          current_delete_path: "items/delete-a.parquet",
          current_delete_path_is_relative: true,
          current_delete_file_size_bytes: 40n,
          current_delete_footer_size: 8n,
          current_delete_format: "positional",
          previous_delete_path: null,
          begin_snapshot: 2n,
          deletions: null
        }),
        expect.objectContaining({
          data_file_id: 11n,
          data_path: "items/data-b.parquet",
          record_count: 2n,
          current_delete_path: null,
          begin_snapshot: 2n,
          deletions: null
        })
      ]);

      expect((await client.query(duckLakeTableSizesQuery(2))).rows()).toEqual([
        expect.objectContaining({
          schema_id: 0n,
          table_id: 1n,
          table_name: "items",
          data_file_count: 1n,
          data_total_size: 100n,
          delete_file_count: 1n,
          delete_total_size: 40n
        })
      ]);

      const compactionFiles = await client.query(duckLakeFilesForCompactionQuery(1));
      expect(compactionFiles.rows()).toEqual([
        expect.objectContaining({
          data_file_id: 10n,
          record_count: 5n,
          row_id_start: 0n,
          begin_snapshot: 1n,
          schema_version: 1n,
          keys: ["region=us", "date=2026-05-14"],
          data_path: "items/data-a.parquet",
          data_file_size_bytes: 100n,
          del_data_file_id: 10n,
          del_delete_file_id: 20n,
          delete_count: 1n,
          del_path: "items/delete-a.parquet",
          del_format: "positional"
        }),
        expect.objectContaining({
          data_file_id: 11n,
          record_count: 2n,
          row_id_start: 5n,
          schema_version: 1n,
          keys: null,
          data_path: "items/data-b.parquet",
          del_data_file_id: null
        })
      ]);

      expect((await client.query(duckLakeEmptySupersededInlinedTablesQuery())).rows()).toEqual([
        { table_id: 1n, schema_version: 1n, table_name: "ducklake_inlined_data_1_1" }
      ]);
      await client.query(`
        DELETE FROM "main".ducklake_inlined_data_tables WHERE table_id=1 AND schema_version=1;
        DROP TABLE IF EXISTS "main".ducklake_inlined_data_1_1;
      `);
      expect((await client.query(duckLakeEmptySupersededInlinedTablesQuery())).rows()).toEqual([]);

      expect((await client.query(duckLakeReadInlinedFileDeletionsQuery(1, 2))).rows()).toEqual([
        { file_id: 10n, row_id: 3n },
        { file_id: 10n, row_id: 4n },
        { file_id: 11n, row_id: 0n }
      ]);
      expect((await client.query(duckLakeInlinedDeletionFileIdsQuery(1, [10, 12], 2))).rows()).toEqual([
        { file_id: 10n }
      ]);
      expect((await client.query(duckLakeReadInlinedFileDeletionsForRangeQuery(1, 2, 2))).rows()).toEqual([
        { file_id: 10n, row_id: 3n, begin_snapshot: 2n },
        { file_id: 10n, row_id: 4n, begin_snapshot: 2n }
      ]);

      const flushDeletes = await client.query(duckLakeFlushInlinedFileDeletionsQuery(1, 2));
      expect(flushDeletes.rows()).toEqual([
        expect.objectContaining({
          file_id: 10n,
          path: "items/data-a.parquet",
          path_is_relative: true,
          row_id: 3n,
          begin_snapshot: 2n,
          delete_file_id: 20n,
          del_path: "items/delete-a.parquet",
          del_path_is_relative: true,
          del_begin_snapshot: 2n,
          del_format: "positional"
        }),
        expect.objectContaining({
          file_id: 10n,
          row_id: 4n,
          delete_file_id: 20n
        }),
        expect.objectContaining({
          file_id: 11n,
          path: "items/data-b.parquet",
          row_id: 0n,
          begin_snapshot: 1n,
          delete_file_id: null
        })
      ]);

      const snapshots = await client.query(duckLakeAllSnapshotsQuery());
      expect(snapshots.rows()).toContainEqual(
        expect.objectContaining({
          snapshot_id: 2n,
          schema_version: 1n,
          changes_made: "deleted_file:10",
          author: "tester",
          commit_message: "delete"
        })
      );

      expect((await client.query(duckLakeOldFilesForCleanupQuery())).rows()).toEqual([
        expect.objectContaining({
          data_file_id: 99n,
          path: "items/stale.parquet",
          path_is_relative: true
        })
      ]);
      expect((await client.values<bigint>(duckLakeNetDataFileRowCountWithInlinedDeletionsQuery(1, 2, "ducklake_inlined_delete_1")))).toEqual([2n]);
      expect((await client.values<bigint>(duckLakeNetInlinedRowCountQuery("ducklake_inlined_data_1_2", 2)))).toEqual([1n]);

      await client.query("DELETE FROM \"main\".ducklake_files_scheduled_for_deletion WHERE data_file_id IN (99)");
      expect((await client.query(duckLakeOldFilesForCleanupQuery())).rows()).toEqual([]);

      await client.query(`
        INSERT INTO "main".ducklake_macro_impl VALUES (999, 1, 'duckdb', 'x', 'scalar');
        INSERT INTO "main".ducklake_macro_parameters VALUES (999, 1, 1, 'x', 'INTEGER', NULL, 'literal');
        INSERT INTO "main".ducklake_name_mapping VALUES (999, 1, 'source_id', 1, NULL, false);
        DELETE FROM "main".ducklake_macro_impl tbl
        WHERE NOT EXISTS (
          SELECT 1 FROM "main".ducklake_macro m
          WHERE m.macro_id = tbl.macro_id
        );
        DELETE FROM "main".ducklake_macro_parameters tbl
        WHERE NOT EXISTS (
          SELECT 1 FROM "main".ducklake_macro m
          WHERE m.macro_id = tbl.macro_id
        );
        DELETE FROM "main".ducklake_name_mapping tbl
        WHERE NOT EXISTS (
          SELECT 1 FROM "main".ducklake_column_mapping m
          WHERE m.mapping_id = tbl.mapping_id
        );
      `);
      expect((await client.values<bigint>("SELECT COUNT(*) FROM \"main\".ducklake_macro_impl WHERE macro_id = 999"))).toEqual([0n]);
      expect((await client.values<bigint>("SELECT COUNT(*) FROM \"main\".ducklake_macro_parameters WHERE macro_id = 999"))).toEqual([0n]);
      expect((await client.values<bigint>("SELECT COUNT(*) FROM \"main\".ducklake_name_mapping WHERE mapping_id = 999"))).toEqual([0n]);

      expect((await client.query(duckLakeExpiredTablesForSnapshotCleanupQuery())).rows()).toEqual([{ table_id: 9n }]);
      expect((await client.query(duckLakeExpiredDataFilesForSnapshotCleanupQuery())).rows()).toEqual([
        {
          data_file_id: 90n,
          table_id: 9n,
          path: "expired/data.parquet",
          path_is_relative: true
        }
      ]);
      expect((await client.query(duckLakeExpiredDeleteFilesForSnapshotCleanupQuery())).rows()).toEqual([
        {
          delete_file_id: 91n,
          table_id: 9n,
          path: "expired/delete.parquet",
          path_is_relative: true
        }
      ]);
      await client.query(`
        DELETE FROM "main".ducklake_data_file WHERE data_file_id IN (90);
        DELETE FROM "main".ducklake_file_column_stats WHERE data_file_id IN (90);
        DELETE FROM "main".ducklake_file_variant_stats WHERE data_file_id IN (90);
        DELETE FROM "main".ducklake_file_partition_value WHERE data_file_id IN (90);
        DELETE FROM "main".ducklake_delete_file WHERE delete_file_id IN (91);
        INSERT INTO "main".ducklake_files_scheduled_for_deletion VALUES
          (90, 'expired/data.parquet', true, NOW()),
          (91, 'expired/delete.parquet', true, NOW());
      `);
      expect((await client.values<bigint>("SELECT COUNT(*) FROM \"main\".ducklake_data_file WHERE data_file_id = 90"))).toEqual([0n]);
      expect((await client.values<bigint>("SELECT COUNT(*) FROM \"main\".ducklake_delete_file WHERE delete_file_id = 91"))).toEqual([0n]);
      expect((await client.query("SELECT data_file_id, path FROM \"main\".ducklake_files_scheduled_for_deletion WHERE data_file_id IN (90, 91) ORDER BY data_file_id")).rows()).toEqual([
        { data_file_id: 90n, path: "expired/data.parquet" },
        { data_file_id: 91n, path: "expired/delete.parquet" }
      ]);
    } finally {
      await client.disconnect();
    }
  });

  it("executes DuckLake compaction, snapshot-expiration, and inlined-delete metadata queries", async () => {
    const client = await createCatalogClient("ducklake_compaction_mutations");
    try {
      await runDuckLakeBootstrapSqlFixture(client);
      await client.query(`
        INSERT INTO "main".ducklake_snapshot VALUES
          (1, NOW(), 1, 5, 20),
          (2, NOW(), 1, 5, 20),
          (3, NOW(), 2, 6, 30);
        INSERT INTO "main".ducklake_table VALUES (1, UUID(), 1, NULL, 0, 'items', 'items/', true);
        INSERT INTO "main".ducklake_schema_versions VALUES
          (1, 1, 1),
          (3, 2, 1);
        INSERT INTO "main".ducklake_inlined_data_tables VALUES
          (1, 'ducklake_inlined_data_1_1', 1),
          (1, 'ducklake_inlined_data_1_2', 2);
        CREATE TABLE IF NOT EXISTS "main".ducklake_inlined_delete_1(file_id BIGINT, row_id BIGINT, begin_snapshot BIGINT);
        CREATE TABLE IF NOT EXISTS "main".ducklake_inlined_data_1_1(row_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT, id INTEGER);
        CREATE TABLE IF NOT EXISTS "main".ducklake_inlined_data_1_2(row_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT, id INTEGER);
        INSERT INTO "main".ducklake_inlined_delete_1 VALUES
          (10, 0, 2),
          (10, 1, 3);
        INSERT INTO "main".ducklake_inlined_data_1_1 VALUES
          (0, 1, NULL, 10),
          (1, 2, NULL, 11),
          (2, 3, NULL, 12);
        INSERT INTO "main".ducklake_data_file VALUES
          (10, 1, 1, NULL, 0, 'items/a.parquet', true, 'parquet', 10, 100, 10, 0, NULL, NULL, NULL, NULL),
          (11, 1, 1, NULL, 1, 'items/b.parquet', true, 'parquet', 10, 100, 10, 10, NULL, NULL, NULL, NULL),
          (12, 1, 1, 2, 2, 'items/old.parquet', true, 'parquet', 5, 50, 10, 20, NULL, NULL, NULL, NULL);
        INSERT INTO "main".ducklake_delete_file VALUES
          (20, 1, 2, NULL, 10, 'items/a-delete.parquet', true, 'positional', 2, 20, 5, NULL, NULL),
          (21, 1, 2, NULL, 11, 'items/b-delete.parquet', true, 'positional', 1, 10, 5, NULL, NULL);
      `);

      await client.query("CALL quack_clear_cache()");

      expect((await client.query('SELECT NULL FROM "main".ducklake_inlined_delete_1 LIMIT 1')).rows()).toHaveLength(1);
      expect((await client.query(duckLakeLatestInlinedDataTableNameQuery(1))).rows()).toEqual([
        { table_name: "ducklake_inlined_data_1_2" }
      ]);
      expect((await client.query('SELECT DISTINCT schema_version FROM "main".ducklake_snapshot ORDER BY schema_version')).rows()).toEqual([
        { schema_version: 0n },
        { schema_version: 1n },
        { schema_version: 2n }
      ]);

      await client.query(`
        UPDATE "main".ducklake_delete_file SET end_snapshot = 3
        WHERE delete_file_id = 20 AND end_snapshot IS NULL;
        UPDATE "main".ducklake_data_file SET end_snapshot = 3
        WHERE data_file_id = 10;
        UPDATE "main".ducklake_data_file SET begin_snapshot = 3
        WHERE data_file_id = 11;
        DELETE FROM "main".ducklake_data_file WHERE data_file_id IN (12);
        DELETE FROM "main".ducklake_delete_file WHERE delete_file_id IN (21);
        INSERT INTO "main".ducklake_files_scheduled_for_deletion VALUES
          (12, 'items/old.parquet', true, NOW()),
          (21, 'items/b-delete.parquet', true, NOW());
      `);
      expect((await client.query('SELECT data_file_id, begin_snapshot, end_snapshot FROM "main".ducklake_data_file ORDER BY data_file_id')).rows()).toEqual([
        { data_file_id: 10n, begin_snapshot: 1n, end_snapshot: 3n },
        { data_file_id: 11n, begin_snapshot: 3n, end_snapshot: null }
      ]);
      expect((await client.query('SELECT delete_file_id, end_snapshot FROM "main".ducklake_delete_file ORDER BY delete_file_id')).rows()).toEqual([
        { delete_file_id: 20n, end_snapshot: 3n }
      ]);
      expect((await client.query('SELECT data_file_id, path FROM "main".ducklake_files_scheduled_for_deletion ORDER BY data_file_id')).rows()).toEqual([
        { data_file_id: 12n, path: "items/old.parquet" },
        { data_file_id: 21n, path: "items/b-delete.parquet" }
      ]);

      await client.query(`
        DELETE FROM "main".ducklake_inlined_data_1_1 WHERE begin_snapshot <= 2;
        DELETE FROM "main".ducklake_snapshot WHERE snapshot_id IN (1);
        DROP TABLE IF EXISTS "main".ducklake_inlined_data_1_2;
      `);
      expect((await client.query('SELECT row_id, begin_snapshot, id FROM "main".ducklake_inlined_data_1_1')).rows()).toEqual([
        { row_id: 2n, begin_snapshot: 3n, id: 12 }
      ]);
      expect((await client.query('SELECT snapshot_id FROM "main".ducklake_snapshot ORDER BY snapshot_id')).rows()).toEqual([
        { snapshot_id: 0n },
        { snapshot_id: 2n },
        { snapshot_id: 3n }
      ]);
      expect((await client.values<bigint>(`
        SELECT COUNT(*) FROM information_schema.tables
        WHERE table_name = 'ducklake_inlined_data_1_2' AND table_schema = 'main'
      `))).toEqual([0n]);
    } finally {
      await client.disconnect();
    }
  });

  it("executes DuckLake catalog-entry drop metadata queries", async () => {
    const client = await createCatalogClient("ducklake_entry_drops");
    try {
      await runDuckLakeBootstrapSqlFixture(client);
      await client.query(`
        INSERT INTO "main".ducklake_snapshot VALUES (4, NOW(), 2, 10, 20);
        INSERT INTO "main".ducklake_schema VALUES (7, UUID(), 1, NULL, 'analytics', 'analytics/', true);
        INSERT INTO "main".ducklake_table VALUES (8, UUID(), 1, NULL, 7, 'events', 'events/', true);
        INSERT INTO "main".ducklake_view VALUES (9, UUID(), 1, NULL, 7, 'events_view', 'duckdb', 'SELECT 1', 'id');
        INSERT INTO "main".ducklake_macro VALUES (7, 10, 'event_count', 1, NULL);
        INSERT INTO "main".ducklake_tag VALUES
          (8, 1, NULL, 'comment', 'events table'),
          (9, 1, NULL, 'comment', 'events view');
        INSERT INTO "main".ducklake_column VALUES (11, 1, NULL, 8, 1, 'id', 'int32', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
        INSERT INTO "main".ducklake_column_tag VALUES (8, 11, 1, NULL, 'comment', 'id column');
        INSERT INTO "main".ducklake_partition_info VALUES (12, 8, 1, NULL);
        INSERT INTO "main".ducklake_partition_column VALUES (12, 8, 0, 11, 'identity');
        INSERT INTO "main".ducklake_sort_info VALUES (13, 8, 1, NULL);
        INSERT INTO "main".ducklake_sort_expression VALUES (13, 8, 0, 'id', 'duckdb', 'ASC', 'NULLS_LAST');
        INSERT INTO "main".ducklake_data_file VALUES (14, 8, 1, NULL, 0, 'events/a.parquet', true, 'parquet', 1, 10, 1, 0, NULL, NULL, NULL, NULL);
        INSERT INTO "main".ducklake_delete_file VALUES (15, 8, 1, NULL, 14, 'events/a-delete.parquet', true, 'positional', 1, 10, 1, NULL, NULL);
      `);

      await client.query(`
        UPDATE "main".ducklake_table SET end_snapshot = 4 WHERE end_snapshot IS NULL AND table_id IN (8);
        UPDATE "main".ducklake_partition_info SET end_snapshot = 4 WHERE end_snapshot IS NULL AND table_id IN (8);
        UPDATE "main".ducklake_column SET end_snapshot = 4 WHERE end_snapshot IS NULL AND table_id IN (8);
        UPDATE "main".ducklake_column_tag SET end_snapshot = 4 WHERE end_snapshot IS NULL AND table_id IN (8);
        UPDATE "main".ducklake_data_file SET end_snapshot = 4 WHERE end_snapshot IS NULL AND table_id IN (8);
        UPDATE "main".ducklake_delete_file SET end_snapshot = 4 WHERE end_snapshot IS NULL AND table_id IN (8);
        UPDATE "main".ducklake_tag SET end_snapshot = 4 WHERE end_snapshot IS NULL AND object_id IN (8, 9);
        UPDATE "main".ducklake_sort_info SET end_snapshot = 4 WHERE end_snapshot IS NULL AND table_id IN (8);
        UPDATE "main".ducklake_view SET end_snapshot = 4 WHERE end_snapshot IS NULL AND view_id IN (9);
        UPDATE "main".ducklake_macro SET end_snapshot = 4 WHERE end_snapshot IS NULL AND macro_id IN (10);
        UPDATE "main".ducklake_schema SET end_snapshot = 4 WHERE end_snapshot IS NULL AND schema_id IN (7);
      `);

      for (const [tableName, filter] of [
        ["ducklake_table", "table_id = 8"],
        ["ducklake_partition_info", "table_id = 8"],
        ["ducklake_column", "table_id = 8"],
        ["ducklake_column_tag", "table_id = 8"],
        ["ducklake_data_file", "table_id = 8"],
        ["ducklake_delete_file", "table_id = 8"],
        ["ducklake_sort_info", "table_id = 8"],
        ["ducklake_view", "view_id = 9"],
        ["ducklake_macro", "macro_id = 10"],
        ["ducklake_schema", "schema_id = 7"]
      ]) {
        expect(await client.values<bigint>(`SELECT end_snapshot FROM "main".${tableName} WHERE ${filter}`)).toEqual([4n]);
      }
      expect((await client.query('SELECT object_id, end_snapshot FROM "main".ducklake_tag ORDER BY object_id')).rows()).toEqual([
        { object_id: 8n, end_snapshot: 4n },
        { object_id: 9n, end_snapshot: 4n }
      ]);
    } finally {
      await client.disconnect();
    }
  });

  it("executes DuckLake inlined-data read and CTE update catalog queries", async () => {
    const client = await createCatalogClient("ducklake_inlined");
    try {
      await runDuckLakeBootstrapSqlFixture(client);
      await client.query(`
        INSERT INTO "main".ducklake_column VALUES
          (1, 1, NULL, 7, 1, 'id', 'int32', NULL, 'NULL', true, NULL, 'literal', 'duckdb'),
          (2, 1, NULL, 7, 2, 'label', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
        CREATE TABLE "main".ducklake_inlined_data_7_1(
          row_id BIGINT,
          begin_snapshot BIGINT,
          end_snapshot BIGINT,
          id INTEGER,
          "label" VARCHAR,
          metric DOUBLE
        );
        INSERT INTO "main".ducklake_inlined_data_7_1 VALUES
          (0, 1, NULL, 1, 'active', 1.5),
          (1, 1, 2, 2, 'deleted', 2.5),
          (2, 3, NULL, 3, 'inserted', 3.5);
      `);

      const activeAtSnapshot = await client.query(`
        SELECT id AS col1, "label" AS col2
        FROM "main".ducklake_inlined_data_7_1 inlined_data
        WHERE 2 >= begin_snapshot AND (2 < end_snapshot OR end_snapshot IS NULL)
        ORDER BY row_id
      `);
      expect(activeAtSnapshot.rows()).toEqual([{ col1: 1, col2: "active" }]);

      const insertions = await client.query(`
        SELECT id AS col1, "label" AS col2
        FROM "main".ducklake_inlined_data_7_1 inlined_data
        WHERE inlined_data.begin_snapshot >= 2 AND inlined_data.begin_snapshot <= 3
      `);
      expect(insertions.rows()).toEqual([{ col1: 3, col2: "inserted" }]);

      const deletions = await client.query(`
        SELECT id AS col1, "label" AS col2
        FROM "main".ducklake_inlined_data_7_1 inlined_data
        WHERE inlined_data.end_snapshot >= 2 AND inlined_data.end_snapshot <= 3
      `);
      expect(deletions.rows()).toEqual([{ col1: 2, col2: "deleted" }]);

      const flushRows = await client.query(`
        SELECT row_id AS col1, begin_snapshot AS col2, end_snapshot AS col3, id AS col4, metric AS col5
        FROM "main".ducklake_inlined_data_7_1 inlined_data
        WHERE 3 >= begin_snapshot
        ORDER BY row_id, begin_snapshot
      `);
      expect(flushRows.rows()).toEqual([
        { col1: 0n, col2: 1n, col3: null, col4: 1, col5: 1.5 },
        { col1: 1n, col2: 1n, col3: 2n, col4: 2, col5: 2.5 },
        { col1: 2n, col2: 3n, col3: null, col4: 3, col5: 3.5 }
      ]);

      await client.query(`
        WITH deleted_row_list(deleted_row_id) AS (
        VALUES (0), (2)
        )
        UPDATE "main".ducklake_inlined_data_7_1
        SET end_snapshot = 4
        FROM deleted_row_list
        WHERE row_id=deleted_row_id AND end_snapshot IS NULL AND begin_snapshot != 4;

        WITH dropped_cols(tid, cid) AS (
        VALUES (7, 1)
        )
        UPDATE "main".ducklake_column
        SET end_snapshot = 4
        FROM dropped_cols
        WHERE table_id=tid AND column_id=cid AND end_snapshot IS NULL;
      `);

      expect((await client.query("SELECT row_id, end_snapshot FROM \"main\".ducklake_inlined_data_7_1 ORDER BY row_id")).rows()).toEqual([
        { row_id: 0n, end_snapshot: 4n },
        { row_id: 1n, end_snapshot: 2n },
        { row_id: 2n, end_snapshot: 4n }
      ]);
      expect((await client.query("SELECT column_id, end_snapshot FROM \"main\".ducklake_column WHERE table_id = 7 ORDER BY column_id")).rows()).toEqual([
        { column_id: 1n, end_snapshot: 4n },
        { column_id: 2n, end_snapshot: null }
      ]);
    } finally {
      await client.disconnect();
    }
  });

  it("executes DuckLake column mapping catalog queries", async () => {
    const client = await createCatalogClient("ducklake_mappings");
    try {
      await runDuckLakeBootstrapSqlFixture(client);
      await client.query(`
        INSERT INTO "main".ducklake_column_mapping VALUES
          (101, 8, 'by_name'),
          (102, 8, 'by_id');
        INSERT INTO "main".ducklake_name_mapping VALUES
          (101, 1, 'event_id', 10, NULL, false),
          (101, 2, 'payload', 11, 1, false),
          (102, 3, 'region', 12, NULL, true);
      `);

      const mappings = await client.query(`
        SELECT mapping_id, table_id, type, column_id, source_name, target_field_id, parent_column, is_partition
        FROM "main".ducklake_column_mapping
        JOIN "main".ducklake_name_mapping USING (mapping_id)
        ORDER BY mapping_id, parent_column NULLS FIRST
      `);
      expect(mappings.rows()).toEqual([
        {
          mapping_id: 101n,
          table_id: 8n,
          type: "by_name",
          column_id: 1n,
          source_name: "event_id",
          target_field_id: 10n,
          parent_column: null,
          is_partition: false
        },
        {
          mapping_id: 101n,
          table_id: 8n,
          type: "by_name",
          column_id: 2n,
          source_name: "payload",
          target_field_id: 11n,
          parent_column: 1n,
          is_partition: false
        },
        {
          mapping_id: 102n,
          table_id: 8n,
          type: "by_id",
          column_id: 3n,
          source_name: "region",
          target_field_id: 12n,
          parent_column: null,
          is_partition: true
        }
      ]);

      const filtered = await client.query(`
        SELECT mapping_id, table_id, type, column_id, source_name, target_field_id, parent_column, is_partition
        FROM "main".ducklake_column_mapping
        JOIN "main".ducklake_name_mapping USING (mapping_id)
        WHERE mapping_id >= 102
        ORDER BY mapping_id, parent_column NULLS FIRST
      `);
      expect(filtered.rows()).toEqual([
        {
          mapping_id: 102n,
          table_id: 8n,
          type: "by_id",
          column_id: 3n,
          source_name: "region",
          target_field_id: 12n,
          parent_column: null,
          is_partition: true
        }
      ]);
    } finally {
      await client.disconnect();
    }
  });

  it("executes DuckLake file stats filter-pushdown CTE queries", async () => {
    const client = await createCatalogClient("ducklake_stats_filter");
    try {
      await runDuckLakeBootstrapSqlFixture(client);
      await client.query(`
        INSERT INTO "main".ducklake_data_file VALUES
          (10, 1, 1, NULL, 0, 'items/a.parquet', true, 'parquet', 5, 100, 10, 0, NULL, NULL, NULL, NULL),
          (11, 1, 1, NULL, 1, 'items/b.parquet', true, 'parquet', 5, 100, 10, 5, NULL, NULL, NULL, NULL),
          (12, 1, 1, NULL, 2, 'items/c.parquet', true, 'parquet', 5, 100, 10, 10, NULL, NULL, NULL, NULL);
        INSERT INTO "main".ducklake_file_column_stats VALUES
          (10, 1, 1, 10, 5, 0, '1', '10', false, NULL),
          (11, 1, 1, 10, 5, 0, '20', '30', false, NULL),
          (12, 1, 1, 10, NULL, NULL, NULL, NULL, NULL, NULL);
      `);

      const files = await client.query(`
        WITH col_1_stats AS MATERIALIZED (
          SELECT data_file_id, min_value, max_value, contains_nan
          FROM "main".ducklake_file_column_stats
          WHERE column_id = 1 AND table_id = 1
        )
        SELECT data.data_file_id, data.path
        FROM "main".ducklake_data_file data
        JOIN col_1_stats USING (data_file_id)
        WHERE data.table_id = 1
          AND TRY_CAST(col_1_stats.min_value AS BIGINT) <= 5
          AND TRY_CAST(col_1_stats.max_value AS BIGINT) >= 5
      `);
      expect(files.rows()).toEqual([{ data_file_id: 10n, path: "items/a.parquet" }]);

      const dynamicallyOrdered = await client.query(`
        SELECT data.data_file_id, data.path, stats_0.min_value, stats_0.max_value
        FROM "main".ducklake_data_file data
        LEFT JOIN "main".ducklake_file_column_stats stats_0 ON stats_0.data_file_id = data.data_file_id AND
          stats_0.table_id = data.table_id AND stats_0.column_id = 1
        WHERE data.table_id=1 AND 2 >= data.begin_snapshot AND (2 < data.end_snapshot OR data.end_snapshot IS NULL)
        ORDER BY TRY_CAST(stats_0.max_value AS BIGINT) DESC NULLS LAST
      `);
      expect(dynamicallyOrdered.rows()).toEqual([
        { data_file_id: 11n, path: "items/b.parquet", min_value: "20", max_value: "30" },
        { data_file_id: 10n, path: "items/a.parquet", min_value: "1", max_value: "10" },
        { data_file_id: 12n, path: "items/c.parquet", min_value: null, max_value: null }
      ]);
    } finally {
      await client.disconnect();
    }
  });

  it("executes DuckLake path, column-origin, and option catalog queries", async () => {
    const client = await createCatalogClient("ducklake_options");
    try {
      await runDuckLakeBootstrapSqlFixture(client);
      await client.query(`
        INSERT INTO "main".ducklake_schema VALUES (7, UUID(), 1, NULL, 'analytics', 'analytics/', true);
        INSERT INTO "main".ducklake_table VALUES (8, UUID(), 1, NULL, 7, 'events', 'events/', true);
        INSERT INTO "main".ducklake_column VALUES
          (1, 1, NULL, 8, 1, 'event_id', 'int64', NULL, 'NULL', true, NULL, 'literal', 'duckdb'),
          (2, 2, NULL, 8, 2, 'payload', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb');
      `);

      expect((await client.query(duckLakePathForSchemaQuery(7))).rows()).toEqual([
        { path: "analytics/", path_is_relative: true }
      ]);
      expect((await client.query(duckLakePathForTableQuery(8))).rows()).toEqual([
        {
          s_path: "analytics/",
          s_path_is_relative: true,
          t_path: "events/",
          t_path_is_relative: true
        }
      ]);
      expect((await client.query(duckLakeColumnCreatedWithTableQuery("events", "event_id"))).rows()).toHaveLength(1);
      expect((await client.query(duckLakeColumnCreatedWithTableQuery("events", "payload"))).rows()).toEqual([]);

      expect((await client.values<bigint>(duckLakeOptionExistsQuery("auto_compact", "scope IS NULL")))).toEqual([0n]);
      await client.query("INSERT INTO \"main\".ducklake_metadata VALUES ('auto_compact', 'true', NULL, NULL)");
      expect((await client.values<bigint>(duckLakeOptionExistsQuery("auto_compact", "scope IS NULL")))).toEqual([1n]);
      await client.query("UPDATE \"main\".ducklake_metadata SET value='false' WHERE key='auto_compact' AND scope IS NULL");
      expect((await client.query("SELECT key, value, scope, scope_id FROM \"main\".ducklake_metadata WHERE key='auto_compact'")).rows()).toEqual([
        { key: "auto_compact", value: "false", scope: null, scope_id: null }
      ]);

      await client.query(`
        INSERT INTO "main".ducklake_metadata VALUES ('target_file_size', '1048576', 'schema', 7);
        INSERT INTO "main".ducklake_metadata VALUES ('parquet_compression', 'zstd', 'table', 8);
      `);
      const scopedOptions = await client.query(`
        SELECT key, value, scope, scope_id
        FROM "main".ducklake_metadata
        WHERE scope IS NOT NULL
        ORDER BY scope, scope_id, key
      `);
      expect(scopedOptions.rows()).toEqual([
        { key: "target_file_size", value: "1048576", scope: "schema", scope_id: 7n },
        { key: "parquet_compression", value: "zstd", scope: "table", scope_id: 8n }
      ]);
    } finally {
      await client.disconnect();
    }
  });
});

// Mirrors the DDL/DML DuckLake sends while bootstrapping a fresh catalog.
// Production users should let DuckLake issue this SQL through the Quack endpoint.
async function runDuckLakeBootstrapSqlFixture(client: QuackClient, dataPath = plannedDataPathForClient(client)): Promise<void> {
  await client.query(`
    CREATE TABLE "main".ducklake_metadata(key VARCHAR NOT NULL, value VARCHAR NOT NULL, scope VARCHAR, scope_id BIGINT);
    CREATE TABLE "main".ducklake_snapshot(snapshot_id BIGINT PRIMARY KEY, snapshot_time TIMESTAMPTZ, schema_version BIGINT, next_catalog_id BIGINT, next_file_id BIGINT);
    CREATE TABLE "main".ducklake_snapshot_changes(snapshot_id BIGINT PRIMARY KEY, changes_made VARCHAR, author VARCHAR, commit_message VARCHAR, commit_extra_info VARCHAR);
    CREATE TABLE "main".ducklake_schema(schema_id BIGINT PRIMARY KEY, schema_uuid UUID, begin_snapshot BIGINT, end_snapshot BIGINT, schema_name VARCHAR, path VARCHAR, path_is_relative BOOLEAN);
    CREATE TABLE "main".ducklake_table(table_id BIGINT, table_uuid UUID, begin_snapshot BIGINT, end_snapshot BIGINT, schema_id BIGINT, table_name VARCHAR, path VARCHAR, path_is_relative BOOLEAN);
    CREATE TABLE "main".ducklake_view(view_id BIGINT, view_uuid UUID, begin_snapshot BIGINT, end_snapshot BIGINT, schema_id BIGINT, view_name VARCHAR, dialect VARCHAR, sql VARCHAR, column_aliases VARCHAR);
    CREATE TABLE "main".ducklake_tag(object_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT, key VARCHAR, value VARCHAR);
    CREATE TABLE "main".ducklake_column_tag(table_id BIGINT, column_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT, key VARCHAR, value VARCHAR);
    CREATE TABLE "main".ducklake_data_file(data_file_id BIGINT PRIMARY KEY, table_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT, file_order BIGINT, path VARCHAR, path_is_relative BOOLEAN, file_format VARCHAR, record_count BIGINT, file_size_bytes BIGINT, footer_size BIGINT, row_id_start BIGINT, partition_id BIGINT, encryption_key VARCHAR, mapping_id BIGINT, partial_max BIGINT);
    CREATE TABLE "main".ducklake_file_column_stats(data_file_id BIGINT, table_id BIGINT, column_id BIGINT, column_size_bytes BIGINT, value_count BIGINT, null_count BIGINT, min_value VARCHAR, max_value VARCHAR, contains_nan BOOLEAN, extra_stats VARCHAR);
    CREATE TABLE "main".ducklake_file_variant_stats(data_file_id BIGINT, table_id BIGINT, column_id BIGINT, variant_path VARCHAR, shredded_type VARCHAR, column_size_bytes BIGINT, value_count BIGINT, null_count BIGINT, min_value VARCHAR, max_value VARCHAR, contains_nan BOOLEAN, extra_stats VARCHAR);
    CREATE TABLE "main".ducklake_delete_file(delete_file_id BIGINT PRIMARY KEY, table_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT, data_file_id BIGINT, path VARCHAR, path_is_relative BOOLEAN, format VARCHAR, delete_count BIGINT, file_size_bytes BIGINT, footer_size BIGINT, encryption_key VARCHAR, partial_max BIGINT);
    CREATE TABLE "main".ducklake_column(column_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT, table_id BIGINT, column_order BIGINT, column_name VARCHAR, column_type VARCHAR, initial_default VARCHAR, default_value VARCHAR, nulls_allowed BOOLEAN, parent_column BIGINT, default_value_type VARCHAR, default_value_dialect VARCHAR);
    CREATE TABLE "main".ducklake_table_stats(table_id BIGINT, record_count BIGINT, next_row_id BIGINT, file_size_bytes BIGINT);
    CREATE TABLE "main".ducklake_table_column_stats(table_id BIGINT, column_id BIGINT, contains_null BOOLEAN, contains_nan BOOLEAN, min_value VARCHAR, max_value VARCHAR, extra_stats VARCHAR);
    CREATE TABLE "main".ducklake_partition_info(partition_id BIGINT, table_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT);
    CREATE TABLE "main".ducklake_partition_column(partition_id BIGINT, table_id BIGINT, partition_key_index BIGINT, column_id BIGINT, transform VARCHAR);
    CREATE TABLE "main".ducklake_file_partition_value(data_file_id BIGINT, table_id BIGINT, partition_key_index BIGINT, partition_value VARCHAR);
    CREATE TABLE "main".ducklake_files_scheduled_for_deletion(data_file_id BIGINT, path VARCHAR, path_is_relative BOOLEAN, schedule_start TIMESTAMPTZ);
    CREATE TABLE "main".ducklake_inlined_data_tables(table_id BIGINT, table_name VARCHAR, schema_version BIGINT);
    CREATE TABLE "main".ducklake_column_mapping(mapping_id BIGINT, table_id BIGINT, type VARCHAR);
    CREATE TABLE "main".ducklake_name_mapping(mapping_id BIGINT, column_id BIGINT, source_name VARCHAR, target_field_id BIGINT, parent_column BIGINT, is_partition BOOLEAN);
    CREATE TABLE "main".ducklake_schema_versions(begin_snapshot BIGINT, schema_version BIGINT, table_id BIGINT);
    CREATE TABLE "main".ducklake_macro(schema_id BIGINT, macro_id BIGINT, macro_name VARCHAR, begin_snapshot BIGINT, end_snapshot BIGINT);
    CREATE TABLE "main".ducklake_macro_impl(macro_id BIGINT, impl_id BIGINT, dialect VARCHAR, sql VARCHAR, type VARCHAR);
    CREATE TABLE "main".ducklake_macro_parameters(macro_id BIGINT, impl_id BIGINT, column_id BIGINT, parameter_name VARCHAR, parameter_type VARCHAR, default_value VARCHAR, default_value_type VARCHAR);
    CREATE TABLE "main".ducklake_sort_info(sort_id BIGINT, table_id BIGINT, begin_snapshot BIGINT, end_snapshot BIGINT);
    CREATE TABLE "main".ducklake_sort_expression(sort_id BIGINT, table_id BIGINT, sort_key_index BIGINT, expression VARCHAR, dialect VARCHAR, sort_direction VARCHAR, null_order VARCHAR);
    INSERT INTO "main".ducklake_snapshot VALUES (0, NOW(), 0, 1, 0);
    INSERT INTO "main".ducklake_snapshot_changes VALUES (0, 'created_schema:"main"', NULL, NULL, NULL);
    INSERT INTO "main".ducklake_metadata (key, value) VALUES ('version', '1.0'), ('created_by', 'DuckDB test'), ('data_path', ${sqlStringLiteral(dataPath)}), ('encrypted', 'false');
    INSERT INTO "main".ducklake_schema VALUES (0, UUID(), 0, NULL, 'main', 'main/', true);
  `);
}

function plannedDataPathForClient(client: QuackClient): string {
  const dataPath = clientDataPaths.get(client);
  if (!dataPath) {
    throw new Error("Test client has no planned dataPath");
  }
  return dataPath;
}

function duckLakeTableInfoQuery(snapshotId: number): string {
  return `
    SELECT schema_id, tbl.table_id, table_uuid::VARCHAR, table_name,
      (
        SELECT LIST({'key': key, 'value': value})
        FROM "main".ducklake_tag tag
        WHERE object_id=table_id AND
              ${snapshotId} >= tag.begin_snapshot AND (${snapshotId} < tag.end_snapshot OR tag.end_snapshot IS NULL)
      ) AS tag,
      (
        SELECT LIST({'name': table_name, 'schema_version': schema_version})
        FROM "main".ducklake_inlined_data_tables inlined_data_tables
        WHERE inlined_data_tables.table_id = tbl.table_id
      ) AS inlined_data_tables,
      path, path_is_relative,
      col.column_id, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column,
      (
        SELECT LIST({'key': key, 'value': value})
        FROM "main".ducklake_column_tag col_tag
        WHERE col_tag.table_id=tbl.table_id AND col_tag.column_id=col.column_id AND
              ${snapshotId} >= col_tag.begin_snapshot AND (${snapshotId} < col_tag.end_snapshot OR col_tag.end_snapshot IS NULL)
      ) AS column_tags, default_value_type
    FROM "main".ducklake_table tbl
    LEFT JOIN "main".ducklake_column col USING (table_id)
    WHERE ${snapshotId} >= tbl.begin_snapshot AND (${snapshotId} < tbl.end_snapshot OR tbl.end_snapshot IS NULL)
      AND ((${snapshotId} >= col.begin_snapshot AND (${snapshotId} < col.end_snapshot OR col.end_snapshot IS NULL)) OR column_id IS NULL)
    ORDER BY table_id, parent_column NULLS FIRST, column_order
  `;
}

function duckLakeViewInfoQuery(snapshotId: number): string {
  return `
    SELECT view_id, view_uuid, schema_id, view_name, dialect, sql, column_aliases,
      (
        SELECT LIST({'key': key, 'value': value})
        FROM "main".ducklake_tag tag
        WHERE object_id=view_id AND
              ${snapshotId} >= tag.begin_snapshot AND (${snapshotId} < tag.end_snapshot OR tag.end_snapshot IS NULL)
      ) AS tag
    FROM "main".ducklake_view view
    WHERE ${snapshotId} >= begin_snapshot AND (${snapshotId} < view.end_snapshot OR view.end_snapshot IS NULL)
  `;
}

function duckLakeMacroInfoQuery(snapshotId: number): string {
  return `
    SELECT schema_id, ducklake_macro.macro_id, macro_name, (
      SELECT LIST({'dialect': dialect, 'sql': sql, 'type': type, 'params': (
        SELECT LIST({'parameter_name': parameter_name, 'parameter_type': parameter_type, 'default_value': default_value, 'default_value_type': default_value_type})
        FROM "main".ducklake_macro_parameters
        WHERE ducklake_macro_impl.macro_id = ducklake_macro_parameters.macro_id
          AND ducklake_macro_impl.impl_id = ducklake_macro_parameters.impl_id
      )})
      FROM "main".ducklake_macro_impl
      WHERE ducklake_macro.macro_id = ducklake_macro_impl.macro_id
    ) AS impl
    FROM "main".ducklake_macro
    WHERE ${snapshotId} >= ducklake_macro.begin_snapshot AND (${snapshotId} < ducklake_macro.end_snapshot OR ducklake_macro.end_snapshot IS NULL)
  `;
}

function duckLakePartitionInfoQuery(snapshotId: number): string {
  return `
    SELECT partition_id, part.table_id, partition_key_index, column_id, transform
    FROM "main".ducklake_partition_info part
    JOIN "main".ducklake_partition_column part_col USING (partition_id)
    WHERE ${snapshotId} >= part.begin_snapshot AND (${snapshotId} < part.end_snapshot OR part.end_snapshot IS NULL)
    ORDER BY part.table_id, partition_id, partition_key_index
  `;
}

function duckLakeSortInfoQuery(snapshotId: number): string {
  return `
    SELECT sort.sort_id, sort.table_id, sort_expr.sort_key_index, sort_expr.expression, sort_expr.dialect, sort_expr.sort_direction, sort_expr.null_order
    FROM "main".ducklake_sort_info sort
    JOIN "main".ducklake_sort_expression sort_expr USING (sort_id)
    WHERE ${snapshotId} >= sort.begin_snapshot AND (${snapshotId} < sort.end_snapshot OR sort.end_snapshot IS NULL)
    ORDER BY sort.table_id, sort.sort_id, sort_expr.sort_key_index
  `;
}

function duckLakeGlobalStatsQuery(): string {
  return `
    SELECT table_id, column_id, record_count, next_row_id, file_size_bytes, contains_null, contains_nan, min_value, max_value, extra_stats
    FROM "main".ducklake_table_stats
    LEFT JOIN "main".ducklake_table_column_stats USING (table_id)
    WHERE record_count IS NOT NULL AND file_size_bytes IS NOT NULL
    ORDER BY table_id
  `;
}

function duckLakeBeginSnapshotForTableQuery(tableId: number): string {
  return `
    SELECT begin_snapshot
    FROM "main".ducklake_table
    WHERE table_id = ${tableId}
  `;
}

function duckLakeSnapshotAtVersionQuery(snapshotId: number): string {
  return `
    SELECT snapshot_id, schema_version, next_catalog_id, next_file_id
    FROM "main".ducklake_snapshot
    WHERE snapshot_id = ${snapshotId}
  `;
}

function duckLakeSnapshotAtTimestampQuery(comparator: "<" | ">", order: "ASC" | "DESC", timestamp: string): string {
  return `
    SELECT snapshot_id, schema_version, next_catalog_id, next_file_id
    FROM "main".ducklake_snapshot
    WHERE snapshot_id = (
      SELECT snapshot_id
      FROM "main".ducklake_snapshot
      WHERE snapshot_time::TIMESTAMPTZ ${comparator}= '${timestamp}'
      ORDER BY snapshot_time::TIMESTAMPTZ ${order}
      LIMIT 1
    )
  `;
}

function duckLakeBeginSnapshotForSchemaVersionQuery(tableId: number, schemaVersion: number): string {
  return `
    SELECT begin_snapshot
    FROM "main".ducklake_schema_versions
    WHERE table_id = ${tableId} AND schema_version = ${schemaVersion}
  `;
}

function duckLakeNextColumnIdQuery(tableId: number): string {
  return `
    SELECT MAX(column_id)
    FROM "main".ducklake_column
    WHERE table_id = ${tableId}
  `;
}

function duckLakeNetDataFileRowCountQuery(tableId: number, snapshotId: number): string {
  return `
    SELECT
      COALESCE((SELECT SUM(record_count) FROM "main".ducklake_data_file
                WHERE table_id = ${tableId}
                  AND ${snapshotId} >= begin_snapshot
                  AND (${snapshotId} < end_snapshot OR end_snapshot IS NULL)), 0)
      -
      COALESCE((SELECT SUM(del.delete_count) FROM "main".ducklake_delete_file del
                JOIN "main".ducklake_data_file data ON del.data_file_id = data.data_file_id
                WHERE del.table_id = ${tableId}
                  AND ${snapshotId} >= del.begin_snapshot
                  AND (${snapshotId} < del.end_snapshot OR del.end_snapshot IS NULL)
                  AND ${snapshotId} >= data.begin_snapshot
                  AND (${snapshotId} < data.end_snapshot OR data.end_snapshot IS NULL)), 0)
      -
      0
  `;
}

function duckLakeNetDataFileRowCountWithInlinedDeletionsQuery(tableId: number, snapshotId: number, inlinedTableName: string): string {
  return `
    SELECT
      COALESCE((SELECT SUM(record_count) FROM "main".ducklake_data_file
                WHERE table_id = ${tableId}
                  AND ${snapshotId} >= begin_snapshot
                  AND (${snapshotId} < end_snapshot OR end_snapshot IS NULL)), 0)
      -
      COALESCE((SELECT SUM(del.delete_count) FROM "main".ducklake_delete_file del
                JOIN "main".ducklake_data_file data ON del.data_file_id = data.data_file_id
                WHERE del.table_id = ${tableId}
                  AND ${snapshotId} >= del.begin_snapshot
                  AND (${snapshotId} < del.end_snapshot OR del.end_snapshot IS NULL)
                  AND ${snapshotId} >= data.begin_snapshot
                  AND (${snapshotId} < data.end_snapshot OR data.end_snapshot IS NULL)), 0)
      -
      COALESCE((SELECT COUNT(*) FROM "main".${inlinedTableName} del
                JOIN "main".ducklake_data_file data ON del.file_id = data.data_file_id
                WHERE del.begin_snapshot <= ${snapshotId}
                  AND data.table_id = ${tableId}
                  AND ${snapshotId} >= data.begin_snapshot
                  AND (${snapshotId} < data.end_snapshot OR data.end_snapshot IS NULL)), 0)
  `;
}

function duckLakeNetInlinedRowCountQuery(inlinedTableName: string, snapshotId: number): string {
  return `
    SELECT COUNT(*)
    FROM "main".${inlinedTableName}
    WHERE ${snapshotId} >= begin_snapshot
      AND (${snapshotId} < end_snapshot OR end_snapshot IS NULL)
  `;
}

function duckLakeLatestInlinedDataTableNameQuery(tableId: number): string {
  return `
    SELECT table_name
    FROM "main".ducklake_inlined_data_tables
    WHERE table_id = ${tableId} AND schema_version=(
      SELECT MAX(schema_version)
      FROM "main".ducklake_inlined_data_tables
      WHERE table_id=${tableId}
    )
  `;
}

function duckLakeFilesForTableQuery(tableId: number, snapshotId: number): string {
  return `
    SELECT data.data_file_id,
      data.path AS data_path,
      data.path_is_relative AS data_path_is_relative,
      data.file_size_bytes AS data_file_size_bytes,
      data.footer_size AS data_footer_size,
      data.row_id_start,
      data.begin_snapshot,
      data.partial_max,
      data.mapping_id,
      del.path AS del_path,
      del.path_is_relative AS del_path_is_relative,
      del.file_size_bytes AS del_file_size_bytes,
      del.footer_size AS del_footer_size,
      del.format AS del_format
    FROM "main".ducklake_data_file data
    LEFT JOIN (
      SELECT *
      FROM "main".ducklake_delete_file
      WHERE table_id=${tableId} AND ${snapshotId} >= begin_snapshot
            AND (${snapshotId} < end_snapshot OR end_snapshot IS NULL)
      ) del ON del.data_file_id = data.data_file_id
    WHERE data.table_id=${tableId} AND ${snapshotId} >= data.begin_snapshot AND (${snapshotId} < data.end_snapshot OR data.end_snapshot IS NULL)
  `;
}

function duckLakeExtendedFilesForTableQuery(tableId: number, snapshotId: number): string {
  return `
    SELECT data.data_file_id,
      del.delete_file_id,
      data.record_count,
      data.path AS data_path,
      data.path_is_relative AS data_path_is_relative,
      data.file_size_bytes AS data_file_size_bytes,
      data.footer_size AS data_footer_size,
      data.row_id_start,
      data.mapping_id,
      del.path AS del_path,
      del.path_is_relative AS del_path_is_relative,
      del.file_size_bytes AS del_file_size_bytes,
      del.footer_size AS del_footer_size,
      del.format AS del_format,
      del.begin_snapshot
    FROM "main".ducklake_data_file data
    LEFT JOIN (
      SELECT *
      FROM "main".ducklake_delete_file
      WHERE table_id=${tableId} AND ${snapshotId} >= begin_snapshot
            AND (${snapshotId} < end_snapshot OR end_snapshot IS NULL)
      ) del USING (data_file_id)
    WHERE data.table_id=${tableId} AND ${snapshotId} >= data.begin_snapshot AND (${snapshotId} < data.end_snapshot OR data.end_snapshot IS NULL)
  `;
}

function duckLakeSnapshotAndStatsChangesQuery(snapshotId: number): string {
  return `
    SELECT
      snapshot_id,
      schema_version,
      next_catalog_id,
      next_file_id,
      COALESCE((
              SELECT STRING_AGG(changes_made, ',')
              FROM "main".ducklake_snapshot_changes c
              WHERE c.snapshot_id > ${snapshotId}
              ),'') AS changes,
      NULL AS table_id,
      NULL AS column_id,
      NULL AS record_count,
      NULL AS next_row_id,
      NULL AS file_size_bytes,
      NULL AS contains_null,
      NULL AS contains_nan,
      NULL AS min_value,
      NULL AS max_value,
      NULL AS extra_stats
      FROM "main".ducklake_snapshot
      WHERE snapshot_id = (
          SELECT MAX(snapshot_id)
          FROM "main".ducklake_snapshot)
    UNION ALL
    SELECT
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      table_id,
      column_id,
      record_count,
      next_row_id,
      file_size_bytes,
      contains_null,
      contains_nan,
      min_value,
      max_value,
      extra_stats
    FROM "main".ducklake_table_stats
    LEFT JOIN "main".ducklake_table_column_stats
      USING (table_id)
    WHERE record_count IS NOT NULL
      AND file_size_bytes IS NOT NULL
    ORDER BY table_id NULLS FIRST
  `;
}

function duckLakeFilesDeletedOrDroppedAfterSnapshotQuery(snapshotId: number): string {
  return `
    SELECT data_file_id
    FROM "main".ducklake_delete_file
    WHERE begin_snapshot > ${snapshotId}
    UNION ALL
    SELECT data_file_id
    FROM "main".ducklake_data_file
    WHERE end_snapshot IS NOT NULL AND end_snapshot > ${snapshotId}
  `;
}

function duckLakeTableInsertionsQuery(tableId: number, startSnapshotId: number, endSnapshotId: number): string {
  return `
    SELECT
      data.path AS data_path,
      data.path_is_relative AS data_path_is_relative,
      data.file_size_bytes AS data_file_size_bytes,
      data.footer_size AS data_footer_size,
      data.row_id_start,
      data.begin_snapshot,
      data.partial_max,
      data.mapping_id,
      del.path AS del_path,
      del.path_is_relative AS del_path_is_relative,
      del.file_size_bytes AS del_file_size_bytes,
      del.footer_size AS del_footer_size,
      del.format AS del_format
    FROM "main".ducklake_data_file data, (
      SELECT
        CAST(NULL AS VARCHAR) path,
        CAST(NULL AS BOOLEAN) path_is_relative,
        CAST(NULL AS BIGINT) file_size_bytes,
        CAST(NULL AS BIGINT) footer_size,
        CAST(NULL AS VARCHAR) format
    ) del
    WHERE data.table_id=${tableId} AND data.begin_snapshot <= ${endSnapshotId} AND (
      (data.begin_snapshot >= ${startSnapshotId}) OR
      (data.partial_max IS NOT NULL AND data.partial_max >= ${startSnapshotId})
    )
  `;
}

function duckLakeTableDeletionsQuery(tableId: number, startSnapshotId: number, endSnapshotId: number): string {
  const dataFileSelect = `
    data.data_file_id,
    data.path AS data_path,
    data.path_is_relative AS data_path_is_relative,
    data.file_size_bytes AS data_file_size_bytes,
    data.footer_size AS data_footer_size,
    data.row_id_start,
    data.record_count,
    data.mapping_id
  `;
  const deleteSelect = (prefix: string) => `
    ${prefix}.path AS ${prefix}_path,
    ${prefix}.path_is_relative AS ${prefix}_path_is_relative,
    ${prefix}.file_size_bytes AS ${prefix}_file_size_bytes,
    ${prefix}.footer_size AS ${prefix}_footer_size,
    ${prefix}.format AS ${prefix}_format
  `;
  return `
    WITH main_results AS (
      SELECT ${dataFileSelect}, ${deleteSelect("current_delete")}, ${deleteSelect("previous_delete")}, current_delete.begin_snapshot
      FROM (
        SELECT data_file_id, begin_snapshot, path, path_is_relative, file_size_bytes, footer_size, format
        FROM "main".ducklake_delete_file
        WHERE table_id = ${tableId} AND begin_snapshot <= ${endSnapshotId}
      ) AS current_delete
      LEFT JOIN LATERAL (
        SELECT DISTINCT ON (data_file_id)
          data_file_id,
          path,
          path_is_relative,
          file_size_bytes,
          footer_size,
          format
        FROM "main".ducklake_delete_file
        WHERE table_id = ${tableId} AND begin_snapshot < ${startSnapshotId}
        ORDER BY data_file_id, begin_snapshot DESC
      ) AS previous_delete
      USING (data_file_id)
      JOIN (
        SELECT *
        FROM "main".ducklake_data_file data
        WHERE table_id = ${tableId}
      ) AS data
      USING (data_file_id)

      UNION ALL

      SELECT ${dataFileSelect}, ${deleteSelect("current_delete")}, ${deleteSelect("previous_delete")}, data.end_snapshot
      FROM (
        SELECT *
        FROM "main".ducklake_data_file
        WHERE table_id = ${tableId} AND end_snapshot >= ${startSnapshotId} AND end_snapshot <= ${endSnapshotId}
      ) AS data
      LEFT JOIN LATERAL (
        SELECT DISTINCT ON (data_file_id)
          data_file_id,
          path,
          path_is_relative,
          file_size_bytes,
          footer_size,
          format
        FROM "main".ducklake_delete_file
        WHERE table_id = ${tableId} AND begin_snapshot < data.end_snapshot
        ORDER BY data_file_id, begin_snapshot DESC
      ) AS previous_delete
      USING (data_file_id), (
        SELECT NULL path, NULL path_is_relative, NULL file_size_bytes, NULL footer_size, NULL format
      ) current_delete
    )
    SELECT main_results.*, NULL as deletions
    FROM main_results
  `;
}

function duckLakeTableSizesQuery(snapshotId: number): string {
  return `
    SELECT
      schema_id, table_id, table_name, table_uuid,
      data_file_info.file_count AS data_file_count,
      data_file_info.total_file_size AS data_total_size,
      delete_file_info.file_count AS delete_file_count,
      delete_file_info.total_file_size AS delete_total_size
    FROM "main".ducklake_table tbl, LATERAL (
      SELECT COUNT(*) file_count, SUM(file_size_bytes) total_file_size
      FROM "main".ducklake_data_file df
      WHERE df.table_id = tbl.table_id AND ${snapshotId} >= begin_snapshot AND (${snapshotId} < end_snapshot OR end_snapshot IS NULL)
    ) data_file_info, LATERAL (
      SELECT COUNT(*) file_count, SUM(file_size_bytes) total_file_size
      FROM "main".ducklake_delete_file df
      WHERE df.table_id = tbl.table_id AND ${snapshotId} >= begin_snapshot AND (${snapshotId} < end_snapshot OR end_snapshot IS NULL)
    ) delete_file_info
    WHERE ${snapshotId} >= begin_snapshot AND (${snapshotId} < end_snapshot OR end_snapshot IS NULL)
  `;
}

function duckLakeFilesForCompactionQuery(tableId: number): string {
  return `
    WITH snapshot_ranges AS (
      SELECT
        begin_snapshot,
        COALESCE(
          LEAD(begin_snapshot) OVER (ORDER BY begin_snapshot),
          9223372036854775807
        ) AS end_snapshot,
        schema_version
      FROM "main".ducklake_schema_versions
      WHERE table_id=${tableId}
      ORDER BY begin_snapshot
    )
    SELECT data.data_file_id, data.record_count, data.row_id_start, data.begin_snapshot,
      data.end_snapshot, data.mapping_id, sr.schema_version, data.partial_max,
      data.partition_id, partition_info.keys,
      data.path AS data_path,
      data.path_is_relative AS data_path_is_relative,
      data.file_size_bytes AS data_file_size_bytes,
      data.footer_size AS data_footer_size,
      del.data_file_id AS del_data_file_id,
      del.delete_file_id AS del_delete_file_id,
      del.delete_count,
      del.begin_snapshot AS del_begin_snapshot,
      del.end_snapshot AS del_end_snapshot,
      del.partial_max AS del_partial_max,
      del.path AS del_path,
      del.path_is_relative AS del_path_is_relative,
      del.file_size_bytes AS del_file_size_bytes,
      del.footer_size AS del_footer_size,
      del.format AS del_format
    FROM "main".ducklake_data_file data
    LEFT JOIN snapshot_ranges sr
      ON data.begin_snapshot >= sr.begin_snapshot AND data.begin_snapshot < sr.end_snapshot
    LEFT JOIN (
      SELECT *
      FROM "main".ducklake_delete_file
      WHERE table_id=${tableId}
    ) del USING (data_file_id)
    LEFT JOIN (
      SELECT data_file_id, ARRAY_AGG(partition_value ORDER BY partition_key_index) keys
      FROM "main".ducklake_file_partition_value
      GROUP BY data_file_id
    ) partition_info USING (data_file_id)
    WHERE data.table_id=${tableId}
    ORDER BY data.begin_snapshot, data.row_id_start, data.data_file_id, del.begin_snapshot
  `;
}

function duckLakeEmptySupersededInlinedTablesQuery(): string {
  return `
    SELECT idt.table_id, idt.schema_version, idt.table_name
    FROM "main".ducklake_inlined_data_tables idt
    JOIN duckdb_tables() dt
      ON dt.database_name = 'main'
      AND dt.table_name = idt.table_name
    WHERE idt.schema_version < (
      SELECT MAX(idt2.schema_version)
      FROM "main".ducklake_inlined_data_tables idt2
      WHERE idt2.table_id = idt.table_id
    )
    AND dt.estimated_size = 0
  `;
}

function duckLakeReadInlinedFileDeletionsQuery(tableId: number, snapshotId: number): string {
  return `
    SELECT file_id, row_id
    FROM "main".ducklake_inlined_delete_${tableId}
    WHERE begin_snapshot <= ${snapshotId}
  `;
}

function duckLakeInlinedDeletionFileIdsQuery(tableId: number, fileIds: number[], snapshotId: number): string {
  return `
    SELECT DISTINCT file_id
    FROM "main".ducklake_inlined_delete_${tableId}
    WHERE file_id IN (${fileIds.join(", ")}) AND begin_snapshot <= ${snapshotId}
  `;
}

function duckLakeReadInlinedFileDeletionsForRangeQuery(tableId: number, startSnapshotId: number, endSnapshotId: number): string {
  return `
    SELECT file_id, row_id, begin_snapshot
    FROM "main".ducklake_inlined_delete_${tableId}
    WHERE begin_snapshot >= ${startSnapshotId} AND begin_snapshot <= ${endSnapshotId}
  `;
}

function duckLakeFlushInlinedFileDeletionsQuery(tableId: number, snapshotId: number): string {
  return `
    SELECT del.file_id, data.path, data.path_is_relative, del.row_id, del.begin_snapshot,
      existing_del.delete_file_id,
      existing_del.path as del_path,
      existing_del.path_is_relative as del_path_is_relative,
      existing_del.begin_snapshot as del_begin_snapshot,
      existing_del.encryption_key as del_encryption_key,
      existing_del.format as del_format
    FROM "main".ducklake_inlined_delete_${tableId} del
    JOIN "main".ducklake_data_file data ON del.file_id = data.data_file_id
    LEFT JOIN (
      SELECT * FROM "main".ducklake_delete_file
      WHERE table_id = ${tableId} AND ${snapshotId} >= begin_snapshot
            AND (${snapshotId} < end_snapshot OR end_snapshot IS NULL)
    ) existing_del ON del.file_id = existing_del.data_file_id
  `;
}

function duckLakeAllSnapshotsQuery(): string {
  return `
    SELECT snapshot_id, snapshot_time, schema_version, changes_made, author, commit_message, commit_extra_info
    FROM "main".ducklake_snapshot
    LEFT JOIN "main".ducklake_snapshot_changes USING (snapshot_id)
    ORDER BY snapshot_id
  `;
}

function duckLakeOldFilesForCleanupQuery(): string {
  return `
    SELECT data_file_id, path, path_is_relative, schedule_start
    FROM "main".ducklake_files_scheduled_for_deletion
  `;
}

function duckLakeExpiredTablesForSnapshotCleanupQuery(): string {
  return `
    SELECT table_id
    FROM "main".ducklake_table t
    WHERE end_snapshot IS NOT NULL AND NOT EXISTS (
      SELECT snapshot_id
      FROM "main".ducklake_snapshot
      WHERE snapshot_id >= begin_snapshot AND snapshot_id < end_snapshot
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "main".ducklake_table t2
      WHERE t2.table_id = t.table_id
        AND (t2.end_snapshot IS NULL OR EXISTS (
          SELECT snapshot_id
          FROM "main".ducklake_snapshot
          WHERE snapshot_id >= begin_snapshot AND snapshot_id < t2.end_snapshot
        ))
    )
  `;
}

function duckLakeExpiredDataFilesForSnapshotCleanupQuery(): string {
  return `
    SELECT data_file_id, table_id, path, path_is_relative
    FROM "main".ducklake_data_file
    WHERE (end_snapshot IS NOT NULL AND NOT EXISTS(
      SELECT snapshot_id
      FROM "main".ducklake_snapshot
      WHERE snapshot_id >= begin_snapshot AND snapshot_id < end_snapshot
    ))
  `;
}

function duckLakeExpiredDeleteFilesForSnapshotCleanupQuery(): string {
  return `
    SELECT delete_file_id, table_id, path, path_is_relative
    FROM "main".ducklake_delete_file
    WHERE (end_snapshot IS NOT NULL AND NOT EXISTS(
      SELECT snapshot_id
      FROM "main".ducklake_snapshot
      WHERE snapshot_id >= begin_snapshot AND snapshot_id < end_snapshot
    ))
  `;
}

function duckLakeOrphanFilesForCleanupQuery(dataPath = "/lake/"): string {
  const dataPathLiteral = sqlStringLiteral(dataPath);
  return `
    SELECT filename
    FROM read_blob(${dataPathLiteral} || '**')
    WHERE suffix(filename, '.parquet')
    AND filename NOT IN (
      SELECT REPLACE(
        CASE
          WHEN NOT file_relative THEN file_path
          ELSE CASE
            WHEN NOT table_relative THEN table_path || file_path
            ELSE CASE
              WHEN NOT schema_relative THEN schema_path || table_path || file_path
              ELSE ${dataPathLiteral} || schema_path || table_path || file_path
            END
          END
        END,
        '/',
        '/'
      ) AS full_path
      FROM (
        SELECT s.path AS schema_path,
               t.path AS table_path,
               file_path,
               s.path_is_relative AS schema_relative,
               t.path_is_relative AS table_relative,
               file_relative
        FROM (
          SELECT f.path AS file_path, f.path_is_relative AS file_relative, table_id
          FROM "main".ducklake_data_file f
          UNION ALL
          SELECT d.path AS file_path, d.path_is_relative AS file_relative, table_id
          FROM "main".ducklake_delete_file d
        ) files
        JOIN "main".ducklake_table t USING (table_id)
        JOIN "main".ducklake_schema s USING (schema_id)
      )
    )
  `;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function duckLakePathForSchemaQuery(schemaId: number): string {
  return `
    SELECT path, path_is_relative
    FROM "main".ducklake_schema
    WHERE schema_id = ${schemaId}
  `;
}

function arrayBufferFromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function boundTestR2Bucket(): R2Bucket {
  const bucket = (env as unknown as { DUCKLAKE_R2?: R2Bucket }).DUCKLAKE_R2;
  if (!bucket) {
    throw new Error("DUCKLAKE_R2 test binding is not configured");
  }
  return bucket;
}

function fakeR2Bucket(files: Record<string, ArrayBuffer>): R2Bucket {
  const uploaded = new Date("2026-05-15T00:00:00.000Z");
  return {
    async head(key: string) {
      const file = files[key];
      return file
        ? {
            key,
            version: "test",
            size: file.byteLength,
            etag: "test",
            httpEtag: "\"test\"",
            uploaded,
            checksums: {}
          }
        : null;
    },
    async get(key: string, options?: R2GetOptions) {
      const file = files[key];
      if (!file) {
        return null;
      }
      const range = options?.range;
      const offset = typeof range === "object" && "offset" in range && typeof range.offset === "number" ? range.offset : 0;
      const length = typeof range === "object" && "length" in range && typeof range.length === "number"
        ? range.length
        : file.byteLength - offset;
      return {
        key,
        version: "test",
        size: file.byteLength,
        etag: "test",
        httpEtag: "\"test\"",
        uploaded,
        checksums: {},
        range,
        body: null,
        bodyUsed: false,
        writeHttpMetadata() {},
        httpMetadata: {},
        customMetadata: {},
        async arrayBuffer() {
          return file.slice(offset, offset + length);
        },
        async text() {
          return new TextDecoder().decode(file.slice(offset, offset + length));
        },
        async json() {
          return JSON.parse(await this.text()) as unknown;
        },
        blob() {
          return Promise.resolve(new Blob([file.slice(offset, offset + length)]));
        }
      };
    },
    async list(options?: R2ListOptions) {
      const prefix = options?.prefix ?? "";
      return {
        objects: Object.entries(files)
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, file]) => ({
            key,
            version: "test",
            size: file.byteLength,
            etag: "test",
            httpEtag: "\"test\"",
            uploaded,
            checksums: {}
          })),
        truncated: false,
        delimitedPrefixes: []
      };
    }
  } as unknown as R2Bucket;
}

function duckLakePathForTableQuery(tableId: number): string {
  return `
    SELECT
      s.path AS s_path,
      s.path_is_relative AS s_path_is_relative,
      t.path AS t_path,
      t.path_is_relative AS t_path_is_relative
    FROM "main".ducklake_schema s
    JOIN "main".ducklake_table t
    USING (schema_id)
    WHERE table_id = ${tableId}
  `;
}

function duckLakeColumnCreatedWithTableQuery(tableName: string, columnName: string): string {
  return `
    SELECT TRUE
    FROM "main".ducklake_table t
    INNER JOIN "main".ducklake_column c
      ON c.table_id = t.table_id
    WHERE c.column_name = '${columnName}' AND
      t.table_name = '${tableName}' AND c.begin_snapshot = t.begin_snapshot AND c.end_snapshot IS NULL
  `;
}

function duckLakeOptionExistsQuery(optionKey: string, scopeFilter: string): string {
  return `
    SELECT COUNT(*)
    FROM "main".ducklake_metadata
    WHERE key = '${optionKey}' AND ${scopeFilter}
  `;
}
