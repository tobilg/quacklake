import { SignJWT } from "jose";

export type R2CredentialScope =
  | "object-read-only"
  | "object-read-write"
  | "admin-read-only"
  | "admin-read-write";

export interface R2TempCredentialConfig {
  endpoint: string;
  accountId: string;
  parentAccessKeyId: string;
  parentSecretAccessKey: string;
  bucket: string;
}

export interface R2TempCredentialOptions {
  scope: R2CredentialScope;
  actions?: string[];
  ttlSeconds: number;
  paths?: {
    prefixPaths?: string[];
    objectPaths?: string[];
  };
}

export interface R2TempCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

const encoder = new TextEncoder();

export async function createR2TempCredentials(
  config: R2TempCredentialConfig,
  options: R2TempCredentialOptions
): Promise<R2TempCredentials> {
  const claims: Record<string, unknown> = {
    bucket: config.bucket,
    scope: options.scope
  };
  if (options.actions?.length) {
    claims.actions = options.actions;
  }
  if (options.paths) {
    claims.paths = {
      prefixPaths: options.paths.prefixPaths ?? [],
      objectPaths: options.paths.objectPaths ?? []
    };
  }

  const jwt = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(config.accountId)
    .setIssuer(config.parentAccessKeyId)
    .setAudience(new URL(config.endpoint).host)
    .setIssuedAt()
    .setExpirationTime(`${options.ttlSeconds}s`)
    .sign(encoder.encode(config.parentSecretAccessKey));

  return {
    accessKeyId: config.parentAccessKeyId,
    secretAccessKey: await sha256Hex(jwt),
    sessionToken: btoa(`jwt/${jwt}`)
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
