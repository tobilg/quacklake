import type { RuntimeEnv } from "./env";

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
