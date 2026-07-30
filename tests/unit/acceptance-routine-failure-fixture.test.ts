import { describe, expect, it } from "vitest";
import {
  BA_MALFORMED_ROUTINE_BUILD_RESULT,
  BA_ROUTINE_FAILURE_MODES,
  BA_ROUTINE_TIMEOUT_MESSAGE,
  BA_ROUTINE_UNAVAILABLE_MESSAGE,
  BaRoutineBuildUnavailableError,
  createBaRoutineBuildFailure,
  parseBaRoutineFailureMode,
} from "@/ai/acceptance-routine-failure-fixture";
import { routineBuildSchema } from "@/ai/tasks/routine-build/schema";

describe("deterministic BA routine-build failure fixture", () => {
  it("exposes only the three explicit modes and refuses configuration typos", () => {
    expect(BA_ROUTINE_FAILURE_MODES).toEqual([
      "timeout",
      "malformed",
      "unavailable",
    ]);
    expect(parseBaRoutineFailureMode(undefined)).toBeNull();
    expect(parseBaRoutineFailureMode("")).toBeNull();
    for (const mode of BA_ROUTINE_FAILURE_MODES) {
      expect(parseBaRoutineFailureMode(mode)).toBe(mode);
    }
    expect(() => parseBaRoutineFailureMode("time-out")).toThrow(
      "Unknown deterministic BA routine-build failure mode.",
    );
  });

  it("creates an exact TimeoutError without including request data", () => {
    expect.assertions(5);
    try {
      createBaRoutineBuildFailure("timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(DOMException);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("TimeoutError");
      expect((error as Error).message).toBe(BA_ROUTINE_TIMEOUT_MESSAGE);
      expect((error as Error).message).not.toContain("Day 1");
    }
  });

  it("returns a fixed malformed value that fails the real routine schema", () => {
    expect(createBaRoutineBuildFailure("malformed")).toBe(
      BA_MALFORMED_ROUTINE_BUILD_RESULT,
    );
    const parsed = routineBuildSchema.safeParse(
      BA_MALFORMED_ROUTINE_BUILD_RESULT,
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["data", "days"],
          code: "too_small",
        }),
      );
    }
    expect(Object.isFrozen(BA_MALFORMED_ROUTINE_BUILD_RESULT)).toBe(true);
    expect(Object.isFrozen(BA_MALFORMED_ROUTINE_BUILD_RESULT.data.days)).toBe(
      true,
    );
  });

  it("throws the dedicated unavailable error with a stable safe identity", () => {
    expect.assertions(5);
    try {
      createBaRoutineBuildFailure("unavailable");
    } catch (error) {
      expect(error).toBeInstanceOf(BaRoutineBuildUnavailableError);
      expect(error).toBeInstanceOf(Error);
      expect((error as BaRoutineBuildUnavailableError).name).toBe(
        "BaRoutineBuildUnavailableError",
      );
      expect((error as BaRoutineBuildUnavailableError).code).toBe(
        "ba_routine_build_unavailable",
      );
      expect((error as Error).message).toBe(BA_ROUTINE_UNAVAILABLE_MESSAGE);
    }
  });
});
