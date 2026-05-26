import { Dialect, generate, lineage, lineageWithSchema, parse } from "@polyglot-sql/sdk";
import type { LineageNode, Schema, TableSchema } from "@polyglot-sql/sdk";
import type {
  AuthAction,
  AuthPrincipal,
  AuthResource,
  CatalogAuthPolicy,
  CatalogAuthPolicyRule,
  PrincipalMatch
} from "./auth";
import { splitSqlStatements } from "./sql-text";

export type AuthorizationSqlSchema = Schema;

export interface RequiredPermission {
  action: AuthAction;
  resource: AuthResource;
}

export interface ClassifiedStatement {
  sql: string;
  confident: boolean;
  reason?: string;
  requiredActions: RequiredPermission[];
}

export interface AuthorizationDecision {
  allowed: boolean;
  reason: string;
  matchedRules: Array<{ ruleId: string; effect: "allow" | "deny" }>;
  requiredActions: RequiredPermission[];
  statements: ClassifiedStatement[];
}

interface ClassificationResult {
  confident: boolean;
  reason?: string;
  requiredActions: RequiredPermission[];
}

interface SourceTable {
  resource: AuthResource;
  alias?: string;
}

interface RelationInfo {
  sources: SourceTable[];
  directSource?: SourceTable;
  derived: boolean;
}

interface SelectAnalysis {
  sources: SourceTable[];
  relationMap: Map<string, RelationInfo>;
  relationSources: SourceTable[];
  hasDerivedRelations: boolean;
}

interface SourceResult {
  sources: SourceTable[];
  reason?: string;
}

interface ProjectionResult {
  requiredActions: RequiredPermission[];
  reason?: string;
}

interface ColumnReference {
  column: string;
  qualifier?: string;
}

type AstNode = Record<string, unknown>;

const NO_PERMISSION_TYPES = new Set(["transaction", "commit", "rollback", "set_statement", "use"]);

export function classifySqlText(sqlText: string, schema?: AuthorizationSqlSchema): ClassifiedStatement[] {
  return splitSqlStatements(sqlText).map((statement) => classifySqlStatement(statement, schema));
}

export function classifyAppend(schemaName: string | undefined, tableName: string): ClassifiedStatement {
  return {
    sql: "APPEND_REQUEST",
    confident: true,
    requiredActions: [
      {
        action: "table.insert",
        resource: tableResource(schemaName, tableName)
      }
    ]
  };
}

export function evaluatePolicy(
  principal: AuthPrincipal,
  policy: CatalogAuthPolicy | undefined,
  statements: ClassifiedStatement[]
): AuthorizationDecision {
  const requiredActions = statements.flatMap((statement) => statement.requiredActions);
  const unclassified = statements.find((statement) => !statement.confident);
  if (unclassified) {
    return {
      allowed: false,
      reason: unclassified.reason ?? "SQL statement could not be classified confidently",
      matchedRules: [],
      requiredActions,
      statements
    };
  }
  if (!policy) {
    return {
      allowed: false,
      reason: "missing catalog auth policy",
      matchedRules: [],
      requiredActions,
      statements
    };
  }
  const matchedRules: Array<{ ruleId: string; effect: "allow" | "deny" }> = [];
  const deny = policy.rules.find((rule, index) => {
    if (rule.effect !== "deny" || !principalMatches(principal, rule.principal)) {
      return false;
    }
    const matched = requiredActions.some((required) => ruleMatchesPermission(rule, required, principal));
    if (matched) {
      matchedRules.push({ ruleId: rule.ruleId ?? `rule-${index}`, effect: "deny" });
    }
    return matched;
  });
  if (deny) {
    return {
      allowed: false,
      reason: "matched deny rule",
      matchedRules,
      requiredActions,
      statements
    };
  }
  if (policy.defaultEffect === "allow") {
    return {
      allowed: true,
      reason: "policy default allow",
      matchedRules,
      requiredActions,
      statements
    };
  }
  const missing = requiredActions.find((required) => {
    const allowRule = policy.rules.find((rule, index) => {
      if (rule.effect !== "allow" || !principalMatches(principal, rule.principal)) {
        return false;
      }
      const matched = ruleMatchesPermission(rule, required, principal);
      if (matched) {
        matchedRules.push({ ruleId: rule.ruleId ?? `rule-${index}`, effect: "allow" });
      }
      return matched;
    });
    return !allowRule;
  });
  if (missing) {
    return {
      allowed: false,
      reason: `no allow rule for ${missing.action}`,
      matchedRules: uniqueMatchedRules(matchedRules),
      requiredActions,
      statements
    };
  }
  return {
    allowed: true,
    reason: requiredActions.length === 0 ? "no catalog permissions required" : "all required actions allowed",
    matchedRules: uniqueMatchedRules(matchedRules),
    requiredActions,
    statements
  };
}

export function principalMatches(principal: AuthPrincipal, match: PrincipalMatch | undefined): boolean {
  if (!match) {
    return true;
  }
  if (match.subjectsAny && !match.subjectsAny.includes(principal.subject)) {
    return false;
  }
  if (match.issuersAny && !match.issuersAny.includes(principal.issuer)) {
    return false;
  }
  if (match.scopesAny && !hasAny(principal.scopes, match.scopesAny)) {
    return false;
  }
  if (match.scopesAll && !hasAll(principal.scopes, match.scopesAll)) {
    return false;
  }
  if (match.groupsAny && !hasAny(principal.groups, match.groupsAny)) {
    return false;
  }
  if (match.groupsAll && !hasAll(principal.groups, match.groupsAll)) {
    return false;
  }
  if (match.rolesAny && !hasAny(principal.roles, match.rolesAny)) {
    return false;
  }
  if (match.rolesAll && !hasAll(principal.roles, match.rolesAll)) {
    return false;
  }
  if (match.claims) {
    for (const [key, value] of Object.entries(match.claims)) {
      if (principal.claims[key] !== value) {
        return false;
      }
    }
  }
  return true;
}

function classifySqlStatement(sql: string, schema: AuthorizationSqlSchema | undefined): ClassifiedStatement {
  const trimmed = sql.trim();
  if (!trimmed) {
    return { sql, confident: true, requiredActions: [] };
  }
  const { parsed, classificationSql } = parseSqlForAuthorization(trimmed);
  if (!parsed.success) {
    return {
      sql,
      confident: false,
      reason: parseFailureReason(parsed.error, parsed.errorLine, parsed.errorColumn),
      requiredActions: []
    };
  }
  const nodes = astArray(parsed.ast);
  const required: RequiredPermission[] = [];
  for (const node of nodes) {
    const classified = classifyAstNode(classificationSql, node, schema);
    required.push(...classified.requiredActions);
    if (!classified.confident) {
      return {
        sql,
        confident: false,
        reason: classified.reason,
        requiredActions: uniquePermissions(required)
      };
    }
  }
  return { sql, confident: true, requiredActions: uniquePermissions(required) };
}

function parseSqlForAuthorization(sql: string): { parsed: ReturnType<typeof parse>; classificationSql: string } {
  const parsed = parse(sql, Dialect.DuckDB);
  if (parsed.success) {
    return { parsed, classificationSql: sql };
  }
  const compatibleSql = duckDbParserCompatibilitySql(sql);
  if (compatibleSql !== sql) {
    const compatibleParsed = parse(compatibleSql, Dialect.DuckDB);
    if (compatibleParsed.success) {
      return { parsed: compatibleParsed, classificationSql: compatibleSql };
    }
  }
  return { parsed, classificationSql: sql };
}

function duckDbParserCompatibilitySql(sql: string): string {
  const identifier = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
  const tableReference = String.raw`${identifier}(?:\s*\.\s*${identifier}){0,2}`;
  const aliasBoundary = String.raw`(?=\s*(?:WHERE|ON|USING|JOIN|LEFT|RIGHT|FULL|INNER|CROSS|ORDER|GROUP|HAVING|QUALIFY|LIMIT|,|$))`;
  return sql.replace(
    new RegExp(String.raw`\b(FROM|JOIN)\s+(${tableReference})\s+(view|sort)${aliasBoundary}`, "gi"),
    "$1 $2 AS $3"
  );
}

function classifyAstNode(sql: string, node: unknown, schema: AuthorizationSqlSchema | undefined): ClassificationResult {
  const type = expressionType(node);
  if (!type) {
    return unsupported(sql);
  }
  if (NO_PERMISSION_TYPES.has(type)) {
    return ok([]);
  }
  switch (type) {
    case "command":
      return allowedInternalCommand(node) ? ok([]) : unsupported(sql);
    case "create_schema":
      return createSchemaPermissions(node);
    case "drop_schema":
      return dropSchemaPermissions(node);
    case "create_table":
      return createTablePermissions(sql, node, schema);
    case "drop_table":
      return dropTablePermissions(node);
    case "alter_table":
      return alterTablePermissions(node);
    case "insert":
      return insertPermissions(sql, node, schema);
    case "update":
      return mutationStatementPermissions("table.update", nodeValue(node, "update")?.table);
    case "delete":
      return mutationStatementPermissions("table.delete", nodeValue(node, "delete")?.table);
    case "select":
    case "union":
    case "intersect":
    case "except":
      return classifyQueryRead(sql, node, schema);
    default:
      return unsupported(sql);
  }
}

function createSchemaPermissions(node: unknown): ClassificationResult {
  const create = nodeValue(node, "create_schema");
  const name = identifierPath(create?.name).at(-1);
  if (!name) {
    return fail("Unable to resolve CREATE SCHEMA target");
  }
  return ok([{ action: "schema.create", resource: { schema: name } }]);
}

function dropSchemaPermissions(node: unknown): ClassificationResult {
  const drop = nodeValue(node, "drop_schema");
  const name = identifierName(drop?.name);
  if (!name) {
    return fail("Unable to resolve DROP SCHEMA target");
  }
  return ok([{ action: "schema.drop", resource: { schema: name } }]);
}

function createTablePermissions(sql: string, node: unknown, schema: AuthorizationSqlSchema | undefined): ClassificationResult {
  const create = nodeValue(node, "create_table");
  const resource = tableResourceFromTableRef(create?.name);
  if (!resource.table) {
    return fail("Unable to resolve CREATE TABLE target");
  }
  const required: RequiredPermission[] = [{ action: "table.create", resource }];
  if (create?.as_select) {
    const selectSql = sqlForAst(create.as_select, sql);
    const read = classifyQueryRead(selectSql, create.as_select, schema);
    required.push(...read.requiredActions);
    if (!read.confident) {
      return { ...read, requiredActions: uniquePermissions(required) };
    }
  }
  return ok(required);
}

function dropTablePermissions(node: unknown): ClassificationResult {
  const drop = nodeValue(node, "drop_table");
  const names = Array.isArray(drop?.names) ? drop.names : [];
  const required: RequiredPermission[] = [];
  for (const name of names) {
    const resource = tableResourceFromTableRef(name);
    if (!resource.table) {
      return fail("Unable to resolve DROP TABLE target");
    }
    required.push({ action: "table.drop", resource });
  }
  return required.length > 0 ? ok(required) : fail("Unable to resolve DROP TABLE target");
}

function alterTablePermissions(node: unknown): ClassificationResult {
  const alter = nodeValue(node, "alter_table");
  const resource = tableResourceFromTableRef(alter?.name);
  if (!resource.table) {
    return fail("Unable to resolve ALTER TABLE target");
  }
  return ok([{ action: "column.alter", resource }]);
}

function insertPermissions(sql: string, node: unknown, schema: AuthorizationSqlSchema | undefined): ClassificationResult {
  const insert = nodeValue(node, "insert");
  const resource = tableResourceFromTableRef(insert?.table);
  if (!resource.table) {
    return fail("Unable to resolve INSERT target");
  }
  const required = mutationPermissions("table.insert", resource);
  if (insert?.query) {
    const querySql = sqlForAst(insert.query, sql);
    const read = classifyQueryRead(querySql, insert.query, schema);
    required.push(...read.requiredActions);
    if (!read.confident) {
      return { ...read, requiredActions: uniquePermissions(required) };
    }
  }
  return ok(required);
}

function mutationStatementPermissions(action: AuthAction, tableRef: unknown): ClassificationResult {
  const resource = tableResourceFromTableRef(tableRef);
  if (!resource.table) {
    return fail(`Unable to resolve ${action} target`);
  }
  return ok(mutationPermissions(action, resource));
}

function classifyQueryRead(sql: string, node: unknown, schema: AuthorizationSqlSchema | undefined): ClassificationResult {
  const type = expressionType(node);
  if (type === "union" || type === "intersect" || type === "except") {
    const data = nodeValue(node, type);
    const required: RequiredPermission[] = [];
    for (const side of [data?.left, data?.right]) {
      if (!side) {
        return fail(`Unable to resolve ${type.toUpperCase()} query branch`);
      }
      const sideSql = sqlForAst(side, sql);
      const classified = classifyQueryRead(sideSql, side, schema);
      required.push(...classified.requiredActions);
      if (!classified.confident) {
        return { ...classified, requiredActions: uniquePermissions(required) };
      }
    }
    return ok(required);
  }
  if (type !== "select") {
    return fail("Unsupported query expression for authorization");
  }
  const analysis = analyzeSelect(node, schema);
  if ("reason" in analysis) {
    return fail(analysis.reason);
  }
  const required = analysis.sources.flatMap((source) => readPermissionForResource(source.resource));
  const projection = projectionColumnPermissions(sql, node, analysis, schema);
  required.push(...projection.requiredActions);
  if (projection.reason) {
    return { confident: false, reason: projection.reason, requiredActions: uniquePermissions(required) };
  }
  return ok(uniquePermissions(required));
}

function analyzeSelect(node: unknown, schema: AuthorizationSqlSchema | undefined): SelectAnalysis | { reason: string } {
  const sources = collectSourceTables(node, schema);
  if (sources.reason) {
    return { reason: sources.reason };
  }
  const relationResult = immediateRelations(node, schema);
  if (relationResult.reason) {
    return { reason: relationResult.reason };
  }
  const relationSources = uniqueSources([...relationResult.relationMap.values()].flatMap((relation) => relation.sources));
  return {
    sources: uniqueSources(sources.sources),
    relationMap: relationResult.relationMap,
    relationSources,
    hasDerivedRelations: relationResult.hasDerivedRelations
  };
}

function collectSourceTables(node: unknown, schema: AuthorizationSqlSchema | undefined, cteNames = new Set<string>()): SourceResult {
  const type = expressionType(node);
  if (type === "select") {
    const select = nodeValue(node, "select");
    const localCtes = new Set(cteNames);
    for (const cte of cteList(select)) {
      const name = identifierName(cte.alias);
      if (name) {
        localCtes.add(name);
      }
    }
    const sources: SourceTable[] = [];
    for (const cte of cteList(select)) {
      const cteSources = collectSourceTables(cte.this, schema, localCtes);
      if (cteSources.reason) {
        return cteSources;
      }
      sources.push(...cteSources.sources);
    }
    for (const child of objectChildrenExcluding(select, new Set(["with"]))) {
      const childSources = collectSourceTables(child, schema, localCtes);
      if (childSources.reason) {
        return childSources;
      }
      sources.push(...childSources.sources);
    }
    return { sources: uniqueSources(sources) };
  }
  if (type === "table") {
    const tableRef = nodeValue(node, "table");
    if (isCteReference(tableRef, cteNames) || isSkippedInternalTable(tableRef)) {
      return { sources: [] };
    }
    const source = sourceFromTableRef(tableRef);
    if (!source.resource.table) {
      return { sources: [], reason: "Unable to resolve source table" };
    }
    const unknown = unknownSourceReason(source.resource, schema);
    if (unknown) {
      return { sources: [], reason: unknown };
    }
    return { sources: [source] };
  }
  if (!isObject(node)) {
    return { sources: [] };
  }
  const sources: SourceTable[] = [];
  for (const child of Object.values(node)) {
    const childSources = collectSourceTables(child, schema, cteNames);
    if (childSources.reason) {
      return childSources;
    }
    sources.push(...childSources.sources);
  }
  return { sources: uniqueSources(sources) };
}

function immediateRelations(node: unknown, schema: AuthorizationSqlSchema | undefined): {
  relationMap: Map<string, RelationInfo>;
  hasDerivedRelations: boolean;
  reason?: string;
} {
  const select = nodeValue(node, "select");
  const relationMap = new Map<string, RelationInfo>();
  const cteRelations = new Map<string, RelationInfo>();
  const cteNames = new Set(cteList(select).map((cte) => identifierName(cte.alias)).filter((name): name is string => !!name));
  for (const cte of cteList(select)) {
    const name = identifierName(cte.alias);
    if (!name) {
      return { relationMap, hasDerivedRelations: false, reason: "Unable to resolve CTE alias" };
    }
    const sources = collectSourceTables(cte.this, schema, cteNames);
    if (sources.reason) {
      return { relationMap, hasDerivedRelations: false, reason: sources.reason };
    }
    cteRelations.set(name, { sources: uniqueSources(sources.sources), derived: true });
  }

  let hasDerivedRelations = false;
  const relationExpressions = [
    ...arrayValue(select?.from?.expressions),
    ...arrayValue(select?.joins).map((join) => join.this).filter((join): join is unknown => join !== undefined)
  ];
  for (const expression of relationExpressions) {
    const relation = relationFromExpression(expression, cteRelations, schema);
    if (relation.reason) {
      return { relationMap, hasDerivedRelations, reason: relation.reason };
    }
    if (!relation.info) {
      continue;
    }
    hasDerivedRelations ||= relation.info.derived;
    for (const key of relation.keys) {
      addRelationKey(relationMap, key, relation.info);
    }
  }
  return { relationMap, hasDerivedRelations };
}

function relationFromExpression(
  expression: unknown,
  cteRelations: Map<string, RelationInfo>,
  schema: AuthorizationSqlSchema | undefined
): { info?: RelationInfo; keys: string[]; reason?: string } {
  const type = expressionType(expression);
  if (type === "alias") {
    const alias = nodeValue(expression, "alias");
    const relation = relationFromExpression(alias?.this, cteRelations, schema);
    if (relation.info) {
      const aliasName = identifierName(alias?.alias);
      return {
        info: relation.info,
        keys: aliasName ? [aliasName, ...relation.keys] : relation.keys
      };
    }
    return relation;
  }
  if (type === "table") {
    const tableRef = nodeValue(expression, "table");
    const tableName = identifierName(tableRef?.name);
    const aliasName = identifierName(tableRef?.alias);
    if (tableName && !tableRef?.schema && cteRelations.has(tableName)) {
      const cte = cteRelations.get(tableName)!;
      return { info: cte, keys: [aliasName, tableName].filter((key): key is string => !!key) };
    }
    if (isSkippedInternalTable(tableRef)) {
      return { keys: [] };
    }
    const source = sourceFromTableRef(tableRef);
    if (!source.resource.table) {
      return { keys: [], reason: "Unable to resolve source table" };
    }
    const unknown = unknownSourceReason(source.resource, schema);
    if (unknown) {
      return { keys: [], reason: unknown };
    }
    const info: RelationInfo = { sources: [source], directSource: source, derived: false };
    return { info, keys: relationKeys(tableRef, aliasName) };
  }
  if (type === "subquery") {
    const subquery = nodeValue(expression, "subquery");
    const sources = collectSourceTables(subquery?.this, schema);
    if (sources.reason) {
      return { keys: [], reason: sources.reason };
    }
    const aliasName = identifierName(subquery?.alias);
    return {
      info: { sources: uniqueSources(sources.sources), derived: true },
      keys: aliasName ? [aliasName] : []
    };
  }
  if (type === "function") {
    return { keys: [] };
  }
  return { keys: [] };
}

function projectionColumnPermissions(
  sql: string,
  node: unknown,
  analysis: SelectAnalysis,
  schema: AuthorizationSqlSchema | undefined
): ProjectionResult {
  const select = nodeValue(node, "select");
  if (analysis.sources.length === 0) {
    return { requiredActions: [] };
  }
  const readableRelationSources = analysis.relationSources.filter(sourceRequiresColumnAuthorization);
  if (readableRelationSources.length === 0) {
    return { requiredActions: [] };
  }
  const requiredActions: RequiredPermission[] = [];
  for (const projection of arrayValue(select?.expressions)) {
    const { expression, alias } = unwrapAlias(projection);
    const star = starReference(expression);
    if (star) {
      const selected = star.qualifier ? analysis.relationMap.get(star.qualifier)?.sources : analysis.relationSources;
      if (!selected) {
        return { requiredActions, reason: `Unknown star qualifier ${star.qualifier}` };
      }
      for (const source of selected.filter(sourceRequiresColumnAuthorization)) {
        requiredActions.push({ action: "column.read", resource: { ...source.resource, column: "*" } });
      }
      continue;
    }

    const targetName = alias ?? outputColumnName(expression);
    if (targetName && shouldUseLineage(expression, analysis)) {
      const traced = lineageColumnPermissions(targetName, sql, schema);
      requiredActions.push(...traced.requiredActions);
      if (traced.reason) {
        return { requiredActions: uniquePermissions(requiredActions), reason: traced.reason };
      }
      continue;
    }

    const resolved = expressionColumnPermissions(expression, analysis, schema);
    requiredActions.push(...resolved.requiredActions);
    if (resolved.reason) {
      return { requiredActions: uniquePermissions(requiredActions), reason: resolved.reason };
    }
  }
  return { requiredActions: uniquePermissions(requiredActions) };
}

function shouldUseLineage(expression: unknown, analysis: SelectAnalysis): boolean {
  if (!analysis.hasDerivedRelations) {
    return false;
  }
  if (analysis.relationSources.every((source) => !sourceRequiresColumnAuthorization(source))) {
    return false;
  }
  const references = columnReferences(expression);
  if (references.length === 0) {
    return false;
  }
  return references.some((reference) => {
    if (reference.qualifier) {
      return analysis.relationMap.get(reference.qualifier)?.derived ?? false;
    }
    return true;
  });
}

function lineageColumnPermissions(
  column: string,
  sql: string,
  schema: AuthorizationSqlSchema | undefined
): ProjectionResult {
  const result = schema
    ? lineageWithSchema(column, sql, schema, Dialect.DuckDB)
    : lineage(column, sql, Dialect.DuckDB);
  if (!result.success || !result.lineage) {
    return {
      requiredActions: [],
      reason: `Unable to resolve column lineage for ${column}: ${result.error ?? "unknown lineage error"}`
    };
  }
  const requiredActions: RequiredPermission[] = [];
  for (const leaf of lineageLeaves(result.lineage)) {
    const tableResource = sourceResourceFromLineageNode(leaf);
    const columnName = columnNameFromLineageNode(leaf);
    if (!tableResource?.table || !columnName || isDuckLakeMetadataTable(tableResource.table)) {
      continue;
    }
    requiredActions.push({ action: "column.read", resource: { ...tableResource, column: columnName } });
  }
  return { requiredActions: uniquePermissions(requiredActions) };
}

function expressionColumnPermissions(
  expression: unknown,
  analysis: SelectAnalysis,
  schema: AuthorizationSqlSchema | undefined
): ProjectionResult {
  const requiredActions: RequiredPermission[] = [];
  for (const reference of columnReferences(expression)) {
    const resolved = resolveColumnReference(reference, analysis, schema);
    requiredActions.push(...resolved.requiredActions);
    if (resolved.reason) {
      return { requiredActions: uniquePermissions(requiredActions), reason: resolved.reason };
    }
  }
  return { requiredActions: uniquePermissions(requiredActions) };
}

function resolveColumnReference(
  reference: ColumnReference,
  analysis: SelectAnalysis,
  schema: AuthorizationSqlSchema | undefined
): ProjectionResult {
  if (reference.qualifier) {
    const relation = analysis.relationMap.get(reference.qualifier);
    if (!relation) {
      return { requiredActions: [], reason: `Unknown column qualifier ${reference.qualifier}` };
    }
    if (relation.derived || !relation.directSource) {
      return { requiredActions: [], reason: `Unable to resolve derived column ${reference.qualifier}.${reference.column}` };
    }
    if (!sourceRequiresColumnAuthorization(relation.directSource)) {
      return { requiredActions: [] };
    }
    if (schema && !schemaHasColumn(schema, relation.directSource.resource, reference.column)) {
      return { requiredActions: [], reason: `Unknown projected column ${reference.qualifier}.${reference.column}` };
    }
    return columnReadForSource(relation.directSource, reference.column);
  }

  if (analysis.relationSources.length === 0) {
    return { requiredActions: [] };
  }
  const relationSources = analysis.relationSources.filter(sourceRequiresColumnAuthorization);
  if (relationSources.length === 0) {
    return { requiredActions: [] };
  }
  if (analysis.hasDerivedRelations) {
    return { requiredActions: [], reason: `Unable to resolve derived column ${reference.column}` };
  }
  const candidates = schema
    ? relationSources.filter((source) => schemaHasColumn(schema, source.resource, reference.column))
    : relationSources;
  if (schema && candidates.length === 0) {
    return { requiredActions: [], reason: `Unknown projected column ${reference.column}` };
  }
  if (!schema && candidates.length === 1) {
    return columnReadForSource(candidates[0]!, reference.column);
  }
  if (candidates.length !== 1) {
    return { requiredActions: [], reason: `Ambiguous projected column ${reference.column}` };
  }
  return columnReadForSource(candidates[0]!, reference.column);
}

function columnReadForSource(source: SourceTable, column: string): ProjectionResult {
  if (!sourceRequiresColumnAuthorization(source)) {
    return { requiredActions: [] };
  }
  return {
    requiredActions: [
      {
        action: "column.read",
        resource: { ...source.resource, column }
      }
    ]
  };
}

function readPermissionForResource(resource: AuthResource): RequiredPermission[] {
  if (isInformationSchemaTable(resource)) {
    return informationSchemaReadPermissions(resource);
  }
  if (isDuckLakeMetadataTable(resource.table, "ducklake_schema")) {
    return [{ action: "schema.read", resource: { schema: resource.schema ?? "*" } }];
  }
  if (isDuckLakeMetadataTable(resource.table, "ducklake_column")) {
    return [{ action: "column.read", resource: { schema: "*", table: "*", column: "*" } }];
  }
  return [{ action: "table.read", resource }];
}

function informationSchemaReadPermissions(resource: AuthResource): RequiredPermission[] {
  switch (resource.table) {
    case "schemata":
      return [{ action: "schema.read", resource: { schema: "*" } }];
    case "columns":
      return [{ action: "column.read", resource: { schema: "*", table: "*", column: "*" } }];
    case "tables":
    case "views":
      return [{ action: "table.read", resource: { schema: "*", table: "*" } }];
    default:
      return [{ action: "schema.read", resource: { schema: "*" } }];
  }
}

function mutationPermissions(action: AuthAction, resource: AuthResource): RequiredPermission[] {
  if (isDuckLakeMetadataTable(resource.table)) {
    return [{ action: "catalog.admin", resource: { schema: resource.schema, table: resource.table } }];
  }
  return [{ action, resource }];
}

function tableResource(schemaName: string | undefined, tableName: string): AuthResource {
  return {
    schema: schemaName ?? "main",
    table: tableName
  };
}

function tableResourceFromTableRef(tableRef: unknown): AuthResource {
  if (!isObject(tableRef)) {
    return {};
  }
  const table = identifierName(tableRef.name);
  if (!table) {
    return {};
  }
  const schema = identifierName(tableRef.schema) ?? "main";
  return { schema, table };
}

function sourceFromTableRef(tableRef: unknown): SourceTable {
  const resource = tableResourceFromTableRef(tableRef);
  const alias = isObject(tableRef) ? identifierName(tableRef.alias) : undefined;
  return {
    resource,
    ...(alias ? { alias } : {})
  };
}

function relationKeys(tableRef: unknown, aliasName: string | undefined): string[] {
  if (!isObject(tableRef)) {
    return [];
  }
  const table = identifierName(tableRef.name);
  const schema = identifierName(tableRef.schema);
  const catalog = identifierName(tableRef.catalog);
  const keys = [aliasName, table];
  if (schema && table) {
    keys.push(`${schema}.${table}`);
  }
  if (catalog && schema && table) {
    keys.push(`${catalog}.${schema}.${table}`);
  }
  return keys.filter((key): key is string => !!key);
}

function addRelationKey(map: Map<string, RelationInfo>, key: string, relation: RelationInfo): void {
  map.set(key, relation);
}

function unknownSourceReason(resource: AuthResource, schema: AuthorizationSqlSchema | undefined): string | undefined {
  if (!schema || isSystemMetadataTable(resource)) {
    return undefined;
  }
  return schemaHasTable(schema, resource) ? undefined : `Unknown source table ${resourceName(resource)}`;
}

function schemaHasTable(schema: AuthorizationSqlSchema, resource: AuthResource): boolean {
  return schema.tables.some((table) => tableMatchesResource(table, resource));
}

function schemaHasColumn(schema: AuthorizationSqlSchema, resource: AuthResource, column: string): boolean {
  const table = schema.tables.find((candidate) => tableMatchesResource(candidate, resource));
  return !!table?.columns.some((candidate) => candidate.name === column);
}

function tableMatchesResource(table: TableSchema, resource: AuthResource): boolean {
  const tableIdentity = tableSchemaIdentity(table);
  return tableIdentity.table === resource.table && tableIdentity.schema === (resource.schema ?? "main");
}

function tableSchemaIdentity(table: TableSchema): { schema: string; table: string } {
  if (table.schema) {
    return { schema: table.schema, table: table.name };
  }
  const parts = table.name.split(".");
  if (parts.length > 1) {
    return { schema: parts.at(-2) ?? "main", table: parts.at(-1) ?? table.name };
  }
  return { schema: "main", table: table.name };
}

function ruleMatchesPermission(rule: CatalogAuthPolicyRule, required: RequiredPermission, principal: AuthPrincipal): boolean {
  if (!rule.actions.includes("*") && !rule.actions.includes(required.action)) {
    return false;
  }
  if (!resourceMatches(rule.resource, required.resource)) {
    return false;
  }
  return rowPredicateClaimsPresent(rule.rowPredicate, principal);
}

function resourceMatches(ruleResource: AuthResource | undefined, required: AuthResource): boolean {
  if (!ruleResource) {
    return true;
  }
  if (!wildcardMatch(ruleResource.schema, required.schema)) {
    return false;
  }
  if (!wildcardMatch(ruleResource.table, required.table)) {
    return false;
  }
  const requiredColumn = required.column;
  if (!requiredColumn) {
    return true;
  }
  const ruleColumn = ruleResource.column;
  if (ruleColumn !== undefined) {
    return wildcardMatch(ruleColumn, requiredColumn);
  }
  if (ruleResource.columns) {
    return ruleResource.columns.includes("*") || ruleResource.columns.includes(requiredColumn);
  }
  return true;
}

function wildcardMatch(pattern: string | undefined, value: string | undefined): boolean {
  return pattern === undefined || pattern === "*" || value === undefined || pattern === value;
}

function rowPredicateClaimsPresent(rowPredicate: string | undefined, principal: AuthPrincipal): boolean {
  if (!rowPredicate) {
    return true;
  }
  for (const match of rowPredicate.matchAll(/\$\{claims\.([A-Za-z_][\w$]*)\}/g)) {
    const claimName = match[1];
    if (!claimName || principal.claims[claimName] === undefined || principal.claims[claimName] === null) {
      return false;
    }
  }
  return true;
}

function allowedInternalCommand(node: unknown): boolean {
  const command = nodeValue(node, "command");
  return typeof command?.this === "string" && command.this.replace(/\s+/g, "").toLowerCase() === "callquack_clear_cache()";
}

function expressionType(node: unknown): string | undefined {
  if (!isObject(node)) {
    return undefined;
  }
  const keys = Object.keys(node);
  return keys.length === 1 ? keys[0] : undefined;
}

function nodeValue(node: unknown, key: string): Record<string, any> | undefined {
  if (!isObject(node)) {
    return undefined;
  }
  const value = node[key];
  return isObject(value) ? value as Record<string, any> : undefined;
}

function astArray(ast: unknown): unknown[] {
  if (Array.isArray(ast)) {
    return ast;
  }
  return ast === undefined || ast === null ? [] : [ast];
}

function arrayValue(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value) ? value.filter(isObject) as Array<Record<string, any>> : [];
}

function cteList(select: Record<string, any> | undefined): Array<Record<string, any>> {
  return arrayValue(select?.with?.ctes);
}

function objectChildrenExcluding(value: unknown, excluded: Set<string>): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isObject(value)) {
    return [];
  }
  return Object.entries(value)
    .filter(([key]) => !excluded.has(key))
    .map(([, child]) => child);
}

function identifierName(value: unknown): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const name = value.name;
  return typeof name === "string" ? name : undefined;
}

function identifierPath(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(identifierName).filter((name): name is string => !!name);
  }
  const name = identifierName(value);
  return name ? [name] : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCteReference(tableRef: unknown, cteNames: Set<string>): boolean {
  return isObject(tableRef) && !tableRef.schema && !!identifierName(tableRef.name) && cteNames.has(identifierName(tableRef.name)!);
}

function isSkippedInternalTable(tableRef: unknown): boolean {
  const table = isObject(tableRef) ? identifierName(tableRef.name) : undefined;
  return !!table && /^sqlite_/i.test(table);
}

function unwrapAlias(projection: unknown): { expression: unknown; alias?: string } {
  const alias = nodeValue(projection, "alias");
  if (!alias) {
    return { expression: projection };
  }
  const aliasName = identifierName(alias.alias);
  return {
    expression: alias.this,
    ...(aliasName ? { alias: aliasName } : {})
  };
}

function starReference(expression: unknown): { qualifier?: string } | undefined {
  const star = nodeValue(expression, "star");
  if (star) {
    const qualifier = identifierName(star.table);
    return qualifier ? { qualifier } : {};
  }
  return undefined;
}

function outputColumnName(expression: unknown): string | undefined {
  const column = nodeValue(expression, "column");
  if (column) {
    return identifierName(column.name);
  }
  const dot = nodeValue(expression, "dot");
  if (dot) {
    return identifierName(dot.field);
  }
  return undefined;
}

function columnReferences(expression: unknown): ColumnReference[] {
  const dot = nodeValue(expression, "dot");
  if (dot) {
    const qualified = qualifiedColumnFromDot(dot);
    if (qualified) {
      return [qualified];
    }
  }
  const column = nodeValue(expression, "column");
  if (column) {
    const columnName = identifierName(column.name);
    if (!columnName) {
      return [];
    }
    const qualifier = identifierName(column.table);
    return [{ column: columnName, ...(qualifier ? { qualifier } : {}) }];
  }
  const type = expressionType(expression);
  if (type === "table" || type === "star") {
    return [];
  }
  if (!isObject(expression)) {
    return [];
  }
  return Object.values(expression).flatMap((child) => columnReferences(child));
}

function qualifiedColumnFromDot(dot: Record<string, any>): ColumnReference | undefined {
  const field = identifierName(dot.field);
  const innerColumn = nodeValue(dot.this, "column");
  const table = identifierName(innerColumn?.table);
  const name = identifierName(innerColumn?.name);
  if (!field || !name) {
    return undefined;
  }
  return {
    column: field,
    qualifier: table ? `${table}.${name}` : name
  };
}

function lineageLeaves(node: LineageNode): LineageNode[] {
  if (node.downstream.length === 0) {
    return [node];
  }
  return node.downstream.flatMap((child) => lineageLeaves(child));
}

function sourceResourceFromLineageNode(node: LineageNode): AuthResource | undefined {
  const source: unknown = node.source;
  if (isObject(source) && isObject(source.table)) {
    const resource = tableResourceFromTableRef(source.table);
    return resource.table ? resource : undefined;
  }
  if (node.source_name) {
    const parts = node.source_name.split(".");
    const table = parts.at(-1);
    if (!table) {
      return undefined;
    }
    const schema = parts.length > 1 ? parts.at(-2) : "main";
    return { schema, table };
  }
  return undefined;
}

function columnNameFromLineageNode(node: LineageNode): string | undefined {
  const reference = columnReferences(node.expression)[0];
  if (reference) {
    return reference.column;
  }
  const parts = node.name.split(".");
  return parts.at(-1);
}

function sqlForAst(node: unknown, fallback: string): string {
  const generated = generate([node], Dialect.DuckDB);
  if (generated.success && Array.isArray(generated.sql) && typeof generated.sql[0] === "string") {
    return generated.sql[0];
  }
  return fallback;
}

function parseFailureReason(error: string | undefined, line: number | undefined, column: number | undefined): string {
  const location = line !== undefined && column !== undefined ? ` at ${line}:${column}` : "";
  return `SQL parse error${location}: ${error ?? "statement could not be parsed"}`;
}

function resourceName(resource: AuthResource): string {
  return `${resource.schema ?? "main"}.${resource.table ?? "*"}`;
}

function ok(requiredActions: RequiredPermission[]): ClassificationResult {
  return { confident: true, requiredActions: uniquePermissions(requiredActions) };
}

function fail(reason: string): ClassificationResult {
  return { confident: false, reason, requiredActions: [] };
}

function unsupported(sql: string): ClassificationResult {
  return {
    confident: false,
    reason: `Unsupported SQL for authorization: ${sql.trim().slice(0, 80)}`,
    requiredActions: []
  };
}

function isDuckLakeMetadataTable(tableName: string | undefined, specific?: string): boolean {
  if (!tableName) {
    return false;
  }
  if (specific) {
    return tableName === specific;
  }
  return /^ducklake_/.test(tableName);
}

function isInformationSchemaTable(resource: AuthResource): boolean {
  return resource.schema === "information_schema" && !!resource.table;
}

function isSystemMetadataTable(resource: AuthResource): boolean {
  return isInformationSchemaTable(resource) || isDuckLakeMetadataTable(resource.table);
}

function sourceRequiresColumnAuthorization(source: SourceTable): boolean {
  return !isSystemMetadataTable(source.resource);
}

function hasAny(values: string[], required: string[]): boolean {
  return required.some((value) => values.includes(value));
}

function hasAll(values: string[], required: string[]): boolean {
  return required.every((value) => values.includes(value));
}

function uniquePermissions(permissions: RequiredPermission[]): RequiredPermission[] {
  const seen = new Set<string>();
  return permissions.filter((permission) => {
    const key = `${permission.action}:${permission.resource.schema ?? ""}:${permission.resource.table ?? ""}:${permission.resource.column ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueSources(sources: SourceTable[]): SourceTable[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.resource.schema ?? ""}:${source.resource.table ?? ""}:${source.alias ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueMatchedRules(rules: Array<{ ruleId: string; effect: "allow" | "deny" }>): Array<{ ruleId: string; effect: "allow" | "deny" }> {
  const seen = new Set<string>();
  return rules.filter((rule) => {
    const key = `${rule.effect}:${rule.ruleId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
