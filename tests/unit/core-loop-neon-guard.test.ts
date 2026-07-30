import { describe, expect, it } from "vitest";
import {
  coreLoopNeonFlags,
  prepareCoreLoopNeonRuntime,
  validateCoreLoopNeonTarget,
} from "../../scripts/lib/core-loop-neon-guard.mjs";

const disposable = "postgresql://owner:secret@ep-example.us-east-2.aws.neon.tech/workout_disposable_test?sslmode=require";

function validate(overrides: Record<string, unknown> = {}) {
  return validateCoreLoopNeonTarget({
    disposableUrl: disposable,
    productionUrl: undefined,
    allowWrites: true,
    migrated: false,
    runtimeEnvironment: undefined,
    ...overrides,
  });
}

describe("real-Neon core-loop refusal guard", () => {
  it("requires the explicit write flag before accepting any target", () => {
    expect(() => validate({ allowWrites: false })).toThrow("--allow-writes");
  });

  it("refuses non-Neon, production-like, and ordinary database names", () => {
    expect(() => validate({ disposableUrl: "postgresql://owner:secret@localhost/workout_test" })).toThrow("real Neon");
    expect(() => validate({ disposableUrl: "postgresql://owner:secret@ep-example.us-east-2.aws.neon.tech/workout_production_test" })).toThrow("production-like");
    expect(() => validate({ disposableUrl: "postgresql://owner:secret@ep-example.us-east-2.aws.neon.tech/neondb" })).toThrow("test or disposable");
  });

  it("refuses the normal application database even when credentials differ", () => {
    expect(() => validate({
      productionUrl: "postgresql://other:credentials@ep-example.us-east-2.aws.neon.tech/workout_disposable_test?sslmode=require",
    })).toThrow("matches DATABASE_URL");
  });

  it("refuses production runtime and unknown flags", () => {
    expect(() => validate({ runtimeEnvironment: "production" })).toThrow("production runtime");
    expect(() => coreLoopNeonFlags(["--allow-writes", "--unexpected"])).toThrow("Unknown argument");
  });

  it("accepts only the guarded disposable target and records migrated intent", () => {
    expect(validate({ migrated: true })).toMatchObject({
      databaseName: "workout_disposable_test",
      migrated: true,
    });
    expect(coreLoopNeonFlags(["--allow-writes", "--migrated"])).toEqual({
      allowWrites: true,
      migrated: true,
    });
  });

  it("binds only a validated disposable target to transactional services", () => {
    const environment: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgresql://owner:secret@production.example/app",
      NODE_ENV: "test",
    };
    const target = prepareCoreLoopNeonRuntime({
      disposableUrl: disposable,
      productionUrl: environment.DATABASE_URL,
      allowWrites: true,
      migrated: false,
      runtimeEnvironment: undefined,
    }, environment);

    expect(environment.DATABASE_URL).toBe(target.databaseUrl);

    const refusedEnvironment: NodeJS.ProcessEnv = {
      DATABASE_URL: disposable,
      NODE_ENV: "test",
    };
    expect(() => prepareCoreLoopNeonRuntime({
      disposableUrl: disposable,
      productionUrl: refusedEnvironment.DATABASE_URL,
      allowWrites: true,
      migrated: false,
      runtimeEnvironment: undefined,
    }, refusedEnvironment)).toThrow("matches DATABASE_URL");
    expect(refusedEnvironment.DATABASE_URL).toBe(disposable);
  });
});
