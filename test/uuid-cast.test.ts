import { describe, expect, it } from "vitest";
import { rewriteDuckDbSql } from "../src/sql-rewrite";

describe("UUID CAST rewriting", () => {
  it.each([
    ["SELECT CAST('00112233-4455-6677-8899-aabbccddeeff' AS UUID)", "SELECT CAST('00112233-4455-6677-8899-aabbccddeeff' AS TEXT)"],
    ["SELECT cast(NULL as uuid)", "SELECT cast(NULL as TEXT)"],
    ["SELECT CaSt\t( NULL\nAs\tUuId )", "SELECT CaSt\t( NULL\nAs\tTEXT )"],
    ["SELECT CAST(('aabbccdd-eeff-4011-8233-445566778899') AS /* type */ UUID)", "SELECT CAST(('aabbccdd-eeff-4011-8233-445566778899') AS /* type */ TEXT)"],
    ["SELECT CAST/* call */(/* value */NULL/* end */AS/* type */UUID/* close */)", "SELECT CAST/* call */(/* value */NULL/* end */AS/* type */TEXT/* close */)"],
    ["SELECT CAST(NULL AS -- type\nUUID)", "SELECT CAST(NULL AS -- type\nTEXT)"],
    ["SELECT CAST(COALESCE(CAST(NULL AS UUID), ('abc')) AS UUID), CAST(NULL AS UUID)", "SELECT CAST(COALESCE(CAST(NULL AS TEXT), ('abc')) AS TEXT), CAST(NULL AS TEXT)"],
    ["SELECT CAST((SELECT value AS UUID FROM items) AS UUID)", "SELECT CAST((SELECT value AS UUID FROM items) AS TEXT)"],
    ["SELECT 'CAST(x AS UUID)' AS UUID, CAST(NULL AS UUID)", "SELECT 'CAST(x AS UUID)' AS UUID, CAST(NULL AS TEXT)"],
    ["SELECT CAST('it''s (AS UUID)' AS UUID)", "SELECT CAST('it''s (AS UUID)' AS TEXT)"],
    ['SELECT "CAST(x AS UUID)", "escaped""CAST(x AS UUID)", CAST("UUID" AS UUID) AS "UUID"', 'SELECT "CAST(x AS UUID)", "escaped""CAST(x AS UUID)", CAST("UUID" AS TEXT) AS "UUID"'],
    ["SELECT `CAST(x AS UUID)`, CAST(`UUID` AS UUID)", "SELECT `CAST(x AS UUID)`, CAST(`UUID` AS TEXT)"],
    ["SELECT CAST(NULL AS UUID) /* CAST(x AS UUID) */ -- CAST(y AS UUID)", "SELECT CAST(NULL AS TEXT) /* CAST(x AS UUID) */ -- CAST(y AS UUID)"]
  ])("rewrites only UUID cast targets: %s", (sql, expected) => {
    expect(rewriteDuckDbSql(sql)).toBe(expected);
  });

  it.each([
    "SELECT UUID, value AS UUID FROM items",
    "CREATE TABLE items(id UUID)",
    'SELECT "CAST"(value AS UUID)',
    "SELECT other_cast(value AS UUID)",
    "SELECT CAST((SELECT value AS UUID FROM items) AS TEXT)",
    'SELECT CAST(value AS "UUID")',
    "SELECT CAST(value AS UUID[])",
    "SELECT CAST(value AS UUID_EXTRA)"
  ])("leaves other UUID uses unchanged: %s", (sql) => {
    expect(rewriteDuckDbSql(sql)).toBe(sql);
  });

  it("retains the existing limited TRY_CAST and postfix cast behavior", () => {
    expect(rewriteDuckDbSql("SELECT TRY_CAST(NULL AS UUID)")).toBe("SELECT CAST(NULL AS TEXT)");
    expect(rewriteDuckDbSql("SELECT TRY_CAST((NULL) AS UUID)")).toBe("SELECT TRY_CAST((NULL) AS UUID)");
    expect(rewriteDuckDbSql("SELECT '00112233-4455-6677-8899-aabbccddeeff'::UUID, NULL::UUID")).toBe(
      "SELECT '00112233-4455-6677-8899-aabbccddeeff', NULL"
    );
  });
});
