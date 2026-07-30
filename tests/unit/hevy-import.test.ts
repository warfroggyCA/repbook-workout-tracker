import { describe, expect, it } from "vitest";
import {
  HEVY_HEADERS,
  HEVY_MAX_ROWS,
  isSuspiciousSetDuration,
  parseHevyCsv,
  parseHevyLocalDate,
} from "@/services/hevy-import";

function csvRow(values: Array<string | number | null>) {
  return values
    .map((value) => {
      const text = value == null ? "" : String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    })
    .join(",");
}

function fixture() {
  const rows = [
    ["Strength A", "Jun 1, 2026, 6:00 PM", "Jun 1, 2026, 7:00 PM", "Good session", "Bench Press (Barbell)", "", "Pause", 0, "warmup", 45, 10, "", "", ""],
    ["Strength A", "Jun 1, 2026, 6:00 PM", "Jun 1, 2026, 7:00 PM", "Good session", "Bench Press (Barbell)", "", "Pause", 0, "normal", 135, 8, "", "", 8],
    ["Strength A", "Jun 1, 2026, 6:00 PM", "Jun 1, 2026, 7:00 PM", "Good session", "Bench Press (Dumbbell)", "", "Per dumbbell", 0, "normal", 50, 10, "", "", 8],
    ["Strength A", "Jun 1, 2026, 6:00 PM", "Jun 1, 2026, 7:00 PM", "Good session", "Cable Curl", "pair-a", "", 0, "normal", 40, 12, "", "", ""],
    ["Strength A", "Jun 1, 2026, 6:00 PM", "Jun 1, 2026, 7:00 PM", "Good session", "Cable Pushdown", "pair-a", "", 0, "normal", 50, 12, "", "", ""],
    ["Conditioning", "Jun 3, 2026, 7:00 AM", "Jun 3, 2026, 9:00 AM", "", "Elliptical", "", "", 0, "normal", "", "", "", 7200, ""],
  ];
  return [HEVY_HEADERS.join(","), ...rows.map(csvRow)].join("\n");
}

function validRow(overrides: Partial<Record<(typeof HEVY_HEADERS)[number], string | number>> = {}) {
  const row: Record<(typeof HEVY_HEADERS)[number], string | number> = {
    title: "Limits workout",
    start_time: "Jun 1, 2026, 6:00 PM",
    end_time: "Jun 1, 2026, 7:00 PM",
    description: "",
    exercise_title: "Bench Press (Barbell)",
    superset_id: "",
    exercise_notes: "",
    set_index: 0,
    set_type: "normal",
    weight_lbs: 135,
    reps: 8,
    distance_km: "",
    duration_seconds: "",
    rpe: 8,
    ...overrides,
  };
  return HEVY_HEADERS.map((header) => row[header]);
}

describe("Hevy CSV import parser", () => {
  it("profiles and preserves ordered variants, warm-ups, supersets, and timed work", () => {
    const parsed = parseHevyCsv(fixture(), "America/Toronto");
    expect(parsed.profile).toMatchObject({
      workouts: 2,
      exerciseOccurrences: 5,
      sets: 6,
      warmupSets: 1,
      normalSets: 5,
      supersetGroups: 1,
      distinctExercises: 5,
    });
    expect(parsed.exercises.map((item) => item.rawName)).toContain("Bench Press (Barbell)");
    expect(parsed.exercises.map((item) => item.rawName)).toContain("Bench Press (Dumbbell)");

    const strength = parsed.workouts.find((workout) => workout.title === "Strength A")!;
    expect(strength.occurrences.map((item) => item.rawName)).toEqual([
      "Bench Press (Barbell)",
      "Bench Press (Dumbbell)",
      "Cable Curl",
      "Cable Pushdown",
    ]);
    expect(strength.occurrences[0].rows.map((row) => row.setIndex)).toEqual([0, 0]);
    expect(strength.occurrences[0].rows.map((row) => row.setType)).toEqual(["warmup", "normal"]);

    const elliptical = parsed.workouts.find((workout) => workout.title === "Conditioning")!
      .occurrences[0].rows[0];
    expect(elliptical.reps).toBeNull();
    expect(elliptical.weightLbs).toBeNull();
    expect(elliptical.durationSeconds).toBe(7200);
    expect(elliptical.metricType).toBe("duration");
    // A two-hour timed set inside a two-hour workout is genuine steady-state
    // cardio, not suspect data.
    expect(parsed.profile.warnings).toEqual([]);
  });

  it("only flags durations that exceed the workout or claim long rep-based sets", () => {
    const rows = [
      ["Mixed", "Jun 5, 2026, 6:00 PM", "Jun 5, 2026, 7:00 PM", "", "Plank", "", "", 0, "normal", "", "", "", 900, ""],
      ["Mixed", "Jun 5, 2026, 6:00 PM", "Jun 5, 2026, 7:00 PM", "", "Bench Press (Barbell)", "", "", 0, "normal", 135, 8, "", 1200, ""],
      ["Mixed", "Jun 5, 2026, 6:00 PM", "Jun 5, 2026, 7:00 PM", "", "Elliptical", "", "", 0, "normal", "", "", "", 3900, ""],
    ];
    const csv = [HEVY_HEADERS.join(","), ...rows.map(csvRow)].join("\n");
    const parsed = parseHevyCsv(csv, "America/Toronto");
    expect(parsed.profile.warnings).toEqual([
      expect.objectContaining({ code: "set_duration_over_10m", sourceRow: 3 }),
      expect.objectContaining({ code: "set_duration_exceeds_workout", sourceRow: 4 }),
    ]);
  });

  it("classifies suspicious set durations by metric type and workout length", () => {
    const workoutSeconds = 3600;
    expect(
      isSuspiciousSetDuration({ durationSeconds: null, metricType: "weight_reps", workoutSeconds })
    ).toBe(false);
    // Timed work may run long without being suspect.
    expect(
      isSuspiciousSetDuration({ durationSeconds: 1800, metricType: "duration", workoutSeconds })
    ).toBe(false);
    expect(
      isSuspiciousSetDuration({ durationSeconds: 1800, metricType: "distance_duration", workoutSeconds })
    ).toBe(false);
    // A rep-based set claiming more than ten minutes is not believable.
    expect(
      isSuspiciousSetDuration({ durationSeconds: 1200, metricType: "weight_reps", workoutSeconds })
    ).toBe(true);
    // Nothing may exceed its own workout.
    expect(
      isSuspiciousSetDuration({ durationSeconds: 4000, metricType: "duration", workoutSeconds })
    ).toBe(true);
  });

  it("interprets Hevy wall-clock dates in the selected timezone, including DST", () => {
    expect(parseHevyLocalDate("Jul 1, 2026, 6:00 PM", "America/Toronto").toISOString()).toBe(
      "2026-07-01T22:00:00.000Z"
    );
    expect(parseHevyLocalDate("Jan 1, 2026, 6:00 PM", "America/Toronto").toISOString()).toBe(
      "2026-01-01T23:00:00.000Z"
    );
  });

  it("requires the exact ordered Hevy header contract", () => {
    const reordered = [...HEVY_HEADERS];
    [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
    expect(() =>
      parseHevyCsv(
        [reordered.join(","), csvRow(validRow())].join("\n"),
        "America/Toronto"
      )
    ).toThrow("headers must be exactly");
    expect(() =>
      parseHevyCsv(
        [HEVY_HEADERS.slice(0, -1).join(","), csvRow(validRow().slice(0, -1))].join("\n"),
        "America/Toronto"
      )
    ).toThrow("headers must be exactly");
    expect(() =>
      parseHevyCsv(
        [[...HEVY_HEADERS, "unexpected"].join(","), csvRow([...validRow(), "x"])].join("\n"),
        "America/Toronto"
      )
    ).toThrow("headers must be exactly");
  });

  it("rejects oversized records, row counts, fields, dates, and numeric values", () => {
    expect(() =>
      parseHevyCsv(
        [HEVY_HEADERS.join(","), csvRow(validRow({ title: "x".repeat(201) }))].join("\n"),
        "America/Toronto"
      )
    ).toThrow("title exceeds the 200-character limit");
    expect(() =>
      parseHevyCsv(
        [HEVY_HEADERS.join(","), csvRow(validRow({ weight_lbs: 10_001 }))].join("\n"),
        "America/Toronto"
      )
    ).toThrow("weight_lbs exceeds 10000");
    expect(() =>
      parseHevyCsv(
        [HEVY_HEADERS.join(","), csvRow(validRow({ start_time: "Feb 30, 2026, 6:00 PM" }))].join("\n"),
        "America/Toronto"
      )
    ).toThrow("Unsupported Hevy date");
    expect(() =>
      parseHevyCsv(
        [
          HEVY_HEADERS.join(","),
          ...Array.from({ length: HEVY_MAX_ROWS + 1 }, (_, index) =>
            csvRow(validRow({ set_index: index }))
          ),
        ].join("\n"),
        "America/Toronto"
      )
    ).toThrow(`${HEVY_MAX_ROWS}-row limit`);
  });

  it("rejects invalid timezones before accepting wall-clock dates", () => {
    expect(() =>
      parseHevyCsv(
        [HEVY_HEADERS.join(","), csvRow(validRow())].join("\n"),
        "Not/A_Timezone"
      )
    ).toThrow();
  });
});
