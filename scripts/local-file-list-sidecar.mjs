#!/usr/bin/env node
import { readdir, stat } from "node:fs/promises";
import http from "node:http";

const port = Number(process.env.PORT ?? 9797);
const host = process.env.HOST ?? "127.0.0.1";
const fileListToken = process.env.DUCKLAKE_FILE_LIST_TOKEN;

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    const body = await readBody(request);
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed.pattern !== "string") {
      writeJson(response, 400, { error: "missing_pattern" });
      return;
    }
    if (!isAuthorized(request, fileListToken)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    writeJson(response, 200, { files: await localFilesForPattern(parsed.pattern) });
  } catch (error) {
    writeJson(response, 500, {
      error: "file_list_failed",
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, host, () => {
  console.error(`quacklake file list sidecar listening on http://${host}:${port}`);
});

function isAuthorized(request, expectedToken) {
  return !expectedToken || request.headers.authorization === `Bearer ${expectedToken}`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function writeJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function localFilesForPattern(pattern) {
  const prefix = globPrefix(pattern);
  const matcher = globToRegExp(pattern);
  const files = [];
  await collectFiles(prefix, matcher, files);
  return files.sort((left, right) => left.filename.localeCompare(right.filename));
}

async function collectFiles(path, matcher, files) {
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  if (info.isFile()) {
    const filename = normalizePath(path);
    if (matcher.test(filename)) {
      files.push({ filename, lastModified: info.mtime.toISOString() });
    }
    return;
  }
  if (!info.isDirectory()) {
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    await collectFiles(`${path.replace(/\/$/, "")}/${entry.name}`, matcher, files);
  }
}

function globPrefix(pattern) {
  const normalized = normalizePath(pattern);
  const index = normalized.search(/[*?[\]]/);
  if (index < 0) {
    return normalized;
  }
  const slash = normalized.lastIndexOf("/", index);
  return slash < 0 ? "." : normalized.slice(0, slash + 1);
}

function globToRegExp(pattern) {
  const normalized = normalizePath(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`${source}$`);
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
