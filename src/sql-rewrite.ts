import { LogicalTypeId } from "./quack-imports";
import { logicalTypeFromDuckDbType, sqliteTypeForLogicalType } from "./quack-values";
import { quoteIdentifier, removeDuckDbCasts, splitTopLevel, sqlString, unquoteIdentifier } from "./sql-text";
import { identifierParts, normalizeTableName } from "./sql-names";
import type { ColumnInfo, ParsedColumnInfo } from "./sql-types";

export function rewriteDuckDbSql(
  statement: string,
  options: { shouldRewriteQualifiedName?: (normalizedName: string) => boolean } = {}
): string {
  let rewritten = statement.trim();
  rewritten = rewritten.replace(/^CREATE\s+TEMP(?:ORARY)?\s+TABLE\b/i, "CREATE TABLE");
  rewritten = replaceFunctions(rewritten);
  rewritten = removeDuckDbCasts(rewritten);
  rewritten = stripOrderByAll(rewritten);
  rewritten = rewriteHashOrderByOrdinals(rewritten);
  rewritten = stripMaterializedHints(rewritten);
  rewritten = replaceBooleanLiterals(rewritten);
  rewritten = rewriteDeleteAliases(rewritten);
  rewritten = rewriteUpdateTargetReferences(rewritten);
  rewritten = rewritten.replace(/\bAS\s+TIMESTAMPTZ\b/gi, "AS TEXT");
  rewritten = rewritten.replace(/\bAS\s+TIMESTAMP\b/gi, "AS TEXT");
  rewritten = rewritten.replace(/\bAS\s+VARCHAR\b/gi, "AS TEXT");
  rewritten = rewritten.replace(/\bAS\s+BIGINT\b/gi, "AS INTEGER");
  rewritten = rewriteQualifiedNames(rewritten, options.shouldRewriteQualifiedName);
  return rewritten;
}

export function duckDbTypeName(column: ColumnInfo): string {
  switch (column.type.id) {
    case LogicalTypeId.BOOLEAN:
      return "BOOLEAN";
    case LogicalTypeId.TINYINT:
      return "TINYINT";
    case LogicalTypeId.SMALLINT:
      return "SMALLINT";
    case LogicalTypeId.INTEGER:
      return "INTEGER";
    case LogicalTypeId.BIGINT:
      return "BIGINT";
    case LogicalTypeId.UTINYINT:
      return "UTINYINT";
    case LogicalTypeId.USMALLINT:
      return "USMALLINT";
    case LogicalTypeId.UINTEGER:
      return "UINTEGER";
    case LogicalTypeId.UBIGINT:
      return "UBIGINT";
    case LogicalTypeId.FLOAT:
      return "FLOAT";
    case LogicalTypeId.DOUBLE:
      return "DOUBLE";
  }
  if (column.sqliteType === "TEXT") {
    return "VARCHAR";
  }
  if (column.sqliteType === "INTEGER") {
    return "BIGINT";
  }
  if (column.sqliteType === "REAL") {
    return "DOUBLE";
  }
  if (column.sqliteType === "BLOB") {
    return "BLOB";
  }
  return column.sqliteType;
}

export function parseColumnDefinitions(rawColumns: string): ParsedColumnInfo[] {
  return splitTopLevel(rawColumns).map((definition, ordinal) => {
    const match = definition.match(/^("[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\s+([\s\S]+)$/);
    if (!match) {
      throw new Error(`Unsupported column definition: ${definition}`);
    }
    const [, rawName, rest] = match;
    const { typeName, constraints } = splitTypeAndConstraints(rest ?? "");
    const type = logicalTypeFromDuckDbType(typeName);
    let sqliteType = sqliteTypeForLogicalType(type);
    let sqliteConstraints = constraints;
    if (/\bPRIMARY\s+KEY\b/i.test(sqliteConstraints) && (type.id === LogicalTypeId.BIGINT || type.id === LogicalTypeId.INTEGER)) {
      sqliteType = "INTEGER";
    }
    sqliteConstraints = sqliteConstraints.replace(/\bDEFAULT\s+TRUE\b/gi, "DEFAULT 1").replace(/\bDEFAULT\s+FALSE\b/gi, "DEFAULT 0");
    return {
      name: unquoteIdentifier(rawName ?? ""),
      ordinal,
      type,
      sqliteType,
      constraints: sqliteConstraints
    };
  });
}

export function isMutation(sqlText: string): boolean {
  return /^(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i.test(sqlText.trim());
}

export function findMutatedTable(sqlText: string): string | undefined {
  const match =
    sqlText.match(/^INSERT\s+INTO\s+("[^"]+"|[A-Za-z_][\w$]*)/i) ??
    sqlText.match(/^UPDATE\s+("[^"]+"|[A-Za-z_][\w$]*)/i) ??
    sqlText.match(/^DELETE\s+FROM\s+("[^"]+"|[A-Za-z_][\w$]*)/i) ??
    sqlText.match(/^ALTER\s+TABLE\s+("[^"]+"|[A-Za-z_][\w$]*)/i) ??
    sqlText.match(/^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)/i);
  return match?.[1] ? unquoteIdentifier(match[1]) : undefined;
}

export function findSourceTables(sqlText: string): string[] {
  return [...sqlText.matchAll(/\b(?:FROM|JOIN)\s+("[^"]+"|[A-Za-z_][\w$]*)/gi)]
    .map((match) => match[1])
    .filter((rawTableName): rawTableName is string => !!rawTableName)
    .map(unquoteIdentifier)
    .filter((tableName, index, tableNames) => tableNames.indexOf(tableName) === index);
}

export function selectAliasSourceColumnNames(sqlText: string): Map<string, string> {
  const result = new Map<string, string>();
  const selectList = topLevelSelectList(sqlText);
  if (!selectList) {
    return result;
  }
  for (const projection of splitTopLevel(selectList)) {
    const match = projection.match(/([\s\S]+?)\s+AS\s+("[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\s*$/i);
    if (!match?.[1] || !match[2]) {
      continue;
    }
    const sourceColumn = sourceColumnFromProjection(match[1]);
    if (sourceColumn) {
      result.set(unquoteIdentifier(match[2]), sourceColumn);
    }
  }
  return result;
}

export function aggregateSourceColumnName(resultName: string): string | undefined {
  const match = resultName.match(/^(?:MAX|MIN|SUM)\s*\(\s*"?([A-Za-z_][\w$]*)"?\s*\)$/i);
  return match?.[1];
}

export function normalizeSnapshotValue(value: unknown): string | number | ArrayBuffer | null {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number") {
    return value ?? null;
  }
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (value instanceof Uint8Array) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy.buffer;
  }
  return String(value);
}

function splitTypeAndConstraints(rest: string): { typeName: string; constraints: string } {
  const keywords = ["PRIMARY", "NOT", "NULL", "DEFAULT", "UNIQUE", "CHECK", "REFERENCES", "COLLATE", "GENERATED"];
  const tokens = rest.trim().split(/\s+/);
  let depth = 0;
  let splitIndex = tokens.length;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    for (const char of token) {
      if (char === "(") {
        depth++;
      } else if (char === ")") {
        depth = Math.max(0, depth - 1);
      }
    }
    if (depth === 0 && keywords.includes(token.toUpperCase())) {
      splitIndex = index;
      break;
    }
  }
  return {
    typeName: tokens.slice(0, splitIndex).join(" "),
    constraints: tokens.slice(splitIndex).join(" ")
  };
}

function replaceFunctions(sqlText: string): string {
  return sqlText
    .replace(/\bNOW\s*\(\s*\)/gi, () => sqlString(new Date().toISOString()))
    .replace(/\bUUID\s*\(\s*\)/gi, () => sqlString(crypto.randomUUID()))
    .replace(/\bSTRING_AGG\s*\(/gi, "GROUP_CONCAT(")
    .replace(
      /\bTRY_CAST\s*\(\s*regexp_extract\s*\(\s*partial_file_info\s*,\s*'partial_max:[^']+'\s*,\s*1\s*\)\s+AS\s+BIGINT\s*\)/gi,
      "CAST(substr(partial_file_info, instr(partial_file_info, 'partial_max:') + length('partial_max:')) AS INTEGER)"
    )
    .replace(/\bTRY_CAST\s*\(([^()]+?)\s+AS\s+([A-Za-z_][A-Za-z0-9_]*(?:\s+[A-Za-z_][A-Za-z0-9_]*)?)\s*\)/gi, (_match, expression, typeName) => {
      return `CAST(${expression} AS ${sqliteCastType(typeName)})`;
    });
}

function stripOrderByAll(sqlText: string): string {
  return sqlText.replace(/\s+ORDER\s+BY\s+ALL(?:\s+(?:ASC|DESC))?\s*$/i, "");
}

function rewriteHashOrderByOrdinals(sqlText: string): string {
  return sqlText.replace(/\bORDER\s+BY\s+[\s\S]*$/i, (orderBy) => orderBy.replace(/#(\d+)\b/g, "$1"));
}

function stripMaterializedHints(sqlText: string): string {
  return sqlText.replace(/\bAS\s+(?:NOT\s+)?MATERIALIZED\s*\(/gi, "AS (");
}

function rewriteDeleteAliases(sqlText: string): string {
  const identifier = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|[A-Za-z_][\w$]*)`;
  const match = sqlText.match(new RegExp(String.raw`^DELETE\s+FROM\s+(${identifier}(?:\s*\.\s*${identifier})?)\s+([A-Za-z_][\w$]*)\s+WHERE\s+([\s\S]*)$`, "i"));
  if (!match?.[1] || !match[2] || !match[3]) {
    return sqlText;
  }
  const tableName = quoteIdentifier(normalizeTableName(match[1]));
  return `DELETE FROM ${tableName} WHERE rowid IN (SELECT ${match[2]}.rowid FROM ${tableName} ${match[2]} WHERE ${match[3]})`;
}

function rewriteUpdateTargetReferences(sqlText: string): string {
  const identifier = String.raw`(?:"[^"]+"|` + "`[^`]+`" + String.raw`|[A-Za-z_][\w$]*)`;
  const match = sqlText.match(new RegExp(String.raw`\bUPDATE\s+(${identifier}(?:\s*\.\s*${identifier})?)(?:\s+(?:AS\s+)?[A-Za-z_][\w$]*)?\s+SET\b`, "i"));
  if (!match?.[1]) {
    return sqlText;
  }
  const parts = identifierParts(match[1]);
  const targetTableName = parts.at(-1);
  if (!targetTableName) {
    return sqlText;
  }
  const targetQualifier = quoteIdentifier(normalizeTableName(match[1]));
  return sqlText.replace(new RegExp(String.raw`\b${escapeRegExp(targetTableName)}\s*\.`, "g"), `${targetQualifier}.`);
}

function sqliteCastType(typeName: string): string {
  const normalized = typeName.trim().replace(/\s+/g, " ").toUpperCase();
  if (
    [
      "BOOLEAN",
      "BOOL",
      "TINYINT",
      "SMALLINT",
      "INTEGER",
      "INT",
      "BIGINT",
      "HUGEINT",
      "UTINYINT",
      "USMALLINT",
      "UINTEGER",
      "UBIGINT"
    ].includes(normalized)
  ) {
    return "INTEGER";
  }
  if (["FLOAT", "REAL", "DOUBLE", "DOUBLE PRECISION"].includes(normalized)) {
    return "REAL";
  }
  if (["BLOB", "BYTEA"].includes(normalized)) {
    return "BLOB";
  }
  return "TEXT";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceBooleanLiterals(sqlText: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < sqlText.length; index++) {
    const char = sqlText[index]!;
    const next = sqlText[index + 1];
    if (quote) {
      result += char;
      if (char === quote) {
        if (quote === "'" && next === "'") {
          result += next;
          index++;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      result += char;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (/[A-Za-z0-9_]/.test(sqlText[end] ?? "")) {
        end++;
      }
      const token = sqlText.slice(index, end);
      if (/^TRUE$/i.test(token)) {
        result += "1";
      } else if (/^FALSE$/i.test(token)) {
        result += "0";
      } else {
        result += token;
      }
      index = end - 1;
      continue;
    }
    result += char;
  }
  return result;
}

function rewriteQualifiedNames(sqlText: string, shouldRewrite?: (normalizedName: string) => boolean): string {
  return sqlText.replace(
    /(?<!['\w])(?:(?:"[^"]+"|[A-Za-z_][\w$]*)\s*\.\s*)+(?:"[^"]+"|[A-Za-z_][\w$]*)/g,
    (match) => {
      if (/^information_schema\s*\./i.test(match)) {
        return match;
      }
      const normalizedName = normalizeTableName(match);
      if (shouldRewrite && !shouldRewrite(normalizedName)) {
        return match;
      }
      return quoteIdentifier(normalizedName);
    }
  );
}

function topLevelSelectList(sqlText: string): string | undefined {
  const trimmed = sqlText.trim();
  if (!/^SELECT\b/i.test(trimmed)) {
    return undefined;
  }
  let quote: "'" | '"' | "`" | undefined;
  let depth = 0;
  for (let index = "SELECT".length; index < trimmed.length; index++) {
    const char = trimmed[index]!;
    const next = trimmed[index + 1];
    if (quote) {
      if (char === quote) {
        if (quote === "'" && next === "'") {
          index++;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    }
    const rest = trimmed.slice(index);
    if (depth === 0 && /^\s*FROM\b/i.test(rest)) {
      return trimmed.slice("SELECT".length, index).trim();
    }
  }
  return undefined;
}

function sourceColumnFromProjection(expression: string): string | undefined {
  const cast = expression.match(/^CAST\s*\(\s*([\s\S]+?)\s+AS\s+[\s\S]+?\)\s*$/i);
  const source = (cast?.[1] ?? expression).trim();
  const match = source.match(/(?:(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\s*\.\s*)?("[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\s*$/);
  if (!match?.[1]) {
    return undefined;
  }
  const column = unquoteIdentifier(match[1]);
  return /^(?:NULL|TRUE|FALSE)$/i.test(column) ? undefined : column;
}
