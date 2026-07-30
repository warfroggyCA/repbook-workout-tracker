import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextAuthConfig } from "next-auth";

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: {},
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadConfig(
  environment: "development" | "production",
  values: {
    allowedEmails?: string;
    secret?: string;
    disposableE2e?: boolean;
    githubConfigured?: boolean;
    disposablePreview?: boolean;
  } = {}
) {
  vi.stubEnv("NODE_ENV", environment);
  vi.stubEnv("ALLOWED_EMAILS", values.allowedEmails ?? "owner@example.com");
  vi.stubEnv("AUTH_SECRET", values.secret ?? "");
  vi.stubEnv("AUTH_GITHUB_ID", values.githubConfigured ? "test-client-id" : "");
  vi.stubEnv(
    "AUTH_GITHUB_SECRET",
    values.githubConfigured ? "test-client-secret" : ""
  );
  vi.stubEnv("E2E_DEV_LOGIN", values.disposableE2e ? "1" : "");
  vi.stubEnv("AI_FAKE", values.disposableE2e ? "1" : "");
  vi.stubEnv("PGLITE_DIR", values.disposableE2e ? "/tmp/test-pglite" : "");
  vi.stubEnv(
    "SNAPSHOT_LOCAL_DIR",
    values.disposableE2e ? "/tmp/test-snapshots" : ""
  );
  vi.stubEnv(
    "SNAPSHOT_ENCRYPTION_KEY_V1",
    values.disposableE2e ? "test-key" : ""
  );
  vi.stubEnv(
    "DATABASE_URL",
    values.disposableE2e
      ? "postgresql://workout_tracker_test:local-test-only@local.test/workout_tracker_test"
      : values.disposablePreview
        ? "postgresql://preview:secret@ep-example.us-east-1.aws.neon.tech/workout_preview_test"
      : ""
  );
  vi.stubEnv("VERCEL_ENV", values.disposablePreview ? "preview" : "");
  vi.stubEnv("PREVIEW_PUBLIC_LOGIN", values.disposablePreview ? "1" : "");
  vi.resetModules();
  return (await import("@/lib/auth")).authConfig;
}

function providerIds(config: NextAuthConfig): string[] {
  return config.providers.map((provider) => {
    const resolved =
      typeof provider === "function"
        ? (provider as () => {
            id: string;
            options?: { id?: string };
          })()
        : provider;
    return String(resolved.options?.id ?? resolved.id);
  });
}

describe("Auth.js configuration", () => {
  it("admits only allowlisted email addresses", async () => {
    const config = await loadConfig("production", {
      allowedEmails: "owner@example.com",
      secret: "test-secret",
    });
    const signIn = config.callbacks?.signIn;
    expect(signIn).toBeTypeOf("function");

    expect(
      await signIn?.({ user: { email: "OWNER@example.com" } } as never)
    ).toBe(true);
    expect(
      await signIn?.({ user: { email: "other@example.com" } } as never)
    ).toBe(false);
    expect(await signIn?.({ user: { email: null } } as never)).toBe(false);
  });

  it("configures GitHub only when both provider credentials are present", async () => {
    const configured = await loadConfig("production", {
      secret: "test-secret",
      githubConfigured: true,
    });
    expect(providerIds(configured)).toContain("github");

    vi.stubEnv("AUTH_GITHUB_SECRET", "");
    vi.resetModules();
    const missingSecret = (await import("@/lib/auth")).authConfig;
    expect(providerIds(missingSecret)).not.toContain("github");
  });

  it("records provider sign-in evidence only when an account is present", async () => {
    const config = await loadConfig("production", { secret: "test-secret" });
    const jwt = config.callbacks?.jwt;
    expect(jwt).toBeTypeOf("function");
    vi.spyOn(Date, "now").mockReturnValue(123_456);

    const initialToken = { sub: "user-1" };
    const unchanged = await jwt?.({ token: initialToken } as never);
    expect(unchanged).toBe(initialToken);
    expect(unchanged).not.toHaveProperty("lastProviderSignInAt");

    const stamped = await jwt?.({
      token: { sub: "user-1" },
      account: { provider: "github" },
    } as never);
    expect(stamped).toMatchObject({
      sub: "user-1",
      lastProviderSignInAt: 123_456,
      lastAuthProvider: "github",
    });
  });

  it("maps optional token evidence onto every session and keeps an eight-hour lifetime", async () => {
    const config = await loadConfig("production", { secret: "test-secret" });
    const session = config.callbacks?.session;
    expect(session).toBeTypeOf("function");
    expect(config.session?.maxAge).toBe(8 * 60 * 60);

    expect(
      await session?.({
        session: { user: {}, expires: "2099-01-01T00:00:00.000Z" },
        token: {
          lastProviderSignInAt: 123_456,
          lastAuthProvider: "github",
        },
      } as never)
    ).toMatchObject({
      lastProviderSignInAt: 123_456,
      lastAuthProvider: "github",
    });

    expect(
      await session?.({
        session: { user: {}, expires: "2099-01-01T00:00:00.000Z" },
        token: {},
      } as never)
    ).toMatchObject({
      lastProviderSignInAt: null,
      lastAuthProvider: null,
    });
  });

  it("exposes dev login and the fallback secret only in development", async () => {
    const development = await loadConfig("development");
    expect(providerIds(development)).toContain("dev-login");
    expect(development.secret).toBe("insecure-dev-secret");

    const production = await loadConfig("production");
    expect(providerIds(production)).not.toContain("dev-login");
    expect(production.secret).toBeUndefined();
  });

  it("exposes dev login in production only for the guarded disposable acceptance runtime", async () => {
    const guarded = await loadConfig("production", {
      disposableE2e: true,
      secret: "test-secret",
    });
    expect(providerIds(guarded)).toContain("dev-login");

    vi.stubEnv("PGLITE_DIR", "");
    vi.resetModules();
    const withoutDisposableDatabase = (await import("@/lib/auth")).authConfig;
    expect(providerIds(withoutDisposableDatabase)).not.toContain("dev-login");
  });

  it("provides one-click login only for a guarded disposable Vercel Preview", async () => {
    const guarded = await loadConfig("production", {
      disposablePreview: true,
      secret: "test-secret",
    });
    const provider = guarded.providers
      .map((candidate) =>
        typeof candidate === "function" ? candidate() : candidate
      )
      .find((candidate) => candidate.id === "credentials");
    const authorize = provider?.options?.authorize as
      | ((
          credentials: Record<string, unknown>,
          request: Request
        ) => Promise<unknown>)
      | undefined;

    expect(providerIds(guarded)).toContain("dev-login");
    expect(authorize).toBeTypeOf("function");
    await expect(authorize?.({}, {} as never)).resolves.toMatchObject({
      email: "owner@example.com",
      name: "Preview user",
    });

    vi.stubEnv("VERCEL_ENV", "production");
    await expect(authorize?.({}, {} as never)).resolves.toBeNull();

    vi.resetModules();
    const production = (await import("@/lib/auth")).authConfig;
    expect(providerIds(production)).not.toContain("dev-login");
  });
});
