import { optionalEnv } from "@/lib/env";
import { allowedEmailSet } from "@/lib/allowlist";

const LOCAL_ACCEPTANCE_DATABASE_URL =
  "postgresql://workout_tracker_test:local-test-only@local.test/workout_tracker_test";
const DISPOSABLE_DATABASE_NAME = /(test|disposable)/i;
const PRODUCTION_DATABASE_NAME = /(prod|production|main)/i;

function isDisposableNeonDatabase(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false;

  try {
    const parsed = new URL(databaseUrl);
    const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    return (
      (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") &&
      parsed.hostname.endsWith(".neon.tech") &&
      DISPOSABLE_DATABASE_NAME.test(databaseName) &&
      !PRODUCTION_DATABASE_NAME.test(databaseName)
    );
  } catch {
    return false;
  }
}

export function isDisposableAcceptanceRuntime(): boolean {
  return (
    optionalEnv("E2E_DEV_LOGIN") === "1" &&
    optionalEnv("AI_FAKE") === "1" &&
    Boolean(optionalEnv("PGLITE_DIR")) &&
    Boolean(optionalEnv("SNAPSHOT_LOCAL_DIR")) &&
    Boolean(optionalEnv("SNAPSHOT_ENCRYPTION_KEY_V1")) &&
    optionalEnv("DATABASE_URL") === LOCAL_ACCEPTANCE_DATABASE_URL
  );
}

/**
 * Enables the one-click synthetic credentials provider only for Vercel Preview
 * deployments backed by an explicitly disposable Neon database. Production
 * cannot satisfy this identity even if the feature flag is copied there.
 */
export function isDisposableVercelPreviewRuntime(): boolean {
  return (
    optionalEnv("VERCEL_ENV") === "preview" &&
    optionalEnv("PREVIEW_PUBLIC_LOGIN") === "1" &&
    allowedEmailSet().size > 0 &&
    isDisposableNeonDatabase(optionalEnv("DATABASE_URL"))
  );
}

export function disposablePreviewIdentityEmail(): string | null {
  if (!isDisposableVercelPreviewRuntime()) return null;
  return allowedEmailSet().values().next().value ?? null;
}

/**
 * Stage 6 uses the same local-only production bridge identity as the other
 * optimized acceptance routes, plus its own fixture marker.
 */
export function isStage6DisposableAcceptanceRuntime(): boolean {
  return (
    optionalEnv("STAGE6_SIMULATION_FIXTURE") === "1" &&
    optionalEnv("E2E_DEV_LOGIN") === "1" &&
    optionalEnv("AI_FAKE") === "1" &&
    Boolean(optionalEnv("PGLITE_DIR")) &&
    Boolean(optionalEnv("SNAPSHOT_LOCAL_DIR")) &&
    Boolean(optionalEnv("SNAPSHOT_ENCRYPTION_KEY_V1")) &&
    optionalEnv("DATABASE_URL") === LOCAL_ACCEPTANCE_DATABASE_URL
  );
}

/** Enables deterministic workout-start failures only in the guarded local fixture. */
export function isPhase0StartDisposableAcceptanceRuntime(): boolean {
  return (
    optionalEnv("PHASE0_START_FIXTURE") === "1" &&
    isDisposableAcceptanceRuntime()
  );
}

/** Exposes the Phase 1 component proof only inside its disposable local run. */
export function isPhase1FoundationDisposableAcceptanceRuntime(): boolean {
  return (
    optionalEnv("PHASE1_FOUNDATION_FIXTURE") === "1" &&
    isDisposableAcceptanceRuntime()
  );
}
