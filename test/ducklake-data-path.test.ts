import { describe, expect, it } from "vitest";
import { duckLakeDataPathValuesFromMetadataWrite } from "../src/ducklake-data-path";

describe("DuckLake metadata DATA_PATH extraction", () => {
  it("handles reordered quoted columns, escaped strings, and multiple tuples", () => {
    expect(duckLakeDataPathValuesFromMetadataWrite(`
      INSERT INTO main.ducklake_metadata ("value", \`key\`, scope, scope_id) VALUES
        ('r2://lake/it''s/(first),path/', 'data_path', NULL, NULL),
        ('ignored', 'version', NULL, NULL),
        ('r2://lake/second/', 'data_path', NULL, NULL)
    `)).toEqual(["r2://lake/it's/(first),path/", "r2://lake/second/"]);
  });

  it("only extracts literal data paths, without treating nested expressions as tuple fields", () => {
    expect(duckLakeDataPathValuesFromMetadataWrite(`
      INSERT INTO ducklake_metadata (key, value, scope) VALUES
        ('data_path', NULL, NULL),
        ('data_path', concat('r2://lake/', 'computed/'), NULL),
        ('data_path', 'r2://lake/literal/', [1, 2]),
        ('version', '1', NULL)
    `)).toEqual(["r2://lake/literal/"]);
    expect(duckLakeDataPathValuesFromMetadataWrite("INSERT INTO ducklake_metadata (key, scope) VALUES ('data_path', 'global')")).toEqual([]);
    expect(duckLakeDataPathValuesFromMetadataWrite("INSERT INTO ducklake_metadata (value) VALUES ('r2://lake/')")).toEqual([]);
  });

  it("extracts literal updates while ignoring unrelated keys and nonliteral values", () => {
    expect(duckLakeDataPathValuesFromMetadataWrite("UPDATE main.ducklake_metadata SET value = 'r2://lake/it''s/' WHERE key = 'data_path'"))
      .toEqual(["r2://lake/it's/"]);
    expect(duckLakeDataPathValuesFromMetadataWrite("UPDATE ducklake_metadata SET value = NULL WHERE key = 'data_path'")).toEqual([]);
    expect(duckLakeDataPathValuesFromMetadataWrite("UPDATE ducklake_metadata SET value = '1' WHERE key = 'version'")).toEqual([]);
    expect(duckLakeDataPathValuesFromMetadataWrite("SELECT * FROM ducklake_metadata")).toEqual([]);
  });
});
