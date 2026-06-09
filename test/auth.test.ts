import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { LogicalTypes, MessageType, QuackClient } from "@quack-protocol/sdk";

const adminHeaders = {
  Authorization: "Bearer admin-test-token",
  "Content-Type": "application/json"
};

const firstPartySecret = new TextEncoder().encode("jwt-secret-test");

interface CreatedCatalog {
  catalog: { catalogId: string; dataPath: string; dataAccessMode: "catalog_only" | "trusted_client" };
  credential: { credentialId: string };
  jwt: string;
  ducklake: {
    secretName: string;
    quackScope: string;
    dataPath: string;
    secretSql: string;
    attachSql: string;
  };
}

interface OpenApiDoc {
  openapi: string;
  paths: Record<string, Record<string, OpenApiOperation | unknown> & { parameters?: unknown[] }>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    responses?: Record<string, unknown>;
    examples?: Record<string, unknown>;
  };
}

interface OpenApiOperation {
  operationId?: string;
  security?: unknown[];
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
}

describe("JWT authentication and catalog authorization", () => {
  it("requires admin bearer auth for admin routes while leaving api docs public", async () => {
    const docs = await SELF.fetch("http://example.com/api-docs");
    expect(docs.status).toBe(200);

    const missing = await SELF.fetch("http://example.com/admin/catalogs");
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({ error: "Unauthorized" });

    const wrong = await SELF.fetch("http://example.com/admin/catalogs", {
      headers: { Authorization: "Bearer wrong-token" }
    });
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toMatchObject({ error: "Unauthorized" });
  });

  it("serves OpenAPI v3 admin API docs without admin auth", async () => {
    const response = await SELF.fetch("http://example.com/api-docs");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const docs = await response.json<OpenApiDoc>();

    expect(docs.openapi).toBe("3.0.3");
    expect(docs.paths["/api-docs"]?.get).toMatchObject({ security: [] });
    expect(docs.paths["/catalog/data-lease"]?.post).toMatchObject({
      operationId: "createDataLease",
      security: [{ CatalogBearer: [] }]
    });
    expect(docs.paths["/admin/catalogs"]?.post).toMatchObject({
      operationId: "createCatalog",
      security: [{ AdminBearer: [] }]
    });
    expect(docs.paths["/admin/r2-buckets"]?.get).toMatchObject({
      operationId: "listR2Buckets",
      security: [{ AdminBearer: [] }]
    });
    expect(docs.paths["/admin/catalogs/{catalogId}/credentials"]?.post).toMatchObject({
      operationId: "createCredential"
    });
    expect(docs.paths["/admin/oidc/providers/{providerId}"]?.delete).toMatchObject({
      operationId: "deleteOidcProvider"
    });
    expect(docs.paths["/admin/authz/explain"]?.post).toMatchObject({
      operationId: "explainAuthz"
    });
    expect(docs.paths["/admin/catalogs/{catalogId}/files"]).toBeUndefined();
    expect(docs.components.securitySchemes.AdminBearer).toMatchObject({ type: "http", scheme: "bearer" });
    expect(docs.components.schemas).toMatchObject({
      CreateCatalogRequest: expect.any(Object),
      CreateCatalogResponse: expect.any(Object),
      OidcProviderConfig: expect.any(Object),
      CatalogAuthPolicy: expect.any(Object),
      AuthzExplainResponse: expect.any(Object),
      DataAccessMode: expect.any(Object),
      CreateDataLeaseResponse: expect.any(Object),
      ListR2BucketsResponse: expect.any(Object),
      R2DiagnosticsResponse: expect.any(Object)
    });
    expect(docs.components.examples).toMatchObject({
      OidcProviderConfigEntra: expect.any(Object),
      OidcProviderConfigCognito: expect.any(Object),
      CatalogAuthPolicyReadOnly: expect.any(Object),
      CatalogAuthMappingEntraFinance: expect.any(Object),
      AuthzExplainResponseAllowed: expect.any(Object),
      AuthzExplainResponseDenied: expect.any(Object)
    });
    assertOpenApiContract(docs);
  });

  it("returns typed client errors for invalid admin authn/authz configuration", async () => {
    await expectAdminError(
      "http://example.com/admin/catalogs",
      { catalogId: "bad id" },
      400,
      /catalogId must/
    );
    await expectAdminError(
      "http://example.com/admin/catalogs",
      { catalogId: `bad_ttl_${crypto.randomUUID().replaceAll("-", "_")}`, expiresInSeconds: -1 },
      400,
      /expiresInSeconds must/
    );
    await expectAdminError(
      "http://example.com/admin/catalogs",
      { catalogId: `bad_access_${crypto.randomUUID().replaceAll("-", "_")}`, dataAccessMode: "raw" },
      400,
      /dataAccessMode must/
    );
    await expectAdminError(
      "http://example.com/admin/catalogs",
      { catalogId: `bad_bucket_${crypto.randomUUID().replaceAll("-", "_")}`, r2Bucket: "missing-bucket" },
      400,
      /not configured/
    );
    await expectAdminError(
      "http://example.com/admin/oidc/providers",
      oidcProviderConfig({ providerId: "bad id" }),
      400,
      /providerId must/
    );
    await expectAdminError(
      "http://example.com/admin/oidc/providers",
      oidcProviderConfig({ issuer: "login.example/tenant" }),
      400,
      /issuer must/
    );
    await expectAdminError(
      "http://example.com/admin/oidc/providers",
      oidcProviderConfig({ audiences: [] }),
      400,
      /audiences must/
    );
    await expectAdminError(
      "http://example.com/admin/oidc/providers",
      oidcProviderConfig({ algorithms: [] }),
      400,
      /algorithms must/
    );
    await expectAdminError(
      "http://example.com/admin/oidc/providers",
      oidcProviderConfig({ jwks: undefined, jwksUri: undefined }),
      400,
      /jwksUri or jwks/
    );
    await expectAdminError(
      "http://example.com/admin/oidc/providers",
      oidcProviderConfig({ jwks: undefined, jwksUri: "issuer.example/keys" }),
      400,
      /jwksUri must/
    );

    const created = await createCatalog("invalid_config");
    await expectAdminError(
      `http://example.com/admin/catalogs/${created.catalog.catalogId}/auth-mapping`,
      { mappings: [{ mappingId: "bad id", providerId: "missing" }] },
      400,
      /mappingId must/,
      "PUT"
    );
    await expectAdminError(
      `http://example.com/admin/catalogs/${created.catalog.catalogId}/auth-mapping`,
      { mappings: [{ mappingId: "valid", providerId: "missing" }] },
      404,
      /OIDC provider missing does not exist/,
      "PUT"
    );
    await expectAdminError(
      `http://example.com/admin/catalogs/${created.catalog.catalogId}/auth-policy`,
      { version: 2, defaultEffect: "deny", rules: [] },
      400,
      /auth policy version/,
      "PUT"
    );
    await expectAdminError(
      `http://example.com/admin/catalogs/${created.catalog.catalogId}/auth-policy`,
      { version: 1, defaultEffect: "maybe", rules: [] },
      400,
      /defaultEffect/,
      "PUT"
    );
    await expectAdminError(
      `http://example.com/admin/catalogs/${created.catalog.catalogId}/auth-policy`,
      { version: 1, defaultEffect: "deny", rules: [{ effect: "maybe", actions: ["table.read"] }] },
      400,
      /rule effect/,
      "PUT"
    );
    await expectAdminError(
      `http://example.com/admin/catalogs/${created.catalog.catalogId}/auth-policy`,
      { version: 1, defaultEffect: "deny", rules: [{ effect: "allow", actions: [] }] },
      400,
      /actions must/,
      "PUT"
    );
  });

  it("manages OIDC provider, catalog mapping, and auth policy lifecycle routes", async () => {
    const provider = await createOidcProvider("oidc_lifecycle");

    const listed = await SELF.fetch("http://example.com/admin/oidc/providers", { headers: adminHeaders });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      providers: expect.arrayContaining([expect.objectContaining({ providerId: provider.providerId })])
    });

    const fetched = await SELF.fetch(`http://example.com/admin/oidc/providers/${provider.providerId}`, { headers: adminHeaders });
    expect(fetched.status).toBe(200);
    const providerRecord = await fetched.json<Record<string, unknown>>();
    expect(providerRecord).toMatchObject({
      providerId: provider.providerId,
      issuer: provider.issuer,
      audiences: [provider.audience],
      algorithms: ["RS256"]
    });

    const updated = await SELF.fetch(`http://example.com/admin/oidc/providers/${provider.providerId}`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        ...providerRecord,
        clockToleranceSeconds: 5,
        claimMapping: {
          subject: "sub",
          scopes: "scope",
          groups: "groups",
          roles: "roles",
          tenantId: "tid",
          department: "department"
        }
      })
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      providerId: provider.providerId,
      clockToleranceSeconds: 5,
      claimMapping: expect.objectContaining({ department: "department" })
    });

    const created = await createCatalog("lifecycle");
    const mapping = {
      mappings: [
        {
          mappingId: "finance-tenant-a",
          providerId: provider.providerId,
          priority: 100,
          match: {
            scopesAll: ["ducklake:finance:connect"],
            claims: { tenantId: "tenant-a" }
          }
        }
      ]
    };
    await putMapping(created.catalog.catalogId, mapping);

    const fetchedMapping = await SELF.fetch(`http://example.com/admin/catalogs/${created.catalog.catalogId}/auth-mapping`, {
      headers: adminHeaders
    });
    expect(fetchedMapping.status).toBe(200);
    await expect(fetchedMapping.json()).resolves.toEqual(mapping);

    const deleteMapping = await SELF.fetch(`http://example.com/admin/catalogs/${created.catalog.catalogId}/auth-mapping`, {
      method: "DELETE",
      headers: adminHeaders
    });
    expect(deleteMapping.status).toBe(200);
    await expect(deleteMapping.json()).resolves.toEqual({ deleted: true });

    const emptyMapping = await SELF.fetch(`http://example.com/admin/catalogs/${created.catalog.catalogId}/auth-mapping`, {
      headers: adminHeaders
    });
    await expect(emptyMapping.json()).resolves.toEqual({ mappings: [] });

    const policy = {
      version: 1,
      defaultEffect: "deny",
      rules: [
        {
          ruleId: "catalog-admin",
          effect: "allow",
          principal: { scopesAny: ["catalog.admin"] },
          actions: ["*"],
          resource: { schema: "*", table: "*", column: "*" }
        }
      ]
    };
    await putPolicy(created.catalog.catalogId, policy);

    const fetchedPolicy = await SELF.fetch(`http://example.com/admin/catalogs/${created.catalog.catalogId}/auth-policy`, {
      headers: adminHeaders
    });
    expect(fetchedPolicy.status).toBe(200);
    await expect(fetchedPolicy.json()).resolves.toMatchObject({ policy, policyVersion: 1 });

    const deletePolicy = await SELF.fetch(`http://example.com/admin/catalogs/${created.catalog.catalogId}/auth-policy`, {
      method: "DELETE",
      headers: adminHeaders
    });
    expect(deletePolicy.status).toBe(200);
    await expect(deletePolicy.json()).resolves.toEqual({ deleted: true });

    const emptyPolicy = await SELF.fetch(`http://example.com/admin/catalogs/${created.catalog.catalogId}/auth-policy`, {
      headers: adminHeaders
    });
    await expect(emptyPolicy.json()).resolves.toEqual({ policyVersion: 0 });

    const deleteProvider = await SELF.fetch(`http://example.com/admin/oidc/providers/${provider.providerId}`, {
      method: "DELETE",
      headers: adminHeaders
    });
    expect(deleteProvider.status).toBe(200);
    await expect(deleteProvider.json()).resolves.toEqual({ deleted: true });

    const deletedProvider = await SELF.fetch(`http://example.com/admin/oidc/providers/${provider.providerId}`, {
      headers: adminHeaders
    });
    expect(deletedProvider.status).toBe(404);
  });

  it("issues first-party JWT credentials and never lists raw JWTs", async () => {
    const created = await createCatalog("jwt_issue");
    expect(created.catalog.dataAccessMode).toBe("catalog_only");
    expect(created.catalog.dataPath).toBe(r2TestUri(`catalogs/${created.catalog.catalogId}/`));
    expect(created.ducklake).toMatchObject({
      secretName: `quacklake_${created.catalog.catalogId}`,
      quackScope: "quack:example.com:443",
      dataPath: created.catalog.dataPath,
      attachSql: `ATTACH 'ducklake:quack:example.com:443' AS lake (DATA_PATH '${created.catalog.dataPath}');`
    });
    expect(created.ducklake.secretSql).toContain(`TOKEN '${created.jwt}'`);
    expect(created.ducklake.secretSql).toContain("SCOPE 'quack:example.com:443'");
    expect(created.jwt).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    expect(created.credential.credentialId).toEqual(expect.any(String));

    const listed = await SELF.fetch(`http://example.com/admin/catalogs/${created.catalog.catalogId}/credentials`, {
      headers: adminHeaders
    });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody).toMatchObject({
      credentials: [
        {
          credentialId: created.credential.credentialId,
          catalogId: created.catalog.catalogId
        }
      ]
    });
    expect(JSON.stringify(listedBody)).not.toContain(created.jwt);
  });

  it("lists configured R2 buckets through the admin API", async () => {
    const response = await SELF.fetch("http://example.com/admin/r2-buckets", { headers: adminHeaders });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      buckets: [
        {
          bucket: testR2BucketName(),
          binding: "DUCKLAKE_R2",
          available: true,
          source: "DUCKLAKE_R2_BINDINGS"
        }
      ]
    });
  });

  it("defaults to catalog-only access and vends trusted-client R2 data leases explicitly", async () => {
    const catalogOnly = await createCatalog("lease_default");
    const catalogOnlyLease = await SELF.fetch("http://example.com/catalog/data-lease", {
      method: "POST",
      headers: { Authorization: `Bearer ${catalogOnly.jwt}` }
    });
    expect(catalogOnlyLease.status).toBe(403);
    await expect(catalogOnlyLease.json()).resolves.toMatchObject({
      error: expect.stringContaining("trusted_client")
    });

    const trusted = await createCatalog("lease_trusted", { dataAccessMode: "trusted_client" });
    expect(trusted.catalog.dataAccessMode).toBe("trusted_client");

    const uninitializedLease = await SELF.fetch("http://example.com/catalog/data-lease", {
      method: "POST",
      headers: { Authorization: `Bearer ${trusted.jwt}` }
    });
    expect(uninitializedLease.status).toBe(201);
    await expect(uninitializedLease.json()).resolves.toMatchObject({
      dataPath: trusted.catalog.dataPath,
      r2: {
        bucket: testR2BucketName(),
        prefix: `catalogs/${trusted.catalog.catalogId}/`
      }
    });

    await putPolicy(trusted.catalog.catalogId, { version: 1, defaultEffect: "allow", rules: [] });
    const dataPath = trusted.catalog.dataPath;
    await initializeDuckLakeDataPath(trusted.jwt, dataPath);

    const limitedCredential = await createCredential(trusted.catalog.catalogId, { scopes: ["ducklake.finance.read"] });
    const limitedLease = await SELF.fetch("http://example.com/catalog/data-lease", {
      method: "POST",
      headers: { Authorization: `Bearer ${limitedCredential.jwt}` }
    });
    expect(limitedLease.status).toBe(403);
    await expect(limitedLease.json()).resolves.toMatchObject({
      error: expect.stringContaining("catalog.admin or lake.raw")
    });

    const rawCredential = await createCredential(trusted.catalog.catalogId, { scopes: ["lake.raw"] });
    const rawScopeLease = await SELF.fetch("http://example.com/catalog/data-lease", {
      method: "POST",
      headers: { Authorization: `Bearer ${rawCredential.jwt}` }
    });
    expect(rawScopeLease.status).toBe(201);
    await expect(rawScopeLease.json()).resolves.toMatchObject({
      access: "read_write",
      credentials: { accessKeyId: "test-r2-access-key" }
    });

    const lease = await SELF.fetch("http://example.com/catalog/data-lease", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${trusted.jwt}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ access: "read", reason: "execute" })
    });
    expect(lease.status).toBe(201);
    const body = await lease.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      catalogId: trusted.catalog.catalogId,
      ttlSeconds: 60,
      dataPath,
      access: "read",
      r2: {
        endpoint: "https://test-account.r2.cloudflarestorage.com",
        bucket: testR2BucketName(),
        prefix: `catalogs/${trusted.catalog.catalogId}/`
      },
      credentials: {
        accessKeyId: "test-r2-access-key",
        secretAccessKey: expect.any(String),
        sessionToken: expect.any(String)
      },
      duckdb: {
        secretType: "s3",
        scope: dataPath,
        urlStyle: "path",
        region: "auto"
      },
      warning: expect.stringContaining("raw R2 object access")
    });
    const credentials = body.credentials as { secretAccessKey: string; sessionToken: string };
    expect(credentials.secretAccessKey).not.toBe("test-r2-secret-key");
    expect(atob(credentials.sessionToken)).toMatch(/^jwt\//);
    expect(JSON.stringify(body.duckdb)).not.toContain(credentials.secretAccessKey);
    expect(JSON.stringify(body.duckdb)).not.toContain(credentials.sessionToken);

    const rejectedBody = await SELF.fetch("http://example.com/catalog/data-lease", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${trusted.jwt}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ catalogId: trusted.catalog.catalogId })
    });
    expect(rejectedBody.status).toBe(400);
    await expect(rejectedBody.json()).resolves.toMatchObject({
      error: expect.stringContaining("catalogId is not accepted")
    });
  });

  it("denies expired, wrong-audience, wrong-issuer, revoked, and catalog-mismatched first-party JWTs", async () => {
    const created = await createCatalog("jwt_deny");
    await putPolicy(created.catalog.catalogId, { version: 1, defaultEffect: "allow", rules: [] });

    await expect(connectWith(await firstPartyJwt(created, { expiresAt: Math.floor(Date.now() / 1000) - 60 }))).rejects.toThrow(/Invalid auth JWT/i);
    await expect(connectWith(await firstPartyJwt(created, { audience: "wrong-audience" }))).rejects.toThrow(/Invalid auth JWT/i);
    await expect(connectWith(await firstPartyJwt(created, { issuer: "wrong-issuer" }))).rejects.toThrow(/Invalid auth JWT/i);
    await expect(connectWith(await firstPartyJwt(created, { catalogId: `${created.catalog.catalogId}_other` }))).rejects.toThrow(/Invalid auth JWT/i);

    const revoke = await SELF.fetch(
      `http://example.com/admin/catalogs/${created.catalog.catalogId}/credentials/${created.credential.credentialId}`,
      {
        method: "DELETE",
        headers: adminHeaders
      }
    );
    expect(revoke.status).toBe(200);
    await expect(connectWith(created.jwt)).rejects.toThrow(/Invalid auth JWT/i);
  });

  it("maps one verified OIDC provider principal to one catalog", async () => {
    const provider = await createOidcProvider("oidc_one");
    const created = await createCatalog("oidc_catalog");
    await putPolicy(created.catalog.catalogId, { version: 1, defaultEffect: "allow", rules: [] });
    await putMapping(created.catalog.catalogId, {
      mappings: [
        {
          mappingId: "finance-readers",
          providerId: provider.providerId,
          match: {
            groupsAny: ["finance"],
            scopesAll: ["ducklake:finance:connect"],
            rolesAny: ["analyst"],
            claims: { tenantId: "tenant-a" }
          }
        }
      ]
    });

    const oidcJwt = await provider.sign({
      groups: ["finance"],
      scope: "ducklake:finance:connect ducklake:finance:read",
      roles: ["analyst"],
      tid: "tenant-a"
    });
    const client = await connectWith(oidcJwt);
    try {
      expect(await client.values<number>("SELECT 1")).toEqual([1]);
    } finally {
      await client.disconnect();
    }
  });

  it("denies OIDC catalog selection when no mapping or multiple catalogs match", async () => {
    const provider = await createOidcProvider("oidc_ambiguous");
    const first = await createCatalog("oidc_first");
    const second = await createCatalog("oidc_second");
    await putPolicy(first.catalog.catalogId, { version: 1, defaultEffect: "allow", rules: [] });
    await putPolicy(second.catalog.catalogId, { version: 1, defaultEffect: "allow", rules: [] });

    const noMatch = await provider.sign({ groups: ["unknown"] });
    await expect(connectWith(noMatch)).rejects.toThrow(/Invalid auth JWT/i);

    const mapping = {
      mappings: [
        {
          mappingId: "shared",
          providerId: provider.providerId,
          match: { groupsAny: ["shared"] }
        }
      ]
    };
    await putMapping(first.catalog.catalogId, mapping);
    await putMapping(second.catalog.catalogId, mapping);

    const ambiguous = await provider.sign({ groups: ["shared"] });
    await expect(connectWith(ambiguous)).rejects.toThrow(/Invalid auth JWT/i);

    const deleteProvider = await SELF.fetch(`http://example.com/admin/oidc/providers/${provider.providerId}`, {
      method: "DELETE",
      headers: adminHeaders
    });
    expect(deleteProvider.status).toBe(409);
  });

  it("denies OIDC JWTs with invalid issuer, audience, timing, algorithm, or key", async () => {
    const provider = await createOidcProvider("oidc_invalid");
    const created = await createCatalog("oidc_invalid_catalog");
    await putPolicy(created.catalog.catalogId, { version: 1, defaultEffect: "allow", rules: [] });
    await putMapping(created.catalog.catalogId, {
      mappings: [
        {
          mappingId: "finance-readers",
          providerId: provider.providerId,
          match: { groupsAny: ["finance"] }
        }
      ]
    });

    const now = Math.floor(Date.now() / 1000);
    const invalidTokens = [
      provider.sign({ groups: ["finance"] }, { issuer: "https://issuer.example/wrong" }),
      provider.sign({ groups: ["finance"] }, { audience: "api://wrong-audience" }),
      provider.sign({ groups: ["finance"] }, { expiresAt: now - 120 }),
      provider.sign({ groups: ["finance"] }, { notBefore: now + 3600 }),
      hs256OidcJwt(provider, { groups: ["finance"] }),
      oidcJwtWithWrongKey(provider, { groups: ["finance"] })
    ];

    for (const token of await Promise.all(invalidTokens)) {
      await expect(connectWith(token)).rejects.toThrow(/Invalid auth JWT/i);
    }
  });

  it("enforces catalog policy for prepared SQL and explains decisions", async () => {
    const created = await createCatalog("authz_columns");
    await putPolicy(created.catalog.catalogId, { version: 1, defaultEffect: "allow", rules: [] });
    const adminClient = await connectWith(created.jwt);
    try {
      await adminClient.query("CREATE TABLE items(id INTEGER, secret VARCHAR)");
      await adminClient.query("INSERT INTO items VALUES (1, 'hidden')");
    } finally {
      await adminClient.disconnect();
    }

    await putPolicy(created.catalog.catalogId, {
      version: 1,
      defaultEffect: "deny",
      rules: [
        {
          ruleId: "read-id",
          effect: "allow",
          principal: { scopesAny: ["catalog.admin"] },
          actions: ["table.read", "column.read"],
          resource: { schema: "main", table: "items", columns: ["id"] }
        }
      ]
    });

    const limited = await connectWith(created.jwt);
    try {
      expect(await limited.values<number>("SELECT id FROM items")).toEqual([1]);
      await expect(limited.query("SELECT secret FROM items")).rejects.toThrow(/Authorization denied/i);
    } finally {
      await limited.disconnect();
    }

    const explain = await SELF.fetch("http://example.com/admin/authz/explain", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        authString: created.jwt,
        sql: "SELECT secret FROM items",
        catalogId: created.catalog.catalogId
      })
    });
    expect(explain.status).toBe(200);
    await expect(explain.json()).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("no allow rule"),
      principal: { authMode: "first_party_jwt" },
      catalog: { catalogId: created.catalog.catalogId },
      requiredActions: expect.arrayContaining([
        { action: "column.read", resource: expect.objectContaining({ table: "items", column: "secret" }) }
      ])
    });
  });

  it("evaluates CRUD actions, deny precedence, row predicates, and unsupported SQL", async () => {
    const created = await createCatalog("authz_matrix");

    await putPolicy(created.catalog.catalogId, {
      version: 1,
      defaultEffect: "deny",
      rules: [
        {
          ruleId: "crud",
          effect: "allow",
          principal: { scopesAny: ["catalog.admin"] },
          actions: ["table.read", "table.create", "table.insert", "table.update", "table.delete", "table.drop"],
          resource: { schema: "main", table: "*" }
        }
      ]
    });
    await expect(explain(created.jwt, created.catalog.catalogId, `
      CREATE TABLE main.allowed(id INTEGER);
      INSERT INTO main.allowed VALUES (1);
      UPDATE main.allowed SET id = 2;
      DELETE FROM main.allowed;
      DROP TABLE main.allowed;
    `)).resolves.toMatchObject({
      allowed: true,
      matchedRules: [{ ruleId: "crud", effect: "allow" }],
      requiredActions: expect.arrayContaining([
        { action: "table.create", resource: expect.objectContaining({ table: "allowed" }) },
        { action: "table.insert", resource: expect.objectContaining({ table: "allowed" }) },
        { action: "table.update", resource: expect.objectContaining({ table: "allowed" }) },
        { action: "table.delete", resource: expect.objectContaining({ table: "allowed" }) },
        { action: "table.drop", resource: expect.objectContaining({ table: "allowed" }) }
      ])
    });

    const bootstrap = await connectWith(created.jwt);
    try {
      await bootstrap.query("CREATE TABLE items(id INTEGER, secret VARCHAR)");
      await bootstrap.query("CREATE TABLE invoices(tenant_id VARCHAR)");
    } finally {
      await bootstrap.disconnect();
    }

    await putPolicy(created.catalog.catalogId, {
      version: 1,
      defaultEffect: "deny",
      rules: [
        {
          ruleId: "deny-secret",
          effect: "deny",
          principal: { scopesAny: ["catalog.admin"] },
          actions: ["column.read"],
          resource: { schema: "main", table: "items", column: "secret" }
        },
        {
          ruleId: "allow-read",
          effect: "allow",
          principal: { scopesAny: ["catalog.admin"] },
          actions: ["table.read", "column.read"],
          resource: { schema: "main", table: "*", column: "*" }
        }
      ]
    });
    await expect(explain(created.jwt, created.catalog.catalogId, "SELECT secret FROM items")).resolves.toMatchObject({
      allowed: false,
      reason: "matched deny rule",
      matchedRules: [{ ruleId: "deny-secret", effect: "deny" }]
    });

    await putPolicy(created.catalog.catalogId, {
      version: 1,
      defaultEffect: "deny",
      rules: [
        {
          ruleId: "tenant-read",
          effect: "allow",
          principal: { scopesAny: ["catalog.admin"] },
          actions: ["table.read", "column.read"],
          resource: { schema: "main", table: "invoices", columns: ["tenant_id"] },
          rowPredicate: "tenant_id = ${claims.tenantId}"
        }
      ]
    });
    await expect(explain(created.jwt, created.catalog.catalogId, "SELECT tenant_id FROM invoices")).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("no allow rule")
    });

    const tenantJwt = await firstPartyJwt(created, { claims: { tenantId: "tenant-a" } });
    await expect(explain(tenantJwt, created.catalog.catalogId, "SELECT tenant_id FROM invoices")).resolves.toMatchObject({
      allowed: true,
      matchedRules: [{ ruleId: "tenant-read", effect: "allow" }]
    });

    await expect(explain(tenantJwt, created.catalog.catalogId, "PRAGMA table_info(items)")).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Unsupported SQL")
    });
  });

  it("authorizes APPEND_REQUEST with the session policy captured at connection time", async () => {
    const created = await createCatalog("append_authz");
    await putPolicy(created.catalog.catalogId, { version: 1, defaultEffect: "allow", rules: [] });
    const bootstrap = await connectWith(created.jwt);
    try {
      await bootstrap.query("CREATE TABLE items(id INTEGER)");
    } finally {
      await bootstrap.disconnect();
    }

    await putPolicy(created.catalog.catalogId, {
      version: 1,
      defaultEffect: "deny",
      rules: [
        {
          ruleId: "writer",
          effect: "allow",
          principal: { scopesAny: ["catalog.admin"] },
          actions: ["table.insert", "table.read", "column.read"],
          resource: { schema: "main", table: "items", column: "*" }
        }
      ]
    });

    const writer = await connectWith(created.jwt);
    try {
      await putPolicy(created.catalog.catalogId, {
        version: 1,
        defaultEffect: "deny",
        rules: [
          {
            ruleId: "read-only",
            effect: "allow",
            principal: { scopesAny: ["catalog.admin"] },
            actions: ["table.read", "column.read"],
            resource: { schema: "main", table: "items", column: "*" }
          }
        ]
      });

      await writer.appendRows("items", [{ id: 1 }], {
        columns: { id: LogicalTypes.integer() }
      });
      expect(await writer.values<number>("SELECT id FROM items")).toEqual([1]);
    } finally {
      await writer.disconnect();
    }

    const denied = await connectWith(created.jwt);
    try {
      await expect(
        denied.appendRows("items", [{ id: 2 }], {
          columns: { id: LogicalTypes.integer() }
        })
      ).rejects.toThrow(/Authorization denied: no allow rule for table.insert/i);
    } finally {
      await denied.disconnect();
    }
  });

  it("returns Quack protocol errors for invalid connection and result paths", async () => {
    const created = await createCatalog("protocol_errors");
    await putPolicy(created.catalog.catalogId, { version: 1, defaultEffect: "allow", rules: [] });
    const client = await connectWith(created.jwt);
    const connectionId = (client as unknown as { connectionId: string }).connectionId;
    expect(connectionId).toEqual(expect.any(String));

    await expect(client.send({ type: MessageType.FETCH_REQUEST, resultUuid: 1n })).rejects.toThrow(/Missing connection id/i);
    await expect(client.send({
      type: MessageType.FETCH_REQUEST,
      connectionId: "not-a-signed-connection-id",
      resultUuid: 1n
    })).rejects.toThrow(/Invalid connection id/i);
    await expect(client.send({
      type: MessageType.FETCH_REQUEST,
      connectionId,
      resultUuid: { upper: 123n, lower: 456n }
    })).rejects.toThrow(/Result has been closed/i);
    await expect(client.send({
      type: MessageType.SUCCESS_RESPONSE,
      connectionId
    })).rejects.toThrow(/Unsupported request message type SUCCESS_RESPONSE/i);

    await client.disconnect();
    await expect(client.send({
      type: MessageType.PREPARE_REQUEST,
      connectionId,
      sql: "SELECT 1"
    })).rejects.toThrow(/Invalid connection id/i);
  });

  it("rejects unsupported Quack protocol versions in the binary error envelope", async () => {
    const created = await createCatalog("protocol_version");
    await putPolicy(created.catalog.catalogId, { version: 1, defaultEffect: "allow", rules: [] });

    await expect(QuackClient.connect("http://example.com", {
      authToken: created.jwt,
      fetch: SELF.fetch.bind(SELF) as typeof fetch,
      minSupportedQuackVersion: 2
    })).rejects.toThrow(/newer Quack protocol version/i);
  });

  it("fetches multi-batch prepared results and closes stale result ids after a new query", async () => {
    const created = await createCatalog("fetch_batches");
    await putPolicy(created.catalog.catalogId, { version: 1, defaultEffect: "allow", rules: [] });
    const client = await connectWith(created.jwt);
    try {
      const connectionId = (client as unknown as { connectionId: string }).connectionId;
      const first = await client.send({
        type: MessageType.PREPARE_REQUEST,
        connectionId,
        sql: `
          WITH RECURSIVE numbers(n) AS (
            SELECT 1
            UNION ALL
            SELECT n + 1 FROM numbers WHERE n < 13000
          )
          SELECT n FROM numbers
        `
      });
      expect(first.type).toBe(MessageType.PREPARE_RESPONSE);
      if (first.type !== MessageType.PREPARE_RESPONSE) {
        throw new Error("Expected PREPARE_RESPONSE");
      }
      expect(first.needsMoreFetch).toBe(true);
      expect(first.results).toHaveLength(12);
      expect(first.results.reduce((total, chunk) => total + chunk.rowCount, 0)).toBe(12 * 1024);

      const fetched = await client.send({
        type: MessageType.FETCH_REQUEST,
        connectionId,
        resultUuid: first.resultUuid
      });
      expect(fetched.type).toBe(MessageType.FETCH_RESPONSE);
      if (fetched.type !== MessageType.FETCH_RESPONSE) {
        throw new Error("Expected FETCH_RESPONSE");
      }
      expect(fetched.results.reduce((total, chunk) => total + chunk.rowCount, 0)).toBe(13000 - 12 * 1024);
      expect(fetched.batchIndex).toBe(2n);

      await client.send({
        type: MessageType.PREPARE_REQUEST,
        connectionId,
        sql: "SELECT 1"
      });
      await expect(client.send({
        type: MessageType.FETCH_REQUEST,
        connectionId,
        resultUuid: first.resultUuid
      })).rejects.toThrow(/Result has been closed/i);
    } finally {
      await client.disconnect();
    }
  });

  it("validates append chunks against the tracked table schema", async () => {
    const created = await createCatalog("append_schema");
    await putPolicy(created.catalog.catalogId, { version: 1, defaultEffect: "allow", rules: [] });
    const client = await connectWith(created.jwt);
    try {
      await client.query("CREATE TABLE items(id INTEGER)");
      await expect(client.appendRows("items", [{ id: 1, extra: "x" }], {
        columns: {
          id: LogicalTypes.integer(),
          extra: LogicalTypes.varchar()
        }
      })).rejects.toThrow(/APPEND_REQUEST has 2 columns, expected 1/i);
    } finally {
      await client.disconnect();
    }
  });
});

async function createCatalog(prefix: string, options: Record<string, unknown> = {}): Promise<CreatedCatalog> {
  const catalogId = `${prefix}_${crypto.randomUUID().replaceAll("-", "_")}`;
  const response = await SELF.fetch("http://example.com/admin/catalogs", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ catalogId, ...options })
  });
  expect(response.status).toBe(201);
  return response.json<CreatedCatalog>();
}

function testR2BucketName(): string {
  const runtimeEnv = env as unknown as { DUCKLAKE_R2_BINDINGS?: string };
  if (runtimeEnv.DUCKLAKE_R2_BINDINGS) {
    try {
      const parsed = JSON.parse(runtimeEnv.DUCKLAKE_R2_BINDINGS) as Record<string, string>;
      const firstBucket = Object.keys(parsed)[0];
      if (firstBucket) {
        return firstBucket;
      }
    } catch {
      // Fall through to the deterministic test default below.
    }
  }
  return "test-ducklake-r2";
}

function r2TestUri(key: string): string {
  return `r2://${testR2BucketName()}/${key}`;
}

async function initializeDuckLakeDataPath(authToken: string, dataPath: string): Promise<void> {
  const client = await connectWith(authToken);
  try {
    await client.query("CREATE TABLE main.ducklake_metadata(key VARCHAR NOT NULL, value VARCHAR NOT NULL, scope VARCHAR, scope_id BIGINT)");
    await client.query(`INSERT INTO main.ducklake_metadata VALUES ('data_path', '${dataPath}', NULL, NULL)`);
  } finally {
    await client.disconnect();
  }
}

async function createCredential(catalogId: string, body: Record<string, unknown>): Promise<{ jwt: string }> {
  const response = await SELF.fetch(`http://example.com/admin/catalogs/${catalogId}/credentials`, {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(201);
  return response.json<{ jwt: string }>();
}

async function putPolicy(catalogId: string, policy: unknown): Promise<void> {
  const response = await SELF.fetch(`http://example.com/admin/catalogs/${catalogId}/auth-policy`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify(policy)
  });
  expect(response.status).toBe(200);
}

async function putMapping(catalogId: string, mapping: unknown): Promise<void> {
  const response = await SELF.fetch(`http://example.com/admin/catalogs/${catalogId}/auth-mapping`, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify(mapping)
  });
  expect(response.status).toBe(200);
}

async function explain(authString: string, catalogId: string, sql: string, messageType = "PREPARE_REQUEST"): Promise<unknown> {
  const response = await SELF.fetch("http://example.com/admin/authz/explain", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({ authString, catalogId, sql, messageType })
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function expectAdminError(
  url: string,
  body: unknown,
  status: number,
  error: RegExp,
  method = "POST"
): Promise<void> {
  const response = await SELF.fetch(url, {
    method,
    headers: adminHeaders,
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(error) });
}

function oidcProviderConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: `provider_${crypto.randomUUID().replaceAll("-", "_")}`,
    issuer: "https://issuer.example/test",
    audiences: ["api://quacklake"],
    algorithms: ["RS256"],
    jwks: [{ kty: "RSA", kid: "test", alg: "RS256", use: "sig", n: "AQAB", e: "AQAB" }],
    ...overrides
  };
}

async function connectWith(authToken: string): Promise<QuackClient> {
  return QuackClient.connect("http://example.com", {
    authToken,
    fetch: SELF.fetch.bind(SELF) as typeof fetch
  });
}

async function firstPartyJwt(
  created: CreatedCatalog,
  overrides: {
    issuer?: string;
    audience?: string;
    catalogId?: string;
    expiresAt?: number;
    notBefore?: number;
    scope?: string;
    claims?: Record<string, unknown>;
  }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({
    ...overrides.claims,
    catalog_id: overrides.catalogId ?? created.catalog.catalogId,
    scope: overrides.scope ?? "catalog.admin"
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(overrides.issuer ?? "quacklake")
    .setAudience(overrides.audience ?? "quacklake:quack")
    .setSubject(`credential:${created.credential.credentialId}`)
    .setJti(created.credential.credentialId)
    .setIssuedAt(now)
    .setExpirationTime(overrides.expiresAt ?? now + 3600);
  if (overrides.notBefore !== undefined) {
    jwt = jwt.setNotBefore(overrides.notBefore);
  }
  return jwt.sign(firstPartySecret);
}

async function createOidcProvider(prefix: string): Promise<{
  providerId: string;
  issuer: string;
  audience: string;
  jwk: JsonWebKey;
  sign(
    claims: Record<string, unknown>,
    overrides?: { issuer?: string; audience?: string; expiresAt?: number; notBefore?: number; kid?: string }
  ): Promise<string>;
}> {
  const providerId = `${prefix}_${crypto.randomUUID().replaceAll("-", "_")}`;
  const issuer = `https://issuer.example/${providerId}`;
  const audience = "api://quacklake";
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = crypto.randomUUID();
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid,
    alg: "RS256",
    use: "sig"
  } as JsonWebKey;
  const response = await SELF.fetch("http://example.com/admin/oidc/providers", {
    method: "POST",
    headers: adminHeaders,
    body: JSON.stringify({
      providerId,
      issuer,
      audiences: [audience],
      algorithms: ["RS256"],
      clockToleranceSeconds: 60,
      claimMapping: {
        subject: "sub",
        scopes: "scope",
        groups: "groups",
        roles: "roles",
        tenantId: "tid"
      },
      jwks: [jwk]
    })
  });
  expect(response.status).toBe(201);
  return {
    providerId,
    issuer,
    audience,
    jwk,
    sign(
      claims: Record<string, unknown>,
      overrides: { issuer?: string; audience?: string; expiresAt?: number; notBefore?: number; kid?: string } = {}
    ): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      let jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: overrides.kid ?? kid })
        .setIssuer(overrides.issuer ?? issuer)
        .setAudience(overrides.audience ?? audience)
        .setSubject(String(claims.sub ?? `user-${providerId}`))
        .setIssuedAt(now)
        .setExpirationTime(overrides.expiresAt ?? now + 3600);
      if (overrides.notBefore !== undefined) {
        jwt = jwt.setNotBefore(overrides.notBefore);
      }
      return jwt.sign(privateKey);
    }
  };
}

async function hs256OidcJwt(
  provider: { issuer: string; audience: string; providerId: string },
  claims: Record<string, unknown>
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(provider.issuer)
    .setAudience(provider.audience)
    .setSubject(String(claims.sub ?? `user-${provider.providerId}`))
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode("wrong-oidc-secret"));
}

async function oidcJwtWithWrongKey(
  provider: { issuer: string; audience: string; providerId: string },
  claims: Record<string, unknown>
): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "wrong-key" })
    .setIssuer(provider.issuer)
    .setAudience(provider.audience)
    .setSubject(String(claims.sub ?? `user-${provider.providerId}`))
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

function assertOpenApiContract(docs: OpenApiDoc): void {
  const refs = collectRefs(docs);
  for (const ref of refs) {
    expect(resolveJsonRef(docs, ref), `OpenAPI $ref ${ref} should resolve`).not.toBeUndefined();
  }

  const operationIds = new Set<string>();
  for (const [path, pathItem] of Object.entries(docs.paths)) {
    const pathParameters = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).filter((name): name is string => !!name);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isHttpMethod(method)) {
        continue;
      }
      if (!isRecord(operation)) {
        throw new Error(`${method.toUpperCase()} ${path} must be an object`);
      }
      const operationId = operation.operationId;
      if (typeof operationId !== "string" || operationId.length === 0) {
        throw new Error(`${method.toUpperCase()} ${path} must define operationId`);
      }
      if (operationIds.has(operationId)) {
        throw new Error(`Duplicate OpenAPI operationId ${operationId}`);
      }
      operationIds.add(operationId);
      if (!isRecord(operation.responses)) {
        throw new Error(`${method.toUpperCase()} ${path} must define responses`);
      }
      const parameters = [
        ...resolveParameters(docs, pathItem.parameters),
        ...resolveParameters(docs, operation.parameters)
      ];
      for (const name of pathParameters) {
        expect(parameters).toContainEqual(expect.objectContaining({ name, in: "path", required: true }));
      }
      if (path === "/api-docs") {
        expect(operation.security).toEqual([]);
      } else if (path.startsWith("/admin/")) {
        expect(operation.security).toEqual([{ AdminBearer: [] }]);
      }
    }
  }
  expect(operationIds.size).toBeGreaterThan(10);
}

function resolveParameters(docs: OpenApiDoc, parameters: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(parameters)) {
    return [];
  }
  return parameters.map((parameter) => {
    const resolved = isRecord(parameter) && typeof parameter.$ref === "string" ? resolveJsonRef(docs, parameter.$ref) : parameter;
    if (!isRecord(resolved)) {
      throw new Error("OpenAPI parameter must resolve to an object");
    }
    return resolved;
  });
}

function collectRefs(value: unknown, refs = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
    return refs;
  }
  if (!isRecord(value)) {
    return refs;
  }
  if (typeof value.$ref === "string") {
    refs.add(value.$ref);
  }
  for (const nested of Object.values(value)) {
    collectRefs(nested, refs);
  }
  return refs;
}

function resolveJsonRef(docs: OpenApiDoc, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new Error(`Only local OpenAPI refs are supported in tests: ${ref}`);
  }
  return ref
    .slice(2)
    .split("/")
    .reduce<unknown>((current, part) => {
      if (!isRecord(current)) {
        return undefined;
      }
      return current[part.replaceAll("~1", "/").replaceAll("~0", "~")];
    }, docs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isHttpMethod(method: string): boolean {
  return ["get", "put", "post", "delete", "patch", "options", "head", "trace"].includes(method);
}
