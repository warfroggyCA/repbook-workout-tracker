import { afterEach, describe, expect, it, vi } from "vitest";
import { maintenanceAuthorized } from "@/lib/maintenance-auth";

function request(secret?: string) {
  return new Request("https://example.com/api/maintenance/recovery", {
    headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("maintenance authorization", () => {
  it("accepts only the configured maintenance secret", () => {
    vi.stubEnv("MAINTENANCE_SECRET", "current-secret");
    vi.stubEnv("CRON_SECRET", "old-secret");

    expect(maintenanceAuthorized(request("current-secret"))).toEqual({
      ok: true,
    });
    expect(maintenanceAuthorized(request("old-secret"))).toEqual({
      ok: false,
      status: 401,
      reason: "Unauthorized",
    });
  });

  it("rejects CRON_SECRET when MAINTENANCE_SECRET is not configured", () => {
    vi.stubEnv("MAINTENANCE_SECRET", "");
    vi.stubEnv("CRON_SECRET", "old-secret");

    expect(maintenanceAuthorized(request("old-secret"))).toEqual({
      ok: false,
      status: 503,
      reason: "Maintenance is not configured.",
    });
  });

  it("rejects a missing authorization header", () => {
    vi.stubEnv("MAINTENANCE_SECRET", "current-secret");

    expect(maintenanceAuthorized(request())).toEqual({
      ok: false,
      status: 401,
      reason: "Unauthorized",
    });
  });

  it("rejects malformed authorization headers without throwing", () => {
    vi.stubEnv("MAINTENANCE_SECRET", "current-secret");

    for (const authorization of [
      "Bearer",
      "Basic current-secret",
      "Bearer %E0%A4%A",
      "Bearer current-secret extra",
    ]) {
      expect(() =>
        maintenanceAuthorized(
          new Request("https://example.com/api/maintenance/recovery", {
            headers: { authorization },
          })
        )
      ).not.toThrow();
      expect(
        maintenanceAuthorized(
          new Request("https://example.com/api/maintenance/recovery", {
            headers: { authorization },
          })
        )
      ).toEqual({
        ok: false,
        status: 401,
        reason: "Unauthorized",
      });
    }
  });
});
