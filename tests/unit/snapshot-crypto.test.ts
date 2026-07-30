import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  decryptSnapshotBytes,
  encryptSnapshotBytes,
  sha256Hex,
  SNAPSHOT_CANONICAL_JSON_MAX_DEPTH,
  SnapshotCanonicalJsonDepthError,
} from "@/services/snapshot-crypto";

describe("snapshot encryption", () => {
  const key = Buffer.alloc(32, 7);

  it("round-trips authenticated encrypted bytes", () => {
    const plaintext = Buffer.from('{"knownGood":true}', "utf8");
    const encrypted = encryptSnapshotBytes(plaintext, key, "v1", Buffer.alloc(12, 3));
    expect(Buffer.from(encrypted).toString("utf8")).not.toContain("knownGood");
    const decrypted = decryptSnapshotBytes(encrypted, (version) => {
      expect(version).toBe("v1");
      return key;
    });
    expect(Buffer.from(decrypted.plaintext)).toEqual(plaintext);
  });

  it("rejects any stored-object tampering", () => {
    const encrypted = encryptSnapshotBytes(Buffer.from("protected"), key, "v1");
    const envelope = JSON.parse(Buffer.from(encrypted).toString("utf8"));
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    expect(() =>
      decryptSnapshotBytes(Buffer.from(JSON.stringify(envelope)), () => key)
    ).toThrow("integrity or encryption verification failed");
  });

  it("canonicalizes object keys without changing array order", () => {
    const left = canonicalJson({ z: [2, 1], a: { y: true, x: "same" } });
    const right = canonicalJson({ a: { x: "same", y: true }, z: [2, 1] });
    expect(left).toBe('{"a":{"x":"same","y":true},"z":[2,1]}');
    expect(left).toBe(right);
    expect(sha256Hex(Buffer.from(left))).toBe(
      "2512f388448374f8ea43af59ed4535c36ef572025e3feec8aa4b2ccb9674daee"
    );
    expect(sha256Hex(Buffer.from(right))).toBe(
      "2512f388448374f8ea43af59ed4535c36ef572025e3feec8aa4b2ccb9674daee"
    );
  });

  it("orders keys by Unicode code point instead of the host locale", () => {
    expect(canonicalJson({ a: 1, Z: 2, "\u00e9": 3 })).toBe(
      '{"Z":2,"a":1,"\u00e9":3}'
    );
    expect(canonicalJson({ "\u{10000}": 1, "\ue000": 2 })).toBe(
      '{"\ue000":2,"\u{10000}":1}'
    );
  });

  it("accepts exactly the supported number of nested containers", () => {
    const value = nestedArrays(SNAPSHOT_CANONICAL_JSON_MAX_DEPTH);

    expect(canonicalJson(value)).toBe(
      `${"[".repeat(SNAPSHOT_CANONICAL_JSON_MAX_DEPTH)}"leaf"${"]".repeat(
        SNAPSHOT_CANONICAL_JSON_MAX_DEPTH
      )}`
    );
  });

  it("refuses a container one level beyond the supported depth", () => {
    const value = nestedArrays(SNAPSHOT_CANONICAL_JSON_MAX_DEPTH + 1);

    expect(() => canonicalJson(value)).toThrow(SnapshotCanonicalJsonDepthError);
    expect(() => canonicalJson(value)).toThrow(
      "Snapshot exceeds the maximum supported nesting depth."
    );
  });

  it("refuses extremely deep values without overflowing the call stack", () => {
    const value = nestedArrays(10_000);

    expect(() => canonicalJson(value)).toThrow(SnapshotCanonicalJsonDepthError);
  });

  it("refuses cycles with a typed error that does not expose content", () => {
    const value: unknown[] = ["private snapshot content"];
    value.push(value);

    let error: unknown;
    try {
      canonicalJson(value);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(SnapshotCanonicalJsonDepthError);
    expect(String(error)).toBe(
      "SnapshotCanonicalJsonDepthError: Snapshot exceeds the maximum supported nesting depth."
    );
    expect(String(error)).not.toContain("private snapshot content");
  });
});

function nestedArrays(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = 0; index < depth; index += 1) {
    value = [value];
  }
  return value;
}
