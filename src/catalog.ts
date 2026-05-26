import { DurableObject } from "cloudflare:workers";
import type { Schema } from "@polyglot-sql/sdk";
import { MessageType } from "./quack-imports";
import type {
  AppendRequestMessage,
  ConnectionRequestMessage,
  ConnectionResponseMessage,
  FetchRequestMessage,
  FetchResponseMessage,
  LogicalType,
  PrepareRequestMessage,
  PrepareResponseMessage,
  QuackDataChunk,
  QuackMessage,
  QuackValue
} from "./quack-imports";
import { randomId } from "./crypto";
import { createDuckLakeDataPathValidator } from "./ducklake-data-path";
import { SqlCompatibilityLayer } from "./sql-compat";
import { createExternalFileLister } from "./file-listing";
import type { ListedFile } from "./file-listing";
import type { RuntimeEnv } from "./env";
import type { SessionAuthContext } from "./auth";
import { classifyAppend, classifySqlText, evaluatePolicy } from "./authz";

interface StoredResult {
  names: string[];
  typesJson: string[];
  chunksJson: string;
  nextOffset: number;
}

interface StoredSessionAuth {
  [key: string]: SqlStorageValue;
  principal_json: string;
  policy_json: string | null;
  policy_version: number;
  catalog_id: string;
}

export class QuackCatalogObject extends DurableObject<RuntimeEnv> {
  private readonly compat: SqlCompatibilityLayer;

  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env);
    this.compat = new SqlCompatibilityLayer(ctx.storage.sql, {
      listFiles: createExternalFileLister(env),
      validateDuckLakeDataPath: createDuckLakeDataPathValidator(() => this.plannedDataPath())
    });
    ctx.blockConcurrencyWhile(async () => {
      this.compat.initialize();
      this.initialize();
    });
  }

  openConnection(request: ConnectionRequestMessage, auth: SessionAuthContext): ConnectionResponseMessage {
    const min = BigInt(request.minSupportedQuackVersion ?? 1n);
    if (min > 1n) {
      throw new Error("Client requires a newer Quack protocol version than this server supports");
    }
    const sessionId = randomId("sess");
    this.compat.createSession(sessionId);
    this.storeSessionAuth(sessionId, auth);
    return {
      type: MessageType.CONNECTION_RESPONSE,
      connectionId: sessionId,
      serverDuckdbVersion: "quacklake/sqlite",
      serverPlatform: "cloudflare-workers-durable-objects",
      quackVersion: 1n
    };
  }

  async handleMessage(message: QuackMessage): Promise<QuackMessage> {
    try {
      switch (message.type) {
        case MessageType.PREPARE_REQUEST:
          return await this.prepare(message);
        case MessageType.FETCH_REQUEST:
          return this.fetchResult(message);
        case MessageType.APPEND_REQUEST:
          return this.append(message);
        case MessageType.DISCONNECT_MESSAGE:
          return this.disconnect(message.connectionId);
        default:
          return this.error(message, `Unsupported request message type ${MessageType[message.type] ?? message.type}`);
      }
    } catch (error) {
      return this.error(message, error instanceof Error ? error.message : String(error));
    }
  }

  stats(): Record<string, number> {
    const base = this.compat.stats();
    const results = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM __dq_results").one().count;
    return { ...base, results };
  }

  replaceFileInventory(files: ListedFile[]): { files: number } {
    return this.compat.replaceFileInventory(files);
  }

  listFileInventory(): { files: ListedFile[] } {
    return { files: this.compat.listFileInventory() };
  }

  authorizationSchema(): Schema {
    return this.compat.authorizationSchema();
  }

  duckLakeDataPath(): string | undefined {
    return this.compat.duckLakeDataPath();
  }

  async configureCatalog(config: { dataPath: string }): Promise<{ dataPath: string }> {
    if (!config.dataPath) {
      throw new Error("dataPath is required");
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO __dq_catalog_config (id, data_path, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data_path = excluded.data_path, updated_at = excluded.updated_at`,
      config.dataPath,
      new Date().toISOString()
    );
    return { dataPath: config.dataPath };
  }

  private async prepare(message: PrepareRequestMessage): Promise<PrepareResponseMessage> {
    const sessionId = this.requireSession(message.connectionId);
    this.authorizeSql(sessionId, message.sql);
    const result = await this.compat.execute(sessionId, message.sql, { rowsPerChunk: this.rowsPerChunk() });
    const allChunks = this.compat.resultToChunks(result, this.rowsPerChunk());
    const firstBatch = allChunks.slice(0, this.chunksPerBatch());
    const needsMoreFetch = allChunks.length > firstBatch.length;
    const resultUuid = this.createResultId();
    this.storeResult(sessionId, resultUuid.key, result.names, result.types.map((type) => JSON.stringify(type)), allChunks, firstBatch.length);
    return {
      type: MessageType.PREPARE_RESPONSE,
      connectionId: sessionId,
      resultNames: result.names,
      resultTypes: result.types,
      results: firstBatch,
      needsMoreFetch,
      resultUuid: resultUuid.parts
    };
  }

  private fetchResult(message: FetchRequestMessage): FetchResponseMessage {
    const sessionId = this.requireSession(message.connectionId);
    const resultKey = resultKeyFromHugeInt(message.resultUuid);
    const stored = this.loadResult(sessionId, resultKey);
    if (!stored) {
      throw new Error("Result has been closed");
    }
    const chunks = JSON.parse(stored.chunksJson) as unknown[];
    const batch = this.deserializeChunks(chunks).slice(stored.nextOffset, stored.nextOffset + this.chunksPerBatch());
    const nextOffset = stored.nextOffset + batch.length;
    this.ctx.storage.sql.exec(
      "UPDATE __dq_results SET next_offset = ?, updated_at = ? WHERE session_id = ? AND result_id = ?",
      nextOffset,
      new Date().toISOString(),
      sessionId,
      resultKey
    );
    return {
      type: MessageType.FETCH_RESPONSE,
      connectionId: sessionId,
      results: batch,
      batchIndex: BigInt(Math.ceil(nextOffset / this.chunksPerBatch()))
    };
  }

  private append(message: AppendRequestMessage): QuackMessage {
    const sessionId = this.requireSession(message.connectionId);
    this.authorizeAppend(sessionId, message.schemaName, message.tableName);
    this.compat.appendChunk(message.schemaName, message.tableName, message.appendChunk);
    return { type: MessageType.SUCCESS_RESPONSE, connectionId: message.connectionId };
  }

  private disconnect(connectionId: string | undefined): QuackMessage {
    const sessionId = this.requireSession(connectionId);
    this.compat.deleteSession(sessionId);
    this.ctx.storage.sql.exec("DELETE FROM __dq_results WHERE session_id = ?", sessionId);
    this.ctx.storage.sql.exec("DELETE FROM __dq_session_auth WHERE session_id = ?", sessionId);
    return { type: MessageType.SUCCESS_RESPONSE, connectionId: sessionId };
  }

  private requireSession(connectionId: string | undefined): string {
    if (!connectionId) {
      throw new Error("Missing connection id");
    }
    const row = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM __dq_sessions WHERE session_id = ?", connectionId)
      .one();
    if (!row.count) {
      throw new Error("Invalid connection id");
    }
    return connectionId;
  }

  private authorizeSql(sessionId: string, sqlText: string): void {
    const auth = this.loadSessionAuth(sessionId);
    const statements = classifySqlText(sqlText, this.compat.authorizationSchema());
    const decision = evaluatePolicy(auth.principal, auth.policy, statements);
    if (!decision.allowed) {
      throw new Error(`Authorization denied: ${decision.reason}`);
    }
  }

  private authorizeAppend(sessionId: string, schemaName: string | undefined, tableName: string): void {
    const auth = this.loadSessionAuth(sessionId);
    const decision = evaluatePolicy(auth.principal, auth.policy, [classifyAppend(schemaName, tableName)]);
    if (!decision.allowed) {
      throw new Error(`Authorization denied: ${decision.reason}`);
    }
  }

  private storeSessionAuth(sessionId: string, auth: SessionAuthContext): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO __dq_session_auth
       (session_id, catalog_id, principal_json, policy_json, policy_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      sessionId,
      auth.catalogId,
      JSON.stringify(auth.principal),
      auth.policy ? JSON.stringify(auth.policy) : null,
      auth.policyVersion,
      new Date().toISOString()
    );
  }

  private loadSessionAuth(sessionId: string): SessionAuthContext {
    const row = this.ctx.storage.sql
      .exec<StoredSessionAuth>(
        "SELECT catalog_id, principal_json, policy_json, policy_version FROM __dq_session_auth WHERE session_id = ?",
        sessionId
      )
      .toArray()[0];
    if (!row) {
      throw new Error("Missing session auth context");
    }
    return {
      catalogId: row.catalog_id,
      principal: JSON.parse(row.principal_json) as SessionAuthContext["principal"],
      policy: row.policy_json ? JSON.parse(row.policy_json) as SessionAuthContext["policy"] : undefined,
      policyVersion: row.policy_version
    };
  }

  private storeResult(
    sessionId: string,
    resultId: string,
    names: string[],
    typesJson: string[],
    chunks: QuackDataChunk[],
    nextOffset: number
  ): void {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec("DELETE FROM __dq_results WHERE session_id = ?", sessionId);
    this.ctx.storage.sql.exec(
      `INSERT INTO __dq_results
       (result_id, session_id, names_json, types_json, chunks_json, next_offset, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      resultId,
      sessionId,
      JSON.stringify(names),
      JSON.stringify(typesJson),
      JSON.stringify(this.serializeChunks(chunks)),
      nextOffset,
      now,
      now
    );
  }

  private loadResult(sessionId: string, resultId: string): StoredResult | undefined {
    const rows = this.ctx.storage.sql
      .exec<{
        names_json: string;
        types_json: string;
        chunks_json: string;
        next_offset: number;
      }>(
        "SELECT names_json, types_json, chunks_json, next_offset FROM __dq_results WHERE session_id = ? AND result_id = ?",
        sessionId,
        resultId
      )
      .toArray();
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    return {
      names: JSON.parse(row.names_json) as string[],
      typesJson: JSON.parse(row.types_json) as string[],
      chunksJson: row.chunks_json,
      nextOffset: row.next_offset
    };
  }

  private serializeChunks(chunks: QuackDataChunk[]): unknown[] {
    return chunks.map((chunk) => ({
      rowCount: chunk.rowCount,
      types: chunk.types,
      columnNames: chunk.columnNames,
      columns: chunk.columns.map((column) => ({
        type: column.type,
        vectorType: column.vectorType,
        values: column.values.map(serializeQuackValue)
      }))
    }));
  }

  private deserializeChunks(raw: unknown[]): QuackDataChunk[] {
    return raw.map((item) => {
      const chunk = item as {
        rowCount: number;
        types: LogicalType[];
        columnNames?: string[];
        columns: Array<{ type: LogicalType; vectorType: number; values: unknown[] }>;
      };
      return {
        rowCount: chunk.rowCount,
        types: chunk.types,
        ...(chunk.columnNames ? { columnNames: chunk.columnNames } : {}),
        columns: chunk.columns.map((column) => ({
          type: column.type,
          vectorType: column.vectorType,
          values: column.values.map(deserializeQuackValue)
        }))
      };
    });
  }

  private createResultId(): { key: string; parts: { upper: bigint; lower: bigint } } {
    const upper = BigInt(Date.now());
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let lower = 0n;
    for (const byte of bytes) {
      lower = (lower << 8n) | BigInt(byte);
    }
    return { key: `${upper}:${lower}`, parts: { upper, lower } };
  }

  private error(message: { connectionId?: string }, errorMessage: string): QuackMessage {
    return {
      type: MessageType.ERROR_RESPONSE,
      ...(message.connectionId ? { connectionId: message.connectionId } : {}),
      message: errorMessage
    };
  }

  private initialize(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS __dq_catalog_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data_path TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS __dq_results (
        result_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        names_json TEXT NOT NULL,
        types_json TEXT NOT NULL,
        chunks_json TEXT NOT NULL,
        next_offset INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, result_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS __dq_session_auth (
        session_id TEXT PRIMARY KEY,
        catalog_id TEXT NOT NULL,
        principal_json TEXT NOT NULL,
        policy_json TEXT,
        policy_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  private rowsPerChunk(): number {
    return readPositiveInt(this.env.QUACK_FETCH_ROWS_PER_CHUNK, 1024);
  }

  private plannedDataPath(): string {
    const row = this.ctx.storage.sql
      .exec<{ data_path: string }>("SELECT data_path FROM __dq_catalog_config WHERE id = 1")
      .toArray()[0];
    if (!row?.data_path) {
      throw new Error("catalog planned dataPath is not configured");
    }
    return row.data_path;
  }

  private chunksPerBatch(): number {
    return readPositiveInt(this.env.QUACK_FETCH_CHUNKS_PER_BATCH, 12);
  }
}

function resultKeyFromHugeInt(value: { upper: bigint; lower: bigint } | bigint | number | string): string {
  if (typeof value === "object" && value !== null && "upper" in value && "lower" in value) {
    return `${value.upper}:${value.lower}`;
  }
  return `0:${String(value)}`;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function serializeQuackValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return { __dq: "bigint", value: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { __dq: "bytes", value: [...value] };
  }
  if (Array.isArray(value)) {
    return value.map(serializeQuackValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, typeof nested === "bigint" ? { __dq: "bigint", value: nested.toString() } : serializeQuackValue(nested)])
    );
  }
  return value;
}

function deserializeQuackValue(value: unknown): QuackValue {
  if (Array.isArray(value)) {
    return value.map(deserializeQuackValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.__dq === "bigint") {
      return BigInt(String(record.value ?? 0));
    }
    if (record.__dq === "bytes" && Array.isArray(record.value)) {
      return new Uint8Array(record.value.map(Number));
    }
    return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, deserializeQuackValue(nested)]));
  }
  return value as QuackValue;
}
