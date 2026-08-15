import { describe, expect, it } from "vitest";
import {
  ACTIVE_WORKOUT_LANGUAGE,
  EFFORT_CHOICES,
} from "@/lib/active-workout-language";
import {
  ACTIVE_WORKOUT_MEASUREMENT_LIMIT,
  clearActiveWorkoutMeasurements,
  parseActiveWorkoutMeasurements,
  readActiveWorkoutMeasurements,
  writeActiveWorkoutMeasurement,
} from "@/lib/active-workout-measurements";
import { ACTIVE_WORKOUT_ACCEPTANCE_FIXTURES } from "../fixtures/active-workout-acceptance";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("active workout foundation", () => {
  it("defines the milestone vocabulary and honest effort anchors", () => {
    expect(Object.keys(ACTIVE_WORKOUT_LANGUAGE)).toEqual([
      "nextSet",
      "primaryAction",
      "adjustment",
      "saved",
      "pending",
      "retrying",
      "failed",
      "effortCategory",
      "exactEffort",
    ]);
    expect(EFFORT_CHOICES.map(({ label, meaning }) => [label, meaning])).toEqual([
      ["Easy", "about 4+ reps in reserve"],
      ["OK", "about 3 reps in reserve"],
      ["Hard", "about 1–2 reps in reserve"],
      ["Grind", "0 reps in reserve or visible slowing"],
    ]);
    expect(EFFORT_CHOICES.map(({ label, legacyRpe }) => [label, legacyRpe])).toEqual([
      ["Easy", 6],
      ["OK", 7],
      ["Hard", 8],
      ["Grind", 9.5],
    ]);
  });

  it("keeps device-only measurements bounded, inspectable, and clearable", () => {
    const storage = memoryStorage();
    const now = new Date();
    for (let index = 0; index < ACTIVE_WORKOUT_MEASUREMENT_LIMIT + 5; index += 1) {
      writeActiveWorkoutMeasurement(
        {
          version: 1,
          clientKey: `fixture-${index}`,
          setId: `set-${index}`,
          readyAtISO: now.toISOString(),
          submittedAtISO: now.toISOString(),
          acknowledgedAtISO: now.toISOString(),
          durationMs: index,
          taps: 1,
          focusChanges: 1,
          corrections: 0,
          outcome: "saved",
        },
        storage
      );
    }
    expect(readActiveWorkoutMeasurements(storage)).toHaveLength(
      ACTIVE_WORKOUT_MEASUREMENT_LIMIT
    );
    expect(readActiveWorkoutMeasurements(storage)[0]?.clientKey).toBe("fixture-5");
    clearActiveWorkoutMeasurements(storage);
    expect(readActiveWorkoutMeasurements(storage)).toEqual([]);
  });

  it("drops expired, malformed, and free-form-shaped records", () => {
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    const raw = JSON.stringify({
      version: 1,
      records: [
        {
          version: 1,
          clientKey: "old",
          setId: null,
          readyAtISO: "2026-01-01T00:00:00.000Z",
          submittedAtISO: "2026-01-01T00:00:00.000Z",
          acknowledgedAtISO: null,
          durationMs: null,
          taps: 0,
          focusChanges: 0,
          corrections: 0,
          outcome: "delayed",
        },
        { version: 1, clientKey: "contains-note", note: "must not be accepted" },
      ],
    });
    expect(parseActiveWorkoutMeasurements(raw, now)).toEqual([]);
  });

  it("covers the milestone acceptance situations without personal content", () => {
    expect(ACTIVE_WORKOUT_ACCEPTANCE_FIXTURES.map((fixture) => fixture.id)).toEqual(
      expect.arrayContaining([
        "normal-workout",
        "superset",
        "slow-save",
        "failing-save",
        "offline-reconnect",
        "exercise-adjustment",
        "narrow-enlarged-text",
      ])
    );
    expect(
      ACTIVE_WORKOUT_ACCEPTANCE_FIXTURES.every((fixture) =>
        fixture.exerciseNames.every((name) => name.startsWith("Fixture "))
      )
    ).toBe(true);
  });
});
