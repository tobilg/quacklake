import { DurableObject } from "cloudflare:workers";
import type { Schema } from "@polyglot-sql/sdk";
import { createLocalJWKSet, createRemoteJWKSet, decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import type {
  AuthPrincipal,
  CatalogAuthMappingDocument,
  CatalogAuthMappingRule,
  CatalogAuthPolicy,
  CatalogRecord,
  CreateCatalogOptions,
  CreateCatalogResult,
  CreateCredentialOptions,
  CreateCredentialResult,
  CredentialRecord,
  DataAccessMode,
  MatchedCatalogMapping,
  OidcProviderConfig,
  OidcProviderRecord,
  ProviderClaimMapping,
  ResolveAuthStringResult
} from "./auth";
import { classifySqlText, evaluatePolicy, principalMatches } from "./authz";
import type { RuntimeEnv } from "./env";
import { objectStoreLocationFromUri, resolveR2BindingForBucket, selectConfiguredR2Bucket } from "./file-listing";
import { plannedDuckLakeDataPath } from "./ducklake-data-path";
import { createR2TempCredentials } from "./r2-temp-credentials";

interface CredentialRow {
  [key: string]: SqlStorageValue;
  credential_id: string;
  catalog_id: string;
  issuer: string;
  subject: string;
  scopes_json: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface CredentialWithCatalogRow extends CredentialRow {
  object_name: string;
}

interface ProviderRow {
  [key: string]: SqlStorageValue;
  provider_id: string;
  issuer: string;
  jwks_uri: string | null;
  audiences_json: string;
  algorithms_json: string;
  clock_tolerance_seconds: number | null;
  claim_mapping_json: string;
  jwks_json: string | null;
  created_at: string;
  updated_at: string;
}

interface PolicyRow {
  [key: string]: SqlStorageValue;
  policy_json: string;
  policy_version: number;
}

interface CatalogRow {
  [key: string]: SqlStorageValue;
  catalog_id: string;
  object_name: string;
  data_path: string | null;
  data_access_mode: string;
  created_at: string;
  updated_at: string;
}

const FIRST_PARTY_PROVIDER_ID = "quacklake";
const DEFAULT_JWT_ISSUER = "quacklake";
const DEFAULT_JWT_AUDIENCE = "quacklake:quack";
const DEFAULT_CREDENTIAL_TTL_SECONDS = 365 * 24 * 60 * 60;
const DEFAULT_DATA_ACCESS_MODE: DataAccessMode = "catalog_only";
const DEFAULT_DATA_LEASE_TTL_SECONDS = 60;
const MIN_DATA_LEASE_TTL_SECONDS = 30;
const MAX_DATA_LEASE_TTL_SECONDS = 120;

export class CatalogRegistry extends DurableObject<RuntimeEnv> {
  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.initialize();
    });
  }

  async createCatalog(catalogId: string, options: CreateCatalogOptions = {}): Promise<CreateCatalogResult> {
    const id = validateCatalogId(catalogId);
    const dataAccessMode = validateDataAccessMode(options.dataAccessMode ?? DEFAULT_DATA_ACCESS_MODE);
    const bucket = selectConfiguredR2Bucket(this.env, options.r2Bucket).bucket;
    const dataPath = plannedDuckLakeDataPath(bucket, id);
    const now = new Date().toISOString();
    const objectName = `catalog:${id}`;
    const exists = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM catalogs WHERE catalog_id = ?", id)
      .one().count;
    if (exists) {
      throw new Error(`Catalog ${id} already exists`);
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO catalogs (catalog_id, object_name, data_path, data_access_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      objectName,
      dataPath,
      dataAccessMode,
      now,
      now
    );
    await this.configureCatalogObject(objectName, dataPath);
    const created = await this.createCredentialSync(id, options);
    return {
      catalog: { catalogId: id, objectName, dataPath, dataAccessMode, createdAt: now, updatedAt: now },
      ...created
    };
  }

  listCatalogs(): CatalogRecord[] {
    return this.ctx.storage.sql
      .exec<CatalogRow>(
        "SELECT catalog_id, object_name, data_path, data_access_mode, created_at, updated_at FROM catalogs ORDER BY catalog_id"
      )
      .toArray()
      .map(catalogRecordFromRow);
  }

  catalogExists(catalogId: string): boolean {
    const id = validateCatalogId(catalogId);
    const row = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM catalogs WHERE catalog_id = ?", id)
      .one();
    return row.count > 0;
  }

  listCredentials(catalogId: string): CredentialRecord[] {
    const id = validateCatalogId(catalogId);
    return this.ctx.storage.sql
      .exec<CredentialRow>(
        `SELECT credential_id, catalog_id, issuer, subject, scopes_json, created_at, expires_at, revoked_at
         FROM credentials
         WHERE catalog_id = ?
         ORDER BY created_at`,
        id
      )
      .toArray()
      .map(credentialRecordFromRow);
  }

  async createCredential(catalogId: string, options: CreateCredentialOptions = {}): Promise<CreateCredentialResult> {
    const id = validateCatalogId(catalogId);
    const exists = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM catalogs WHERE catalog_id = ?", id)
      .one().count;
    if (!exists) {
      throw new Error(`Catalog ${id} does not exist`);
    }
    return this.createCredentialSync(id, options);
  }

  revokeCredential(catalogId: string, credentialId: string): { revoked: boolean } {
    const id = validateCatalogId(catalogId);
    const now = new Date().toISOString();
    const cursor = this.ctx.storage.sql.exec(
      "UPDATE credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE catalog_id = ? AND credential_id = ?",
      now,
      id,
      credentialId
    );
    cursor.toArray();
    return { revoked: true };
  }

  async resolveAuthString(authString: string): Promise<ResolveAuthStringResult | undefined> {
    if (!isJwtLike(authString)) {
      return undefined;
    }
    const firstParty = await this.resolveFirstPartyJwt(authString);
    if (firstParty) {
      return firstParty;
    }
    return this.resolveOidcJwt(authString);
  }

  createOidcProvider(config: OidcProviderConfig): OidcProviderRecord {
    const provider = validateProviderConfig(config);
    const exists = this.providerExists(provider.providerId);
    if (exists) {
      throw new Error(`OIDC provider ${provider.providerId} already exists`);
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO oidc_providers
       (provider_id, issuer, jwks_uri, audiences_json, algorithms_json, clock_tolerance_seconds, claim_mapping_json, jwks_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      provider.providerId,
      provider.issuer,
      provider.jwksUri ?? null,
      JSON.stringify(provider.audiences),
      JSON.stringify(provider.algorithms),
      provider.clockToleranceSeconds ?? null,
      JSON.stringify(provider.claimMapping ?? {}),
      provider.jwks ? JSON.stringify(provider.jwks) : null,
      now,
      now
    );
    return { ...provider, createdAt: now, updatedAt: now };
  }

  listOidcProviders(): OidcProviderRecord[] {
    return this.ctx.storage.sql
      .exec<ProviderRow>(
        `SELECT provider_id, issuer, jwks_uri, audiences_json, algorithms_json, clock_tolerance_seconds,
                claim_mapping_json, jwks_json, created_at, updated_at
         FROM oidc_providers
         ORDER BY provider_id`
      )
      .toArray()
      .map(providerFromRow);
  }

  getOidcProvider(providerId: string): OidcProviderRecord | undefined {
    const id = validateProviderId(providerId);
    const rows = this.ctx.storage.sql
      .exec<ProviderRow>(
        `SELECT provider_id, issuer, jwks_uri, audiences_json, algorithms_json, clock_tolerance_seconds,
                claim_mapping_json, jwks_json, created_at, updated_at
         FROM oidc_providers
         WHERE provider_id = ?`,
        id
      )
      .toArray();
    return rows[0] ? providerFromRow(rows[0]) : undefined;
  }

  updateOidcProvider(providerId: string, config: OidcProviderConfig): OidcProviderRecord {
    const id = validateProviderId(providerId);
    const provider = validateProviderConfig({ ...config, providerId: id });
    if (!this.providerExists(id)) {
      throw new Error(`OIDC provider ${id} does not exist`);
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE oidc_providers
       SET issuer = ?, jwks_uri = ?, audiences_json = ?, algorithms_json = ?, clock_tolerance_seconds = ?,
           claim_mapping_json = ?, jwks_json = ?, updated_at = ?
       WHERE provider_id = ?`,
      provider.issuer,
      provider.jwksUri ?? null,
      JSON.stringify(provider.audiences),
      JSON.stringify(provider.algorithms),
      provider.clockToleranceSeconds ?? null,
      JSON.stringify(provider.claimMapping ?? {}),
      provider.jwks ? JSON.stringify(provider.jwks) : null,
      now,
      id
    );
    const createdAt = this.getOidcProvider(id)?.createdAt ?? now;
    return { ...provider, createdAt, updatedAt: now };
  }

  deleteOidcProvider(providerId: string): { deleted: boolean; conflict?: boolean; error?: string } {
    const id = validateProviderId(providerId);
    const references = this.catalogMappingsReferencingProvider(id);
    if (references.length > 0) {
      return {
        deleted: false,
        conflict: true,
        error: `OIDC provider ${id} is referenced by catalog auth mappings`
      };
    }
    this.ctx.storage.sql.exec("DELETE FROM oidc_providers WHERE provider_id = ?", id);
    return { deleted: true };
  }

  getCatalogAuthMapping(catalogId: string): CatalogAuthMappingDocument {
    const id = validateCatalogId(catalogId);
    const row = this.ctx.storage.sql
      .exec<{ mappings_json: string }>("SELECT mappings_json FROM catalog_auth_mappings WHERE catalog_id = ?", id)
      .toArray()[0];
    return row ? parseJson<CatalogAuthMappingDocument>(row.mappings_json, { mappings: [] }) : { mappings: [] };
  }

  replaceCatalogAuthMapping(catalogId: string, document: CatalogAuthMappingDocument): CatalogAuthMappingDocument {
    const id = validateCatalogId(catalogId);
    this.requireCatalog(id);
    const mappings = validateMappingDocument(document);
    for (const mapping of mappings.mappings) {
      if (!this.providerExists(mapping.providerId)) {
        throw new Error(`OIDC provider ${mapping.providerId} does not exist`);
      }
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO catalog_auth_mappings (catalog_id, mappings_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(catalog_id) DO UPDATE SET mappings_json = excluded.mappings_json, updated_at = excluded.updated_at`,
      id,
      JSON.stringify(mappings),
      new Date().toISOString()
    );
    return mappings;
  }

  deleteCatalogAuthMapping(catalogId: string): { deleted: boolean } {
    const id = validateCatalogId(catalogId);
    this.ctx.storage.sql.exec("DELETE FROM catalog_auth_mappings WHERE catalog_id = ?", id);
    return { deleted: true };
  }

  getCatalogAuthPolicy(catalogId: string): { policy?: CatalogAuthPolicy; policyVersion: number } {
    const id = validateCatalogId(catalogId);
    const row = this.ctx.storage.sql
      .exec<PolicyRow>("SELECT policy_json, policy_version FROM catalog_auth_policies WHERE catalog_id = ?", id)
      .toArray()[0];
    if (!row) {
      return { policyVersion: 0 };
    }
    return {
      policy: parseJson<CatalogAuthPolicy>(row.policy_json, { version: 1, defaultEffect: "deny", rules: [] }),
      policyVersion: row.policy_version
    };
  }

  putCatalogAuthPolicy(catalogId: string, policy: CatalogAuthPolicy): { policy: CatalogAuthPolicy; policyVersion: number } {
    const id = validateCatalogId(catalogId);
    this.requireCatalog(id);
    const validated = validatePolicy(policy);
    const current = this.getCatalogAuthPolicy(id).policyVersion;
    const nextVersion = current + 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO catalog_auth_policies (catalog_id, policy_json, policy_version, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(catalog_id) DO UPDATE SET
         policy_json = excluded.policy_json,
         policy_version = excluded.policy_version,
         updated_at = excluded.updated_at`,
      id,
      JSON.stringify(validated),
      nextVersion,
      new Date().toISOString()
    );
    return { policy: validated, policyVersion: nextVersion };
  }

  deleteCatalogAuthPolicy(catalogId: string): { deleted: boolean } {
    const id = validateCatalogId(catalogId);
    this.ctx.storage.sql.exec("DELETE FROM catalog_auth_policies WHERE catalog_id = ?", id);
    return { deleted: true };
  }

  async explainAuthz(input: { authString: string; sql?: string; catalogId?: string; messageType?: string }): Promise<unknown> {
    const resolved = await this.resolveAuthString(input.authString);
    if (!resolved) {
      return {
        allowed: false,
        reason: "authentication denied",
        principal: null,
        catalog: input.catalogId ? { catalogId: input.catalogId } : null,
        request: { protocol: "quack", messageType: input.messageType ?? "PREPARE_REQUEST", sql: input.sql ?? "" },
        resources: [],
        requiredActions: [],
        matchedRules: []
      };
    }
    if (input.catalogId && input.catalogId !== resolved.catalogId) {
      return {
        allowed: false,
        reason: "resolved catalog does not match requested catalog",
        principal: resolved.principal,
        catalog: { catalogId: resolved.catalogId },
        mapping: resolved.mapping,
        requiredActions: [],
        matchedRules: []
      };
    }
    const schema = input.sql ? await this.catalogAuthorizationSchema(resolved.objectName) : undefined;
    const statements = input.sql ? classifySqlText(input.sql, schema) : [];
    const decision = evaluatePolicy(resolved.principal, resolved.policy, statements);
    return {
      ...decision,
      principal: resolved.principal,
      catalog: {
        catalogId: resolved.catalogId,
        policyVersion: resolved.policyVersion
      },
      mapping: resolved.mapping,
      request: {
        protocol: "quack",
        messageType: input.messageType ?? "PREPARE_REQUEST",
        sql: input.sql ?? "",
        statements
      },
      resources: decision.requiredActions.map((required) => required.resource)
    };
  }

  async createDataLease(authString: string, request: unknown = {}): Promise<unknown> {
    try {
      return await this.createDataLeaseUnsafe(authString, request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        error: message,
        status: statusForDataLeaseError(message)
      };
    }
  }

  private async createDataLeaseUnsafe(authString: string, request: unknown): Promise<unknown> {
    const body = validateDataLeaseRequest(request);
    const resolved = await this.resolveAuthString(authString);
    if (!resolved) {
      throw new Error("authentication denied");
    }
    const catalog = this.catalogById(resolved.catalogId);
    if (!catalog) {
      throw new Error(`Catalog ${resolved.catalogId} does not exist`);
    }
    if (catalog.dataAccessMode !== "trusted_client") {
      throw new Error("raw data leases require dataAccessMode trusted_client");
    }
    if (!principalHasRawLakeAccess(resolved.principal)) {
      throw new Error("raw data leases require catalog.admin or lake.raw scope");
    }

    const metadataDataPath = await this.catalogDuckLakeDataPath(catalog.objectName);
    if (metadataDataPath && metadataDataPath !== catalog.dataPath) {
      throw new Error(
        `catalog metadata data_path ${JSON.stringify(metadataDataPath)} does not match planned dataPath ${JSON.stringify(catalog.dataPath)}`
      );
    }
    const dataPath = metadataDataPath ?? catalog.dataPath;
    if (!dataPath) {
      throw new Error("catalog planned dataPath is not configured");
    }
    const location = objectStoreLocationFromUri(dataPath);
    if (!location) {
      throw new Error(`catalog data_path must be an r2:// or s3:// URI; got ${JSON.stringify(dataPath)}`);
    }
    const binding = resolveR2BindingForBucket(this.env, location.bucket);
    if (!binding.binding) {
      throw new Error(
        `DuckLake DATA_PATH bucket ${JSON.stringify(location.bucket)} is not mapped to an R2 binding; configure DUCKLAKE_R2_BINDINGS`
      );
    }

    const ttlSeconds = dataLeaseTtlSeconds(this.env);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const endpoint = r2Endpoint(this.env);
    const scope = body.access === "read" ? "object-read-only" : "object-read-write";
    const credentials = await createR2TempCredentials(
      {
        endpoint,
        accountId: requiredEnv(this.env.R2_ACCOUNT_ID, "R2_ACCOUNT_ID"),
        parentAccessKeyId: requiredEnv(this.env.R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID"),
        parentSecretAccessKey: requiredEnv(this.env.R2_SECRET_ACCESS_KEY, "R2_SECRET_ACCESS_KEY"),
        bucket: location.bucket
      },
      {
        scope,
        ttlSeconds,
        paths: location.key ? { prefixPaths: [location.key] } : undefined
      }
    );

    return {
      catalogId: catalog.catalogId,
      expiresAt,
      ttlSeconds,
      dataPath,
      access: body.access,
      r2: {
        endpoint,
        bucket: location.bucket,
        prefix: location.key
      },
      credentials,
      duckdb: {
        secretType: "s3",
        scope: dataPath,
        urlStyle: "path",
        region: "auto"
      },
      warning: "These credentials grant raw R2 object access under the catalog data path and do not enforce catalog row or column policies at the storage layer."
    };
  }

  private async catalogAuthorizationSchema(objectName: string): Promise<Schema> {
    const catalog = this.env.QUACK_CATALOGS.getByName(objectName) as unknown as {
      authorizationSchema(): Promise<Schema>;
    };
    return catalog.authorizationSchema();
  }

  private async catalogDuckLakeDataPath(objectName: string): Promise<string | undefined> {
    const catalog = this.env.QUACK_CATALOGS.getByName(objectName) as unknown as {
      duckLakeDataPath(): Promise<string | undefined>;
    };
    return catalog.duckLakeDataPath();
  }

  private async configureCatalogObject(objectName: string, dataPath: string): Promise<void> {
    const catalog = this.env.QUACK_CATALOGS.getByName(objectName) as unknown as {
      configureCatalog(config: { dataPath: string }): Promise<{ dataPath: string }>;
    };
    await catalog.configureCatalog({ dataPath });
  }

  private async createCredentialSync(catalogId: string, options: CreateCredentialOptions): Promise<CreateCredentialResult> {
    const credentialId = crypto.randomUUID();
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = credentialExpiresAt(now, options, this.env);
    const issuer = jwtIssuer(this.env);
    const audience = jwtAudience(this.env);
    const scopes = normalizeStringArray(options.scopes ?? ["catalog.admin"]);
    const subject = `credential:${credentialId}`;
    const jwt = await new SignJWT({
      catalog_id: catalogId,
      scope: scopes.join(" ")
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(subject)
      .setJti(credentialId)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(new Date(expiresAt).getTime() / 1000))
      .sign(this.jwtSecretKey());
    this.ctx.storage.sql.exec(
      `INSERT INTO credentials
       (credential_id, catalog_id, issuer, subject, scopes_json, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      credentialId,
      catalogId,
      issuer,
      subject,
      JSON.stringify(scopes),
      createdAt,
      expiresAt
    );
    const credential = {
      credentialId,
      catalogId,
      issuer,
      subject,
      scopes,
      createdAt,
      expiresAt
    };
    return {
      credential,
      jwt,
      credentialId
    };
  }

  private async resolveFirstPartyJwt(authString: string): Promise<ResolveAuthStringResult | undefined> {
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(authString, this.jwtSecretKey(), {
        issuer: jwtIssuer(this.env),
        audience: jwtAudience(this.env),
        algorithms: ["HS256"]
      });
      payload = verified.payload;
    } catch {
      return undefined;
    }
    const credentialId = typeof payload.jti === "string" ? payload.jti : undefined;
    const catalogId = typeof payload.catalog_id === "string" ? payload.catalog_id : undefined;
    if (!credentialId || !catalogId || payload.sub !== `credential:${credentialId}`) {
      return undefined;
    }
    const rows = this.ctx.storage.sql
      .exec<CredentialWithCatalogRow>(
        `SELECT cr.credential_id, cr.catalog_id, cr.issuer, cr.subject, cr.scopes_json, cr.created_at,
                cr.expires_at, cr.revoked_at, c.object_name
         FROM credentials cr
         JOIN catalogs c USING (catalog_id)
         WHERE cr.credential_id = ?`,
        credentialId
      )
      .toArray();
    const row = rows[0];
    if (!row || row.revoked_at || row.catalog_id !== catalogId || row.subject !== payload.sub || new Date(row.expires_at).getTime() <= Date.now()) {
      return undefined;
    }
    const policy = this.getCatalogAuthPolicy(row.catalog_id);
    const principal: AuthPrincipal = {
      issuer: String(payload.iss),
      subject: String(payload.sub),
      audience: normalizeAudience(payload.aud),
      scopes: scopesFromClaim(payload.scope),
      groups: stringArrayFromClaim(payload.groups),
      roles: stringArrayFromClaim(payload.roles),
      claims: payload as Record<string, unknown>,
      credentialId,
      providerId: FIRST_PARTY_PROVIDER_ID,
      authMode: "first_party_jwt"
    };
    return {
      catalogId: row.catalog_id,
      objectName: row.object_name,
      principal,
      policyVersion: policy.policyVersion,
      ...(policy.policy ? { policy: policy.policy } : {})
    };
  }

  private async resolveOidcJwt(authString: string): Promise<ResolveAuthStringResult | undefined> {
    const providers = this.listOidcProviders();
    const successes: Array<{ provider: OidcProviderRecord; payload: JWTPayload; principal: AuthPrincipal }> = [];
    for (const provider of providers) {
      const verified = await this.verifyOidcProvider(provider, authString);
      if (verified) {
        successes.push(verified);
      }
    }
    if (successes.length !== 1) {
      return undefined;
    }
    const success = successes[0];
    if (!success) {
      return undefined;
    }
    const { principal } = success;
    const mappings = this.matchCatalogMappings(principal);
    const catalogIds = [...new Set(mappings.map((mapping) => mapping.catalogId))];
    if (catalogIds.length !== 1) {
      return undefined;
    }
    const catalog = this.catalogById(catalogIds[0]!);
    if (!catalog) {
      return undefined;
    }
    const policy = this.getCatalogAuthPolicy(catalog.catalogId);
    const mapping = mappings.find((candidate) => candidate.catalogId === catalog.catalogId);
    return {
      catalogId: catalog.catalogId,
      objectName: catalog.objectName,
      principal,
      policyVersion: policy.policyVersion,
      ...(policy.policy ? { policy: policy.policy } : {}),
      ...(mapping ? { mapping } : {})
    };
  }

  private async verifyOidcProvider(
    provider: OidcProviderRecord,
    authString: string
  ): Promise<{ provider: OidcProviderRecord; payload: JWTPayload; principal: AuthPrincipal } | undefined> {
    try {
      const header = decodeProtectedHeader(authString);
      if (!header.alg || !provider.algorithms.includes(header.alg)) {
        return undefined;
      }
      const keySet = provider.jwks?.length
        ? createLocalJWKSet({ keys: provider.jwks })
        : createRemoteJWKSet(new URL(provider.jwksUri ?? ""));
      const { payload } = await jwtVerify(authString, keySet, {
        issuer: provider.issuer,
        audience: provider.audiences,
        algorithms: provider.algorithms,
        clockTolerance: provider.clockToleranceSeconds ?? 0
      });
      return {
        provider,
        payload,
        principal: principalFromOidcPayload(provider, payload)
      };
    } catch {
      return undefined;
    }
  }

  private matchCatalogMappings(principal: AuthPrincipal): MatchedCatalogMapping[] {
    const rows = this.ctx.storage.sql
      .exec<{ catalog_id: string; mappings_json: string }>(
        "SELECT catalog_id, mappings_json FROM catalog_auth_mappings ORDER BY catalog_id"
      )
      .toArray();
    const matches: MatchedCatalogMapping[] = [];
    for (const row of rows) {
      const document = parseJson<CatalogAuthMappingDocument>(row.mappings_json, { mappings: [] });
      for (const mapping of document.mappings) {
        if (mapping.providerId === principal.providerId && principalMatches(principal, mapping.match)) {
          matches.push({ catalogId: row.catalog_id, mapping });
        }
      }
    }
    return matches;
  }

  private catalogMappingsReferencingProvider(providerId: string): string[] {
    const rows = this.ctx.storage.sql
      .exec<{ catalog_id: string; mappings_json: string }>("SELECT catalog_id, mappings_json FROM catalog_auth_mappings")
      .toArray();
    return rows
      .filter((row) => parseJson<CatalogAuthMappingDocument>(row.mappings_json, { mappings: [] }).mappings.some((mapping) => mapping.providerId === providerId))
      .map((row) => row.catalog_id);
  }

  private providerExists(providerId: string): boolean {
    const row = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM oidc_providers WHERE provider_id = ?", validateProviderId(providerId))
      .one();
    return row.count > 0;
  }

  private requireCatalog(catalogId: string): void {
    if (!this.catalogExists(catalogId)) {
      throw new Error(`Catalog ${catalogId} does not exist`);
    }
  }

  private catalogById(catalogId: string): CatalogRecord | undefined {
    const row = this.ctx.storage.sql
      .exec<CatalogRow>(
        "SELECT catalog_id, object_name, data_path, data_access_mode, created_at, updated_at FROM catalogs WHERE catalog_id = ?",
        catalogId
      )
      .toArray()[0];
    return row ? catalogRecordFromRow(row) : undefined;
  }

  private initialize(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS catalogs (
        catalog_id TEXT PRIMARY KEY,
        object_name TEXT NOT NULL,
        data_path TEXT NOT NULL,
        data_access_mode TEXT NOT NULL DEFAULT 'catalog_only',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    try {
      this.ctx.storage.sql.exec("ALTER TABLE catalogs ADD COLUMN data_path TEXT");
    } catch {
      // Existing deployments already have the column.
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        credential_id TEXT PRIMARY KEY,
        catalog_id TEXT NOT NULL REFERENCES catalogs(catalog_id),
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS oidc_providers (
        provider_id TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        jwks_uri TEXT,
        audiences_json TEXT NOT NULL,
        algorithms_json TEXT NOT NULL,
        clock_tolerance_seconds INTEGER,
        claim_mapping_json TEXT NOT NULL,
        jwks_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS catalog_auth_mappings (
        catalog_id TEXT PRIMARY KEY REFERENCES catalogs(catalog_id),
        mappings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS catalog_auth_policies (
        catalog_id TEXT PRIMARY KEY REFERENCES catalogs(catalog_id),
        policy_json TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  private jwtSecretKey(): Uint8Array {
    if (!this.env.QUACKLAKE_JWT_SECRET) {
      throw new Error("QUACKLAKE_JWT_SECRET secret is not configured");
    }
    return new TextEncoder().encode(this.env.QUACKLAKE_JWT_SECRET);
  }
}

function credentialRecordFromRow(row: CredentialRow): CredentialRecord {
  return {
    credentialId: row.credential_id,
    catalogId: row.catalog_id,
    issuer: row.issuer,
    subject: row.subject,
    scopes: parseJson<string[]>(row.scopes_json, []),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {})
  };
}

function catalogRecordFromRow(row: CatalogRow): CatalogRecord {
  return {
    catalogId: row.catalog_id,
    objectName: row.object_name,
    dataPath: row.data_path ?? "",
    dataAccessMode: validateDataAccessMode(row.data_access_mode),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function providerFromRow(row: ProviderRow): OidcProviderRecord {
  return {
    providerId: row.provider_id,
    issuer: row.issuer,
    ...(row.jwks_uri ? { jwksUri: row.jwks_uri } : {}),
    audiences: parseJson<string[]>(row.audiences_json, []),
    algorithms: parseJson<string[]>(row.algorithms_json, []),
    clockToleranceSeconds: row.clock_tolerance_seconds ?? undefined,
    claimMapping: parseJson<ProviderClaimMapping>(row.claim_mapping_json, {}),
    ...(row.jwks_json ? { jwks: parseJson<JsonWebKey[]>(row.jwks_json, []) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function principalFromOidcPayload(provider: OidcProviderRecord, payload: JWTPayload): AuthPrincipal {
  const mapping = provider.claimMapping ?? {};
  const claims = { ...(payload as Record<string, unknown>) };
  for (const [target, source] of Object.entries(mapping)) {
    if (!source || ["subject", "scopes", "groups", "roles"].includes(target)) {
      continue;
    }
    const mapped = claimValue(payload, source);
    if (mapped !== undefined) {
      claims[target] = mapped;
    }
  }
  const subject = claimValue(payload, mapping.subject ?? "sub");
  return {
    issuer: String(payload.iss ?? provider.issuer),
    subject: typeof subject === "string" ? subject : String(subject ?? ""),
    audience: normalizeAudience(payload.aud),
    scopes: scopesFromClaim(claimValue(payload, mapping.scopes ?? "scope") ?? claimValue(payload, "scp")),
    groups: stringArrayFromClaim(claimValue(payload, mapping.groups ?? "groups")),
    roles: stringArrayFromClaim(claimValue(payload, mapping.roles ?? "roles")),
    claims,
    providerId: provider.providerId,
    authMode: "oidc_jwt"
  };
}

export function validateProviderConfig(config: OidcProviderConfig): OidcProviderConfig {
  const providerId = validateProviderId(config.providerId);
  if (!config.issuer || !/^https?:\/\//.test(config.issuer)) {
    throw new Error("issuer must be an absolute http(s) URL");
  }
  const audiences = normalizeStringArray(config.audiences);
  if (audiences.length === 0) {
    throw new Error("audiences must contain at least one value");
  }
  const algorithms = normalizeStringArray(config.algorithms);
  if (algorithms.length === 0) {
    throw new Error("algorithms must contain at least one value");
  }
  if (!config.jwksUri && !config.jwks?.length) {
    throw new Error("jwksUri or jwks must be configured");
  }
  if (config.jwksUri && !/^https?:\/\//.test(config.jwksUri)) {
    throw new Error("jwksUri must be an absolute http(s) URL");
  }
  return {
    providerId,
    issuer: config.issuer,
    ...(config.jwksUri ? { jwksUri: config.jwksUri } : {}),
    audiences,
    algorithms,
    clockToleranceSeconds: Number.isFinite(config.clockToleranceSeconds) ? Math.max(0, Number(config.clockToleranceSeconds)) : undefined,
    claimMapping: config.claimMapping ?? {},
    ...(config.jwks?.length ? { jwks: config.jwks } : {})
  };
}

export function validateMappingDocument(document: CatalogAuthMappingDocument): CatalogAuthMappingDocument {
  const mappings = (document.mappings ?? []).map((mapping): CatalogAuthMappingRule => {
    if (!mapping.mappingId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(mapping.mappingId)) {
      throw new Error("mappingId must be 1-128 characters and contain only letters, digits, underscore, dot, colon, or dash");
    }
    return {
      mappingId: mapping.mappingId,
      providerId: validateProviderId(mapping.providerId),
      priority: Number.isFinite(mapping.priority) ? Number(mapping.priority) : undefined,
      match: mapping.match ?? {}
    };
  });
  return { mappings };
}

export function validatePolicy(policy: CatalogAuthPolicy): CatalogAuthPolicy {
  if (policy.version !== 1) {
    throw new Error("auth policy version must be 1");
  }
  const defaultEffect = policy.defaultEffect ?? "deny";
  if (defaultEffect !== "allow" && defaultEffect !== "deny") {
    throw new Error("auth policy defaultEffect must be allow or deny");
  }
  return {
    version: 1,
    defaultEffect,
    rules: (policy.rules ?? []).map((rule) => {
      if (rule.effect !== "allow" && rule.effect !== "deny") {
        throw new Error("auth policy rule effect must be allow or deny");
      }
      if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
        throw new Error("auth policy rule actions must be non-empty");
      }
      return {
        ...rule,
        effect: rule.effect,
        actions: rule.actions,
        principal: rule.principal ?? {},
        resource: rule.resource ?? {}
      };
    })
  };
}

interface DataLeaseRequest {
  access: "read" | "read_write";
  reason?: "attach" | "prepare" | "execute" | "refresh";
}

function validateDataLeaseRequest(raw: unknown): DataLeaseRequest {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if ("catalogId" in body) {
    throw new Error("catalogId is not accepted by /catalog/data-lease; the bearer token resolves the catalog");
  }
  if ("dataPath" in body) {
    throw new Error("dataPath is not accepted by /catalog/data-lease; the catalog metadata data_path is used");
  }
  if ("ttlSeconds" in body) {
    throw new Error("ttlSeconds is not accepted by /catalog/data-lease; lease TTL is server-configured");
  }
  const allowedKeys = new Set(["access", "reason"]);
  const unknownKey = Object.keys(body).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new Error(`${unknownKey} is not accepted by /catalog/data-lease`);
  }
  const access = body.access ?? "read_write";
  if (access !== "read" && access !== "read_write") {
    throw new Error("access must be read or read_write");
  }
  const reason = body.reason;
  if (reason !== undefined && reason !== "attach" && reason !== "prepare" && reason !== "execute" && reason !== "refresh") {
    throw new Error("reason must be attach, prepare, execute, or refresh");
  }
  return {
    access,
    ...(reason ? { reason } : {})
  };
}

function principalHasRawLakeAccess(principal: AuthPrincipal): boolean {
  return principal.scopes.includes("catalog.admin") || principal.scopes.includes("lake.raw");
}

function dataLeaseTtlSeconds(env: RuntimeEnv): number {
  const parsed = Number(env.DUCKLAKE_R2_DATA_LEASE_TTL_SECONDS ?? DEFAULT_DATA_LEASE_TTL_SECONDS);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_DATA_LEASE_TTL_SECONDS;
  }
  return Math.max(MIN_DATA_LEASE_TTL_SECONDS, Math.min(MAX_DATA_LEASE_TTL_SECONDS, Math.floor(parsed)));
}

function requiredEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function r2Endpoint(env: RuntimeEnv): string {
  const endpoint = requiredEnv(env.R2_ENDPOINT, "R2_ENDPOINT");
  try {
    return new URL(endpoint).toString().replace(/\/$/, "");
  } catch {
    throw new Error("R2_ENDPOINT must be an absolute URL");
  }
}

function statusForDataLeaseError(message: string): number {
  if (/authentication denied/i.test(message)) {
    return 401;
  }
  if (/require|Unauthorized/i.test(message)) {
    return 403;
  }
  if (/data_path is not initialized/i.test(message)) {
    return 409;
  }
  if (/does not match planned dataPath/i.test(message)) {
    return 409;
  }
  if (/R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_ACCOUNT_ID|R2_ENDPOINT/.test(message)) {
    return 503;
  }
  if (/not mapped to an R2 binding/i.test(message)) {
    return 424;
  }
  if (/\b(?:must|required|invalid|not accepted)\b/i.test(message) || /^Unexpected token\b/.test(message)) {
    return 400;
  }
  if (/\bdoes not exist\b/i.test(message)) {
    return 404;
  }
  return 500;
}

function credentialExpiresAt(now: Date, options: CreateCredentialOptions, env: RuntimeEnv): string {
  if (options.expiresAt) {
    const expires = new Date(options.expiresAt);
    if (!Number.isFinite(expires.getTime()) || expires.getTime() <= now.getTime()) {
      throw new Error("expiresAt must be a future ISO timestamp");
    }
    return expires.toISOString();
  }
  const ttl = Number(options.expiresInSeconds ?? env.QUACKLAKE_JWT_DEFAULT_TTL_SECONDS ?? DEFAULT_CREDENTIAL_TTL_SECONDS);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("expiresInSeconds must be a positive number");
  }
  return new Date(now.getTime() + ttl * 1000).toISOString();
}

export function validateCreateCredentialOptions(options: CreateCredentialOptions, env: RuntimeEnv): void {
  credentialExpiresAt(new Date(), options, env);
}

function jwtIssuer(env: RuntimeEnv): string {
  return env.QUACKLAKE_JWT_ISSUER ?? DEFAULT_JWT_ISSUER;
}

function jwtAudience(env: RuntimeEnv): string {
  return env.QUACKLAKE_JWT_AUDIENCE ?? DEFAULT_JWT_AUDIENCE;
}

function isJwtLike(value: string): boolean {
  return value.split(".").length === 3;
}

function normalizeAudience(value: JWTPayload["aud"]): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === "string") {
    return [value];
  }
  return [];
}

function scopesFromClaim(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  return stringArrayFromClaim(value);
}

function stringArrayFromClaim(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.includes(" ") ? value.split(/\s+/).filter(Boolean) : [value];
  }
  return [];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function claimValue(payload: JWTPayload, path: string): unknown {
  let value: unknown = payload;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function validateCatalogId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) {
    throw new Error("catalogId must be 1-128 characters and contain only letters, digits, underscore, dot, colon, or dash");
  }
  return id;
}

export function validateDataAccessMode(value: unknown): DataAccessMode {
  if (value === "catalog_only" || value === "trusted_client") {
    return value;
  }
  throw new Error("dataAccessMode must be catalog_only or trusted_client");
}

export function validateProviderId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) {
    throw new Error("providerId must be 1-128 characters and contain only letters, digits, underscore, dot, colon, or dash");
  }
  return id;
}
