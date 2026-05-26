import type { RuntimeEnv } from "./env";

export interface ListedFile {
  filename: string;
  lastModified?: string;
}

export type FileListFunction = (pattern: string) => Promise<ListedFile[]>;

export interface ObjectStoreLocation {
  scheme: "r2" | "s3";
  bucket: string;
  key: string;
}

export interface R2BindingResolution {
  bucketName: string;
  bindingName?: string;
  binding?: R2Bucket;
  source?: "DUCKLAKE_R2_BINDINGS";
  configuredBindings: Record<string, string>;
}

export interface ConfiguredR2Bucket {
  bucket: string;
  binding: string;
  available: boolean;
  source: "DUCKLAKE_R2_BINDINGS";
}

export function createExternalFileLister(env: RuntimeEnv): FileListFunction {
  return async (pattern: string) => {
    const endpointFiles = await listFromEndpoint(env, pattern);
    const r2Files = await listFromR2(env, pattern);
    return dedupeFiles([...endpointFiles, ...r2Files]);
  };
}

export function globPrefix(pattern: string): string {
  const globIndex = pattern.indexOf("**");
  return globIndex >= 0 ? pattern.slice(0, globIndex) : pattern;
}

function dedupeFiles(files: ListedFile[]): ListedFile[] {
  const byName = new Map<string, ListedFile>();
  for (const file of files) {
    byName.set(file.filename, file);
  }
  return [...byName.values()].sort((left, right) => left.filename.localeCompare(right.filename));
}

async function listFromEndpoint(env: RuntimeEnv, pattern: string): Promise<ListedFile[]> {
  if (!env.DUCKLAKE_FILE_LIST_ENDPOINT) {
    return [];
  }
  const response = await fetch(env.DUCKLAKE_FILE_LIST_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.DUCKLAKE_FILE_LIST_TOKEN ? { Authorization: `Bearer ${env.DUCKLAKE_FILE_LIST_TOKEN}` } : {})
    },
    body: JSON.stringify({ pattern })
  });
  if (!response.ok) {
    throw new Error(`File list endpoint returned ${response.status}`);
  }
  return normalizeFileListResponse(await response.json());
}

async function listFromR2(env: RuntimeEnv, pattern: string): Promise<ListedFile[]> {
  const parsed = parseObjectStorePattern(pattern);
  if (!parsed) {
    return [];
  }
  const binding = r2BindingForBucket(env, parsed.bucket);
  if (!binding) {
    return [];
  }
  const files: ListedFile[] = [];
  let cursor: string | undefined;
  do {
    const page = await binding.list({ prefix: parsed.keyPrefix, cursor });
    for (const object of page.objects) {
      files.push({
        filename: `${parsed.scheme}://${parsed.bucket}/${object.key}`,
        lastModified: object.uploaded.toISOString()
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return files;
}

function parseObjectStorePattern(pattern: string): { scheme: "r2" | "s3"; bucket: string; keyPrefix: string } | undefined {
  const prefix = globPrefix(pattern);
  const location = objectStoreLocationFromUri(prefix);
  if (!location) {
    return undefined;
  }
  return {
    scheme: location.scheme,
    bucket: location.bucket,
    keyPrefix: location.key
  };
}

export function r2BindingForBucket(env: RuntimeEnv, bucketName: string): R2Bucket | undefined {
  return resolveR2BindingForBucket(env, bucketName).binding;
}

export function resolveR2BindingForBucket(env: RuntimeEnv, bucketName: string): R2BindingResolution {
  const configured = parseR2BindingMap(env.DUCKLAKE_R2_BINDINGS);
  const bindingName = configured[bucketName];
  if (bindingName && isR2Bucket(env[bindingName])) {
    return {
      bucketName,
      bindingName,
      binding: env[bindingName],
      source: "DUCKLAKE_R2_BINDINGS",
      configuredBindings: configured
    };
  }
  return {
    bucketName,
    bindingName,
    configuredBindings: configured
  };
}

export function listConfiguredR2Buckets(env: RuntimeEnv): ConfiguredR2Bucket[] {
  return Object.entries(parseR2BindingMap(env.DUCKLAKE_R2_BINDINGS))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([bucket, binding]) => ({
      bucket,
      binding,
      available: isR2Bucket(env[binding]),
      source: "DUCKLAKE_R2_BINDINGS"
    }));
}

export function selectConfiguredR2Bucket(env: RuntimeEnv, requestedBucket?: string): ConfiguredR2Bucket {
  if (requestedBucket !== undefined && (typeof requestedBucket !== "string" || requestedBucket.trim() === "")) {
    throw new Error("r2Bucket must be a configured bucket name");
  }
  const buckets = listConfiguredR2Buckets(env);
  const selected = requestedBucket
    ? buckets.find((bucket) => bucket.bucket === requestedBucket)
    : singleConfiguredBucket(buckets);
  if (!selected) {
    if (requestedBucket) {
      throw new Error(`r2Bucket ${JSON.stringify(requestedBucket)} is not configured in DUCKLAKE_R2_BINDINGS`);
    }
    if (buckets.length === 0) {
      throw new Error("DUCKLAKE_R2_BINDINGS must configure at least one R2 bucket before creating catalogs");
    }
    throw new Error("r2Bucket is required when DUCKLAKE_R2_BINDINGS configures multiple buckets");
  }
  if (!selected.available) {
    throw new Error(
      `r2Bucket ${JSON.stringify(selected.bucket)} maps to missing Worker R2 binding ${JSON.stringify(selected.binding)}`
    );
  }
  return selected;
}

export function objectStoreLocationFromUri(uri: string): ObjectStoreLocation | undefined {
  const match = uri.match(/^(r2|s3):\/\/([^/]+)\/?(.*)$/i);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return {
    scheme: match[1].toLowerCase() as "r2" | "s3",
    bucket: match[2],
    key: match[3] ?? ""
  };
}

export function r2BindingHint(bucketName: string, resolution?: R2BindingResolution): string {
  const mappedName = resolution?.bindingName;
  const mapExample = JSON.stringify({ [bucketName]: mappedName ?? "DUCKLAKE_R2" });
  return `Configure wrangler r2_buckets with a binding for bucket ${JSON.stringify(bucketName)} and set DUCKLAKE_R2_BINDINGS=${mapExample}; if the bucket uses an R2 jurisdiction endpoint, set the same r2_buckets[].jurisdiction.`;
}

export function parseR2BindingMap(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  } catch {
    return {};
  }
}

function isR2Bucket(value: unknown): value is R2Bucket {
  return !!value && typeof value === "object" && typeof (value as { list?: unknown }).list === "function";
}

function singleConfiguredBucket(buckets: ConfiguredR2Bucket[]): ConfiguredR2Bucket | undefined {
  if (buckets.length === 1) {
    return buckets[0];
  }
  return undefined;
}

function normalizeFileListResponse(raw: unknown): ListedFile[] {
  const files = Array.isArray(raw) ? raw : (raw as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return [];
  }
  return files.flatMap((item): ListedFile[] => {
    if (typeof item === "string") {
      return [{ filename: item }];
    }
    if (!item || typeof item !== "object") {
      return [];
    }
    const candidate = item as { filename?: unknown; path?: unknown; lastModified?: unknown; last_modified?: unknown };
    const filename = typeof candidate.filename === "string"
      ? candidate.filename
      : typeof candidate.path === "string"
        ? candidate.path
        : undefined;
    if (!filename) {
      return [];
    }
    const lastModified = typeof candidate.lastModified === "string"
      ? candidate.lastModified
      : typeof candidate.last_modified === "string"
        ? candidate.last_modified
        : undefined;
    return [{ filename, ...(lastModified ? { lastModified } : {}) }];
  });
}
