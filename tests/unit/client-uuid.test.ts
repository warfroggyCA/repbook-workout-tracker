import { describe, expect, it, vi } from "vitest";
import { createClientUuid } from "@/lib/client-uuid";

describe("createClientUuid", () => {
  it("uses the platform UUID generator when available", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");

    expect(createClientUuid({ randomUUID })).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("creates an RFC 4122 version 4 UUID from secure random bytes", () => {
    let calls = 0;
    const getRandomValues = <T extends ArrayBufferView>(value: T): T => {
      calls += 1;
      const bytes = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return value;
    };

    expect(createClientUuid({ getRandomValues })).toBe(
      "00010203-0405-4607-8809-0a0b0c0d0e0f",
    );
    expect(calls).toBe(1);
  });

  it("fails closed when no secure random source exists", () => {
    expect(() => createClientUuid({})).toThrow(
      "Secure random values are unavailable.",
    );
  });
});
