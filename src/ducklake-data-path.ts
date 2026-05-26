export function plannedDuckLakeDataPath(bucket: string, catalogId: string): string {
  return `r2://${bucket}/catalogs/${catalogId}/`;
}

export function createDuckLakeDataPathValidator(plannedDataPath: () => string): (dataPath: string) => void {
  return (dataPath: string) => assertPlannedDuckLakeDataPath(dataPath, plannedDataPath());
}

export function assertPlannedDuckLakeDataPath(dataPath: string, plannedDataPath: string): void {
  if (dataPath !== plannedDataPath) {
    throw new Error(
      `DuckLake DATA_PATH must match the catalog planned dataPath ${JSON.stringify(plannedDataPath)}; got ${JSON.stringify(dataPath)}`
    );
  }
}

export function duckLakeDataPathValuesFromMetadataWrite(statement: string): string[] {
  const trimmed = statement.trim();
  if (!/\bducklake_metadata\b/i.test(trimmed)) {
    return [];
  }
  return insertDataPathValues(trimmed) ?? updateDataPathValues(trimmed) ?? [];
}

function insertDataPathValues(statement: string): string[] | undefined {
  const match = statement.match(
    /^INSERT\s+INTO\s+(?:(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\s*\.\s*)?(?:"ducklake_metadata"|`ducklake_metadata`|ducklake_metadata)\b\s*(?:\(([^)]*)\))?\s+VALUES\s*([\s\S]*)$/i
  );
  if (!match?.[2]) {
    return undefined;
  }
  const columns = match[1] ? splitTopLevel(match[1]).map(normalizeIdentifier) : [];
  const keyIndex = columns.length > 0 ? columns.indexOf("key") : 0;
  const valueIndex = columns.length > 0 ? columns.indexOf("value") : 1;
  if (keyIndex < 0 || valueIndex < 0) {
    return [];
  }
  return parseValueTuples(match[2]).flatMap((tuple) => {
    const key = tuple[keyIndex];
    const value = tuple[valueIndex];
    return key === "data_path" && typeof value === "string" ? [value] : [];
  });
}

function updateDataPathValues(statement: string): string[] | undefined {
  const match = statement.match(
    /^UPDATE\s+(?:(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*)\s*\.\s*)?(?:"ducklake_metadata"|`ducklake_metadata`|ducklake_metadata)\b\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]*)$/i
  );
  if (!match?.[1] || !match[2] || !/\bkey\s*=\s*'data_path'/i.test(match[2])) {
    return undefined;
  }
  const value = match[1].match(/\bvalue\s*=\s*'((?:''|[^'])*)'/i)?.[1];
  return value === undefined ? [] : [sqlStringValue(value)];
}

function parseValueTuples(valuesSql: string): Array<Array<string | null | undefined>> {
  const tuples: Array<Array<string | null | undefined>> = [];
  for (const tupleSql of topLevelTuples(valuesSql)) {
    tuples.push(splitTopLevel(tupleSql).map(sqlScalarValue));
  }
  return tuples;
}

function topLevelTuples(valuesSql: string): string[] {
  const tuples: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let index = 0; index < valuesSql.length; index++) {
    const char = valuesSql[index];
    if (inString) {
      if (char === "'" && valuesSql[index + 1] === "'") {
        index++;
      } else if (char === "'") {
        inString = false;
      }
      continue;
    }
    if (char === "'") {
      inString = true;
      continue;
    }
    if (char === "(") {
      if (depth === 0) {
        start = index + 1;
      }
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0 && start >= 0) {
        tuples.push(valuesSql.slice(start, index));
        start = -1;
      }
    }
  }
  return tuples;
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (inString) {
      if (char === "'" && input[index + 1] === "'") {
        index++;
      } else if (char === "'") {
        inString = false;
      }
      continue;
    }
    if (char === "'") {
      inString = true;
    } else if (char === "(" || char === "[") {
      depth++;
    } else if (char === ")" || char === "]") {
      depth--;
    } else if (char === "," && depth === 0) {
      parts.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts;
}

function sqlScalarValue(input: string): string | null | undefined {
  const trimmed = input.trim();
  const stringMatch = trimmed.match(/^'((?:''|[^'])*)'$/);
  if (stringMatch?.[1] !== undefined) {
    return sqlStringValue(stringMatch[1]);
  }
  if (/^NULL$/i.test(trimmed)) {
    return null;
  }
  return undefined;
}

function sqlStringValue(value: string): string {
  return value.replaceAll("''", "'");
}

function normalizeIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("`") && trimmed.endsWith("`"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.toLowerCase();
}
