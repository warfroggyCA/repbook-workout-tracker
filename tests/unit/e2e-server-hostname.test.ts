import { describe, expect, it } from "vitest";
import { resolveE2EServerHostname } from "../../scripts/e2e-server-hostname.mjs";

describe("disposable E2E server hostname", () => {
  it("stays loopback-only by default", () => {
    expect(resolveE2EServerHostname(undefined)).toBe("127.0.0.1");
    expect(resolveE2EServerHostname("")).toBe("127.0.0.1");
  });

  it("permits the explicit local-network study binding", () => {
    expect(resolveE2EServerHostname("0.0.0.0")).toBe("0.0.0.0");
  });

  it("refuses arbitrary hostnames and addresses", () => {
    expect(() => resolveE2EServerHostname("workout.example.com")).toThrow(
      "E2E_HOSTNAME must be 127.0.0.1 or 0.0.0.0.",
    );
    expect(() => resolveE2EServerHostname("192.168.2.22")).toThrow(
      "E2E_HOSTNAME must be 127.0.0.1 or 0.0.0.0.",
    );
  });
});
