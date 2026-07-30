import { afterEach, describe, expect, it, vi } from "vitest";
import { getToken } from "next-auth/jwt";
import { authorizedSessionIdentity } from "@/lib/session-authorization";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Auth.js security regressions", () => {
  it("treats malformed bearer tokens as unauthenticated", async () => {
    for (const authorization of [
      "Bearer %",
      "Bearer %E0%A4%A",
      "Bearer %ZZ",
    ]) {
      await expect(
        getToken({
          req: new Request("https://example.com/api/protected", {
            headers: { authorization },
          }),
          secret: "test-secret",
          secureCookie: true,
        })
      ).resolves.toBeNull();
    }
  });

  it("fails closed for Auth.js error objects and unauthorized identities", () => {
    vi.stubEnv("ALLOWED_EMAILS", "owner@example.com");

    expect(
      authorizedSessionIdentity({
        message:
          "There was a problem with the server configuration. Check the server logs for more information.",
      } as never)
    ).toBeNull();
    expect(
      authorizedSessionIdentity({ user: { email: "other@example.com" } })
    ).toBeNull();
    expect(
      authorizedSessionIdentity({ user: { email: "OWNER@example.com" } })
    ).toEqual({ email: "owner@example.com", name: null });
  });
});
