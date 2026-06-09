import {
  LogicalTypes,
  dataChunk
} from "./quack-imports";
import type { LogicalType, QuackDataChunk } from "./quack-imports";
import type { Schema, TableSchema } from "@polyglot-sql/sdk";
import { DuckLakeMetadataCompat } from "./ducklake-metadata";
import { duckLakeDataPathValuesFromMetadataWrite } from "./ducklake-data-path";
import {
  deserializeLogicalType,
  inferLogicalType,
  quackValueFromSql,
  serializeLogicalType,
  sqlValueFromQuack
} from "./quack-values";
import { quoteIdentifier, splitSqlStatements, unquoteIdentifier } from "./sql-text";
import { normalizeSchemaName, normalizeTableName, schemaNameFromTableName, splitStoredTableName } from "./sql-names";
import {
  aggregateSourceColumnName,
  duckDbTypeName,
  findMutatedTable,
  findSourceTables,
  isMutation,
  normalizeSnapshotValue,
  parseColumnDefinitions,
  rewriteDuckDbSql,
  selectAliasSourceColumnNames
} from "./sql-rewrite";
import type { ColumnInfo, QueryResultData, SqlExecutionOptions, SqlStorage, SnapshotTable, TransactionSnapshot } from "./sql-types";
import { emptyResult, successResult } from "./sql-types";

export { normalizeTableName } from "./sql-names";
export { rewriteDuckDbSql } from "./sql-rewrite";

export interface SqlCompatibilityLayerOptions {
  validateDuckLakeDataPath?: (dataPath: string) => void;
}

export class SqlCompatibilityLayer {
  private readonly duckLake: DuckLakeMetadataCompat;
  private readonly validateDuckLakeDataPath: ((dataPath: string) => void) | undefined;

  constructor(private readonly sql: SqlStorage, options: SqlCompatibilityLayerOptions = {}) {
    this.validateDuckLakeDataPath = options.validateDuckLakeDataPath;
    this.duckLake = new DuckLakeMetadataCompat({
      sql,
      tableExists: (tableName) => this.tableExists(tableName),
      tableRowCount: (tableName) => this.tableRowCount(tableName),
      bumpTableVersion: (tableName) => this.bumpTableVersion(tableName)
    });
  }

  initialize(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS __dq_table_columns (
        table_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        logical_type_json TEXT NOT NULL,
        sqlite_type TEXT NOT NULL,
        PRIMARY KEY (table_name, column_name)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS __dq_table_versions (
        table_name TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS __dq_schemas (
        schema_name TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )
    `);
    this.sql.exec("INSERT OR IGNORE INTO __dq_schemas (schema_name, created_at) VALUES ('main', ?)", new Date().toISOString());
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS __dq_sessions (
        session_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        in_transaction INTEGER NOT NULL DEFAULT 0,
        tx_id TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS __dq_tx_snapshots (
        session_id TEXT PRIMARY KEY,
        tx_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  createSession(sessionId: string): void {
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT OR REPLACE INTO __dq_sessions (session_id, created_at, last_seen, in_transaction, tx_id)
       VALUES (?, COALESCE((SELECT created_at FROM __dq_sessions WHERE session_id = ?), ?), ?, 0, NULL)`,
      sessionId,
      sessionId,
      now,
      now
    );
  }

  touchSession(sessionId: string): void {
    this.sql.exec("UPDATE __dq_sessions SET last_seen = ? WHERE session_id = ?", new Date().toISOString(), sessionId);
  }

  deleteSession(sessionId: string): void {
    this.sql.exec("DELETE FROM __dq_tx_snapshots WHERE session_id = ?", sessionId);
    this.sql.exec("DELETE FROM __dq_sessions WHERE session_id = ?", sessionId);
  }

  async execute(sessionId: string, sqlText: string, options: SqlExecutionOptions): Promise<QueryResultData> {
    this.touchSession(sessionId);
    const statements = splitSqlStatements(sqlText);
    for (const statement of statements) {
      this.validateDuckLakeDataPathWrite(statement);
    }
    let last: QueryResultData = { names: [], types: [], rows: [] };
    for (const statement of statements) {
      last = await this.executeOne(sessionId, statement, options);
    }
    return last;
  }

  appendChunk(schemaName: string | undefined, tableName: string, chunk: QuackDataChunk): void {
    const normalizedName = normalizeTableName(schemaName ? `${schemaName}.${tableName}` : tableName);
    const columns = this.getColumns(normalizedName);
    if (columns.length === 0) {
      throw new Error(`Table ${tableName} does not exist or has no tracked schema`);
    }
    if (columns.length !== chunk.columns.length) {
      throw new Error(`APPEND_REQUEST has ${chunk.columns.length} columns, expected ${columns.length}`);
    }
    const placeholders = `(${columns.map(() => "?").join(", ")})`;
    const query = `INSERT INTO ${quoteIdentifier(normalizedName)} (${columns.map((column) => quoteIdentifier(column.name)).join(", ")}) VALUES ${placeholders}`;
    for (let rowIndex = 0; rowIndex < chunk.rowCount; rowIndex++) {
      const values = columns.map((column, columnIndex) => {
        const vector = chunk.columns[columnIndex];
        const value = vector?.values[rowIndex] ?? null;
        return sqlValueFromQuack(value, column.type);
      });
      this.sql.exec(query, ...values);
    }
    this.bumpTableVersion(normalizedName);
  }

  resultToChunks(result: QueryResultData, rowsPerChunk: number): QuackDataChunk[] {
    if (result.names.length === 0) {
      return [];
    }
    const chunks: QuackDataChunk[] = [];
    for (let offset = 0; offset < result.rows.length || (offset === 0 && result.rows.length === 0); offset += rowsPerChunk) {
      const rows = result.rows.slice(offset, offset + rowsPerChunk);
      chunks.push(
        dataChunk(
          result.names.map((name, columnIndex) => ({
            name,
            type: result.types[columnIndex] ?? LogicalTypes.varchar(),
            values: rows.map((row) => row[columnIndex] ?? null)
          }))
        )
      );
      if (result.rows.length === 0) {
        break;
      }
    }
    return chunks.filter((chunk) => chunk.rowCount > 0);
  }

  stats(): Record<string, number> {
    const tables = this.userTables().length;
    const sessions = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM __dq_sessions").one().count;
    return { tables, sessions };
  }

  authorizationSchema(): Schema {
    const rows = this.sql
      .exec<{ table_name: string; column_name: string; ordinal: number; sqlite_type: string }>(
        `SELECT table_name, column_name, ordinal, sqlite_type
         FROM __dq_table_columns
         ORDER BY table_name, ordinal`
      )
      .toArray();
    const tables = new Map<string, TableSchema>();
    for (const row of rows) {
      const identity = splitStoredTableName(row.table_name);
      const key = `${identity.schemaName}.${identity.tableName}`;
      let table = tables.get(key);
      if (!table) {
        table = {
          schema: identity.schemaName,
          name: identity.tableName,
          columns: []
        };
        tables.set(key, table);
      }
      table.columns.push({
        name: row.column_name,
        type: row.sqlite_type
      });
    }
    return { strict: true, tables: [...tables.values()] };
  }

  duckLakeDataPath(): string | undefined {
    return this.duckLakeDataPaths()[0];
  }

  private async executeOne(sessionId: string, statement: string, options: SqlExecutionOptions): Promise<QueryResultData> {
    const trimmed = statement.trim();
    if (!trimmed) {
      return { names: [], types: [], rows: [] };
    }
    if (/^BEGIN(?:\s+TRANSACTION)?$/i.test(trimmed)) {
      this.beginTransaction(sessionId);
      return successResult();
    }
    if (/^COMMIT$/i.test(trimmed)) {
      this.commitTransaction(sessionId);
      return successResult();
    }
    if (/^ROLLBACK$/i.test(trimmed)) {
      this.rollbackTransaction(sessionId);
      return successResult();
    }
    if (/^(SET|USE)\b/i.test(trimmed)) {
      return successResult();
    }
    if (this.trySchemaStatement(trimmed)) {
      return successResult();
    }
    if (/^CALL\s+quack_clear_cache\s*\(\s*\)$/i.test(trimmed)) {
      return successResult();
    }
    const informationSchema = this.tryInformationSchema(trimmed);
    if (informationSchema) {
      return informationSchema;
    }

    const duckDbCatalog = this.tryDuckDbCatalogFunctions(trimmed);
    if (duckDbCatalog) {
      return duckDbCatalog;
    }
    if (/\bparquet_full_metadata\s*\(/i.test(trimmed)) {
      throw new Error(
        "quacklake does not execute parquet_full_metadata(); it must run in the DuckDB client process. Use a DuckLake build containing duckdb/ducklake#1164."
      );
    }

    const duckLakeMetadata = await this.duckLake.tryQuery(trimmed);
    if (duckLakeMetadata) {
      return duckLakeMetadata;
    }

    const duckLakeMutation = this.duckLake.tryMutation(trimmed);
    if (duckLakeMutation) {
      this.validateExistingDuckLakeDataPaths();
      return duckLakeMutation;
    }

    const createTable = this.tryCreateTable(trimmed);
    if (createTable) {
      this.validateExistingDuckLakeDataPaths();
      return createTable;
    }

    const alterTable = this.tryAlterTable(trimmed);
    if (alterTable) {
      this.validateExistingDuckLakeDataPaths();
      return alterTable;
    }

    const rewritten = rewriteDuckDbSql(trimmed, {
      shouldRewriteQualifiedName: (normalizedName) => this.tableExists(normalizedName)
    });
    const cursor = this.sql.exec<Record<string, SqlStorageValue>>(rewritten);
    const changedCatalog = isMutation(rewritten) || /^(?:CREATE|ALTER|DROP)\b/i.test(rewritten);
    const names = [...(cursor.columnNames ?? [])];
    if (isMutation(rewritten)) {
      const table = findMutatedTable(rewritten);
      if (table) {
        this.bumpTableVersion(table);
      }
    }
    if (changedCatalog) {
      this.validateExistingDuckLakeDataPaths();
    }
    if (names.length === 0) {
      return successResult();
    }
    const rawRows = cursor.toArray();
    const types = this.resolveResultTypes(rewritten, names, rawRows);
    const rows = rawRows.map((row) => names.map((name, index) => quackValueFromSql(row[name], types[index] ?? LogicalTypes.varchar())));
    void options;
    return { names, types, rows };
  }

  private tryCreateTable(statement: string): QueryResultData | undefined {
    const match = statement.match(/^CREATE\s+(TEMP(?:ORARY)?\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(.+?)\s*\(([\s\S]*)\)\s*$/i);
    if (!match) {
      return undefined;
    }
    const [, temporary = "", ifNotExists = "", rawName, rawColumns] = match;
    if (!rawName || !rawColumns) {
      return undefined;
    }
    const schemaName = schemaNameFromTableName(rawName);
    if (schemaName) {
      this.ensureSchema(schemaName);
    }
    const tableName = normalizeTableName(rawName);
    if (ifNotExists && this.tableExists(tableName)) {
      return successResult();
    }
    const parsedColumns = parseColumnDefinitions(rawColumns);
    const sqliteColumns = parsedColumns.map((column) => {
      const constraints = column.constraints ? ` ${column.constraints}` : "";
      return `${quoteIdentifier(column.name)} ${column.sqliteType}${constraints}`;
    });
    const createSql = `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${quoteIdentifier(tableName)} (${sqliteColumns.join(", ")})`;
    this.sql.exec(createSql);
    this.sql.exec("DELETE FROM __dq_table_columns WHERE table_name = ?", tableName);
    for (const column of parsedColumns) {
      this.sql.exec(
        `INSERT INTO __dq_table_columns (table_name, column_name, ordinal, logical_type_json, sqlite_type)
         VALUES (?, ?, ?, ?, ?)`,
        tableName,
        column.name,
        column.ordinal,
        serializeLogicalType(column.type),
        column.sqliteType
      );
    }
    this.sql.exec("INSERT OR IGNORE INTO __dq_table_versions (table_name, version) VALUES (?, 0)", tableName);
    return successResult();
  }

  private tryAlterTable(statement: string): QueryResultData | undefined {
    const rename = statement.match(/^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(.+?)\s+RENAME\s+TO\s+("[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\s*$/i);
    if (rename?.[2] && rename[3]) {
      const sourceName = normalizeTableName(rename[2]);
      if (!this.tableExists(sourceName)) {
        if (rename[1]) {
          return successResult();
        }
        return undefined;
      }
      const sourceSchemaName = schemaNameFromTableName(rename[2]);
      const targetName = normalizeTableName(sourceSchemaName ? `${sourceSchemaName}.${rename[3]}` : rename[3]);
      this.sql.exec(`ALTER TABLE ${quoteIdentifier(sourceName)} RENAME TO ${quoteIdentifier(targetName)}`);
      this.sql.exec("UPDATE __dq_table_columns SET table_name = ? WHERE table_name = ?", targetName, sourceName);
      this.sql.exec("UPDATE __dq_table_versions SET table_name = ? WHERE table_name = ?", targetName, sourceName);
      this.bumpTableVersion(targetName);
      return successResult();
    }

    const addColumn = statement.match(/^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(.+?)\s+ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i);
    if (addColumn?.[2] && addColumn[4]) {
      const tableName = normalizeTableName(addColumn[2]);
      if (!this.tableExists(tableName)) {
        if (addColumn[1]) {
          return successResult();
        }
        return undefined;
      }
      const [column] = parseColumnDefinitions(addColumn[4]);
      if (!column) {
        return undefined;
      }
      if (this.columnExists(tableName, column.name)) {
        if (addColumn[3]) {
          return successResult();
        }
        return undefined;
      }
      const constraints = column.constraints ? ` ${column.constraints}` : "";
      this.sql.exec(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(column.name)} ${column.sqliteType}${constraints}`);
      this.sql.exec(
        `INSERT INTO __dq_table_columns (table_name, column_name, ordinal, logical_type_json, sqlite_type)
         VALUES (?, ?, ?, ?, ?)`,
        tableName,
        column.name,
        this.nextColumnOrdinal(tableName),
        serializeLogicalType(column.type),
        column.sqliteType
      );
      this.bumpTableVersion(tableName);
      return successResult();
    }

    const dropColumn = statement.match(/^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(.+?)\s+DROP\s+COLUMN\s+(IF\s+EXISTS\s+)?("[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\s*$/i);
    if (dropColumn?.[2] && dropColumn[4]) {
      const tableName = normalizeTableName(dropColumn[2]);
      if (!this.tableExists(tableName)) {
        if (dropColumn[1]) {
          return successResult();
        }
        return undefined;
      }
      const columnName = unquoteIdentifier(dropColumn[4]);
      if (!this.columnExists(tableName, columnName)) {
        if (dropColumn[3]) {
          return successResult();
        }
        return undefined;
      }
      this.sql.exec(`ALTER TABLE ${quoteIdentifier(tableName)} DROP COLUMN ${quoteIdentifier(columnName)}`);
      this.sql.exec("DELETE FROM __dq_table_columns WHERE table_name = ? AND column_name = ?", tableName, columnName);
      this.bumpTableVersion(tableName);
      return successResult();
    }

    return undefined;
  }

  private tryInformationSchema(statement: string): QueryResultData | undefined {
    if (/\binformation_schema\.schemata\b/i.test(statement)) {
      return {
        names: ["catalog_name", "schema_name"],
        types: [LogicalTypes.varchar(), LogicalTypes.varchar()],
        rows: this.schemaNames().map((schemaName) => ["memory", schemaName])
      };
    }
    if (!/\binformation_schema\.tables\b/i.test(statement)) {
      return undefined;
    }
    const tableName = statement.match(/\btable_name\s*=\s*'([^']+)'/i)?.[1];
    const tableSchema = statement.match(/\btable_schema\s*=\s*'([^']+)'/i)?.[1];
    const normalized = tableName ? normalizeTableName(tableSchema ? `${tableSchema}.${tableName}` : tableName) : undefined;
    const exists = normalized ? this.tableExists(normalized) : false;
    if (/COUNT\s*\(\s*\*\s*\)/i.test(statement)) {
      return {
        names: ["count_star()"],
        types: [LogicalTypes.bigint()],
        rows: [[exists ? 1n : 0n]]
      };
    }
    return {
      names: ["table_name", "table_schema"],
      types: [LogicalTypes.varchar(), LogicalTypes.varchar()],
      rows: exists && tableName ? [[tableName, tableSchema ?? "main"]] : []
    };
  }

  private trySchemaStatement(statement: string): boolean {
    const create = statement.match(/^CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)(?:\s+.*)?$/i);
    if (create?.[1]) {
      this.ensureSchema(normalizeSchemaName(create[1]));
      return true;
    }
    const drop = statement.match(/^DROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?("[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)(?:\s+(?:CASCADE|RESTRICT))?$/i);
    if (drop?.[1]) {
      const schemaName = normalizeSchemaName(drop[1]);
      if (schemaName !== "main") {
        this.sql.exec("DELETE FROM __dq_schemas WHERE schema_name = ?", schemaName);
      }
      return true;
    }
    return false;
  }

  private tryDuckDbCatalogFunctions(statement: string): QueryResultData | undefined {
    if (/\bduckdb_secrets\s*\(\s*\)/i.test(statement)) {
      return emptyResult(
        ["name", "type", "provider", "persistent", "storage", "scope", "secret_string"],
        [
          LogicalTypes.varchar(),
          LogicalTypes.varchar(),
          LogicalTypes.varchar(),
          LogicalTypes.boolean(),
          LogicalTypes.varchar(),
          LogicalTypes.list(LogicalTypes.varchar()),
          LogicalTypes.varchar()
        ]
      );
    }
    if (/\bduckdb_databases\s*\(\s*\)/i.test(statement)) {
      const mapType = LogicalTypes.map(LogicalTypes.varchar(), LogicalTypes.varchar());
      return {
        names: ["database_name", "database_oid", "path", "comment", "tags", "internal", "type", "readonly", "encrypted", "cipher", "options"],
        types: [
          LogicalTypes.varchar(),
          LogicalTypes.bigint(),
          LogicalTypes.varchar(),
          LogicalTypes.varchar(),
          mapType,
          LogicalTypes.boolean(),
          LogicalTypes.varchar(),
          LogicalTypes.boolean(),
          LogicalTypes.boolean(),
          LogicalTypes.varchar(),
          mapType
        ],
        rows: [
          ["memory", 1n, null, null, [], false, "duckdb", false, false, null, []],
          ["system", 0n, null, null, [], true, "duckdb", false, false, null, []],
          ["temp", 2n, null, null, [], true, "duckdb", false, false, null, []]
        ]
      };
    }
    if (!/\bduckdb_(?:tables|views)\s*\(\s*\)/i.test(statement)) {
      return undefined;
    }
    if (
      /\bFROM\s+(?:"[^"]+"|[A-Za-z_][\w$]*)\.ducklake_inlined_data_tables\s+idt\b/i.test(statement) &&
      /\bJOIN\s+duckdb_tables\s*\(\s*\)\s+dt\b/i.test(statement) &&
      /\bdt\.estimated_size\s*=\s*0\b/i.test(statement)
    ) {
      return this.duckLake.emptySupersededInlinedTables(statement);
    }
    if (/\bFROM\s+duckdb_tables\s*\(\s*\)\s+UNION\s+ALL\s+SELECT\b[\s\S]*\bFROM\s+duckdb_views\s*\(\s*\)/i.test(statement)) {
      return {
        names: ["schema_name", "sql", "'table'"],
        types: [LogicalTypes.varchar(), LogicalTypes.varchar(), LogicalTypes.varchar()],
        rows: this.userTables().map((tableName) => {
          const identity = splitStoredTableName(tableName);
          return [identity.schemaName, this.createTableSqlForDuckDb(tableName), "table"];
        })
      };
    }
    if (/\bduckdb_views\s*\(\s*\)/i.test(statement)) {
      return {
        names: ["schema_name", "view_name", "sql"],
        types: [LogicalTypes.varchar(), LogicalTypes.varchar(), LogicalTypes.varchar()],
        rows: []
      };
    }
    if (/COUNT\s*\(\s*\*\s*\)/i.test(statement)) {
      return {
        names: ["count_star()"],
        types: [LogicalTypes.bigint()],
        rows: [[BigInt(this.userTables().length)]]
      };
    }
    return {
      names: ["database_name", "schema_name", "table_name", "sql"],
      types: [LogicalTypes.varchar(), LogicalTypes.varchar(), LogicalTypes.varchar(), LogicalTypes.varchar()],
      rows: this.userTables().map((tableName) => {
        const identity = splitStoredTableName(tableName);
        return ["memory", identity.schemaName, identity.tableName, this.createTableSqlForDuckDb(tableName)];
      })
    };
  }

  private ensureSchema(schemaName: string): void {
    this.sql.exec("INSERT OR IGNORE INTO __dq_schemas (schema_name, created_at) VALUES (?, ?)", schemaName, new Date().toISOString());
  }

  private schemaNames(): string[] {
    const explicit = this.sql.exec<{ schema_name: string }>("SELECT schema_name FROM __dq_schemas").toArray().map((row) => row.schema_name);
    const derived = this.userTables()
      .map((name) => name.includes("__") ? name.split("__")[0] : undefined)
      .filter((name): name is string => !!name);
    return [...new Set([...explicit, ...derived])].sort();
  }

  private createTableSqlForDuckDb(storedTableName: string): string {
    const identity = splitStoredTableName(storedTableName);
    const columns = this.getColumns(storedTableName);
    const columnSql = columns.map((column) => `${quoteIdentifier(column.name)} ${duckDbTypeName(column)}`).join(", ");
    return `CREATE TABLE ${quoteIdentifier(identity.schemaName)}.${quoteIdentifier(identity.tableName)} (${columnSql});`;
  }

  private resolveResultTypes(sqlText: string, names: string[], rows: Record<string, SqlStorageValue>[]): LogicalType[] {
    const sourceColumns = findSourceTables(sqlText).flatMap((sourceTable) => this.getColumns(sourceTable));
    const aliasSources = selectAliasSourceColumnNames(sqlText);
    return names.map((name) => {
      if (/^count\b|^count\s*\(|^COUNT\b|^COUNT\s*\(/.test(name)) {
        return LogicalTypes.bigint();
      }
      if (/\b(?:MAX|MIN|SUM)\s*\(/i.test(name)) {
        return LogicalTypes.bigint();
      }
      const aggregateColumnName = aggregateSourceColumnName(name);
      const tracked =
        sourceColumns.find((column) => column.name === name) ??
        sourceColumns.find((column) => column.name === aliasSources.get(name)) ??
        sourceColumns.find((column) => name.endsWith(`_${column.name}`)) ??
        sourceColumns.find((column) => column.name === aggregateColumnName);
      if (tracked) {
        return tracked.type;
      }
      return inferLogicalType(rows.map((row) => row[name]));
    });
  }

  private getColumns(tableName: string): ColumnInfo[] {
    return this.sql
      .exec<{ column_name: string; ordinal: number; logical_type_json: string; sqlite_type: string }>(
        `SELECT column_name, ordinal, logical_type_json, sqlite_type
         FROM __dq_table_columns
         WHERE table_name = ?
         ORDER BY ordinal`,
        tableName
      )
      .toArray()
      .map((row) => ({
        name: row.column_name,
        ordinal: row.ordinal,
        type: deserializeLogicalType(row.logical_type_json),
        sqliteType: row.sqlite_type
      }));
  }

  private columnExists(tableName: string, columnName: string): boolean {
    const row = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM __dq_table_columns WHERE table_name = ? AND column_name = ?",
        tableName,
        columnName
      )
      .one();
    return row.count > 0;
  }

  private nextColumnOrdinal(tableName: string): number {
    const row = this.sql
      .exec<{ next_ordinal: number | null }>("SELECT COALESCE(MAX(ordinal) + 1, 0) AS next_ordinal FROM __dq_table_columns WHERE table_name = ?", tableName)
      .one();
    return row.next_ordinal ?? 0;
  }

  private tableExists(tableName: string): boolean {
    const row = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        tableName
      )
      .one();
    return row.count > 0;
  }

  private tableRowCount(tableName: string): number {
    return this.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).one().count;
  }

  private validateDuckLakeDataPathWrite(statement: string): void {
    if (!this.validateDuckLakeDataPath) {
      return;
    }
    for (const dataPath of duckLakeDataPathValuesFromMetadataWrite(statement)) {
      this.validateDuckLakeDataPath(dataPath);
    }
  }

  private validateExistingDuckLakeDataPaths(): void {
    if (!this.validateDuckLakeDataPath) {
      return;
    }
    for (const dataPath of this.duckLakeDataPaths()) {
      this.validateDuckLakeDataPath(dataPath);
    }
  }

  private duckLakeDataPaths(): string[] {
    const metadataTables = this.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND (name = 'ducklake_metadata' OR name LIKE '%__ducklake_metadata') ORDER BY name"
      )
      .toArray();
    const dataPaths: string[] = [];
    for (const table of metadataTables) {
      const rows = this.sql
        .exec<{ value: string }>(
          `SELECT value FROM ${quoteIdentifier(table.name)} WHERE key = 'data_path' ORDER BY rowid`
        )
        .toArray();
      dataPaths.push(...rows.map((row) => row.value));
    }
    return dataPaths;
  }

  private bumpTableVersion(tableName: string): void {
    this.sql.exec(
      `INSERT INTO __dq_table_versions (table_name, version) VALUES (?, 1)
       ON CONFLICT(table_name) DO UPDATE SET version = version + 1`,
      tableName
    );
  }

  private beginTransaction(sessionId: string): void {
    const active = this.sql
      .exec<{ in_transaction: number }>("SELECT in_transaction FROM __dq_sessions WHERE session_id = ?", sessionId)
      .one();
    if (active.in_transaction) {
      throw new Error("Transaction already active");
    }
    const txId = crypto.randomUUID();
    const snapshot = this.snapshotDatabase();
    const now = new Date().toISOString();
    this.sql.exec(
      "INSERT OR REPLACE INTO __dq_tx_snapshots (session_id, tx_id, snapshot_json, created_at) VALUES (?, ?, ?, ?)",
      sessionId,
      txId,
      JSON.stringify(snapshot),
      now
    );
    this.sql.exec("UPDATE __dq_sessions SET in_transaction = 1, tx_id = ? WHERE session_id = ?", txId, sessionId);
  }

  private commitTransaction(sessionId: string): void {
    this.sql.exec("DELETE FROM __dq_tx_snapshots WHERE session_id = ?", sessionId);
    this.sql.exec("UPDATE __dq_sessions SET in_transaction = 0, tx_id = NULL WHERE session_id = ?", sessionId);
  }

  private rollbackTransaction(sessionId: string): void {
    const row = this.sql
      .exec<{ snapshot_json: string }>("SELECT snapshot_json FROM __dq_tx_snapshots WHERE session_id = ?", sessionId)
      .one();
    if (!row) {
      throw new Error("No active transaction");
    }
    const snapshot = JSON.parse(row.snapshot_json) as TransactionSnapshot;
    for (const table of this.userTables()) {
      this.sql.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
    }
    for (const table of snapshot.tables) {
      this.sql.exec(table.createSql);
      for (const rawRow of table.rows) {
        const names = Object.keys(rawRow);
        if (names.length === 0) {
          continue;
        }
        this.sql.exec(
          `INSERT INTO ${quoteIdentifier(table.name)} (${names.map(quoteIdentifier).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
          ...names.map((name) => normalizeSnapshotValue(rawRow[name]))
        );
      }
    }
    this.sql.exec("DELETE FROM __dq_table_columns");
    for (const column of snapshot.columns) {
      this.sql.exec(
        `INSERT INTO __dq_table_columns (table_name, column_name, ordinal, logical_type_json, sqlite_type)
         VALUES (?, ?, ?, ?, ?)`,
        String(column.table_name),
        String(column.column_name),
        Number(column.ordinal),
        String(column.logical_type_json),
        String(column.sqlite_type)
      );
    }
    this.sql.exec("DELETE FROM __dq_table_versions");
    for (const version of snapshot.versions) {
      this.sql.exec(
        "INSERT INTO __dq_table_versions (table_name, version) VALUES (?, ?)",
        String(version.table_name),
        Number(version.version)
      );
    }
    this.sql.exec("DELETE FROM __dq_schemas");
    for (const schema of snapshot.schemas ?? []) {
      this.sql.exec(
        "INSERT INTO __dq_schemas (schema_name, created_at) VALUES (?, ?)",
        String(schema.schema_name),
        String(schema.created_at)
      );
    }
    this.sql.exec("DELETE FROM __dq_tx_snapshots WHERE session_id = ?", sessionId);
    this.sql.exec("UPDATE __dq_sessions SET in_transaction = 0, tx_id = NULL WHERE session_id = ?", sessionId);
  }

  private snapshotDatabase(): TransactionSnapshot {
    const tables = this.userTables().map((name): SnapshotTable => {
      const createSql = this.sql
        .exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", name)
        .one().sql;
      return {
        name,
        createSql,
        rows: this.sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${quoteIdentifier(name)}`).toArray()
      };
    });
    return {
      tables,
      columns: this.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM __dq_table_columns").toArray(),
      versions: this.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM __dq_table_versions").toArray(),
      schemas: this.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM __dq_schemas").toArray()
    };
  }

  private userTables(): string[] {
    return this.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '__dq_%' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .toArray()
      .map((row) => row.name);
  }
}
