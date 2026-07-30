import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("database environment selection", () => {
  it("refuses to use PGlite in production when DATABASE_URL is blank", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "   ");

    const { getDb } = await import("@/db");

    await expect(getDb()).rejects.toThrow(
      "DATABASE_URL must be configured in production."
    );
  });
});
