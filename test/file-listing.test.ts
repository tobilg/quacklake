import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExternalFileLister,
  globPrefix,
  listConfiguredR2Buckets,
  objectStoreLocationFromUri,
  parseR2BindingMap,
  r2BindingForBucket,
  r2BindingHint,
  resolveR2BindingForBucket,
  selectConfiguredR2Bucket
} from "../src/file-listing";
import type { RuntimeEnv } from "../src/env";

describe("file listing helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses object-store patterns and R2 binding maps defensively", () => {
    expect(globPrefix("r2://bucket/lake/**/*.parquet")).toBe("r2://bucket/lake/");
    expect(globPrefix("r2://bucket/lake/a.parquet")).toBe("r2://bucket/lake/a.parquet");
    expect(objectStoreLocationFromUri("s3://bucket/path/file.parquet")).toEqual({
      scheme: "s3",
      bucket: "bucket",
      key: "path/file.parquet"
    });
    expect(objectStoreLocationFromUri("https://example.com/file")).toBeUndefined();
    expect(objectStoreLocationFromUri("r2:///missing-bucket")).toBeUndefined();

    expect(parseR2BindingMap(undefined)).toEqual({});
    expect(parseR2BindingMap("not-json")).toEqual({});
    expect(parseR2BindingMap("[]")).toEqual({});
    expect(parseR2BindingMap('{"bucket":"DUCKLAKE_R2","ignored":7}')).toEqual({ bucket: "DUCKLAKE_R2" });
  });

  it("lists and resolves R2 bindings from DUCKLAKE_R2_BINDINGS only", () => {
    const explicit = fakeR2Bucket(["explicit/a.parquet"]);
    const env = {
      DUCKLAKE_R2_BINDINGS: JSON.stringify({ explicit: "EXPLICIT_BINDING", broken: "NOT_A_BUCKET" }),
      EXPLICIT_BINDING: explicit,
      NOT_A_BUCKET: {}
    } as unknown as RuntimeEnv;

    expect(listConfiguredR2Buckets(env)).toEqual([
      { bucket: "broken", binding: "NOT_A_BUCKET", available: false, source: "DUCKLAKE_R2_BINDINGS" },
      { bucket: "explicit", binding: "EXPLICIT_BINDING", available: true, source: "DUCKLAKE_R2_BINDINGS" }
    ]);
    expect(resolveR2BindingForBucket(env, "explicit")).toMatchObject({
      bucketName: "explicit",
      bindingName: "EXPLICIT_BINDING",
      source: "DUCKLAKE_R2_BINDINGS",
      binding: explicit
    });
    expect(resolveR2BindingForBucket(env, "missing")).toMatchObject({
      bucketName: "missing"
    });
    expect(r2BindingForBucket(env, "broken")).toBeUndefined();
    expect(r2BindingHint("missing")).toContain("DUCKLAKE_R2_BINDINGS");
  });

  it("selects catalog R2 buckets defensively", () => {
    const single = {
      DUCKLAKE_R2_BINDINGS: JSON.stringify({ lake: "DUCKLAKE_R2" }),
      DUCKLAKE_R2: fakeR2Bucket([])
    } as unknown as RuntimeEnv;
    expect(selectConfiguredR2Bucket(single)).toMatchObject({ bucket: "lake", binding: "DUCKLAKE_R2" });

    const multiple = {
      DUCKLAKE_R2_BINDINGS: JSON.stringify({ lake: "DUCKLAKE_R2", archive: "ARCHIVE_R2" }),
      DUCKLAKE_R2: fakeR2Bucket([]),
      ARCHIVE_R2: fakeR2Bucket([])
    } as unknown as RuntimeEnv;
    expect(selectConfiguredR2Bucket(multiple, "archive")).toMatchObject({ bucket: "archive", binding: "ARCHIVE_R2" });
    expect(() => selectConfiguredR2Bucket(multiple)).toThrow(/r2Bucket is required/i);
    expect(() => selectConfiguredR2Bucket(multiple, "unknown")).toThrow(/not configured/i);
    expect(() => selectConfiguredR2Bucket({ DUCKLAKE_R2_BINDINGS: JSON.stringify({ lake: "MISSING" }) } as RuntimeEnv)).toThrow(/missing Worker R2 binding/i);
    expect(listConfiguredR2Buckets({} as RuntimeEnv)).toEqual([]);
  });

  it("combines endpoint and R2 listings, normalizes response shapes, dedupes, and sorts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      files: [
        "r2://lake/prefix/from-string.parquet",
        { path: "r2://lake/prefix/from-path.parquet", last_modified: "2026-05-18T00:00:00.000Z" },
        { filename: "r2://lake/prefix/duplicate.parquet", lastModified: "2026-05-17T00:00:00.000Z" },
        { nope: true },
        7
      ]
    }))));

    const env = {
      DUCKLAKE_FILE_LIST_ENDPOINT: "https://files.example/list",
      DUCKLAKE_FILE_LIST_TOKEN: "secret",
      DUCKLAKE_R2_BINDINGS: JSON.stringify({ lake: "DUCKLAKE_R2" }),
      DUCKLAKE_R2: fakeR2Bucket(["prefix/duplicate.parquet", "prefix/from-r2.parquet", "other/ignored.parquet"])
    } as unknown as RuntimeEnv;

    const files = await createExternalFileLister(env)("r2://lake/prefix/**");
    expect(files).toEqual([
      { filename: "r2://lake/prefix/duplicate.parquet", lastModified: "2026-05-15T00:00:00.000Z" },
      { filename: "r2://lake/prefix/from-path.parquet", lastModified: "2026-05-18T00:00:00.000Z" },
      { filename: "r2://lake/prefix/from-r2.parquet", lastModified: "2026-05-15T00:00:00.000Z" },
      { filename: "r2://lake/prefix/from-string.parquet" }
    ]);
    expect(fetch).toHaveBeenCalledWith("https://files.example/list", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      body: JSON.stringify({ pattern: "r2://lake/prefix/**" })
    }));
  });

  it("surfaces file endpoint errors and ignores unmapped object-store patterns", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(createExternalFileLister({
      DUCKLAKE_FILE_LIST_ENDPOINT: "https://files.example/list"
    } as RuntimeEnv)("r2://lake/prefix/**")).rejects.toThrow(/returned 503/);

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ files: "not-an-array" }))));
    await expect(createExternalFileLister({
      DUCKLAKE_FILE_LIST_ENDPOINT: "https://files.example/list"
    } as RuntimeEnv)("not-an-object-store-pattern")).resolves.toEqual([]);

    vi.unstubAllGlobals();
    await expect(createExternalFileLister({} as RuntimeEnv)("not-an-object-store-pattern")).resolves.toEqual([]);
    await expect(createExternalFileLister({
      DUCKLAKE_R2_BINDINGS: JSON.stringify({ lake: "MISSING_BINDING" })
    } as unknown as RuntimeEnv)("r2://lake/prefix/**")).resolves.toEqual([]);
  });
});

function fakeR2Bucket(keys: string[]): R2Bucket {
  return {
    async list(options?: R2ListOptions): Promise<R2Objects> {
      const prefix = options?.prefix ?? "";
      const matching = keys.filter((key) => key.startsWith(prefix));
      const offset = options?.cursor ? Number(options.cursor) : 0;
      const pageKeys = matching.slice(offset, offset + 1);
      const nextOffset = offset + pageKeys.length;
      return {
        objects: pageKeys.map((key) => ({
          key,
          version: "v1",
          size: 1,
          etag: `"${key}"`,
          httpEtag: `"${key}"`,
          uploaded: new Date("2026-05-15T00:00:00.000Z"),
          checksums: { toJSON: () => ({}) },
          storageClass: "Standard",
          writeHttpMetadata() {}
        })),
        delimitedPrefixes: [],
        truncated: nextOffset < matching.length,
        cursor: String(nextOffset)
      };
    }
  } as unknown as R2Bucket;
}
