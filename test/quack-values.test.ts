import { describe, expect, it } from "vitest";
import {
  LogicalTypeId,
  LogicalTypes,
  dateValue,
  timestampValue,
  type QuackValue
} from "@quack-protocol/sdk";
import {
  decodeStoredQuackValue,
  deserializeLogicalType,
  encodeStoredQuackValue,
  inferLogicalType,
  logicalTypeFromDuckDbType,
  quackValueFromSql,
  serializeLogicalType,
  sqliteTypeForLogicalType,
  sqlValueFromQuack
} from "../src/quack-values";

describe("Quack value conversion", () => {
  it("maps DuckDB type names to Quack logical types and SQLite storage types", () => {
    expect(logicalTypeFromDuckDbType("DECIMAL(10, 2)")).toMatchObject({
      id: LogicalTypeId.DECIMAL,
      typeInfo: { width: 10, scale: 2 }
    });
    expect(logicalTypeFromDuckDbType("integer[]")).toMatchObject({
      id: LogicalTypeId.LIST,
      typeInfo: { childType: { id: LogicalTypeId.INTEGER } }
    });
    expect(logicalTypeFromDuckDbType("timestamp with time zone").id).toBe(LogicalTypeId.TIMESTAMP_TZ);
    expect(logicalTypeFromDuckDbType("struct(a int)").id).toBe(LogicalTypeId.VARCHAR);
    expect(logicalTypeFromDuckDbType("unknown_type").id).toBe(LogicalTypeId.VARCHAR);

    expect(sqliteTypeForLogicalType(LogicalTypes.boolean())).toBe("INTEGER");
    expect(sqliteTypeForLogicalType(LogicalTypes.bigint())).toBe("INTEGER");
    expect(sqliteTypeForLogicalType(LogicalTypes.time())).toBe("INTEGER");
    expect(sqliteTypeForLogicalType(LogicalTypes.double())).toBe("TEXT");
    expect(sqliteTypeForLogicalType(LogicalTypes.blob())).toBe("BLOB");
    expect(sqliteTypeForLogicalType(LogicalTypes.geometry())).toBe("BLOB");
    expect(sqliteTypeForLogicalType(LogicalTypes.date())).toBe("TEXT");
  });

  it("infers logical types from representative JavaScript values", () => {
    expect(inferLogicalType([null, undefined]).id).toBe(LogicalTypeId.VARCHAR);
    expect(inferLogicalType([null, true]).id).toBe(LogicalTypeId.BOOLEAN);
    expect(inferLogicalType([1n]).id).toBe(LogicalTypeId.BIGINT);
    expect(inferLogicalType([123]).id).toBe(LogicalTypeId.INTEGER);
    expect(inferLogicalType([2 ** 40]).id).toBe(LogicalTypeId.DOUBLE);
    expect(inferLogicalType([new ArrayBuffer(2)]).id).toBe(LogicalTypeId.BLOB);
    expect(inferLogicalType([new Uint8Array([1, 2])]).id).toBe(LogicalTypeId.BLOB);
    expect(inferLogicalType(["text"]).id).toBe(LogicalTypeId.VARCHAR);
  });

  it("converts Quack values into SQLite-bindable values", () => {
    expect(sqlValueFromQuack(null, LogicalTypes.varchar())).toBeNull();
    expect(sqlValueFromQuack(true, LogicalTypes.boolean())).toBe(1);
    expect(sqlValueFromQuack(false, LogicalTypes.boolean())).toBe(0);
    expect(sqlValueFromQuack(7n, LogicalTypes.bigint())).toBe(7);
    expect(sqlValueFromQuack(9007199254740993n, LogicalTypes.bigint())).toBe("9007199254740993");
    expect(sqlValueFromQuack(Number.NaN, LogicalTypes.double())).toBe("NaN");
    expect(sqlValueFromQuack(dateValue(1), LogicalTypes.date())).toBe("1970-01-02");
    expect(sqlValueFromQuack(timestampValue(1n, "seconds"), LogicalTypes.timestampSeconds())).toBe("1970-01-01T00:00:01.000Z");
    expect(sqlValueFromQuack({ kind: "time", unit: "micros", value: 123n }, LogicalTypes.time())).toBe("123");
    expect(sqlValueFromQuack({ kind: "time_tz", bits: 456n }, LogicalTypes.timeTz())).toBe("456");
    expect(sqlValueFromQuack(789n, LogicalTypes.timeNs())).toBe("789");

    const blob = sqlValueFromQuack(new Uint8Array([1, 2, 3]), LogicalTypes.blob());
    expect(blob).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(blob as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(sqlValueFromQuack("abc", LogicalTypes.blob()) as ArrayBuffer)]).toEqual([97, 98, 99]);

    const nested = sqlValueFromQuack([1n, 2n], LogicalTypes.list(LogicalTypes.bigint()));
    expect(nested).toBe('[{"__dq":"bigint","value":"1"},{"__dq":"bigint","value":"2"}]');
  });

  it("converts SQLite values into Quack values", () => {
    expect(quackValueFromSql(null, LogicalTypes.varchar())).toBeNull();
    expect(quackValueFromSql(1, LogicalTypes.boolean())).toBe(true);
    expect(quackValueFromSql("8", LogicalTypes.integer())).toBe(8);
    expect(quackValueFromSql("42", LogicalTypes.bigint())).toBe(42n);
    expect(quackValueFromSql("3.5", LogicalTypes.double())).toBe(3.5);
    expect(quackValueFromSql(2, LogicalTypes.date())).toEqual(dateValue(2));
    expect(quackValueFromSql("2026-05-19T12:34:56Z", LogicalTypes.date())).toMatchObject({ kind: "date" });
    expect(quackValueFromSql("5", LogicalTypes.timestampSeconds())).toEqual(timestampValue(5n, "seconds"));
    expect(quackValueFromSql("6", LogicalTypes.timestampMillis())).toEqual(timestampValue(6n, "millis"));
    expect(quackValueFromSql("7", LogicalTypes.timestampNanos())).toEqual(timestampValue(7n, "nanos"));
    expect(quackValueFromSql("2026-05-19T12:34:56Z", LogicalTypes.timestamp())).toMatchObject({ kind: "timestamp", unit: "micros" });
    expect(quackValueFromSql("2026-05-19T12:34:56Z", LogicalTypes.timestampTz())).toMatchObject({ kind: "timestamp", timezone: "utc" });
    expect(quackValueFromSql("12", LogicalTypes.time())).toBe(12n);
    expect(quackValueFromSql(new Uint8Array([1, 2]), LogicalTypes.blob())).toEqual(new Uint8Array([1, 2]));
    expect(quackValueFromSql(new Uint8Array([3, 4]).buffer, LogicalTypes.blob())).toEqual(new Uint8Array([3, 4]));
    expect(quackValueFromSql("abc", LogicalTypes.blob())).toEqual(new TextEncoder().encode("abc"));
    expect(quackValueFromSql("550e8400-e29b-41d4-a716-446655440000", LogicalTypes.uuid())).toBe("550e8400-e29b-41d4-a716-446655440000");

    const listType = LogicalTypes.list(LogicalTypes.bigint());
    expect(quackValueFromSql(encodeStoredQuackValue([1n, 2n]), listType)).toEqual([1n, 2n]);

    const structType = LogicalTypes.struct([
      { name: "id", type: LogicalTypes.bigint() },
      { name: "label", type: LogicalTypes.varchar() }
    ]);
    expect(quackValueFromSql('{"id":"9","label":"nine","ignored":"x"}', structType)).toEqual({
      id: 9n,
      label: "nine"
    });
    expect(quackValueFromSql("not-json", structType)).toBe("not-json");
  });

  it("round-trips stored nested values and logical type metadata", () => {
    const value: QuackValue = {
      id: 123n,
      bytes: new Uint8Array([4, 5]),
      eventTime: timestampValue(10n, "millis", "utc"),
      rows: [{ count: 2n }]
    };
    const stored = encodeStoredQuackValue(value);
    const decoded = decodeStoredQuackValue(stored, LogicalTypes.varchar());
    expect(decoded).toEqual(value);
    expect(decodeStoredQuackValue('{"kind":"date","days":3}', LogicalTypes.date())).toEqual(dateValue(3));
    expect(decodeStoredQuackValue('{"kind":"decimal","value":"1234","width":10,"scale":2}', LogicalTypes.decimal(10, 2))).toEqual({
      kind: "decimal",
      value: 1234n,
      width: 10,
      scale: 2
    });
    expect(decodeStoredQuackValue('{"kind":"interval","months":1,"days":2,"micros":"3"}', LogicalTypes.interval())).toEqual({
      kind: "interval",
      months: 1,
      days: 2,
      micros: 3n
    });
    expect(decodeStoredQuackValue("[1,2]", LogicalTypes.varchar())).toEqual([1, 2]);

    const type = LogicalTypes.array(LogicalTypes.integer(), 3);
    expect(deserializeLogicalType(serializeLogicalType(type))).toEqual(type);
  });
});
