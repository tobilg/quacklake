export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    const next = sql[index + 1];

    if (lineComment) {
      current += char;
      if (char === "\n") {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        index++;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) {
        if (quote === "'" && next === "'") {
          current += next;
          index++;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      current += char + next;
      index++;
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      current += char + next;
      index++;
      blockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      current += char;
      quote = char;
      continue;
    }
    if (char === ";") {
      const trimmed = current.trim();
      if (trimmed) {
        statements.push(trimmed);
      }
      current = "";
      continue;
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) {
    statements.push(trimmed);
  }
  return statements;
}

export function splitTopLevel(input: string, separator = ","): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;

  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    const next = input[index + 1];
    if (quote) {
      current += char;
      if (char === quote) {
        if (quote === "'" && next === "'") {
          current += next;
          index++;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && char === separator) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

export function removeDuckDbCasts(sql: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    const next = sql[index + 1];
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
    if (char === ":" && next === ":") {
      index += 2;
      while (/\s/.test(sql[index] ?? "")) {
        index++;
      }
      while (/[A-Za-z0-9_]/.test(sql[index] ?? "")) {
        index++;
      }
      if (sql[index] === "(") {
        let depth = 1;
        index++;
        while (index < sql.length && depth > 0) {
          if (sql[index] === "(") {
            depth++;
          } else if (sql[index] === ")") {
            depth--;
          }
          index++;
        }
      }
      index--;
      continue;
    }
    result += char;
  }
  return result;
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("`") && trimmed.endsWith("`"))) {
    const quote = trimmed[0]!;
    return trimmed.slice(1, -1).replaceAll(quote + quote, quote);
  }
  return trimmed;
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
