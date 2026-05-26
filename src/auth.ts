export type AuthMode = "first_party_jwt" | "oidc_jwt";

export interface AuthPrincipal {
  issuer: string;
  subject: string;
  audience: string[];
  scopes: string[];
  groups: string[];
  roles: string[];
  claims: Record<string, unknown>;
  credentialId?: string;
  providerId: string;
  authMode: AuthMode;
}

export interface CredentialRecord {
  credentialId: string;
  catalogId: string;
  issuer: string;
  subject: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface CreateCredentialOptions {
  scopes?: string[];
  expiresAt?: string;
  expiresInSeconds?: number;
}

export interface CreateCredentialResult {
  credential: CredentialRecord;
  jwt: string;
  credentialId: string;
}

export interface ProviderClaimMapping {
  subject?: string;
  scopes?: string;
  groups?: string;
  roles?: string;
  [claimName: string]: string | undefined;
}

export interface OidcProviderConfig {
  providerId: string;
  issuer: string;
  jwksUri?: string;
  audiences: string[];
  algorithms: string[];
  clockToleranceSeconds?: number;
  claimMapping?: ProviderClaimMapping;
  jwks?: JsonWebKey[];
}

export interface OidcProviderRecord extends OidcProviderConfig {
  createdAt: string;
  updatedAt: string;
}

export interface PrincipalMatch {
  subjectsAny?: string[];
  issuersAny?: string[];
  scopesAny?: string[];
  scopesAll?: string[];
  groupsAny?: string[];
  groupsAll?: string[];
  rolesAny?: string[];
  rolesAll?: string[];
  claims?: Record<string, unknown>;
}

export interface CatalogAuthMappingRule {
  mappingId: string;
  providerId: string;
  priority?: number;
  match?: PrincipalMatch;
}

export interface CatalogAuthMappingDocument {
  mappings: CatalogAuthMappingRule[];
}

export type AuthAction =
  | "schema.read"
  | "schema.create"
  | "schema.drop"
  | "table.read"
  | "table.create"
  | "table.insert"
  | "table.update"
  | "table.delete"
  | "table.drop"
  | "column.read"
  | "column.alter"
  | "catalog.admin";

export interface AuthResource {
  schema?: string;
  table?: string;
  column?: string;
  columns?: string[];
}

export interface CatalogAuthPolicyRule {
  ruleId?: string;
  effect: "allow" | "deny";
  principal?: PrincipalMatch;
  actions: Array<AuthAction | "*">;
  resource?: AuthResource;
  rowPredicate?: string;
}

export interface CatalogAuthPolicy {
  version: 1;
  defaultEffect?: "allow" | "deny";
  rules: CatalogAuthPolicyRule[];
}

export type DataAccessMode = "catalog_only" | "trusted_client";

export interface CatalogRecord {
  catalogId: string;
  objectName: string;
  dataPath: string;
  dataAccessMode: DataAccessMode;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCatalogOptions extends CreateCredentialOptions {
  dataAccessMode?: DataAccessMode;
  r2Bucket?: string;
}

export interface CreateCatalogResult {
  catalog: CatalogRecord;
  credential: CredentialRecord;
  jwt: string;
  credentialId: string;
}

export interface MatchedCatalogMapping {
  catalogId: string;
  mapping: CatalogAuthMappingRule;
}

export interface ResolveAuthStringResult {
  catalogId: string;
  objectName: string;
  principal: AuthPrincipal;
  policyVersion: number;
  policy?: CatalogAuthPolicy;
  mapping?: MatchedCatalogMapping;
}

export interface SessionAuthContext {
  catalogId: string;
  principal: AuthPrincipal;
  policyVersion: number;
  policy?: CatalogAuthPolicy;
}
