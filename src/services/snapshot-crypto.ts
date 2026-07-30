import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export const SNAPSHOT_ENCRYPTION_ALGORITHM = "aes-256-gcm";
export const SNAPSHOT_ENVELOPE_FORMAT = "workout-tracker-encrypted-snapshot";
export const SNAPSHOT_CANONICAL_JSON_MAX_DEPTH = 64;

export class SnapshotCanonicalJsonDepthError extends Error {
  constructor() {
    super("Snapshot exceeds the maximum supported nesting depth.");
    this.name = "SnapshotCanonicalJsonDepthError";
  }
}

type SnapshotEnvelope = {
  format: typeof SNAPSHOT_ENVELOPE_FORMAT;
  version: 1;
  algorithm: typeof SNAPSHOT_ENCRYPTION_ALGORITHM;
  keyVersion: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

export function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseSnapshotKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("Snapshot encryption key must be 32 bytes encoded as base64.");
  }
  return key;
}

function aad(keyVersion: string) {
  return Buffer.from(`${SNAPSHOT_ENVELOPE_FORMAT}:1:${keyVersion}`, "utf8");
}

export function encryptSnapshotBytes(
  plaintext: Uint8Array,
  key: Uint8Array,
  keyVersion: string,
  iv = randomBytes(12)
): Uint8Array {
  if (key.length !== 32) throw new Error("Snapshot encryption key must be 32 bytes.");
  const cipher = createCipheriv(SNAPSHOT_ENCRYPTION_ALGORITHM, key, iv);
  cipher.setAAD(aad(keyVersion));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const envelope: SnapshotEnvelope = {
    format: SNAPSHOT_ENVELOPE_FORMAT,
    version: 1,
    algorithm: SNAPSHOT_ENCRYPTION_ALGORITHM,
    keyVersion,
    iv: Buffer.from(iv).toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

export function decryptSnapshotBytes(
  encrypted: Uint8Array,
  resolveKey: (keyVersion: string) => Uint8Array
): { plaintext: Uint8Array; keyVersion: string } {
  let envelope: SnapshotEnvelope;
  try {
    envelope = JSON.parse(Buffer.from(encrypted).toString("utf8")) as SnapshotEnvelope;
  } catch {
    throw new Error("Snapshot object is not a valid encrypted envelope.");
  }
  if (
    envelope.format !== SNAPSHOT_ENVELOPE_FORMAT ||
    envelope.version !== 1 ||
    envelope.algorithm !== SNAPSHOT_ENCRYPTION_ALGORITHM ||
    !envelope.keyVersion
  ) {
    throw new Error("Snapshot encryption envelope is unsupported.");
  }
  const key = resolveKey(envelope.keyVersion);
  if (key.length !== 32) throw new Error("Snapshot encryption key must be 32 bytes.");
  const decipher = createDecipheriv(
    SNAPSHOT_ENCRYPTION_ALGORITHM,
    key,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAAD(aad(envelope.keyVersion));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  try {
    return {
      plaintext: Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]),
      keyVersion: envelope.keyVersion,
    };
  } catch {
    throw new Error("Snapshot integrity or encryption verification failed.");
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonAtDepth(value, 0);
}

function canonicalJsonAtDepth(value: unknown, depth: number): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Snapshot contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    assertCanonicalJsonContainerDepth(depth);
    return `[${value
      .map((item) => canonicalJsonAtDepth(item, depth + 1))
      .join(",")}]`;
  }
  if (typeof value === "object") {
    assertCanonicalJsonContainerDepth(depth);
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalJsonAtDepth(item, depth + 1)}`
      )
      .join(",")}}`;
  }
  throw new Error("Snapshot contains an unsupported value.");
}

function assertCanonicalJsonContainerDepth(depth: number) {
  if (depth >= SNAPSHOT_CANONICAL_JSON_MAX_DEPTH) {
    throw new SnapshotCanonicalJsonDepthError();
  }
}

function compareUnicodeCodePoints(left: string, right: string) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index];
    }
  }
  return leftPoints.length - rightPoints.length;
}
