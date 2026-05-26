import { unquoteIdentifier } from "./sql-text";

export function normalizeTableName(raw: string): string {
  const parts = identifierParts(raw);
  if (parts.length === 0) {
    throw new Error(`Invalid table name ${raw}`);
  }
  return parts.join("__");
}

export function normalizeSchemaName(raw: string): string {
  const parts = identifierParts(raw);
  if (parts.length !== 1) {
    throw new Error(`Invalid schema name ${raw}`);
  }
  return parts[0] ?? "";
}

export function schemaNameFromTableName(raw: string): string | undefined {
  const parts = identifierParts(raw);
  if (parts.length <= 1) {
    return undefined;
  }
  return parts.slice(0, -1).join("__");
}

export function identifierParts(raw: string): string[] {
  return raw
    .trim()
    .replace(/\s+/g, "")
    .split(".")
    .map((part) => unquoteIdentifier(part).trim())
    .filter(Boolean);
}

export function splitStoredTableName(storedTableName: string): { schemaName: string; tableName: string } {
  const separator = storedTableName.indexOf("__");
  if (separator === -1) {
    return { schemaName: "main", tableName: storedTableName };
  }
  return {
    schemaName: storedTableName.slice(0, separator),
    tableName: storedTableName.slice(separator + 2)
  };
}

export function metadataSchemaName(statement: string, tableName: string): string | undefined {
  const match = statement.match(new RegExp(`\\bFROM\\s+("[^"]+"|[A-Za-z_][\\w$]*)\\.${tableName}\\b`, "i"));
  return match?.[1] ? normalizeSchemaName(match[1]) : undefined;
}

export function snapshotIdFromPredicate(statement: string): number {
  const match = statement.match(/\b(\d+)\s*>=\s+(?:(?:"[^"]+"|[A-Za-z_][\w$]*)\.)?begin_snapshot\b/i);
  return match?.[1] ? Number(match[1]) : 0;
}

export function firstNumberAfter(statement: string, pattern: RegExp): number | undefined {
  const match = statement.match(pattern);
  return match?.[1] ? Number(match[1]) : undefined;
}
