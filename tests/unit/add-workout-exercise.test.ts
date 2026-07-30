import { describe, expect, it } from "vitest";
import {
  addWorkoutExerciseInputSchema,
  clearAddWorkoutExerciseDraft,
  readAddWorkoutExerciseDraft,
  writeAddWorkoutExerciseDraft,
} from "@/lib/add-workout-exercise";

function storageDouble() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    values,
  };
}

describe("active-workout exercise addition draft", () => {
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const input = {
    sessionId,
    exerciseId: "33333333-3333-4333-8333-333333333333",
    mutationId: "44444444-4444-4444-8444-444444444444",
    expectedSessionRevision: 7,
    initialSetCount: 2,
    insertion: "end" as const,
  };

  it("preserves one stable reviewed identity for reload and retry", () => {
    const storage = storageDouble();
    writeAddWorkoutExerciseDraft(storage, ownerId, input, 1_000);

    expect(
      readAddWorkoutExerciseDraft(storage, ownerId, sessionId, 2_000),
    ).toEqual({
      version: 1,
      ownerId,
      savedAt: 1_000,
      input,
    });
    clearAddWorkoutExerciseDraft(storage, ownerId, sessionId);
    expect(
      readAddWorkoutExerciseDraft(storage, ownerId, sessionId, 2_000),
    ).toBeNull();
  });

  it("removes malformed, wrong-owner, and expired device drafts", () => {
    const malformed = storageDouble();
    malformed.setItem(
      `workout-tracker:add-exercise:v1:${ownerId}:${sessionId}`,
      "{",
    );
    expect(
      readAddWorkoutExerciseDraft(malformed, ownerId, sessionId),
    ).toBeNull();
    expect(malformed.values.size).toBe(0);

    const expired = storageDouble();
    writeAddWorkoutExerciseDraft(expired, ownerId, input, 1_000);
    expect(
      readAddWorkoutExerciseDraft(
        expired,
        ownerId,
        sessionId,
        8 * 24 * 60 * 60 * 1000,
      ),
    ).toBeNull();
    expect(expired.values.size).toBe(0);
  });

  it("rejects unbounded set counts and unsupported insertion modes", () => {
    expect(() =>
      addWorkoutExerciseInputSchema.parse({
        ...input,
        initialSetCount: 11,
      }),
    ).toThrow();
    expect(() =>
      addWorkoutExerciseInputSchema.parse({
        ...input,
        insertion: "before",
      }),
    ).toThrow();
  });
});
