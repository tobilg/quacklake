import {
  ExtraTypeInfoType,
  LogicalTypeId,
  LogicalTypes,
  dateFromISODate,
  dateValue,
  getArraySize,
  getChildType,
  getStructChildren,
  timestampFromJSDate,
  timestampValue
} from "./quack-imports";
import type { LogicalType, QuackValue } from "./quack-imports";

type SqlBindable = string | number | ArrayBuffer | null;

export function logicalTypeFromDuckDbType(typeName: string): LogicalType {
  const normalized = typeName.trim().replace(/\s+/g, " ").toUpperCase();
  const decimal = normalized.match(/^DECIMAL\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (decimal) {
    return LogicalTypes.decimal(Number(decimal[1]), Number(decimal[2]));
  }
  if (normalized.endsWith("[]")) {
    return LogicalTypes.list(logicalTypeFromDuckDbType(normalized.slice(0, -2)));
  }
  switch (normalized) {
    case "":
    case "ANY":
    case "UNKNOWN":
      return LogicalTypes.varchar();
    case "BOOL":
    case "BOOLEAN":
      return LogicalTypes.boolean();
    case "TINYINT":
      return LogicalTypes.tinyint();
    case "SMALLINT":
    case "INT2":
      return LogicalTypes.smallint();
    case "INTEGER":
    case "INT":
    case "INT4":
    case "SIGNED":
      return LogicalTypes.integer();
    case "BIGINT":
    case "INT8":
    case "LONG":
      return LogicalTypes.bigint();
    case "UTINYINT":
      return LogicalTypes.utinyint();
    case "USMALLINT":
      return LogicalTypes.usmallint();
    case "UINTEGER":
      return LogicalTypes.uinteger();
    case "UBIGINT":
      return LogicalTypes.ubigint();
    case "HUGEINT":
      return LogicalTypes.hugeint();
    case "UHUGEINT":
      return LogicalTypes.uhugeint();
    case "REAL":
    case "FLOAT":
    case "FLOAT4":
      return LogicalTypes.float();
    case "DOUBLE":
    case "DOUBLE PRECISION":
    case "FLOAT8":
      return LogicalTypes.double();
    case "VARCHAR":
    case "CHAR":
    case "TEXT":
    case "STRING":
      return LogicalTypes.varchar();
    case "BLOB":
    case "BYTEA":
      return LogicalTypes.blob();
    case "UUID":
      return LogicalTypes.uuid();
    case "DATE":
      return LogicalTypes.date();
    case "TIME":
      return LogicalTypes.time();
    case "TIME_NS":
      return LogicalTypes.timeNs();
    case "TIMESTAMP":
    case "DATETIME":
      return LogicalTypes.timestamp();
    case "TIMESTAMPTZ":
    case "TIMESTAMP WITH TIME ZONE":
    case "TIMESTAMP_TZ":
      return LogicalTypes.timestampTz();
    case "TIMESTAMP_S":
    case "TIMESTAMP_SEC":
      return LogicalTypes.timestampSeconds();
    case "TIMESTAMP_MS":
      return LogicalTypes.timestampMillis();
    case "TIMESTAMP_NS":
      return LogicalTypes.timestampNanos();
    case "INTERVAL":
      return LogicalTypes.interval();
    case "JSON":
    case "VARIANT":
      return LogicalTypes.varchar();
    default:
      if (normalized.startsWith("STRUCT") || normalized.startsWith("MAP") || normalized.startsWith("LIST")) {
        return LogicalTypes.varchar();
      }
      return LogicalTypes.varchar();
  }
}

export function sqliteTypeForLogicalType(type: LogicalType): string {
  switch (type.id) {
    case LogicalTypeId.BOOLEAN:
    case LogicalTypeId.TINYINT:
    case LogicalTypeId.SMALLINT:
    case LogicalTypeId.INTEGER:
    case LogicalTypeId.UTINYINT:
    case LogicalTypeId.USMALLINT:
    case LogicalTypeId.UINTEGER:
      return "INTEGER";
    case LogicalTypeId.BIGINT:
    case LogicalTypeId.UBIGINT:
    case LogicalTypeId.TIME:
    case LogicalTypeId.TIME_NS:
    case LogicalTypeId.TIME_TZ:
      return "INTEGER";
    case LogicalTypeId.FLOAT:
    case LogicalTypeId.DOUBLE:
      return "TEXT";
    case LogicalTypeId.BLOB:
    case LogicalTypeId.BIT:
    case LogicalTypeId.GEOMETRY:
      return "BLOB";
    default:
      return "TEXT";
  }
}

export function inferLogicalType(values: readonly unknown[]): LogicalType {
  const value = values.find((candidate) => candidate !== null && candidate !== undefined);
  if (value === undefined || value === null) {
    return LogicalTypes.varchar();
  }
  if (typeof value === "boolean") {
    return LogicalTypes.boolean();
  }
  if (typeof value === "bigint") {
    return LogicalTypes.bigint();
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
      ? LogicalTypes.integer()
      : LogicalTypes.double();
  }
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
    return LogicalTypes.blob();
  }
  return LogicalTypes.varchar();
}

export function quackValueFromSql(value: unknown, type: LogicalType): QuackValue {
  if (value === null || value === undefined) {
    return null;
  }
  switch (type.id) {
    case LogicalTypeId.BOOLEAN:
      return Boolean(value);
    case LogicalTypeId.TINYINT:
    case LogicalTypeId.SMALLINT:
    case LogicalTypeId.INTEGER:
    case LogicalTypeId.UTINYINT:
    case LogicalTypeId.USMALLINT:
    case LogicalTypeId.UINTEGER:
      return Number(value);
    case LogicalTypeId.BIGINT:
    case LogicalTypeId.UBIGINT:
    case LogicalTypeId.HUGEINT:
    case LogicalTypeId.UHUGEINT:
      return BigInt(String(value));
    case LogicalTypeId.FLOAT:
    case LogicalTypeId.DOUBLE:
      return Number(value);
    case LogicalTypeId.DATE:
      if (typeof value === "number") {
        return dateValue(value);
      }
      return dateFromISODate(String(value).slice(0, 10));
    case LogicalTypeId.TIME:
    case LogicalTypeId.TIME_NS:
    case LogicalTypeId.TIME_TZ:
      return BigInt(String(value));
    case LogicalTypeId.TIMESTAMP_SEC:
      return timestampValue(BigInt(String(value)), "seconds");
    case LogicalTypeId.TIMESTAMP_MS:
      return timestampValue(BigInt(String(value)), "millis");
    case LogicalTypeId.TIMESTAMP:
      return timestampFromJSDate(new Date(String(value)), "micros");
    case LogicalTypeId.TIMESTAMP_TZ:
      return timestampFromJSDate(new Date(String(value)), "micros", "utc");
    case LogicalTypeId.TIMESTAMP_NS:
      return timestampValue(BigInt(String(value)), "nanos");
    case LogicalTypeId.BLOB:
    case LogicalTypeId.BIT:
    case LogicalTypeId.GEOMETRY:
      return value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : value instanceof Uint8Array
          ? value
          : new TextEncoder().encode(String(value));
    case LogicalTypeId.STRUCT:
    case LogicalTypeId.LIST:
    case LogicalTypeId.MAP:
    case LogicalTypeId.ARRAY:
    case LogicalTypeId.VARIANT:
      return decodeStoredQuackValue(String(value), type);
    default:
      return String(value);
  }
}

export function sqlValueFromQuack(value: QuackValue, type: LogicalType): SqlBindable {
  if (value === null) {
    return null;
  }
  switch (type.id) {
    case LogicalTypeId.BOOLEAN:
      return value === true ? 1 : 0;
    case LogicalTypeId.TINYINT:
    case LogicalTypeId.SMALLINT:
    case LogicalTypeId.INTEGER:
    case LogicalTypeId.UTINYINT:
    case LogicalTypeId.USMALLINT:
    case LogicalTypeId.UINTEGER:
      return Number(value);
    case LogicalTypeId.FLOAT:
    case LogicalTypeId.DOUBLE:
      return String(Number(value));
    case LogicalTypeId.BIGINT:
    case LogicalTypeId.UBIGINT:
    case LogicalTypeId.HUGEINT:
    case LogicalTypeId.UHUGEINT: {
      const bigint = BigInt(String(value));
      if (bigint <= BigInt(Number.MAX_SAFE_INTEGER) && bigint >= BigInt(Number.MIN_SAFE_INTEGER)) {
        return Number(bigint);
      }
      return bigint.toString();
    }
    case LogicalTypeId.DATE:
      return isTagged(value, "date") ? dateToIso(value.days) : String(value);
    case LogicalTypeId.TIMESTAMP_SEC:
    case LogicalTypeId.TIMESTAMP_MS:
    case LogicalTypeId.TIMESTAMP:
    case LogicalTypeId.TIMESTAMP_NS:
    case LogicalTypeId.TIMESTAMP_TZ:
      return isTagged(value, "timestamp") ? timestampToIso(value) : String(value);
    case LogicalTypeId.TIME:
    case LogicalTypeId.TIME_NS:
    case LogicalTypeId.TIME_TZ:
      if (isTagged(value, "time")) {
        return value.value.toString();
      }
      if (isTagged(value, "time_tz")) {
        return value.bits.toString();
      }
      return String(value);
    case LogicalTypeId.BLOB:
    case LogicalTypeId.BIT:
    case LogicalTypeId.GEOMETRY:
      if (value instanceof Uint8Array) {
        return toArrayBuffer(value);
      }
      return toArrayBuffer(new TextEncoder().encode(String(value)));
    case LogicalTypeId.STRUCT:
    case LogicalTypeId.LIST:
    case LogicalTypeId.MAP:
    case LogicalTypeId.ARRAY:
    case LogicalTypeId.VARIANT:
      return encodeStoredQuackValue(value);
    default:
      return String(value);
  }
}

export function encodeStoredQuackValue(value: QuackValue): string {
  return JSON.stringify(toStoredJson(value));
}

export function decodeStoredQuackValue(value: string, type: LogicalType): QuackValue {
  try {
    return fromStoredJson(JSON.parse(value), type);
  } catch {
    return value;
  }
}

export function serializeLogicalType(type: LogicalType): string {
  return JSON.stringify(type);
}

export function deserializeLogicalType(value: string): LogicalType {
  return JSON.parse(value) as LogicalType;
}

function toStoredJson(value: QuackValue): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (typeof value === "bigint") {
    return { __dq: "bigint", value: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { __dq: "bytes", value: [...value] };
  }
  if (Array.isArray(value)) {
    return value.map((item) => toStoredJson(item));
  }
  if ("kind" in value) {
    const tagged = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(tagged).map(([key, nested]) => [key, typeof nested === "bigint" ? nested.toString() : nested])
    );
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, toStoredJson(nested)]));
}

function fromStoredJson(value: unknown, type: LogicalType): QuackValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "string" && isIntegerLikeType(type)) {
      return BigInt(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const childType =
      type.id === LogicalTypeId.LIST || type.id === LogicalTypeId.MAP || type.id === LogicalTypeId.ARRAY
        ? getChildType(type)
        : LogicalTypes.varchar();
    return value.map((item) => fromStoredJson(item, childType));
  }
  const record = value as Record<string, unknown>;
  if (record.__dq === "bigint") {
    return BigInt(String(record.value));
  }
  if (record.__dq === "bytes" && Array.isArray(record.value)) {
    return new Uint8Array(record.value.map(Number));
  }
  if (record.kind === "date") {
    return { kind: "date", days: Number(record.days ?? 0) };
  }
  if (record.kind === "timestamp") {
    return {
      kind: "timestamp",
      unit: String(record.unit ?? "micros") as "seconds" | "millis" | "micros" | "nanos",
      value: BigInt(String(record.value ?? 0)),
      ...(record.timezone === "utc" ? { timezone: "utc" as const } : {})
    };
  }
  if (record.kind === "decimal") {
    return {
      kind: "decimal",
      value: BigInt(String(record.value ?? 0)),
      width: Number(record.width ?? 18),
      scale: Number(record.scale ?? 0)
    };
  }
  if (record.kind === "interval") {
    return {
      kind: "interval",
      months: Number(record.months ?? 0),
      days: Number(record.days ?? 0),
      micros: BigInt(String(record.micros ?? 0))
    };
  }
  if (type.id === LogicalTypeId.STRUCT && type.typeInfo?.type === ExtraTypeInfoType.STRUCT) {
    const output: Record<string, QuackValue> = {};
    for (const child of getStructChildren(type)) {
      output[child.name] = fromStoredJson(record[child.name], child.type);
    }
    return output;
  }
  return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, fromStoredJson(nested, LogicalTypes.varchar())]));
}

function isIntegerLikeType(type: LogicalType): boolean {
  return (
    type.id === LogicalTypeId.BIGINT ||
    type.id === LogicalTypeId.UBIGINT ||
    type.id === LogicalTypeId.HUGEINT ||
    type.id === LogicalTypeId.UHUGEINT
  );
}

function dateToIso(days: number): string {
  return new Date(days * 86400000).toISOString().slice(0, 10);
}

function timestampToIso(value: Extract<QuackValue, { kind: "timestamp" }>): string {
  const raw =
    value.unit === "seconds"
      ? value.value * 1000n
      : value.unit === "millis"
        ? value.value
        : value.unit === "nanos"
          ? value.value / 1000000n
          : value.value / 1000n;
  return new Date(Number(raw)).toISOString();
}

function isTagged<K extends string>(value: QuackValue, kind: K): value is Extract<QuackValue, { kind: K }> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array) && "kind" in value && value.kind === kind;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
