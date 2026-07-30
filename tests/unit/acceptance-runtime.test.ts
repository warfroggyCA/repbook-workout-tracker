import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDisposableAcceptanceRuntime,
  isDisposableVercelPreviewRuntime,
  isPhase0StartDisposableAcceptanceRuntime,
  isPhase1FoundationDisposableAcceptanceRuntime,
  isStage6DisposableAcceptanceRuntime,
} from "@/lib/acceptance-runtime";

afterEach(() => vi.unstubAllEnvs());

function configureDisposableAcceptanceRuntime() {
  vi.stubEnv("E2E_DEV_LOGIN", "1");
  vi.stubEnv("AI_FAKE", "1");
  vi.stubEnv("PGLITE_DIR", "/tmp/test-pglite");
  vi.stubEnv("SNAPSHOT_LOCAL_DIR", "/tmp/test-snapshots");
  vi.stubEnv("SNAPSHOT_ENCRYPTION_KEY_V1", "test-key");
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://workout_tracker_test:local-test-only@local.test/workout_tracker_test"
  );
}

describe("disposable acceptance runtime", () => {
  it("requires every local-only acceptance guard", () => {
    const requiredGuards = [
      "E2E_DEV_LOGIN",
      "AI_FAKE",
      "PGLITE_DIR",
      "SNAPSHOT_LOCAL_DIR",
      "SNAPSHOT_ENCRYPTION_KEY_V1",
      "DATABASE_URL",
    ] as const;

    for (const guard of requiredGuards) {
      configureDisposableAcceptanceRuntime();
      expect(isDisposableAcceptanceRuntime()).toBe(true);

      vi.stubEnv(guard, "");
      expect(isDisposableAcceptanceRuntime()).toBe(false);
    }
  });

  it("rejects any other database identity", () => {
    configureDisposableAcceptanceRuntime();
    vi.stubEnv("DATABASE_URL", "postgresql://example.invalid/production");
    expect(isDisposableAcceptanceRuntime()).toBe(false);
  });

  it("requires the Phase 0 marker plus every disposable runtime guard", () => {
    configureDisposableAcceptanceRuntime();
    vi.stubEnv("PHASE0_START_FIXTURE", "1");
    expect(isPhase0StartDisposableAcceptanceRuntime()).toBe(true);

    vi.stubEnv("PHASE0_START_FIXTURE", "");
    expect(isPhase0StartDisposableAcceptanceRuntime()).toBe(false);

    vi.stubEnv("PHASE0_START_FIXTURE", "1");
    vi.stubEnv("DATABASE_URL", "postgresql://example.invalid/production");
    expect(isPhase0StartDisposableAcceptanceRuntime()).toBe(false);
  });

  it("requires the Phase 1 marker plus every disposable runtime guard", () => {
    configureDisposableAcceptanceRuntime();
    vi.stubEnv("PHASE1_FOUNDATION_FIXTURE", "1");
    expect(isPhase1FoundationDisposableAcceptanceRuntime()).toBe(true);

    vi.stubEnv("PHASE1_FOUNDATION_FIXTURE", "");
    expect(isPhase1FoundationDisposableAcceptanceRuntime()).toBe(false);

    vi.stubEnv("PHASE1_FOUNDATION_FIXTURE", "1");
    vi.stubEnv("DATABASE_URL", "postgresql://example.invalid/production");
    expect(isPhase1FoundationDisposableAcceptanceRuntime()).toBe(false);
  });

  it("recognizes the separately guarded Stage 6 optimized PGlite bridge", () => {
    configureDisposableAcceptanceRuntime();
    vi.stubEnv("STAGE6_SIMULATION_FIXTURE", "1");
    expect(isStage6DisposableAcceptanceRuntime()).toBe(true);

    vi.stubEnv("PGLITE_DIR", "");
    expect(isStage6DisposableAcceptanceRuntime()).toBe(false);
  });

  it("rejects Stage 6 without its fixture marker or exact local bridge identity", () => {
    configureDisposableAcceptanceRuntime();
    vi.stubEnv("STAGE6_SIMULATION_FIXTURE", "1");
    expect(isStage6DisposableAcceptanceRuntime()).toBe(true);

    vi.stubEnv("STAGE6_SIMULATION_FIXTURE", "");
    expect(isStage6DisposableAcceptanceRuntime()).toBe(false);

    vi.stubEnv("STAGE6_SIMULATION_FIXTURE", "1");
    vi.stubEnv("DATABASE_URL", "");
    expect(isStage6DisposableAcceptanceRuntime()).toBe(false);

    vi.stubEnv("DATABASE_URL", "postgresql://example.invalid/production");
    expect(isStage6DisposableAcceptanceRuntime()).toBe(false);
  });
});

describe("disposable Vercel Preview runtime", () => {
  function configureDisposablePreviewRuntime() {
    vi.stubEnv("ALLOWED_EMAILS", "preview@example.com");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("PREVIEW_PUBLIC_LOGIN", "1");
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://preview:secret@ep-example.us-east-1.aws.neon.tech/workout_preview_test"
    );
  }

  it("requires every preview guard and a disposable Neon database", () => {
    const guards = [
      "ALLOWED_EMAILS",
      "VERCEL_ENV",
      "PREVIEW_PUBLIC_LOGIN",
      "DATABASE_URL",
    ] as const;

    for (const guard of guards) {
      configureDisposablePreviewRuntime();
      expect(isDisposableVercelPreviewRuntime()).toBe(true);

      vi.stubEnv(guard, "");
      expect(isDisposableVercelPreviewRuntime()).toBe(false);
    }
  });

  it("fails closed for production, non-Neon, and production-named databases", () => {
    configureDisposablePreviewRuntime();
    vi.stubEnv("VERCEL_ENV", "production");
    expect(isDisposableVercelPreviewRuntime()).toBe(false);

    configureDisposablePreviewRuntime();
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://preview:secret@example.com/workout_preview_test"
    );
    expect(isDisposableVercelPreviewRuntime()).toBe(false);

    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://preview:secret@ep-example.us-east-1.aws.neon.tech/workout_tracker"
    );
    expect(isDisposableVercelPreviewRuntime()).toBe(false);

    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://preview:secret@ep-example.us-east-1.aws.neon.tech/production_test"
    );
    expect(isDisposableVercelPreviewRuntime()).toBe(false);
  });
});
