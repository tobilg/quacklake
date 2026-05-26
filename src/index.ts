import { decodeMessage, encodeMessage, MessageType } from "./quack-imports";
import type { ConnectionRequestMessage, QuackMessage } from "./quack-imports";
import { signConnectionId, timingSafeEqualText, verifyConnectionId } from "./crypto";
import {
  CatalogRegistry,
  validateCatalogId,
  validateDataAccessMode,
  validateCreateCredentialOptions,
  validateMappingDocument,
  validatePolicy,
  validateProviderConfig,
  validateProviderId
} from "./registry";
import { QuackCatalogObject } from "./catalog";
import type { CatalogRegistryStub, RuntimeEnv } from "./env";
import { listConfiguredR2Buckets, objectStoreLocationFromUri, r2BindingHint, resolveR2BindingForBucket, selectConfiguredR2Bucket } from "./file-listing";
import type { CatalogAuthMappingDocument, CatalogAuthPolicy, CreateCatalogOptions, CreateCatalogResult, CreateCredentialOptions, OidcProviderConfig, SessionAuthContext } from "./auth";
import { openApiDocument } from "./openapi";

export { CatalogRegistry, QuackCatalogObject };

const DUCKDB_MIME_TYPE = "application/duckdb";

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/") {
        return Response.json({
          name: "quacklake",
          protocol: "quack",
          endpoint: "/quack",
          apiDocs: "/api-docs"
        });
      }
      if (request.method === "GET" && url.pathname === "/api-docs") {
        return Response.json(openApiDocument());
      }
      if (url.pathname === "/quack") {
        return await handleQuack(request, env);
      }
      if (url.pathname === "/catalog/data-lease") {
        return await handleDataLease(request, env);
      }
      if (url.pathname.startsWith("/admin/")) {
        return await handleAdmin(request, env, url);
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: statusForUnhandledError(message) });
    }
  }
};

async function handleQuack(request: Request, env: RuntimeEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  let message: QuackMessage;
  try {
    message = decodeMessage(bytes);
  } catch (error) {
    const response = encodeMessage({
      type: MessageType.ERROR_RESPONSE,
      message: error instanceof Error ? error.message : String(error)
    });
    return duckResponse(response);
  }

  let response: QuackMessage;
  try {
    if (message.type === MessageType.CONNECTION_REQUEST) {
      response = await openConnection(env, message);
    } else {
      response = await routeConnectionMessage(env, message);
    }
  } catch (error) {
    response = {
      type: MessageType.ERROR_RESPONSE,
      ...(message.connectionId ? { connectionId: message.connectionId } : {}),
      message: error instanceof Error ? error.message : String(error)
    };
  }
  return duckResponse(encodeMessage(response));
}

async function openConnection(env: RuntimeEnv, message: ConnectionRequestMessage): Promise<QuackMessage> {
  if (!message.authString) {
    return { type: MessageType.ERROR_RESPONSE, message: "Missing auth JWT" };
  }
  if (BigInt(message.minSupportedQuackVersion ?? 1n) > 1n) {
    return {
      type: MessageType.ERROR_RESPONSE,
      message: "Client requires a newer Quack protocol version than this server supports"
    };
  }
  const registry = registryStub(env);
  const resolved = await registry.resolveAuthString(message.authString);
  if (!resolved) {
    return { type: MessageType.ERROR_RESPONSE, message: "Invalid auth JWT" };
  }
  const catalog = env.QUACK_CATALOGS.getByName(resolved.objectName) as unknown as {
    openConnection(message: ConnectionRequestMessage, auth: SessionAuthContext): Promise<QuackMessage>;
  };
  const opened = await catalog.openConnection(message, {
    catalogId: resolved.catalogId,
    principal: resolved.principal,
    policyVersion: resolved.policyVersion,
    ...(resolved.policy ? { policy: resolved.policy } : {})
  });
  if (!opened.connectionId) {
    return { type: MessageType.ERROR_RESPONSE, message: "Catalog did not return a connection id" };
  }
  const signed = await signConnectionId(connectionSecret(env), {
    catalogId: resolved.catalogId,
    sessionId: opened.connectionId
  });
  return { ...opened, connectionId: signed };
}

async function routeConnectionMessage(env: RuntimeEnv, message: QuackMessage): Promise<QuackMessage> {
  const signedConnectionId = message.connectionId;
  if (!signedConnectionId) {
    return { type: MessageType.ERROR_RESPONSE, message: "Missing connection id" };
  }
  const payload = await verifyConnectionId(connectionSecret(env), signedConnectionId);
  if (!payload) {
    return { type: MessageType.ERROR_RESPONSE, message: "Invalid connection id" };
  }
  const catalog = env.QUACK_CATALOGS.getByName(`catalog:${payload.catalogId}`) as unknown as {
    handleMessage(message: QuackMessage): Promise<QuackMessage>;
  };
  const routed = { ...message, connectionId: payload.sessionId } as QuackMessage;
  const response = await catalog.handleMessage(routed);
  if ("connectionId" in response && response.connectionId === payload.sessionId) {
    return { ...response, connectionId: signedConnectionId };
  }
  return response;
}

async function handleDataLease(request: Request, env: RuntimeEnv): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders() });
  }
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
  }
  const registry = registryStub(env);
  try {
    const body = await readJson<unknown>(request);
    const result = await registry.createDataLease(token, body);
    if (isDataLeaseFailure(result)) {
      return Response.json({ error: result.error }, { status: result.status, headers: corsHeaders() });
    }
    return Response.json(result, { status: 201, headers: corsHeaders() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: statusForDataLeaseError(message), headers: corsHeaders() });
  }
}

async function handleAdmin(request: Request, env: RuntimeEnv, url: URL): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!env.ADMIN_TOKEN) {
    return Response.json({ error: "ADMIN_TOKEN is not configured" }, { status: 503 });
  }
  if (!(await timingSafeEqualText(token, env.ADMIN_TOKEN))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const registry = registryStub(env);
  const segments = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && segments.length === 2 && segments[1] === "r2-buckets") {
    return Response.json({ buckets: listConfiguredR2Buckets(env) });
  }
  if (request.method === "GET" && segments.length === 3 && segments[1] === "r2" && segments[2] === "diagnostics") {
    return handleR2Diagnostics(env, url);
  }
  if (segments[1] === "oidc" && segments[2] === "providers") {
    return handleOidcProviders(request, registry, segments);
  }
  if (segments[1] === "authz" && segments[2] === "explain" && segments.length === 3 && request.method === "POST") {
    const body = await readJson<{ authString?: string; sql?: string; catalogId?: string; messageType?: string }>(request);
    if (!body.authString) {
      return Response.json({ error: "authString is required" }, { status: 400 });
    }
    return Response.json(await registry.explainAuthz({ ...body, authString: body.authString }));
  }
  if (request.method === "POST" && segments.length === 2 && segments[1] === "catalogs") {
    const body = await readJson<{ catalogId?: string } & CreateCatalogOptions>(request);
    const catalogId = validateCatalogId(body.catalogId ?? "default");
    const options = catalogOptionsFromBody(body, env);
    if (await registry.catalogExists(catalogId)) {
      return duplicateCatalogResponse(catalogId);
    }
    try {
      const created = await registry.createCatalog(catalogId, options);
      return Response.json(createCatalogResponse(created, url), { status: 201 });
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        return duplicateCatalogResponse(catalogId);
      }
      throw error;
    }
  }
  if (request.method === "GET" && segments.length === 2 && segments[1] === "catalogs") {
    return Response.json({ catalogs: await registry.listCatalogs() });
  }
  if (segments[1] === "catalogs" && segments[2]) {
    const catalogId = validateCatalogId(decodeURIComponent(segments[2]));
    if (request.method === "POST" && segments[3] === "credentials" && segments.length === 4) {
      if (!(await registry.catalogExists(catalogId))) {
        return Response.json({ error: `Catalog ${catalogId} does not exist` }, { status: 404 });
      }
      return Response.json(await registry.createCredential(catalogId, credentialOptionsFromBody(await readJson<CreateCredentialOptions>(request), env)), { status: 201 });
    }
    if (request.method === "GET" && segments[3] === "credentials" && segments.length === 4) {
      const credentials = await registry.listCredentials(catalogId);
      return Response.json({ credentials });
    }
    if (request.method === "DELETE" && segments[3] === "credentials" && segments[4]) {
      return Response.json(await registry.revokeCredential(catalogId, decodeURIComponent(segments[4])));
    }
    if (segments[3] === "auth-mapping" && segments.length === 4) {
      if (request.method === "PUT") {
        if (!(await registry.catalogExists(catalogId))) {
          return Response.json({ error: `Catalog ${catalogId} does not exist` }, { status: 404 });
        }
        const mapping = validateMappingDocument(await readJson<CatalogAuthMappingDocument>(request));
        const providers = new Set((await registry.listOidcProviders()).map((provider) => provider.providerId));
        const missingProvider = mapping.mappings.find((candidate) => !providers.has(candidate.providerId));
        if (missingProvider) {
          return Response.json({ error: `OIDC provider ${missingProvider.providerId} does not exist` }, { status: 404 });
        }
        return Response.json(await registry.replaceCatalogAuthMapping(catalogId, mapping));
      }
      if (request.method === "GET") {
        return Response.json(await registry.getCatalogAuthMapping(catalogId));
      }
      if (request.method === "DELETE") {
        return Response.json(await registry.deleteCatalogAuthMapping(catalogId));
      }
    }
    if (segments[3] === "auth-policy" && segments.length === 4) {
      if (request.method === "PUT") {
        const body = await readJson<CatalogAuthPolicy | { policy?: CatalogAuthPolicy }>(request);
        if (!(await registry.catalogExists(catalogId))) {
          return Response.json({ error: `Catalog ${catalogId} does not exist` }, { status: 404 });
        }
        const policy = validatePolicy("policy" in body && body.policy ? body.policy : body as CatalogAuthPolicy);
        return Response.json(await registry.putCatalogAuthPolicy(catalogId, policy));
      }
      if (request.method === "GET") {
        return Response.json(await registry.getCatalogAuthPolicy(catalogId));
      }
      if (request.method === "DELETE") {
        return Response.json(await registry.deleteCatalogAuthPolicy(catalogId));
      }
    }
    if (segments[3] === "files" && segments.length === 4) {
      const catalog = env.QUACK_CATALOGS.getByName(`catalog:${catalogId}`) as unknown as {
        replaceFileInventory(files: Array<{ filename: string; lastModified?: string }>): Promise<{ files: number }>;
        listFileInventory(): Promise<{ files: Array<{ filename: string; lastModified?: string }> }>;
      };
      if (request.method === "PUT") {
        const body = await readJson<{ files?: Array<{ filename?: string; lastModified?: string; last_modified?: string }> }>(request);
        const files = (body.files ?? []).flatMap((file) => {
          if (!file.filename) {
            return [];
          }
          return [{ filename: file.filename, lastModified: file.lastModified ?? file.last_modified }];
        });
        return Response.json(await catalog.replaceFileInventory(files));
      }
      if (request.method === "GET") {
        return Response.json(await catalog.listFileInventory());
      }
    }
    if (request.method === "GET" && segments[3] === "stats") {
      const catalog = env.QUACK_CATALOGS.getByName(`catalog:${catalogId}`) as unknown as {
        stats(): Promise<Record<string, number>>;
      };
      return Response.json(await catalog.stats());
    }
  }
  return Response.json({ error: "Admin route not found" }, { status: 404 });
}

async function handleR2Diagnostics(env: RuntimeEnv, url: URL): Promise<Response> {
  const path = url.searchParams.get("path") ?? url.searchParams.get("uri") ?? "";
  if (!path) {
    return Response.json(
      {
        ok: false,
        error: "Missing path query parameter",
        hint: "Pass path=r2://<bucket>/<key> or path=s3://<bucket>/<key>."
      },
      { status: 400 }
    );
  }
  const location = objectStoreLocationFromUri(path);
  if (!location) {
    return Response.json(
      {
        ok: false,
        error: "Path is not an r2:// or s3:// object URI",
        path
      },
      { status: 400 }
    );
  }

  const resolved = resolveR2BindingForBucket(env, location.bucket);
  if (!resolved.binding) {
    return Response.json(
      {
        ok: false,
        path,
        scheme: location.scheme,
        bucket: location.bucket,
        key: location.key,
        configuredBindings: resolved.configuredBindings,
        bindingName: resolved.bindingName ?? null,
        error: `Bucket ${location.bucket} is not mapped to a Worker R2 binding`,
        hint: r2BindingHint(location.bucket, resolved)
      },
      { status: 424 }
    );
  }

  if (!location.key) {
    return Response.json({
      ok: true,
      path,
      scheme: location.scheme,
      bucket: location.bucket,
      key: location.key,
      bindingName: resolved.bindingName,
      bindingSource: resolved.source,
      object: null
    });
  }

  const object = await resolved.binding.head(location.key);
  if (!object) {
    return Response.json(
      {
        ok: false,
        path,
        scheme: location.scheme,
        bucket: location.bucket,
        key: location.key,
        bindingName: resolved.bindingName,
        bindingSource: resolved.source,
        object: { exists: false },
        error: "Object was not visible through the Worker R2 binding",
        hint: "Verify the DuckDB storage secret, R2_ENDPOINT, bucket name, object key, and wrangler r2_buckets jurisdiction all point to the same R2 bucket."
      },
      { status: 404 }
    );
  }

  return Response.json({
    ok: true,
    path,
    scheme: location.scheme,
    bucket: location.bucket,
    key: location.key,
    bindingName: resolved.bindingName,
    bindingSource: resolved.source,
    object: {
      exists: true,
      size: object.size,
      uploaded: object.uploaded.toISOString(),
      etag: object.etag
    }
  });
}

function duplicateCatalogResponse(catalogId: string): Response {
  return Response.json(
    {
      error: `Catalog ${catalogId} already exists`,
      hint: `Use POST /admin/catalogs/${encodeURIComponent(catalogId)}/credentials to add a JWT credential for the existing catalog. Use a different catalogId for a fresh DuckLake DATA_PATH.`
    },
    { status: 409 }
  );
}

function createCatalogResponse(created: CreateCatalogResult, url: URL): CreateCatalogResult & {
  ducklake: {
    secretName: string;
    quackScope: string;
    dataPath: string;
    secretSql: string;
    attachSql: string;
  };
} {
  const secretName = `quacklake_${created.catalog.catalogId.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const quackScope = quackScopeFromUrl(url);
  const dataPath = created.catalog.dataPath;
  return {
    ...created,
    ducklake: {
      secretName,
      quackScope,
      dataPath,
      secretSql: `CREATE OR REPLACE SECRET ${secretName} (TYPE quack, TOKEN ${sqlStringLiteral(created.jwt)}, SCOPE ${sqlStringLiteral(quackScope)});`,
      attachSql: `ATTACH ${sqlStringLiteral(`ducklake:${quackScope}`)} AS lake (DATA_PATH ${sqlStringLiteral(dataPath)});`
    }
  };
}

function quackScopeFromUrl(url: URL): string {
  return `quack:${url.hostname}:${url.port || "443"}`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function handleOidcProviders(request: Request, registry: CatalogRegistryStub, segments: string[]): Promise<Response> {
  if (segments.length === 3 && request.method === "POST") {
    return Response.json(await registry.createOidcProvider(validateProviderConfig(await readJson<OidcProviderConfig>(request))), { status: 201 });
  }
  if (segments.length === 3 && request.method === "GET") {
    return Response.json({ providers: await registry.listOidcProviders() });
  }
  if (segments.length === 4 && segments[3]) {
    const providerId = validateProviderId(decodeURIComponent(segments[3]));
    if (request.method === "GET") {
      const provider = await registry.getOidcProvider(providerId);
      return provider ? Response.json(provider) : Response.json({ error: "OIDC provider not found" }, { status: 404 });
    }
    if (request.method === "PUT") {
      const body = await readJson<OidcProviderConfig>(request);
      return Response.json(await registry.updateOidcProvider(providerId, validateProviderConfig({ ...body, providerId })));
    }
    if (request.method === "DELETE") {
      const deleted = await registry.deleteOidcProvider(providerId);
      if (deleted.conflict) {
        return Response.json({ error: deleted.error }, { status: 409 });
      }
      return Response.json(deleted);
    }
  }
  return Response.json({ error: "OIDC provider route not found" }, { status: 404 });
}

function credentialOptionsFromBody(body: CreateCredentialOptions, env: RuntimeEnv): CreateCredentialOptions {
  const options = {
    ...(body.scopes ? { scopes: body.scopes } : {}),
    ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    ...(body.expiresInSeconds ? { expiresInSeconds: body.expiresInSeconds } : {})
  };
  validateCreateCredentialOptions(options, env);
  return options;
}

function catalogOptionsFromBody(body: CreateCatalogOptions, env: RuntimeEnv): CreateCatalogOptions {
  const options = {
    ...credentialOptionsFromBody(body, env),
    ...("r2Bucket" in body ? { r2Bucket: body.r2Bucket } : {}),
    dataAccessMode: validateDataAccessMode(body.dataAccessMode ?? "catalog_only")
  };
  selectConfiguredR2Bucket(env, options.r2Bucket);
  return options;
}

function registryStub(env: RuntimeEnv): CatalogRegistryStub {
  return env.CATALOG_REGISTRY.getByName("global") as unknown as CatalogRegistryStub;
}

function connectionSecret(env: RuntimeEnv): string {
  if (!env.CONNECTION_SIGNING_SECRET) {
    throw new Error("CONNECTION_SIGNING_SECRET secret is not configured");
  }
  return env.CONNECTION_SIGNING_SECRET;
}

async function readJson<T>(request: Request): Promise<T> {
  if (!request.body) {
    return {} as T;
  }
  return (await request.json()) as T;
}

function duckResponse(bytes: Uint8Array): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": DUCKDB_MIME_TYPE
    }
  });
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept,Authorization"
  };
}

function statusForUnhandledError(message: string): number {
  if (/\bdoes not exist\b/i.test(message)) {
    return 404;
  }
  if (
    /r2Bucket .*not configured|missing Worker R2 binding|DUCKLAKE_R2_BINDINGS/i.test(message) ||
    /\b(?:must|required|invalid)\b/i.test(message) ||
    /^Unexpected token\b/.test(message) ||
    /^Expected /.test(message)
  ) {
    return 400;
  }
  return 500;
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
  return statusForUnhandledError(message);
}

function isDataLeaseFailure(value: unknown): value is { error: string; status: number } {
  return !!value &&
    typeof value === "object" &&
    typeof (value as { error?: unknown }).error === "string" &&
    typeof (value as { status?: unknown }).status === "number";
}
