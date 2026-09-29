// Local-only driver for provider-uuid.rs; see guides/uuid-cast-regression.md.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { LogicalTypeId, QuackClient } from "@quack-protocol/sdk";

const executable = process.argv[2];
assert(executable, "pass the compiled quacklake_uuid example path");
const url = "http://127.0.0.1:8798";
const headers = { Authorization: "Bearer uuid-local-admin", "Content-Type": "application/json" };
const catalogId = `uuid_provider_${crypto.randomUUID().replaceAll("-", "_")}`;
const created = await fetch(`${url}/admin/catalogs`, {
  method: "POST", headers, body: JSON.stringify({ catalogId })
});
assert.equal(created.status, 201);
const { jwt, catalog } = await created.json();
const policy = await fetch(`${url}/admin/catalogs/${catalogId}/auth-policy`, {
  method: "PUT", headers,
  body: JSON.stringify({ version: 1, defaultEffect: "allow", rules: [] })
});
assert.equal(policy.status, 200);
const directory = await mkdtemp(join(tmpdir(), "quacklake-uuid-client-"));
try {
  const state = join(directory, "catalog.json");
  await writeFile(state, JSON.stringify({ uri: "quack:127.0.0.1:8798", jwt, dataPath: catalog.dataPath }), { mode: 0o600 });
  const native = spawnSync(executable, [state], { encoding: "utf8", timeout: 60000 });
  process.stdout.write(native.stdout ?? "");
  process.stderr.write((native.stderr ?? "").replaceAll(jwt, "[redacted]"));

  // This client performs another independent connect and binary protocol decode,
  // including when the native client has reproduced the pre-fix HTTP 400.
  const client = await QuackClient.connect(url, { authToken: jwt });
  try {
    assert.equal((await client.query("SELECT table_id FROM ducklake_table")).rows().length, 1);
    console.log("PASS independent table_id read");
    const result = await client.query("SELECT table_uuid FROM ducklake_table");
    assert.deepEqual(result.types.map((type) => type.id), [LogicalTypeId.UUID]);
    assert.equal(result.rows().length, 1);
    assert.match(result.rows()[0].table_uuid, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    console.log("PASS independent @quack-protocol/sdk 0.2.0 UUID read");
  } finally {
    await client.disconnect();
  }
  assert.equal(native.status, 0, "native provider regression failed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
