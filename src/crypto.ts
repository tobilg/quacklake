const encoder = new TextEncoder();

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64Url(bytes)}`;
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToHex(new Uint8Array(signature));
}

export async function timingSafeEqualText(left: string, right: string): Promise<boolean> {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  return timingSafeEqualBytes(leftBytes, rightBytes);
}

export function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

export async function signConnectionId(secret: string, payload: ConnectionIdPayload): Promise<string> {
  const encodedPayload = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await hmacHex(secret, encodedPayload);
  return `dq1.${encodedPayload}.${signature}`;
}

export async function verifyConnectionId(secret: string, value: string): Promise<ConnectionIdPayload | undefined> {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "dq1") {
    return undefined;
  }
  const [, encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return undefined;
  }
  const expected = await hmacHex(secret, encodedPayload);
  if (!timingSafeEqualBytes(hexToBytes(signature), hexToBytes(expected))) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as Partial<ConnectionIdPayload>;
    if (typeof decoded.catalogId !== "string" || typeof decoded.sessionId !== "string") {
      return undefined;
    }
    return { catalogId: decoded.catalogId, sessionId: decoded.sessionId };
  } catch {
    return undefined;
  }
}

export interface ConnectionIdPayload {
  catalogId: string;
  sessionId: string;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || /[^a-f0-9]/i.test(value)) {
    return new Uint8Array();
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}
