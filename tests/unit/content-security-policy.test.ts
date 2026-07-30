import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

describe("nonce content security policy", () => {
  it("generates a different strict script nonce for every page request", () => {
    const request = new NextRequest("https://workouts.example/today");
    const first = proxy(request).headers.get("content-security-policy");
    const second = proxy(request).headers.get("content-security-policy");

    expect(first).toContain("'strict-dynamic'");
    expect(first).toContain("script-src-attr 'none'");
    expect(first).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(first).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(first).not.toBe(second);
  });
});
