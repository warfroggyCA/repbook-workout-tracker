import { afterEach, describe, expect, it, vi } from "vitest";
import { isProductionRuntime, optionalEnv } from "@/lib/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("environment helpers", () => {
  it("treats unset and blank values as missing", () => {
    vi.stubEnv("EMPTY_VALUE", "");
    vi.stubEnv("SPACES_VALUE", "   ");

    expect(optionalEnv("MISSING_VALUE")).toBeUndefined();
    expect(optionalEnv("EMPTY_VALUE")).toBeUndefined();
    expect(optionalEnv("SPACES_VALUE")).toBeUndefined();
  });

  it("trims configured values", () => {
    vi.stubEnv("CONFIGURED_VALUE", "  abc123  ");

    expect(optionalEnv("CONFIGURED_VALUE")).toBe("abc123");
  });

  it("detects production runtime", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isProductionRuntime()).toBe(true);

    vi.stubEnv("NODE_ENV", "development");
    expect(isProductionRuntime()).toBe(false);
  });
});
