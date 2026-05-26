import { LogicalTypes } from "./quack-imports";
import type { LogicalType, QuackValue } from "./quack-imports";

export type SqlStorage = DurableObjectStorage["sql"];

export interface QueryResultData {
  names: string[];
  types: LogicalType[];
  rows: QuackValue[][];
}

export interface SqlExecutionOptions {
  rowsPerChunk: number;
}

export interface ColumnInfo {
  name: string;
  ordinal: number;
  type: LogicalType;
  sqliteType: string;
}

export interface ParsedColumnInfo extends ColumnInfo {
  constraints: string;
}

export interface SnapshotTable {
  name: string;
  createSql: string;
  rows: Record<string, SqlStorageValue>[];
}

export interface TransactionSnapshot {
  tables: SnapshotTable[];
  columns: Record<string, SqlStorageValue>[];
  versions: Record<string, SqlStorageValue>[];
  schemas: Record<string, SqlStorageValue>[];
}

export function successResult(): QueryResultData {
  return { names: ["Success"], types: [LogicalTypes.boolean()], rows: [[true]] };
}

export function emptyResult(names: string[], types: LogicalType[]): QueryResultData {
  return { names, types, rows: [] };
}
