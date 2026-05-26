import { LogicalTypes } from "./quack-imports";
import type { LogicalType, QuackValue } from "./quack-imports";
import type { ListedFile } from "./file-listing";
import { quackValueFromSql } from "./quack-values";
import { quoteIdentifier } from "./sql-text";
import {
  firstNumberAfter,
  metadataSchemaName,
  normalizeSchemaName,
  normalizeTableName,
  snapshotIdFromPredicate
} from "./sql-names";
import type { QueryResultData, SqlStorage } from "./sql-types";
import { emptyResult, successResult } from "./sql-types";

export interface DuckLakeMetadataContext {
  sql: SqlStorage;
  tableExists(tableName: string): boolean;
  tableRowCount(tableName: string): number;
  bumpTableVersion(tableName: string): void;
  listFiles(pattern: string): Promise<ListedFile[]>;
}

interface DuckLakeTagValue {
  [key: string]: QuackValue;
  key: string;
  value: string;
}

interface DuckLakeMacroParameterValue {
  [key: string]: QuackValue;
  parameter_name: string;
  parameter_type: string;
  default_value: string | null;
  default_value_type: string | null;
}

interface DuckLakeMacroImplementationValue {
  [key: string]: QuackValue;
  dialect: string;
  sql: string;
  type: string;
  params: DuckLakeMacroParameterValue[] | null;
}

function duckLakeTagListType(): LogicalType {
  return LogicalTypes.list(
    LogicalTypes.struct([
      { name: "key", type: LogicalTypes.varchar() },
      { name: "value", type: LogicalTypes.varchar() }
    ])
  );
}

export class DuckLakeMetadataCompat {
  constructor(private readonly context: DuckLakeMetadataContext) {}

  emptySupersededInlinedTables(statement: string): QueryResultData {
    return this.duckLakeEmptySupersededInlinedTables(statement);
  }

  tryQuery(statement: string): Promise<QueryResultData | undefined> {
    return this.tryDuckLakeMetadataQuery(statement);
  }

  tryMutation(statement: string): QueryResultData | undefined {
    return this.tryDuckLakeMetadataMutation(statement);
  }

  private get sql(): SqlStorage {
    return this.context.sql;
  }

  private tableExists(tableName: string): boolean {
    return this.context.tableExists(tableName);
  }

  private tableRowCount(tableName: string): number {
    return this.context.tableRowCount(tableName);
  }

  private bumpTableVersion(tableName: string): void {
    this.context.bumpTableVersion(tableName);
  }

  private duckLakeEmptySupersededInlinedTables(statement: string): QueryResultData {
    const names = ["table_id", "schema_version", "table_name"];
    const types = [LogicalTypes.bigint(), LogicalTypes.bigint(), LogicalTypes.varchar()];
    const schemaName = metadataSchemaName(statement, "ducklake_inlined_data_tables") ?? "main";
    const inlinedTablesName = normalizeTableName(`${schemaName}.ducklake_inlined_data_tables`);
    if (!this.tableExists(inlinedTablesName)) {
      return emptyResult(names, types);
    }
    const rows = this.sql
      .exec<{ table_id: number; schema_version: number; table_name: string; max_schema_version: number }>(
        `SELECT idt.table_id, idt.schema_version, idt.table_name,
                (SELECT MAX(idt2.schema_version)
                 FROM ${quoteIdentifier(inlinedTablesName)} idt2
                 WHERE idt2.table_id = idt.table_id) AS max_schema_version
         FROM ${quoteIdentifier(inlinedTablesName)} idt
         ORDER BY idt.table_id, idt.schema_version`
      )
      .toArray()
      .filter((row) => row.schema_version < row.max_schema_version)
      .filter((row) => this.tableExists(normalizeTableName(`${schemaName}.${row.table_name}`)))
      .filter((row) => this.tableRowCount(normalizeTableName(`${schemaName}.${row.table_name}`)) === 0)
      .map((row) => [BigInt(row.table_id), BigInt(row.schema_version), row.table_name]);
    return { names, types, rows };
  }

  private async tryDuckLakeMetadataQuery(statement: string): Promise<QueryResultData | undefined> {
    if (!/^(?:SELECT|WITH)\b/i.test(statement.trim())) {
      return undefined;
    }
    if (/\bFROM\s+read_blob\s*\(/i.test(statement)) {
      return this.duckLakeReadBlob(statement);
    }
    const missingInlinedDelete = this.duckLakeMissingInlinedDeleteQuery(statement);
    if (missingInlinedDelete) {
      return missingInlinedDelete;
    }
    if (
      /\bFROM\s+(?:"[^"]+"|[A-Za-z_][\w$]*)\.ducklake_table\s+tbl\b/i.test(statement) &&
      /\bLEFT\s+JOIN\s+(?:"[^"]+"|[A-Za-z_][\w$]*)\.ducklake_column\s+col\s+USING\s*\(\s*table_id\s*\)/i.test(statement)
    ) {
      return this.duckLakeTableInfo(statement);
    }
    if (/\bWITH\s+main_results\s+AS\b/i.test(statement) && /\bprevious_delete\b/i.test(statement)) {
      return this.duckLakeTableDeletions(statement);
    }
    if (
      /\bFROM\s+(?:"[^"]+"|[A-Za-z_][\w$]*)\.ducklake_table\s+tbl\s*,\s*LATERAL\b/i.test(statement) &&
      /\bdata_file_info\b/i.test(statement) &&
      /\bdelete_file_info\b/i.test(statement)
    ) {
      return this.duckLakeTableSizes(statement);
    }
    if (/\bWITH\s+snapshot_ranges\s+AS\b/i.test(statement) && /\bpartition_info\.keys\b/i.test(statement)) {
      return this.duckLakeFilesForCompaction(statement);
    }
    if (
      /\bFROM\s+(?:"[^"]+"|[A-Za-z_][\w$]*)\.ducklake_view\s+view\b/i.test(statement) &&
      /\bAS\s+tag\b/i.test(statement)
    ) {
      return this.duckLakeViewInfo(statement);
    }
    if (
      /\bFROM\s+(?:"[^"]+"|[A-Za-z_][\w$]*)\.ducklake_macro\b/i.test(statement) &&
      /\bducklake_macro_impl\b/i.test(statement) &&
      /\bAS\s+impl\b/i.test(statement)
    ) {
      return this.duckLakeMacroInfo(statement);
    }
    return undefined;
  }

  private duckLakeMissingInlinedDeleteQuery(statement: string): QueryResultData | undefined {
    const tableName = statement.match(/\bducklake_inlined_delete_\d+\b/i)?.[0];
    const schemaName = tableName ? metadataSchemaName(statement, tableName) ?? "main" : "main";
    if (!tableName || this.tableExists(normalizeTableName(`${schemaName}.${tableName}`))) {
      return undefined;
    }
    if (/\bSELECT\s+DISTINCT\s+file_id\b/i.test(statement)) {
      return emptyResult(["file_id"], [LogicalTypes.bigint()]);
    }
    if (/\bSELECT\s+file_id\s*,\s*row_id\s*,\s*begin_snapshot\b/i.test(statement)) {
      return emptyResult(["file_id", "row_id", "begin_snapshot"], [
        LogicalTypes.bigint(),
        LogicalTypes.bigint(),
        LogicalTypes.bigint()
      ]);
    }
    if (/\bSELECT\s+file_id\s*,\s*row_id\b/i.test(statement)) {
      return emptyResult(["file_id", "row_id"], [LogicalTypes.bigint(), LogicalTypes.bigint()]);
    }
    if (/\bJOIN\s+(?:"[^"]+"|[A-Za-z_][\w$]*)\.ducklake_data_file\s+data\b/i.test(statement)) {
      return emptyResult(
        [
          "file_id",
          "path",
          "path_is_relative",
          "row_id",
          "begin_snapshot",
          "delete_file_id",
          "del_path",
          "del_path_is_relative",
          "del_begin_snapshot",
          "del_encryption_key",
          "del_format"
        ],
        [
          LogicalTypes.bigint(),
          LogicalTypes.varchar(),
          LogicalTypes.boolean(),
          LogicalTypes.bigint(),
          LogicalTypes.bigint(),
          LogicalTypes.bigint(),
          LogicalTypes.varchar(),
          LogicalTypes.boolean(),
          LogicalTypes.bigint(),
          LogicalTypes.blob(),
          LogicalTypes.varchar()
        ]
      );
    }
    return undefined;
  }

  private async duckLakeReadBlob(statement: string): Promise<QueryResultData> {
    const names = ["filename"];
    const types = [LogicalTypes.varchar()];
    const pattern = readBlobPattern(statement);
    if (!pattern) {
      return emptyResult(names, types);
    }
    const files = (await this.context.listFiles(pattern))
      .filter((file) => !/\bsuffix\s*\(\s*filename\s*,\s*'\.parquet'\s*\)/i.test(statement) || file.filename.endsWith(".parquet"))
      .filter((file) => matchesLastModifiedFilter(file, statement));
    const knownFiles = /\bNOT\s+IN\s*\(/i.test(statement) ? this.duckLakeKnownFiles(statement, pattern) : new Set<string>();
    const rows = files
      .filter((file) => !knownFiles.has(normalizePath(file.filename)))
      .map((file) => [file.filename]);
    return { names, types, rows };
  }

  private duckLakeKnownFiles(statement: string, pattern: string): Set<string> {
    const dataPath = dataPathFromReadBlobPattern(pattern);
    const schemaName =
      metadataSchemaName(statement, "ducklake_data_file") ??
      metadataSchemaName(statement, "ducklake_delete_file") ??
      metadataSchemaName(statement, "ducklake_files_scheduled_for_deletion") ??
      "main";
    const known = new Set<string>();
    const schemaTable = normalizeTableName(`${schemaName}.ducklake_schema`);
    const tableTable = normalizeTableName(`${schemaName}.ducklake_table`);
    const dataFileTable = normalizeTableName(`${schemaName}.ducklake_data_file`);
    const deleteFileTable = normalizeTableName(`${schemaName}.ducklake_delete_file`);
    if (this.tableExists(schemaTable) && this.tableExists(tableTable)) {
      for (const fileTable of [dataFileTable, deleteFileTable]) {
        if (!this.tableExists(fileTable)) {
          continue;
        }
        const rows = this.sql
          .exec<{
            schema_path: string | null;
            table_path: string | null;
            file_path: string | null;
            schema_relative: number | null;
            table_relative: number | null;
            file_relative: number | null;
          }>(
            `SELECT s.path AS schema_path,
                    t.path AS table_path,
                    f.path AS file_path,
                    s.path_is_relative AS schema_relative,
                    t.path_is_relative AS table_relative,
                    f.path_is_relative AS file_relative
             FROM ${quoteIdentifier(fileTable)} f
             JOIN ${quoteIdentifier(tableTable)} t ON f.table_id = t.table_id
             JOIN ${quoteIdentifier(schemaTable)} s ON t.schema_id = s.schema_id`
          )
          .toArray();
        for (const row of rows) {
          const path = duckLakeFullFilePath(dataPath, row);
          if (path) {
            known.add(normalizePath(path));
          }
        }
      }
    }
    const scheduledTable = normalizeTableName(`${schemaName}.ducklake_files_scheduled_for_deletion`);
    if (this.tableExists(scheduledTable)) {
      for (const row of this.sql
        .exec<{ path: string | null; path_is_relative: number | null }>(
          `SELECT path, path_is_relative FROM ${quoteIdentifier(scheduledTable)}`
        )
        .toArray()) {
        if (!row.path) {
          continue;
        }
        known.add(normalizePath(isTruthy(row.path_is_relative) ? joinPath(dataPath, row.path) : row.path));
      }
    }
    return known;
  }

  private tryDuckLakeMetadataMutation(statement: string): QueryResultData | undefined {
    if (
      !/^UPDATE\b/i.test(statement.trim()) ||
      !/\bducklake_partition_column\b/i.test(statement) ||
      !/\bLIST\s*\(\s*column_id\s+ORDER\s+BY\s+column_order\s*\)/i.test(statement)
    ) {
      return undefined;
    }
    const schemaName =
      statement.match(/\bUPDATE\s+("[^"]+"|[A-Za-z_][\w$]*)\.ducklake_partition_column\b/i)?.[1] ??
      statement.match(/\bFROM\s+("[^"]+"|[A-Za-z_][\w$]*)\.ducklake_column\b/i)?.[1] ??
      "main";
    const normalizedSchema = normalizeSchemaName(schemaName);
    const partitionColumnTable = normalizeTableName(`${normalizedSchema}.ducklake_partition_column`);
    const columnTable = normalizeTableName(`${normalizedSchema}.ducklake_column`);
    if (!this.tableExists(partitionColumnTable) || !this.tableExists(columnTable)) {
      return undefined;
    }
    this.sql.exec(`
      UPDATE ${quoteIdentifier(partitionColumnTable)} AS part_col
      SET column_id = (
        SELECT col.column_id
        FROM ${quoteIdentifier(columnTable)} AS col
        WHERE col.table_id = part_col.table_id
          AND col.parent_column IS NULL
          AND col.end_snapshot IS NULL
          AND (
            SELECT COUNT(*)
            FROM ${quoteIdentifier(columnTable)} AS earlier_col
            WHERE earlier_col.table_id = col.table_id
              AND earlier_col.parent_column IS NULL
              AND earlier_col.end_snapshot IS NULL
              AND earlier_col.column_order <= col.column_order
          ) = part_col.column_id + 1
        ORDER BY col.column_order
        LIMIT 1
      )
    `);
    this.bumpTableVersion(partitionColumnTable);
    return successResult();
  }

  private duckLakeTableDeletions(statement: string): QueryResultData {
    const names = [
      "data_file_id",
      "data_path",
      "data_path_is_relative",
      "data_file_size_bytes",
      "data_footer_size",
      "row_id_start",
      "record_count",
      "mapping_id",
      "current_delete_path",
      "current_delete_path_is_relative",
      "current_delete_file_size_bytes",
      "current_delete_footer_size",
      "current_delete_format",
      "previous_delete_path",
      "previous_delete_path_is_relative",
      "previous_delete_file_size_bytes",
      "previous_delete_footer_size",
      "previous_delete_format",
      "begin_snapshot",
      "deletions"
    ];
    const deletionsType = LogicalTypes.list(
      LogicalTypes.struct([
        { name: "row_id", type: LogicalTypes.bigint() },
        { name: "snapshot_id", type: LogicalTypes.bigint() }
      ])
    );
    const types = [
      LogicalTypes.bigint(),
      LogicalTypes.varchar(),
      LogicalTypes.boolean(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.varchar(),
      LogicalTypes.boolean(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.varchar(),
      LogicalTypes.varchar(),
      LogicalTypes.boolean(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.varchar(),
      LogicalTypes.bigint(),
      deletionsType
    ];
    const schemaName = metadataSchemaName(statement, "ducklake_delete_file") ?? "main";
    const tableId = firstNumberAfter(statement, /\bWHERE\s+table_id\s*=\s*(\d+)\b/i) ?? 0;
    const startSnapshot =
      firstNumberAfter(statement, /\bbegin_snapshot\s*<\s*(\d+)\b/i) ??
      firstNumberAfter(statement, /\bend_snapshot\s*>=\s*(\d+)\b/i) ??
      0;
    const endSnapshot =
      snapshotIdFromPredicate(statement) ||
      firstNumberAfter(statement, /\bbegin_snapshot\s*<=\s*(\d+)\b/i) ||
      firstNumberAfter(statement, /\bend_snapshot\s*<=\s*(\d+)\b/i) ||
      0;
    const dataFileName = normalizeTableName(`${schemaName}.ducklake_data_file`);
    const deleteFileName = normalizeTableName(`${schemaName}.ducklake_delete_file`);
    if (!this.tableExists(dataFileName) || !this.tableExists(deleteFileName)) {
      return emptyResult(names, types);
    }
    const currentDeletes = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM ${quoteIdentifier(deleteFileName)}
         WHERE table_id = ? AND begin_snapshot <= ?
         ORDER BY data_file_id, begin_snapshot`,
        tableId,
        endSnapshot
      )
      .toArray();
    const activeDataFiles = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM ${quoteIdentifier(dataFileName)}
         WHERE table_id = ?`,
        tableId
      )
      .toArray();
    const dataByFile = new Map(activeDataFiles.map((row) => [Number(row.data_file_id), row]));
    const rows: QuackValue[][] = [];
    for (const currentDelete of currentDeletes) {
      const dataFile = dataByFile.get(Number(currentDelete.data_file_id));
      if (!dataFile) {
        continue;
      }
      const previousDelete = this.latestPreviousDelete(deleteFileName, tableId, Number(currentDelete.data_file_id), startSnapshot);
      rows.push(this.duckLakeDeletionRow(dataFile, currentDelete, previousDelete, Number(currentDelete.begin_snapshot), names, types));
    }
    const fullyDeletedDataFiles = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM ${quoteIdentifier(dataFileName)}
         WHERE table_id = ? AND end_snapshot >= ? AND end_snapshot <= ?
         ORDER BY data_file_id`,
        tableId,
        startSnapshot,
        endSnapshot
      )
      .toArray();
    for (const dataFile of fullyDeletedDataFiles) {
      const previousDelete = this.latestPreviousDelete(
        deleteFileName,
        tableId,
        Number(dataFile.data_file_id),
        Number(dataFile.end_snapshot)
      );
      rows.push(this.duckLakeDeletionRow(dataFile, undefined, previousDelete, Number(dataFile.end_snapshot), names, types));
    }
    return { names, types, rows };
  }

  private duckLakeDeletionRow(
    dataFile: Record<string, SqlStorageValue>,
    currentDelete: Record<string, SqlStorageValue> | undefined,
    previousDelete: Record<string, SqlStorageValue> | undefined,
    beginSnapshot: number,
    names: string[],
    types: LogicalType[]
  ): QuackValue[] {
    const values: Record<string, SqlStorageValue | null> = {
      data_file_id: dataFile.data_file_id ?? null,
      data_path: dataFile.path ?? null,
      data_path_is_relative: dataFile.path_is_relative ?? null,
      data_file_size_bytes: dataFile.file_size_bytes ?? null,
      data_footer_size: dataFile.footer_size ?? null,
      row_id_start: dataFile.row_id_start ?? null,
      record_count: dataFile.record_count ?? null,
      mapping_id: dataFile.mapping_id ?? null,
      current_delete_path: currentDelete?.path ?? null,
      current_delete_path_is_relative: currentDelete?.path_is_relative ?? null,
      current_delete_file_size_bytes: currentDelete?.file_size_bytes ?? null,
      current_delete_footer_size: currentDelete?.footer_size ?? null,
      current_delete_format: currentDelete?.format ?? null,
      previous_delete_path: previousDelete?.path ?? null,
      previous_delete_path_is_relative: previousDelete?.path_is_relative ?? null,
      previous_delete_file_size_bytes: previousDelete?.file_size_bytes ?? null,
      previous_delete_footer_size: previousDelete?.footer_size ?? null,
      previous_delete_format: previousDelete?.format ?? null,
      begin_snapshot: beginSnapshot,
      deletions: null
    };
    return names.map((name, index) => quackValueFromSql(values[name], types[index] ?? LogicalTypes.varchar()));
  }

  private latestPreviousDelete(
    deleteFileName: string,
    tableId: number,
    dataFileId: number,
    beforeSnapshot: number
  ): Record<string, SqlStorageValue> | undefined {
    return this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT *
         FROM ${quoteIdentifier(deleteFileName)}
         WHERE table_id = ? AND data_file_id = ? AND begin_snapshot < ?
         ORDER BY begin_snapshot DESC
         LIMIT 1`,
        tableId,
        dataFileId,
        beforeSnapshot
      )
      .toArray()[0];
  }

  private duckLakeTableSizes(statement: string): QueryResultData {
    const names = [
      "schema_id",
      "table_id",
      "table_name",
      "table_uuid",
      "data_file_count",
      "data_total_size",
      "delete_file_count",
      "delete_total_size"
    ];
    const types = [
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.varchar(),
      LogicalTypes.varchar(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint()
    ];
    const schemaName = metadataSchemaName(statement, "ducklake_table") ?? "main";
    const snapshotId = snapshotIdFromPredicate(statement);
    const tableName = normalizeTableName(`${schemaName}.ducklake_table`);
    const dataFileName = normalizeTableName(`${schemaName}.ducklake_data_file`);
    const deleteFileName = normalizeTableName(`${schemaName}.ducklake_delete_file`);
    if (!this.tableExists(tableName)) {
      return emptyResult(names, types);
    }
    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT schema_id, table_id, table_name, table_uuid
         FROM ${quoteIdentifier(tableName)}
         WHERE ? >= begin_snapshot AND (? < end_snapshot OR end_snapshot IS NULL)
         ORDER BY table_id`,
        snapshotId,
        snapshotId
      )
      .toArray();
    return {
      names,
      types,
      rows: rows.map((row) => {
        const tableId = Number(row.table_id);
        const dataStats = this.fileStatsForTable(dataFileName, tableId, snapshotId);
        const deleteStats = this.tableExists(deleteFileName)
          ? this.fileStatsForTable(deleteFileName, tableId, snapshotId)
          : { count: 0, total: null };
        return [
          quackValueFromSql(row.schema_id, types[0] ?? LogicalTypes.bigint()),
          quackValueFromSql(row.table_id, types[1] ?? LogicalTypes.bigint()),
          quackValueFromSql(row.table_name, types[2] ?? LogicalTypes.varchar()),
          quackValueFromSql(row.table_uuid, types[3] ?? LogicalTypes.varchar()),
          BigInt(dataStats.count),
          dataStats.total === null ? null : BigInt(dataStats.total),
          BigInt(deleteStats.count),
          deleteStats.total === null ? null : BigInt(deleteStats.total)
        ];
      })
    };
  }

  private fileStatsForTable(tableName: string, tableId: number, snapshotId: number): { count: number; total: number | null } {
    if (!this.tableExists(tableName)) {
      return { count: 0, total: null };
    }
    const row = this.sql
      .exec<{ count: number; total: number | null }>(
        `SELECT COUNT(*) AS count, SUM(file_size_bytes) AS total
         FROM ${quoteIdentifier(tableName)}
         WHERE table_id = ? AND ? >= begin_snapshot AND (? < end_snapshot OR end_snapshot IS NULL)`,
        tableId,
        snapshotId,
        snapshotId
      )
      .one();
    return { count: row.count, total: row.total };
  }

  private duckLakeFilesForCompaction(statement: string): QueryResultData {
    const names = [
      "data_file_id",
      "record_count",
      "row_id_start",
      "begin_snapshot",
      "end_snapshot",
      "mapping_id",
      "schema_version",
      "partial_max",
      "partition_id",
      "keys",
      "data_path",
      "data_path_is_relative",
      "data_file_size_bytes",
      "data_footer_size",
      "del_data_file_id",
      "del_delete_file_id",
      "delete_count",
      "del_begin_snapshot",
      "del_end_snapshot",
      "del_partial_max",
      "del_path",
      "del_path_is_relative",
      "del_file_size_bytes",
      "del_footer_size",
      "del_format"
    ];
    const types = [
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.list(LogicalTypes.varchar()),
      LogicalTypes.varchar(),
      LogicalTypes.boolean(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.varchar(),
      LogicalTypes.boolean(),
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.varchar()
    ];
    const schemaName = metadataSchemaName(statement, "ducklake_schema_versions") ?? "main";
    const tableId = firstNumberAfter(statement, /\bWHERE\s+table_id\s*=\s*(\d+)\b/i) ?? 0;
    const dataFileName = normalizeTableName(`${schemaName}.ducklake_data_file`);
    const deleteFileName = normalizeTableName(`${schemaName}.ducklake_delete_file`);
    if (!this.tableExists(dataFileName)) {
      return emptyResult(names, types);
    }
    const dataRows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT *
         FROM ${quoteIdentifier(dataFileName)}
         WHERE table_id = ?
         ORDER BY begin_snapshot, row_id_start, data_file_id`,
        tableId
      )
      .toArray()
      .filter((row) => {
        if (/\bdata\.end_snapshot\s+IS\s+NULL\b/i.test(statement) && row.end_snapshot !== null) {
          return false;
        }
        const minFileSize = firstNumberAfter(statement, /\bdata\.file_size_bytes\s*>=\s*(\d+)\b/i);
        if (minFileSize !== undefined && Number(row.file_size_bytes) < minFileSize) {
          return false;
        }
        const maxFileSize = firstNumberAfter(statement, /\bdata\.file_size_bytes\s*<\s*(\d+)\b/i);
        if (maxFileSize !== undefined && Number(row.file_size_bytes) >= maxFileSize) {
          return false;
        }
        return true;
      });
    const rows: QuackValue[][] = [];
    for (const dataRow of dataRows) {
      const dataFileId = Number(dataRow.data_file_id);
      const deleteRows = this.tableExists(deleteFileName)
        ? this.sql
          .exec<Record<string, SqlStorageValue>>(
            `SELECT *
             FROM ${quoteIdentifier(deleteFileName)}
             WHERE table_id = ? AND data_file_id = ?
             ORDER BY begin_snapshot`,
            tableId,
            dataFileId
          )
          .toArray()
        : [];
      const joinedDeleteRows = deleteRows.length > 0 ? deleteRows : [undefined];
      for (const deleteRow of joinedDeleteRows) {
        rows.push(this.duckLakeCompactionRow(schemaName, tableId, dataRow, deleteRow, names, types));
      }
    }
    return { names, types, rows };
  }

  private duckLakeCompactionRow(
    schemaName: string,
    tableId: number,
    dataRow: Record<string, SqlStorageValue>,
    deleteRow: Record<string, SqlStorageValue> | undefined,
    names: string[],
    types: LogicalType[]
  ): QuackValue[] {
    const dataFileId = Number(dataRow.data_file_id);
    const values: Record<string, SqlStorageValue | QuackValue[] | null> = {
      data_file_id: dataRow.data_file_id ?? null,
      record_count: dataRow.record_count ?? null,
      row_id_start: dataRow.row_id_start ?? null,
      begin_snapshot: dataRow.begin_snapshot ?? null,
      end_snapshot: dataRow.end_snapshot ?? null,
      mapping_id: dataRow.mapping_id ?? null,
      schema_version: this.schemaVersionForDataFile(schemaName, tableId, Number(dataRow.begin_snapshot)),
      partial_max: dataRow.partial_max ?? null,
      partition_id: dataRow.partition_id ?? null,
      keys: this.partitionValuesForDataFile(schemaName, dataFileId),
      data_path: dataRow.path ?? null,
      data_path_is_relative: dataRow.path_is_relative ?? null,
      data_file_size_bytes: dataRow.file_size_bytes ?? null,
      data_footer_size: dataRow.footer_size ?? null,
      del_data_file_id: deleteRow?.data_file_id ?? null,
      del_delete_file_id: deleteRow?.delete_file_id ?? null,
      delete_count: deleteRow?.delete_count ?? null,
      del_begin_snapshot: deleteRow?.begin_snapshot ?? null,
      del_end_snapshot: deleteRow?.end_snapshot ?? null,
      del_partial_max: deleteRow?.partial_max ?? null,
      del_path: deleteRow?.path ?? null,
      del_path_is_relative: deleteRow?.path_is_relative ?? null,
      del_file_size_bytes: deleteRow?.file_size_bytes ?? null,
      del_footer_size: deleteRow?.footer_size ?? null,
      del_format: deleteRow?.format ?? null
    };
    return names.map((name, index) => {
      if (name === "keys") {
        return values.keys as QuackValue[] | null;
      }
      return quackValueFromSql(values[name], types[index] ?? LogicalTypes.varchar());
    });
  }

  private schemaVersionForDataFile(schemaName: string, tableId: number, beginSnapshot: number): number | null {
    const schemaVersionsName = normalizeTableName(`${schemaName}.ducklake_schema_versions`);
    if (!this.tableExists(schemaVersionsName)) {
      return null;
    }
    const row = this.sql
      .exec<{ schema_version: number }>(
        `SELECT schema_version
         FROM ${quoteIdentifier(schemaVersionsName)}
         WHERE table_id = ? AND begin_snapshot <= ?
         ORDER BY begin_snapshot DESC
         LIMIT 1`,
        tableId,
        beginSnapshot
      )
      .toArray()[0];
    return row?.schema_version ?? null;
  }

  private partitionValuesForDataFile(schemaName: string, dataFileId: number): string[] | null {
    const partitionValuesName = normalizeTableName(`${schemaName}.ducklake_file_partition_value`);
    if (!this.tableExists(partitionValuesName)) {
      return null;
    }
    const rows = this.sql
      .exec<{ partition_value: string }>(
        `SELECT partition_value
         FROM ${quoteIdentifier(partitionValuesName)}
         WHERE data_file_id = ?
         ORDER BY partition_key_index`,
        dataFileId
      )
      .toArray();
    return rows.length === 0 ? null : rows.map((row) => row.partition_value);
  }

  private duckLakeTableInfo(statement: string): QueryResultData {
    const tagType = duckLakeTagListType();
    const inlinedDataTablesType = LogicalTypes.list(
      LogicalTypes.struct([
        { name: "name", type: LogicalTypes.varchar() },
        { name: "schema_version", type: LogicalTypes.bigint() }
      ])
    );
    const names = [
      "schema_id",
      "table_id",
      "table_uuid",
      "table_name",
      "tag",
      "inlined_data_tables",
      "path",
      "path_is_relative",
      "column_id",
      "column_name",
      "column_type",
      "initial_default",
      "default_value",
      "nulls_allowed",
      "parent_column",
      "column_tags",
      "default_value_type"
    ];
    const types = [
      LogicalTypes.bigint(),
      LogicalTypes.bigint(),
      LogicalTypes.varchar(),
      LogicalTypes.varchar(),
      tagType,
      inlinedDataTablesType,
      LogicalTypes.varchar(),
      LogicalTypes.boolean(),
      LogicalTypes.bigint(),
      LogicalTypes.varchar(),
      LogicalTypes.varchar(),
      LogicalTypes.varchar(),
      LogicalTypes.varchar(),
      LogicalTypes.boolean(),
      LogicalTypes.bigint(),
      tagType,
      LogicalTypes.varchar()
    ];
    const schemaName = metadataSchemaName(statement, "ducklake_table") ?? "main";
    const snapshotId = snapshotIdFromPredicate(statement);
    const tableName = normalizeTableName(`${schemaName}.ducklake_table`);
    const columnName = normalizeTableName(`${schemaName}.ducklake_column`);
    if (!this.tableExists(tableName) || !this.tableExists(columnName)) {
      return emptyResult(names, types);
    }
    const tagsByObject = this.duckLakeTags(schemaName, snapshotId);
    const columnTagsByColumn = this.duckLakeColumnTags(schemaName, snapshotId);
    const inlinedByTable = new Map<number, Array<{ name: string; schema_version: bigint }>>();
    const inlinedTableName = normalizeTableName(`${schemaName}.ducklake_inlined_data_tables`);
    if (this.tableExists(inlinedTableName)) {
      for (const row of this.sql
        .exec<{ table_id: number; table_name: string; schema_version: number }>(
          `SELECT table_id, table_name, schema_version FROM ${quoteIdentifier(inlinedTableName)}`
        )
        .toArray()) {
        const entries = inlinedByTable.get(row.table_id) ?? [];
        entries.push({ name: row.table_name, schema_version: BigInt(row.schema_version) });
        inlinedByTable.set(row.table_id, entries);
      }
    }
    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT
           tbl.schema_id AS schema_id,
           tbl.table_id AS table_id,
           tbl.table_uuid AS table_uuid,
           tbl.table_name AS table_name,
           NULL AS tag,
           NULL AS inlined_data_tables,
           tbl.path AS path,
           tbl.path_is_relative AS path_is_relative,
           col.column_id AS column_id,
           col.column_name AS column_name,
           col.column_type AS column_type,
           col.initial_default AS initial_default,
           col.default_value AS default_value,
           col.nulls_allowed AS nulls_allowed,
           col.parent_column AS parent_column,
           NULL AS column_tags,
           col.default_value_type AS default_value_type
         FROM ${quoteIdentifier(tableName)} tbl
         LEFT JOIN ${quoteIdentifier(columnName)} col USING (table_id)
         WHERE ? >= tbl.begin_snapshot AND (? < tbl.end_snapshot OR tbl.end_snapshot IS NULL)
           AND ((? >= col.begin_snapshot AND (? < col.end_snapshot OR col.end_snapshot IS NULL)) OR col.column_id IS NULL)
         ORDER BY tbl.table_id, col.parent_column IS NOT NULL, col.parent_column, col.column_order`,
        snapshotId,
        snapshotId,
        snapshotId,
        snapshotId
      )
      .toArray();
    const resultRows = rows.map((row) =>
      names.map((name, index) => {
        if (name === "tag") {
          return tagsByObject.get(Number(row.table_id)) ?? null;
        }
        if (name === "column_tags") {
          return columnTagsByColumn.get(`${String(row.table_id)}:${String(row.column_id)}`) ?? null;
        }
        if (name === "inlined_data_tables") {
          return inlinedByTable.get(Number(row.table_id)) ?? null;
        }
        return quackValueFromSql(row[name], types[index] ?? LogicalTypes.varchar());
      })
    );
    return {
      names,
      types,
      rows: resultRows
    };
  }

  private duckLakeViewInfo(statement: string): QueryResultData {
    const tagType = duckLakeTagListType();
    const names = ["view_id", "view_uuid", "schema_id", "view_name", "dialect", "sql", "column_aliases", "tag"];
    const types = [
      LogicalTypes.bigint(),
      LogicalTypes.uuid(),
      LogicalTypes.bigint(),
      LogicalTypes.varchar(),
      LogicalTypes.varchar(),
      LogicalTypes.varchar(),
      LogicalTypes.varchar(),
      tagType
    ];
    const schemaName = metadataSchemaName(statement, "ducklake_view") ?? "main";
    const snapshotId = snapshotIdFromPredicate(statement);
    const viewTableName = normalizeTableName(`${schemaName}.ducklake_view`);
    if (!this.tableExists(viewTableName)) {
      return emptyResult(names, types);
    }
    const tagsByObject = this.duckLakeTags(schemaName, snapshotId);
    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT view_id, view_uuid, schema_id, view_name, dialect, sql, column_aliases
         FROM ${quoteIdentifier(viewTableName)}
         WHERE ? >= begin_snapshot AND (? < end_snapshot OR end_snapshot IS NULL)`,
        snapshotId,
        snapshotId
      )
      .toArray();
    return {
      names,
      types,
      rows: rows.map((row) =>
        names.map((name, index) => {
          if (name === "tag") {
            return tagsByObject.get(Number(row.view_id)) ?? null;
          }
          return quackValueFromSql(row[name], types[index] ?? LogicalTypes.varchar());
        })
      )
    };
  }

  private duckLakeMacroInfo(statement: string): QueryResultData {
    const paramsType = LogicalTypes.list(
      LogicalTypes.struct([
        { name: "parameter_name", type: LogicalTypes.varchar() },
        { name: "parameter_type", type: LogicalTypes.varchar() },
        { name: "default_value", type: LogicalTypes.varchar() },
        { name: "default_value_type", type: LogicalTypes.varchar() }
      ])
    );
    const implType = LogicalTypes.list(
      LogicalTypes.struct([
        { name: "dialect", type: LogicalTypes.varchar() },
        { name: "sql", type: LogicalTypes.varchar() },
        { name: "type", type: LogicalTypes.varchar() },
        { name: "params", type: paramsType }
      ])
    );
    const names = ["schema_id", "macro_id", "macro_name", "impl"];
    const types = [LogicalTypes.bigint(), LogicalTypes.bigint(), LogicalTypes.varchar(), implType];
    const schemaName = metadataSchemaName(statement, "ducklake_macro") ?? "main";
    const snapshotId = snapshotIdFromPredicate(statement);
    const macroTableName = normalizeTableName(`${schemaName}.ducklake_macro`);
    if (!this.tableExists(macroTableName)) {
      return emptyResult(names, types);
    }
    const implByMacro = this.duckLakeMacroImplementations(schemaName);
    const rows = this.sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT schema_id, macro_id, macro_name
         FROM ${quoteIdentifier(macroTableName)}
         WHERE ? >= begin_snapshot AND (? < end_snapshot OR end_snapshot IS NULL)`,
        snapshotId,
        snapshotId
      )
      .toArray();
    return {
      names,
      types,
      rows: rows.map((row) =>
        names.map((name, index) => {
          if (name === "impl") {
            return implByMacro.get(Number(row.macro_id)) ?? [];
          }
          return quackValueFromSql(row[name], types[index] ?? LogicalTypes.varchar());
        })
      )
    };
  }

  private duckLakeTags(schemaName: string, snapshotId: number): Map<number, DuckLakeTagValue[]> {
    const tagTableName = normalizeTableName(`${schemaName}.ducklake_tag`);
    const tagsByObject = new Map<number, DuckLakeTagValue[]>();
    if (!this.tableExists(tagTableName)) {
      return tagsByObject;
    }
    for (const row of this.sql
      .exec<{ object_id: number; key: string; value: string }>(
        `SELECT object_id, key, value
         FROM ${quoteIdentifier(tagTableName)}
         WHERE ? >= begin_snapshot AND (? < end_snapshot OR end_snapshot IS NULL)
         ORDER BY object_id, key`,
        snapshotId,
        snapshotId
      )
      .toArray()) {
      const tags = tagsByObject.get(row.object_id) ?? [];
      tags.push({ key: row.key, value: row.value });
      tagsByObject.set(row.object_id, tags);
    }
    return tagsByObject;
  }

  private duckLakeColumnTags(schemaName: string, snapshotId: number): Map<string, DuckLakeTagValue[]> {
    const tagTableName = normalizeTableName(`${schemaName}.ducklake_column_tag`);
    const tagsByColumn = new Map<string, DuckLakeTagValue[]>();
    if (!this.tableExists(tagTableName)) {
      return tagsByColumn;
    }
    for (const row of this.sql
      .exec<{ table_id: number; column_id: number; key: string; value: string }>(
        `SELECT table_id, column_id, key, value
         FROM ${quoteIdentifier(tagTableName)}
         WHERE ? >= begin_snapshot AND (? < end_snapshot OR end_snapshot IS NULL)
         ORDER BY table_id, column_id, key`,
        snapshotId,
        snapshotId
      )
      .toArray()) {
      const mapKey = `${row.table_id}:${row.column_id}`;
      const tags = tagsByColumn.get(mapKey) ?? [];
      tags.push({ key: row.key, value: row.value });
      tagsByColumn.set(mapKey, tags);
    }
    return tagsByColumn;
  }

  private duckLakeMacroImplementations(schemaName: string): Map<number, DuckLakeMacroImplementationValue[]> {
    const implTableName = normalizeTableName(`${schemaName}.ducklake_macro_impl`);
    const implByMacro = new Map<number, DuckLakeMacroImplementationValue[]>();
    if (!this.tableExists(implTableName)) {
      return implByMacro;
    }
    const paramsByImpl = this.duckLakeMacroParameters(schemaName);
    for (const row of this.sql
      .exec<{ macro_id: number; impl_id: number; dialect: string; sql: string; type: string }>(
        `SELECT macro_id, impl_id, dialect, sql, type
         FROM ${quoteIdentifier(implTableName)}
         ORDER BY macro_id, impl_id`
      )
      .toArray()) {
      const implementations = implByMacro.get(row.macro_id) ?? [];
      implementations.push({
        dialect: row.dialect,
        sql: row.sql,
        type: row.type,
        params: paramsByImpl.get(`${row.macro_id}:${row.impl_id}`) ?? null
      });
      implByMacro.set(row.macro_id, implementations);
    }
    return implByMacro;
  }

  private duckLakeMacroParameters(schemaName: string): Map<string, DuckLakeMacroParameterValue[]> {
    const paramsTableName = normalizeTableName(`${schemaName}.ducklake_macro_parameters`);
    const paramsByImpl = new Map<string, DuckLakeMacroParameterValue[]>();
    if (!this.tableExists(paramsTableName)) {
      return paramsByImpl;
    }
    for (const row of this.sql
      .exec<{
        macro_id: number;
        impl_id: number;
        parameter_name: string;
        parameter_type: string;
        default_value: string | null;
        default_value_type: string | null;
      }>(
        `SELECT macro_id, impl_id, parameter_name, parameter_type, default_value, default_value_type
         FROM ${quoteIdentifier(paramsTableName)}
         ORDER BY macro_id, impl_id, column_id`
      )
      .toArray()) {
      const mapKey = `${row.macro_id}:${row.impl_id}`;
      const params = paramsByImpl.get(mapKey) ?? [];
      params.push({
        parameter_name: row.parameter_name,
        parameter_type: row.parameter_type,
        default_value: row.default_value,
        default_value_type: row.default_value_type
      });
      paramsByImpl.set(mapKey, params);
    }
    return paramsByImpl;
  }
}

function readBlobPattern(statement: string): string | undefined {
  const match = statement.match(/\bread_blob\s*\(\s*'((?:''|[^'])*)'\s*(?:\|\|\s*'((?:''|[^'])*)')?\s*\)/i);
  if (!match?.[1]) {
    return undefined;
  }
  return sqlStringValue(match[1]) + sqlStringValue(match[2] ?? "");
}

function sqlStringValue(value: string): string {
  return value.replaceAll("''", "'");
}

function dataPathFromReadBlobPattern(pattern: string): string {
  return pattern.endsWith("**") ? pattern.slice(0, -2) : pattern;
}

function matchesLastModifiedFilter(file: ListedFile, statement: string): boolean {
  const olderThan = statement.match(/\blast_modified\s*<\s*'([^']+)'/i)?.[1];
  if (!olderThan) {
    return true;
  }
  if (!file.lastModified) {
    return false;
  }
  const fileTime = Date.parse(file.lastModified);
  const threshold = Date.parse(olderThan);
  return Number.isFinite(fileTime) && Number.isFinite(threshold) && fileTime < threshold;
}

function duckLakeFullFilePath(
  dataPath: string,
  row: {
    schema_path: string | null;
    table_path: string | null;
    file_path: string | null;
    schema_relative: number | boolean | null;
    table_relative: number | boolean | null;
    file_relative: number | boolean | null;
  }
): string | undefined {
  const filePath = row.file_path;
  if (!filePath) {
    return undefined;
  }
  if (!isTruthy(row.file_relative)) {
    return filePath;
  }
  const tablePath = row.table_path ?? "";
  if (!isTruthy(row.table_relative)) {
    return joinPath(tablePath, filePath);
  }
  const schemaPath = row.schema_path ?? "";
  if (!isTruthy(row.schema_relative)) {
    return joinPath(schemaPath, tablePath, filePath);
  }
  return joinPath(dataPath, schemaPath, tablePath, filePath);
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .reduce((joined, part) => {
      if (!joined) {
        return part;
      }
      if (joined.endsWith("/") || part.startsWith("/")) {
        return `${joined}${part}`;
      }
      return `${joined}/${part}`;
    }, "");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isTruthy(value: number | boolean | null): boolean {
  return value === true || value === 1;
}
