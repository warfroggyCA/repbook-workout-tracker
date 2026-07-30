import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(process.cwd(), "scripts/migrate-neon-atomic.mjs");
const baseEnvironment = {
  ...process.env,
  DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/invalid",
  CONFIRM_NEON_MIGRATION: "production-hardening-123e1a0",
};

function runMigrationGuard(overrides: Record<string, string>) {
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...baseEnvironment, ...overrides },
    encoding: "utf8",
  });
}

describe("guarded Neon migration staging", () => {
  it("refuses an unknown stopping migration before connecting", () => {
    const result = runMigrationGuard({
      EXPECTED_CURRENT_MIGRATION: "0042_eminent_king_cobra",
      TARGET_MIGRATION: "not-a-migration",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown target migration tag not-a-migration");
    expect(result.stderr).not.toContain("ECONNREFUSED");
  });

  it("refuses to move a migration journal backwards before connecting", () => {
    const result = runMigrationGuard({
      EXPECTED_CURRENT_MIGRATION: "0044_versioned_program_editor_preview",
      TARGET_MIGRATION: "0043_versioned_program_editor_expand",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "TARGET_MIGRATION cannot be older than EXPECTED_CURRENT_MIGRATION"
    );
    expect(result.stderr).not.toContain("ECONNREFUSED");
  });
});
