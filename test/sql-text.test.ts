import { describe, expect, it } from "vitest";
import { normalizeTableName, rewriteDuckDbSql } from "../src/sql-compat";
import { splitSqlStatements } from "../src/sql-text";

describe("SQL compatibility helpers", () => {
  it("splits statements without splitting quoted semicolons", () => {
    expect(splitSqlStatements("CREATE TABLE t(v VARCHAR); INSERT INTO t VALUES ('a;b'); SELECT * FROM t")).toEqual([
      "CREATE TABLE t(v VARCHAR)",
      "INSERT INTO t VALUES ('a;b')",
      "SELECT * FROM t"
    ]);
  });

  it("normalizes schema-qualified table names for SQLite storage", () => {
    expect(normalizeTableName("main.ducklake_metadata")).toBe("main__ducklake_metadata");
    expect(normalizeTableName('"metadata"."ducklake_snapshot"')).toBe("metadata__ducklake_snapshot");
  });

  it("rewrites common DuckDB syntax to SQLite-compatible SQL", () => {
    const rewritten = rewriteDuckDbSql("SELECT snapshot_time::TIMESTAMPTZ AS ts FROM metadata.ducklake_snapshot WHERE flag = TRUE");
    expect(rewritten).toContain('"metadata__ducklake_snapshot"');
    expect(rewritten).toContain("flag = 1");
    expect(rewritten).not.toContain("::TIMESTAMPTZ");
  });

  it("does not rewrite boolean words inside string literals", () => {
    const rewritten = rewriteDuckDbSql("INSERT INTO metadata.ducklake_metadata VALUES ('encrypted', 'false', NULL, NULL)");
    expect(rewritten).toBe('INSERT INTO "metadata__ducklake_metadata" VALUES (\'encrypted\', \'false\', NULL, NULL)');
  });

  it("rewrites quoted schema-qualified identifiers", () => {
    expect(rewriteDuckDbSql('INSERT INTO "main".ducklake_snapshot VALUES (0)')).toBe(
      'INSERT INTO "main__ducklake_snapshot" VALUES (0)'
    );
  });

  it("leaves alias-qualified columns alone when table lookup rejects them", () => {
    const rewritten = rewriteDuckDbSql('SELECT tbl.table_id FROM "main".ducklake_table tbl', {
      shouldRewriteQualifiedName: (name) => name === "main__ducklake_table"
    });
    expect(rewritten).toBe('SELECT tbl.table_id FROM "main__ducklake_table" tbl');
  });

  it("strips DuckDB ORDER BY ALL syntax", () => {
    expect(rewriteDuckDbSql("SELECT a, b FROM items ORDER BY ALL")).toBe("SELECT a, b FROM items");
  });

  it("rewrites DuckDB migration casts and CTE materialization hints", () => {
    expect(
      rewriteDuckDbSql(
        "SELECT TRY_CAST(regexp_extract(partial_file_info, 'partial_max:(\\d+)', 1) AS BIGINT) AS partial_max FROM ducklake_data_file"
      )
    ).toBe(
      "SELECT CAST(substr(partial_file_info, instr(partial_file_info, 'partial_max:') + length('partial_max:')) AS INTEGER) AS partial_max FROM ducklake_data_file"
    );
    expect(rewriteDuckDbSql("WITH col_1_stats AS NOT MATERIALIZED (SELECT min_value FROM stats) SELECT * FROM col_1_stats")).toBe(
      "WITH col_1_stats AS (SELECT min_value FROM stats) SELECT * FROM col_1_stats"
    );
    expect(
      rewriteDuckDbSql('DELETE FROM "main".ducklake_macro_impl tbl WHERE tbl.macro_id = 1', {
        shouldRewriteQualifiedName: (name) => name === "main__ducklake_macro_impl"
      })
    ).toBe(
      'DELETE FROM "main__ducklake_macro_impl" WHERE rowid IN (SELECT tbl.rowid FROM "main__ducklake_macro_impl" tbl WHERE tbl.macro_id = 1)'
    );
    expect(
      rewriteDuckDbSql('UPDATE "main".ducklake_tag SET end_snapshot = 2 FROM overwritten_tags WHERE ducklake_tag.key = overwritten_tags.key', {
        shouldRewriteQualifiedName: (name) => name === "main__ducklake_tag"
      })
    ).toBe(
      'UPDATE "main__ducklake_tag" SET end_snapshot = 2 FROM overwritten_tags WHERE "main__ducklake_tag".key = overwritten_tags.key'
    );
  });
});
