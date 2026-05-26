import type { CatalogRegistry } from "./registry";
import type { QuackCatalogObject } from "./catalog";
import type {
  CatalogAuthMappingDocument,
  CatalogAuthPolicy,
  CreateCatalogOptions,
  CreateCatalogResult,
  CreateCredentialOptions,
  CreateCredentialResult,
  CredentialRecord,
  OidcProviderConfig,
  OidcProviderRecord,
  ResolveAuthStringResult
} from "./auth";

export interface SecretBindings {
  ADMIN_TOKEN?: string;
  QUACKLAKE_JWT_SECRET?: string;
  CONNECTION_SIGNING_SECRET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

export interface StorageBindings {
  DUCKLAKE_R2_BINDINGS?: string;
  DUCKLAKE_FILE_LIST_ENDPOINT?: string;
  DUCKLAKE_FILE_LIST_TOKEN?: string;
  R2_ACCOUNT_ID?: string;
  R2_ENDPOINT?: string;
  [bindingName: string]: unknown;
}

export interface RuntimeBindings {
  CATALOG_REGISTRY: CatalogNamespace;
  QUACK_CATALOGS: QuackCatalogNamespace;
  QUACK_FETCH_ROWS_PER_CHUNK?: string;
  QUACK_FETCH_CHUNKS_PER_BATCH?: string;
  QUACKLAKE_JWT_ISSUER?: string;
  QUACKLAKE_JWT_AUDIENCE?: string;
  QUACKLAKE_JWT_DEFAULT_TTL_SECONDS?: string;
  DUCKLAKE_R2_DATA_LEASE_TTL_SECONDS?: string;
}

export type RuntimeEnv = RuntimeBindings & SecretBindings & StorageBindings;

export interface CatalogRegistryStub {
  createCatalog(catalogId: string, options?: CreateCatalogOptions): Promise<CreateCatalogResult>;
  listCatalogs(): Promise<unknown>;
  catalogExists(catalogId: string): Promise<boolean>;
  listCredentials(catalogId: string): Promise<CredentialRecord[]>;
  createCredential(catalogId: string, options?: CreateCredentialOptions): Promise<CreateCredentialResult>;
  revokeCredential(catalogId: string, credentialId: string): Promise<unknown>;
  resolveAuthString(authString: string): Promise<ResolveAuthStringResult | undefined>;
  createOidcProvider(config: OidcProviderConfig): Promise<OidcProviderRecord>;
  listOidcProviders(): Promise<OidcProviderRecord[]>;
  getOidcProvider(providerId: string): Promise<OidcProviderRecord | undefined>;
  updateOidcProvider(providerId: string, config: OidcProviderConfig): Promise<OidcProviderRecord>;
  deleteOidcProvider(providerId: string): Promise<{ deleted: boolean; conflict?: boolean; error?: string }>;
  getCatalogAuthMapping(catalogId: string): Promise<CatalogAuthMappingDocument>;
  replaceCatalogAuthMapping(catalogId: string, document: CatalogAuthMappingDocument): Promise<CatalogAuthMappingDocument>;
  deleteCatalogAuthMapping(catalogId: string): Promise<unknown>;
  getCatalogAuthPolicy(catalogId: string): Promise<{ policy?: CatalogAuthPolicy; policyVersion: number }>;
  putCatalogAuthPolicy(catalogId: string, policy: CatalogAuthPolicy): Promise<{ policy: CatalogAuthPolicy; policyVersion: number }>;
  deleteCatalogAuthPolicy(catalogId: string): Promise<unknown>;
  explainAuthz(input: { authString: string; sql?: string; catalogId?: string; messageType?: string }): Promise<unknown>;
  createDataLease(authString: string, request?: unknown): Promise<unknown>;
}

export type CatalogNamespace = DurableObjectNamespace<CatalogRegistry>;
export type QuackCatalogNamespace = DurableObjectNamespace<QuackCatalogObject>;
