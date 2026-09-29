import { SELF, env } from "cloudflare:test";
import { decodeMessage, MessageType, QuackClient } from "@quack-protocol/sdk";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { RuntimeEnv } from "../src/env";

const adminHeaders = { Authorization: "Bearer admin-test-token", "Content-Type": "application/json" };

describe("Worker HTTP and protocol boundaries", () => {
  it("serves health and returns explicit errors for unknown routes", async () => {
    const health = await SELF.fetch("http://example.com/");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ name: "quacklake", endpoint: "/quack" });
    for (const [path, error] of [
      ["/missing", "Not found"],
      ["/admin/missing", "Admin route not found"],
      ["/admin/oidc/providers/missing/extra", "OIDC provider route not found"]
    ]) {
      const response = await SELF.fetch(`http://example.com${path}`, { headers: adminHeaders });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error });
    }
  });

  it.each(["/quack", "/catalog/data-lease"])("supports preflight and rejects GET for %s", async (path) => {
    const preflight = await SELF.fetch(`http://example.com${path}`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(await preflight.text()).toBe("");
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    const get = await SELF.fetch(`http://example.com${path}`);
    expect(get.status).toBe(405);
    expect(get.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await get.text()).toContain("Method not allowed");
  });

  it("encodes malformed Quack requests as binary protocol errors", async () => {
    const response = await SELF.fetch("http://example.com/quack", { method: "POST", body: new Uint8Array([1, 2, 3]) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/duckdb");
    expect(decodeMessage(new Uint8Array(await response.arrayBuffer()))).toMatchObject({
      type: MessageType.ERROR_RESPONSE, message: expect.any(String)
    });
    await expect(QuackClient.connect("http://example.com", { fetch: SELF.fetch.bind(SELF) as typeof fetch }))
      .rejects.toThrow("Missing auth JWT");
  });

  it("rejects missing authentication and malformed lease JSON with CORS headers", async () => {
    const missing = await SELF.fetch("http://example.com/catalog/data-lease", { method: "POST" });
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "Unauthorized" });
    const malformed = await SELF.fetch("http://example.com/catalog/data-lease", {
      method: "POST", headers: adminHeaders, body: '{"access":invalid}'
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await expect(malformed.json()).resolves.toMatchObject({ error: expect.stringContaining("Unexpected token") });
  });

  it("returns service unavailable when admin authentication is unconfigured", async () => {
    const response = await worker.fetch(new Request("http://example.com/admin/catalogs", { headers: adminHeaders }), {
      ...env, ADMIN_TOKEN: undefined
    } as unknown as RuntimeEnv);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "ADMIN_TOKEN is not configured" });
  });

  it("requires an auth token for authorization explanations", async () => {
    const response = await SELF.fetch("http://example.com/admin/authz/explain", { method: "POST", headers: adminHeaders });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "authString is required" });
  });

  it.each([
    { suffix: "/credentials", method: "POST", body: {} },
    { suffix: "/auth-mapping", method: "PUT", body: { mappings: [] } },
    { suffix: "/auth-policy", method: "PUT", body: { version: 1, defaultEffect: "deny", rules: [] } }
  ])("rejects $suffix for a nonexistent catalog", async ({ suffix, method, body }) => {
    const catalogId = `missing_${crypto.randomUUID()}`;
    const response = await SELF.fetch(`http://example.com/admin/catalogs/${catalogId}${suffix}`, {
      method, headers: adminHeaders, body: JSON.stringify(body)
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: `Catalog ${catalogId} does not exist` });
  });

  it("diagnoses missing paths, unsupported URIs, bucket roots, and absent R2 objects", async () => {
    const bucket = Object.keys(JSON.parse((env as unknown as RuntimeEnv).DUCKLAKE_R2_BINDINGS!))[0]!;
    for (const [path, status, expected] of [
      [undefined, 400, { ok: false, error: expect.stringContaining("path") }],
      ["https://example.com/file.parquet", 400, { ok: false, error: "Path is not an r2:// or s3:// object URI" }],
      [`r2://${bucket}`, 200, { ok: true, bucket, key: "", object: null }],
      [`r2://${bucket}/missing-${crypto.randomUUID()}.parquet`, 404, { ok: false, bucket, object: { exists: false } }]
    ] as const) {
      const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
      const response = await SELF.fetch(`http://example.com/admin/r2/diagnostics${query}`, { headers: adminHeaders });
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject(expected);
    }
  });
});
