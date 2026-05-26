import { describe, expect, it } from "vitest";
import type { Schema } from "@polyglot-sql/sdk";
import type { AuthPrincipal, CatalogAuthPolicy } from "../src/auth";
import { classifyAppend, classifySqlText, evaluatePolicy, principalMatches } from "../src/authz";

const principal: AuthPrincipal = {
  issuer: "quacklake",
  subject: "credential:test",
  audience: ["quacklake:quack"],
  scopes: ["catalog.admin", "ducklake.finance.read"],
  groups: ["finance-readers"],
  roles: ["analyst"],
  claims: {
    tenantId: "tenant-a",
    department: "finance"
  },
  credentialId: "test",
  providerId: "quacklake",
  authMode: "first_party_jwt"
};

const financeSchema: Schema = {
  strict: true,
  tables: [
    {
      schema: "finance",
      name: "invoices",
      columns: [
        { name: "id", type: "INTEGER" },
        { name: "amount", type: "INTEGER" },
        { name: "customer_id", type: "INTEGER" },
        { name: "secret", type: "VARCHAR" }
      ]
    },
    {
      schema: "finance",
      name: "customers",
      columns: [
        { name: "id", type: "INTEGER" },
        { name: "name", type: "VARCHAR" }
      ]
    }
  ]
};

describe("SQL authorization classifier", () => {
  it("classifies aliases, joins, aggregates, stars, and CTE source tables", () => {
    expect(classifySqlText(`
      SELECT i.id, c.name
      FROM finance.invoices i
      JOIN finance.customers c ON c.id = i.customer_id
    `)[0]?.requiredActions).toEqual(expect.arrayContaining([
      { action: "table.read", resource: { schema: "finance", table: "invoices" } },
      { action: "table.read", resource: { schema: "finance", table: "customers" } },
      { action: "column.read", resource: { schema: "finance", table: "invoices", column: "id" } },
      { action: "column.read", resource: { schema: "finance", table: "customers", column: "name" } }
    ]));

    expect(classifySqlText("SELECT * FROM finance.invoices")[0]?.requiredActions).toEqual(expect.arrayContaining([
      { action: "table.read", resource: { schema: "finance", table: "invoices" } },
      { action: "column.read", resource: { schema: "finance", table: "invoices", column: "*" } }
    ]));

    expect(classifySqlText("SELECT SUM(amount) FROM finance.invoices")[0]?.requiredActions).toEqual(expect.arrayContaining([
      { action: "table.read", resource: { schema: "finance", table: "invoices" } },
      { action: "column.read", resource: { schema: "finance", table: "invoices", column: "amount" } }
    ]));

    const cteActions = classifySqlText(`
      WITH recent AS (SELECT id, amount FROM finance.invoices)
      SELECT id FROM recent
    `)[0]?.requiredActions;
    expect(cteActions).toEqual(expect.arrayContaining([
      { action: "table.read", resource: { schema: "finance", table: "invoices" } }
    ]));
    expect(cteActions).not.toContainEqual({ action: "table.read", resource: { schema: "main", table: "recent" } });
  });

  it("maps DuckLake metadata reads and writes to catalog resources", () => {
    expect(classifySqlText("SELECT * FROM main.ducklake_schema")[0]?.requiredActions).toEqual(expect.arrayContaining([
      { action: "schema.read", resource: { schema: "main" } }
    ]));
    expect(classifySqlText("SELECT * FROM main.ducklake_column")[0]?.requiredActions).toEqual(expect.arrayContaining([
      { action: "column.read", resource: { schema: "*", table: "*", column: "*" } }
    ]));
    expect(classifySqlText("INSERT INTO main.ducklake_table VALUES (1, 'items')")[0]?.requiredActions).toEqual([
      { action: "catalog.admin", resource: { schema: "main", table: "ducklake_table" } }
    ]);

    expect(classifySqlText("SELECT key FROM main.ducklake_metadata", financeSchema)[0]).toMatchObject({
      confident: true,
      requiredActions: [{ action: "table.read", resource: { schema: "main", table: "ducklake_metadata" } }]
    });
    expect(classifySqlText("SELECT view_id FROM main.ducklake_view view WHERE view.end_snapshot IS NULL", financeSchema)[0]).toMatchObject({
      confident: true,
      requiredActions: [{ action: "table.read", resource: { schema: "main", table: "ducklake_view" } }]
    });
    expect(classifySqlText("SELECT sort.sort_id FROM main.ducklake_sort_info sort", financeSchema)[0]).toMatchObject({
      confident: true,
      requiredActions: [{ action: "table.read", resource: { schema: "main", table: "ducklake_sort_info" } }]
    });
  });

  it("classifies system metadata reads without requiring user-table schema columns", () => {
    expect(classifySqlText("SELECT table_name FROM information_schema.tables", financeSchema)[0]).toMatchObject({
      confident: true,
      requiredActions: [{ action: "table.read", resource: { schema: "*", table: "*" } }]
    });
    expect(classifySqlText("SELECT schema_name FROM information_schema.schemata", financeSchema)[0]).toMatchObject({
      confident: true,
      requiredActions: [{ action: "schema.read", resource: { schema: "*" } }]
    });
  });

  it("classifies multi-statement SQL, schema-qualified names, and quoted identifiers", () => {
    const statements = classifySqlText(`
      CREATE SCHEMA IF NOT EXISTS finance;
      CREATE TABLE finance.invoices(id INTEGER);
      INSERT INTO finance.invoices VALUES (1);
      DROP TABLE finance.invoices;
    `, financeSchema);
    expect(statements).toHaveLength(4);
    expect(statements.flatMap((statement) => statement.requiredActions)).toEqual(expect.arrayContaining([
      { action: "schema.create", resource: { schema: "finance" } },
      { action: "table.create", resource: { schema: "finance", table: "invoices" } },
      { action: "table.insert", resource: { schema: "finance", table: "invoices" } },
      { action: "table.drop", resource: { schema: "finance", table: "invoices" } }
    ]));

    const quotedSchema: Schema = {
      strict: true,
      tables: [
        {
          schema: "main",
          name: "Invoice Items",
          columns: [{ name: "Invoice ID", type: "INTEGER" }]
        }
      ]
    };
    expect(classifySqlText(`SELECT "Invoice ID" FROM "Invoice Items"`, quotedSchema)[0]?.requiredActions).toEqual(expect.arrayContaining([
      { action: "table.read", resource: { schema: "main", table: "Invoice Items" } },
      { action: "column.read", resource: { schema: "main", table: "Invoice Items", column: "Invoice ID" } }
    ]));
  });

  it("uses schema-aware lineage for ambiguous columns, stars, and derived relations", () => {
    expect(classifySqlText(`
      SELECT name
      FROM finance.invoices i
      JOIN finance.customers c ON c.id = i.customer_id
    `, financeSchema)[0]?.requiredActions).toEqual(expect.arrayContaining([
      { action: "column.read", resource: { schema: "finance", table: "customers", column: "name" } }
    ]));

    const ambiguous = classifySqlText(`
      SELECT id
      FROM finance.invoices i
      JOIN finance.customers c ON c.id = i.customer_id
    `, financeSchema)[0];
    expect(ambiguous).toMatchObject({
      confident: false,
      reason: expect.stringContaining("Ambiguous projected column id")
    });

    const unknown = classifySqlText("SELECT missing FROM finance.invoices", financeSchema)[0];
    expect(unknown).toMatchObject({
      confident: false,
      reason: expect.stringContaining("Unknown projected column missing")
    });

    expect(classifySqlText("SELECT i.*, c.name FROM finance.invoices i JOIN finance.customers c ON c.id = i.customer_id", financeSchema)[0]?.requiredActions).toEqual(expect.arrayContaining([
      { action: "column.read", resource: { schema: "finance", table: "invoices", column: "*" } },
      { action: "column.read", resource: { schema: "finance", table: "customers", column: "name" } }
    ]));

    const derivedSchema: Schema = {
      strict: true,
      tables: [
        {
          schema: "main",
          name: "items",
          columns: [
            { name: "id", type: "INTEGER" },
            { name: "secret", type: "VARCHAR" }
          ]
        }
      ]
    };
    expect(classifySqlText("SELECT id FROM (SELECT secret AS id FROM items) s", derivedSchema)[0]?.requiredActions).toEqual(expect.arrayContaining([
      { action: "column.read", resource: { schema: "main", table: "items", column: "secret" } }
    ]));
  });

  it("classifies append targets separately from SQL text", () => {
    expect(classifyAppend(undefined, "items").requiredActions).toEqual([
      { action: "table.insert", resource: { schema: "main", table: "items" } }
    ]);
    expect(classifyAppend("finance", "invoices").requiredActions).toEqual([
      { action: "table.insert", resource: { schema: "finance", table: "invoices" } }
    ]);
  });
});

describe("catalog policy evaluator", () => {
  it("denies missing policies and unclassified SQL even when a policy would otherwise allow by default", () => {
    const read = classifySqlText("SELECT id FROM finance.invoices");
    expect(evaluatePolicy(principal, undefined, read)).toMatchObject({
      allowed: false,
      reason: "missing catalog auth policy"
    });

    expect(evaluatePolicy(principal, { version: 1, defaultEffect: "allow", rules: [] }, classifySqlText("PRAGMA table_info(items)"))).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Unsupported SQL")
    });
  });

  it("applies default allow, deny precedence, wildcard resources, row predicate claim checks, and principal match dimensions", () => {
    expect(evaluatePolicy(principal, { version: 1, defaultEffect: "allow", rules: [] }, classifySqlText("BEGIN"))).toMatchObject({
      allowed: true,
      reason: "policy default allow"
    });

    const policy: CatalogAuthPolicy = {
      version: 1,
      defaultEffect: "deny",
      rules: [
        {
          ruleId: "deny-secrets",
          effect: "deny",
          principal: { groupsAll: ["finance-readers"], rolesAll: ["analyst"], claims: { department: "finance" } },
          actions: ["column.read"],
          resource: { schema: "finance", table: "invoices", column: "secret" }
        },
        {
          ruleId: "tenant-read",
          effect: "allow",
          principal: { scopesAll: ["catalog.admin", "ducklake.finance.read"] },
          actions: ["table.read", "column.read"],
          resource: { schema: "finance", table: "*", column: "*" },
          rowPredicate: "tenant_id = ${claims.tenantId}"
        }
      ]
    };

    expect(evaluatePolicy(principal, policy, classifySqlText("SELECT id FROM finance.invoices"))).toMatchObject({
      allowed: true,
      matchedRules: [{ ruleId: "tenant-read", effect: "allow" }]
    });
    expect(evaluatePolicy(principal, policy, classifySqlText("SELECT secret FROM finance.invoices"))).toMatchObject({
      allowed: false,
      reason: "matched deny rule",
      matchedRules: [{ ruleId: "deny-secrets", effect: "deny" }]
    });
    expect(evaluatePolicy({ ...principal, claims: {} }, policy, classifySqlText("SELECT id FROM finance.invoices"))).toMatchObject({
      allowed: false,
      reason: "no allow rule for table.read"
    });
    expect(principalMatches(principal, {
      subjectsAny: ["credential:test"],
      issuersAny: ["quacklake"],
      scopesAny: ["catalog.admin"],
      groupsAny: ["finance-readers"],
      rolesAny: ["analyst"],
      claims: { tenantId: "tenant-a" }
    })).toBe(true);
    expect(principalMatches(principal, { rolesAll: ["analyst", "admin"] })).toBe(false);
  });
});
