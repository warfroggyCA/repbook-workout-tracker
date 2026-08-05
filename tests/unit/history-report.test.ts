import { describe, expect, it } from "vitest";
import {
  buildHistoryCalendarActivities,
  historyRangeStart,
  parseHistoryRange,
  summarizeHistory,
  type HistorySessionInput,
} from "@/services/history-report";

const now = new Date("2026-04-01T12:00:00.000Z");

function session(
  overrides: Partial<HistorySessionInput> & Pick<HistorySessionInput, "id">
): HistorySessionInput {
  const { id, startedAt = new Date("2026-03-10T12:00:00.000Z"), ...rest } = overrides;
  const built: HistorySessionInput = {
    id,
    templateName: "Day A",
    status: "completed",
    startedAt,
    timezone: "America/Toronto",
    localDate: startedAt.toISOString().slice(0, 10),
    finishedAt: new Date("2026-03-10T13:00:00.000Z"),
    exercises: [],
    occurrences: [],
    painLogs: [],
    ...rest,
  };
  if (overrides.occurrences == null) {
    built.occurrences = built.exercises.flatMap((exercise) =>
      exercise.sets
        .filter((set) => !set.isWarmup)
        .map((set) => ({
          kind: "working_set" as const,
          origin: "planned" as const,
          outcome: "completed" as const,
          completedSetId: set.id,
          plannedRepsMin:
            set.targetMet == null || set.reps == null
              ? null
              : set.targetMet
                ? set.reps
                : set.reps + 1,
          plannedRepsMax: set.reps,
          plannedLoad: set.weight,
          plannedLoadUnit: set.weightUnit,
        })),
    );
  }
  return built;
}

function benchExercise(
  sets: Array<
    Omit<HistorySessionInput["exercises"][number]["sets"][number], "id"> & {
      id?: string;
    }
  >,
) {
  return {
    modificationType: "as_planned" as const,
    skipReason: null,
    exercise: {
      id: "bench",
      name: "Barbell Bench Press",
      loadType: "barbell",
      metricType: "weight_reps" as const,
      loadSemantics: "total",
      primaryMuscles: ["chest", "triceps"],
    },
    sets: sets.map((set, index) => ({
      ...set,
      id: set.id ?? `bench-set-${index + 1}`,
      metricType: set.metricType ?? "weight_reps",
      loadEntryMeaning: set.loadEntryMeaning ?? "total_system",
    })),
  };
}

describe("history report ranges", () => {
  it("defaults invalid ranges and calculates a stable start date", () => {
    expect(parseHistoryRange(undefined)).toBe("12w");
    expect(parseHistoryRange("nonsense")).toBe("12w");
    expect(parseHistoryRange("4w")).toBe("4w");
    expect(historyRangeStart("4w", now)?.toISOString()).toBe(
      "2026-03-04T12:00:00.000Z"
    );
    expect(historyRangeStart("all", now)).toBeNull();
  });
});

describe("independent activity calendar records", () => {
  it("keeps activity measurements separate from workout metrics", () => {
    const records = buildHistoryCalendarActivities([
      {
        id: "walk-1",
        activityType: "walk",
        title: "Power walk",
        startedAt: new Date("2026-03-31T01:00:00.000Z"),
        timezone: "America/Toronto",
        durationSeconds: 2520,
        distanceKm: 3.5,
        averagePaceSecondsPerKm: 720,
        intensity: "moderate",
        elevationGainM: null,
        averageHeartRateBpm: 116,
        energyKcal: null,
        source: "manual",
      },
    ]);

    expect(records[0]).toMatchObject({
      recordType: "activity",
      name: "Power walk",
      durationMin: 42,
      distanceKm: 3.5,
      calendarDateKey: "2026-03-30",
      timezone: "America/Toronto",
    });
    expect("sets" in records[0]).toBe(false);
    expect("volume" in records[0]).toBe(false);
  });
});

describe("summarizeHistory", () => {
  it("preserves unusually long workouts but excludes their duration from insights", () => {
    const report = summarizeHistory(
      [
        session({
          id: "normal",
          startedAt: new Date("2026-03-10T12:00:00.000Z"),
          finishedAt: new Date("2026-03-10T13:00:00.000Z"),
        }),
        session({
          id: "left-open",
          startedAt: new Date("2026-03-11T12:00:00.000Z"),
          finishedAt: new Date("2026-03-13T15:46:00.000Z"),
        }),
      ],
      [],
      3,
      historyRangeStart("4w", now),
      now,
    );

    expect(report.overview.averageDurationMin).toBe(60);
    expect(report.overview.excludedDurationSessions).toBe(1);
    expect(
      report.calendarSessions.find((entry) => entry.id === "left-open"),
    ).toMatchObject({
      durationMin: null,
      durationExcluded: true,
    });
  });

  it("builds workload, progress, recovery, and plan insights from logged data", () => {
    const sessions: HistorySessionInput[] = [
      session({
        id: "first",
        startedAt: new Date("2026-03-10T12:00:00.000Z"),
        finishedAt: new Date("2026-03-10T13:00:00.000Z"),
        exercises: [
          benchExercise([
            {
              weight: 100,
              weightUnit: "lb",
              reps: 10,
              rpe: 7,
              isWarmup: false,
              targetMet: true,
            },
            {
              weight: 100,
              weightUnit: "lb",
              reps: 8,
              rpe: 8,
              isWarmup: false,
              targetMet: false,
            },
          ]),
        ],
      }),
      session({
        id: "second",
        startedAt: new Date("2026-03-24T12:00:00.000Z"),
        finishedAt: new Date("2026-03-24T12:40:00.000Z"),
        exercises: [
          benchExercise([
            {
              weight: 110,
              weightUnit: "lb",
              reps: 10,
              rpe: 8,
              isWarmup: false,
              targetMet: true,
            },
            {
              weight: 110,
              weightUnit: "lb",
              reps: 8,
              rpe: null,
              isWarmup: false,
              targetMet: true,
            },
          ]),
        ],
        painLogs: [{ severity: 5 }],
      }),
      session({
        id: "abandoned",
        status: "abandoned",
        startedAt: new Date("2026-03-28T12:00:00.000Z"),
        finishedAt: new Date("2026-03-28T12:10:00.000Z"),
      }),
    ];

    const report = summarizeHistory(
      sessions,
      [{ severity: 3 }, { severity: 4 }],
      1,
      historyRangeStart("4w", now),
      now
    );

    expect(report.overview).toMatchObject({
      completedSessions: 2,
      abandonedSessions: 1,
      workingSets: 4,
      totalReps: 36,
      loadedVolume: 3780,
      averageDurationMin: 50,
      targetHitRate: 75,
      averageRpe: 7.7,
    });
    expect(report.cadence).toMatchObject({
      completedSessions: 2,
      completeWeeks: 3,
      averageSessionsPerCompleteWeek: 0.67,
      medianGapDays: 14,
    });
    expect(report.overview.targetOutcomes).toMatchObject({
      below: 1,
      at: 3,
      above: 0,
      unknown: 0,
      atOrAboveRate: 75,
    });
    expect(report.muscles[0]).toEqual({
      muscle: "chest",
      sets: 4,
      share: 100,
    });
    expect(report.exerciseProgress[0]).toMatchObject({
      exerciseId: "bench",
      exercise: "Barbell Bench Press",
      sessions: 2,
      sets: 4,
      changePercent: 10,
      first: { sourceSessionId: "first" },
      latest: { sourceSessionId: "second" },
    });
    expect(report.records[0]).toMatchObject({
      exerciseId: "bench",
      sourceSessionId: "second",
      exercise: "Barbell Bench Press",
    });
    expect(report.families[0]).toMatchObject({
      familyKey: "exercise:bench",
      family: "Barbell Bench Press",
    });
    expect(report.recovery).toMatchObject({
      averageFatigue: 3.5,
      painEvents: 1,
      highPainEvents: 1,
    });
    expect(report.insights.some((insight) => insight.title === "Pain flags deserve attention")).toBe(true);
    expect(report.recentSessions[0].id).toBe("abandoned");
    expect(report.calendarSessions.map((entry) => entry.id)).toEqual([
      "abandoned",
      "second",
      "first",
    ]);
  });

  it("states when the selected period has no completed workouts", () => {
    const report = summarizeHistory([], [], 3, historyRangeStart("4w", now), now);
    expect(report.overview.completedSessions).toBe(0);
    expect(report.insights[0].title).toBe("No completed workouts in this period");
  });

  it("converts kilogram sets to pounds before summing volume", () => {
    const report = summarizeHistory(
      [
        session({
          id: "kg",
          exercises: [
            benchExercise([
              {
                weight: 100,
                weightUnit: "kg",
                reps: 10,
                rpe: null,
                isWarmup: false,
                targetMet: null,
              },
              {
                weight: 100,
                weightUnit: "lb",
                reps: 10,
                rpe: null,
                isWarmup: false,
                targetMet: null,
              },
            ]),
          ],
        }),
      ],
      [],
      3,
      historyRangeStart("4w", now),
      now
    );
    // 100 kg × 10 = 2,204.6 lb plus 100 lb × 10 = 1,000 lb.
    expect(report.overview.loadedVolume).toBe(3205);
  });

  it("keeps pure-summary records aligned with supported SQL record semantics", () => {
    const report = summarizeHistory(
      [
        session({
          id: "records",
          exercises: [
            benchExercise([
              {
                weight: 100,
                weightUnit: "lb",
                reps: 10,
                rpe: null,
                isWarmup: false,
                targetMet: null,
              },
              {
                weight: 110,
                weightUnit: "lb",
                reps: 5,
                rpe: null,
                isWarmup: false,
                targetMet: null,
              },
              {
                weight: 500,
                weightUnit: "lb",
                reps: 10,
                rpe: null,
                isWarmup: false,
                targetMet: null,
                excludeFromAnalytics: true,
              },
              {
                weight: 1000,
                weightUnit: "lb",
                reps: 1,
                rpe: null,
                isWarmup: true,
                targetMet: null,
              },
            ]),
            {
              modificationType: "as_planned",
              skipReason: null,
              exercise: {
                id: "assisted",
                name: "Assisted Pull-up",
                loadType: "machine",
                metricType: "assisted_reps",
                loadSemantics: "assistance",
                primaryMuscles: ["back"],
              },
              sets: [
                {
                  id: "assisted-set",
                  weight: 150,
                  weightUnit: "lb",
                  reps: 10,
                  metricType: "assisted_reps",
                  rpe: null,
                  isWarmup: false,
                  targetMet: null,
                },
              ],
            },
            {
              modificationType: "as_planned",
              skipReason: null,
              exercise: {
                id: "plank",
                name: "Plank",
                loadType: "bodyweight",
                metricType: "duration",
                loadSemantics: "none",
                primaryMuscles: ["core"],
              },
              sets: [
                {
                  id: "plank-set",
                  weight: null,
                  reps: 999,
                  metricType: "duration",
                  durationSeconds: 60,
                  rpe: null,
                  isWarmup: false,
                  targetMet: null,
                },
              ],
            },
            {
              modificationType: "as_planned",
              skipReason: null,
              exercise: {
                id: "band-row",
                name: "Band Row",
                loadType: "external",
                metricType: "weight_reps",
                loadSemantics: "resistance_band",
                primaryMuscles: ["back"],
              },
              sets: [
                {
                  id: "band-row-set",
                  weight: null,
                  reps: 20,
                  metricType: "reps",
                  performedSemanticsVersion: 1,
                  performedLoadType: "external",
                  performedLoadSemantics: "resistance_band",
                  rpe: null,
                  isWarmup: false,
                  targetMet: true,
                },
              ],
            },
          ],
        }),
      ],
      [],
      3,
      historyRangeStart("4w", now),
      now,
    );

    const records = report.lenses.find((lens) => lens.key === "records")!;
    expect(records.evidence[0]).toMatchObject({
      label: "Barbell Bench Press",
      value: "100 lb × 10",
    });
    expect(report.records[0]).toMatchObject({
      exerciseId: "bench",
      sourceSessionId: "records",
      exercise: "Barbell Bench Press",
    });
    expect(records.evidence.map((item) => item.label)).not.toContain(
      "Assisted Pull-up",
    );
    expect(records.evidence.map((item) => item.label)).not.toContain("Plank");
    expect(records.evidence.map((item) => item.label)).not.toContain("Band Row");
    expect(report.overview.loadedVolume).toBe(1550);
    expect(
      report.exerciseProgress.find(
        (exercise) => exercise.exercise === "Assisted Pull-up",
      ),
    ).toMatchObject({
      first: { weight: 150, reps: 10, estimatedStrength: null },
      latest: { weight: 150, reps: 10, estimatedStrength: null },
      changePercent: null,
      exclusionReason: "assistance_not_comparable",
      volume: 0,
    });
    expect(report.overview.semanticExclusions).toContainEqual({
      reason: "assistance_not_comparable",
      count: 1,
    });
    expect(report.overview.semanticExclusions).toContainEqual({
      reason: "band_resistance_not_numeric",
      count: 1,
    });
  });

  it("keeps increasing assistance raw while suppressing every positive load claim", () => {
    const assistedExercise = (weight: number) => ({
      modificationType: "as_planned" as const,
      skipReason: null,
      exercise: {
        id: "assisted",
        name: "Assisted Pull-up",
        loadType: "machine",
        metricType: "assisted_reps" as const,
        loadSemantics: "assistance",
        primaryMuscles: ["back"],
      },
      sets: [
        {
          id: `assisted-set-${weight}`,
          weight,
          weightUnit: "lb" as const,
          loadEntryMeaning: "displayed_stack" as const,
          reps: 10,
          metricType: "assisted_reps" as const,
          rpe: null,
          isWarmup: false,
          targetMet: true,
        },
      ],
    });
    const report = summarizeHistory(
      [
        session({
          id: "assisted-first",
          startedAt: new Date("2026-03-10T12:00:00.000Z"),
          exercises: [assistedExercise(100)],
        }),
        session({
          id: "assisted-latest",
          startedAt: new Date("2026-03-24T12:00:00.000Z"),
          exercises: [assistedExercise(150)],
        }),
      ],
      [],
      2,
      historyRangeStart("4w", now),
      now,
    );

    expect(report.overview).toMatchObject({
      loadedVolume: 0,
      targetHitRate: null,
      semanticExclusions: [
        { reason: "assistance_not_comparable", count: 2 },
      ],
    });
    expect(report.records).toEqual([]);
    expect(report.exerciseProgress).toEqual([
      expect.objectContaining({
        first: expect.objectContaining({
          weight: 100,
          reps: 10,
          estimatedStrength: null,
        }),
        latest: expect.objectContaining({
          weight: 150,
          reps: 10,
          estimatedStrength: null,
        }),
        changePercent: null,
        exclusionReason: "assistance_not_comparable",
        volume: 0,
      }),
    ]);
    expect(
      report.insights.some((insight) =>
        insight.title.includes("clearest progression"),
      ),
    ).toBe(false);
  });
});
