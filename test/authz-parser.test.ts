import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "@polyglot-sql/sdk";
import { classifySqlText, evaluatePolicy } from "../src/authz";
import type { AuthPrincipal } from "../src/auth";

// Inject incomplete responses at the external parser boundary. A parser upgrade
// must not turn an unresolved mutation target into a permission-free statement.
vi.mock("@polyglot-sql/sdk", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@polyglot-sql/sdk")>();
  return { ...sdk, parse: vi.fn(sdk.parse) };
});

afterEach(() => vi.mocked(parse).mockReset());

const principal: AuthPrincipal = {
  issuer: "quacklake", subject: "parser-contract-test", audience: [],
  scopes: [], groups: [], roles: [], claims: {}, authMode: "first_party_jwt", providerId: "quacklake"
};

function returnIncompleteAst(ast: unknown): void {
  vi.mocked(parse).mockReturnValueOnce({ success: true, ast } as ReturnType<typeof parse>);
}

describe("authorization parser contract", () => {
  it.each([
    { sql: "CREATE SCHEMA finance", ast: { create_schema: { name: [] } }, reason: "Unable to resolve CREATE SCHEMA target" },
    { sql: "DROP SCHEMA finance", ast: { drop_schema: { name: {} } }, reason: "Unable to resolve DROP SCHEMA target" },
    { sql: "CREATE TABLE items(id INTEGER)", ast: { create_table: { name: {} } }, reason: "Unable to resolve CREATE TABLE target" },
    { sql: "DROP TABLE items", ast: { drop_table: { names: [{}] } }, reason: "Unable to resolve DROP TABLE target" },
    { sql: "ALTER TABLE items ADD COLUMN id INTEGER", ast: { alter_table: { name: null } }, reason: "Unable to resolve ALTER TABLE target" },
    { sql: "INSERT INTO items VALUES (1)", ast: { insert: { table: {} } }, reason: "Unable to resolve INSERT target" },
    { sql: "UPDATE items SET id = 1", ast: { update: { table: {} } }, reason: "Unable to resolve table.update target" },
    { sql: "DELETE FROM items", ast: { delete: {} }, reason: "Unable to resolve table.delete target" },
    { sql: "SELECT * FROM items", ast: { select: { from: { expressions: [{ table: { name: {} } }] } } }, reason: "Unable to resolve source table" },
    { sql: "SELECT 1 UNION SELECT 2", ast: { union: { left: { select: { expressions: [] } } } }, reason: "Unable to resolve UNION query branch" }
  ])("denies incomplete parser output for $sql", ({ sql, ast, reason }) => {
    returnIncompleteAst([ast]);
    const statements = classifySqlText(sql);
    expect(statements).toEqual([{ sql, confident: false, reason, requiredActions: [] }]);
    expect(evaluatePolicy(principal, { version: 1, defaultEffect: "allow", rules: [] }, statements))
      .toMatchObject({ allowed: false, reason, matchedRules: [] });
  });

  it("denies an unknown AST shape instead of treating it as a successful no-op", () => {
    const sql = "DELETE FROM items";
    returnIncompleteAst({ unexpected: {}, shape: {} });
    expect(classifySqlText(sql)).toEqual([{
      sql, confident: false, reason: `Unsupported SQL for authorization: ${sql}`, requiredActions: []
    }]);
  });

  it("denies unsupported query expressions inside INSERT", () => {
    const sql = "INSERT INTO items SELECT 1";
    returnIncompleteAst([{
      insert: { table: { name: { name: "items" } }, query: { unsupported_query: {} } }
    }]);
    expect(classifySqlText(sql)).toEqual([{
      sql, confident: false, reason: "Unsupported query expression for authorization",
      requiredActions: [{ action: "table.insert", resource: { schema: "main", table: "items" } }]
    }]);
  });
});
