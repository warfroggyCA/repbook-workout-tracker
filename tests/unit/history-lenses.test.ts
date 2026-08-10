import { describe, expect, it } from "vitest";
import {
  buildHistoryLenses,
  type BuildHistoryLensesInput,
  type HistoryExerciseProgressEvidence,
} from "@/services/history-lenses";

function input(
  overrides: Partial<BuildHistoryLensesInput> = {},
): BuildHistoryLensesInput {
  return {
    unit: "lb",
    completedSessions: 0,
    abandonedSessions: 0,
    workingSets: 0,
    averageDurationMin: null,
    weekly: [],
    exerciseProgress: [],
    programFit: {
      completedSessions: 0,
      abandonedSessions: 0,
      unlinkedSessions: 0,
      asPlannedOccurrences: 0,
      substitutedOccurrences: 0,
      addedOccurrences: 0,
      skippedOccurrences: 0,
      unlinkedPlannedOccurrences: 0,
      skipReasons: [],
      substitutionReasons: [],
    },
    pain: {
      painEvents: 0,
      highPainEvents: 0,
      attributedPainEvents: 0,
      contexts: [],
      painSkips: [],
      discomfortSubstitutions: [],
      constraints: [],
    },
    records: [],
    ...overrides,
  };
}

function progress(
  exercise: string,
  changePercent: number | null,
  overrides: Partial<HistoryExerciseProgressEvidence> = {},
): HistoryExerciseProgressEvidence {
  return {
    exercise,
    sessions: changePercent == null ? 1 : 2,
    metric: "estimated_strength",
    metricType: "weight_reps",
    loadSemantics: "total",
    first: { weight: 100, reps: 5, estimatedStrength: 117 },
    latest: {
      weight: changePercent == null ? 100 : 110,
      reps: 5,
      estimatedStrength: changePercent == null ? 117 : 128,
    },
    changePercent,
    repChange: null,
    ...overrides,
  };
}

describe("question-driven History lenses", () => {
  it("always returns five complete, honest empty-state answers", () => {
    const lenses = buildHistoryLenses(input());

    expect(lenses.map((lens) => lens.key)).toEqual([
      "progress",
      "program-fit",
      "pain-constraints",
      "work-capacity",
      "records",
    ]);
    for (const lens of lenses) {
      expect(lens.answer.length).toBeGreaterThan(0);
      expect(lens.evidence.length).toBeGreaterThan(0);
      expect(lens.limitation.length).toBeGreaterThan(0);
      expect(lens.decision.statement.length).toBeGreaterThan(0);
      expect(lens.decision.supported).toBe(false);
    }
    const pain = lenses.find((lens) => lens.key === "pain-constraints")!;
    expect(pain.answer).toContain("No pain");
    expect(pain.answer.toLowerCase()).not.toContain("pain-free");
    expect(pain.limitation).toContain("does not mean pain-free");
  });

  it("separates clear progress, unchanged evidence, lower evidence, and uncertainty", () => {
    const lenses = buildHistoryLenses(
      input({
        completedSessions: 4,
        exerciseProgress: [
          progress("Bench Press", 10),
          progress("Row", 0),
          progress("Squat", -10),
          progress("Overhead Press", null),
        ],
      }),
    );
    const lens = lenses.find((candidate) => candidate.key === "progress")!;

    expect(lens.answer).toContain("1 exercise improved");
    expect(lens.answer).toContain("1 exercise stayed broadly stable");
    expect(lens.answer).toContain("1 exercise moved lower");
    expect(lens.answer).toContain("1 exercise remains uncertain");
    expect(lens.decision.supported).toBe(true);
    expect(lens.decision.statement).toContain("Squat");
  });

  it("uses the existing one-percent clarity boundary instead of overreading tiny changes", () => {
    for (const changePercent of [0.5, 0, -0.5]) {
      const lens = buildHistoryLenses(
        input({
          completedSessions: 2,
          exerciseProgress: [progress("Bench Press", changePercent)],
        }),
      ).find((candidate) => candidate.key === "progress")!;

      expect(lens.answer).toContain("stayed broadly stable");
      expect(lens.answer).not.toContain("improved");
      expect(lens.answer).not.toContain("moved lower");
    }
  });

  it("keeps unsupported assistance and timed observations out of progress", () => {
    const lens = buildHistoryLenses(
      input({
        completedSessions: 3,
        exerciseProgress: [
          progress("Assisted Pull-up", 12, {
            metricType: "assisted_reps",
            loadSemantics: "assistance",
          }),
          progress("Plank", 15, { metricType: "duration" }),
        ],
      }),
    ).find((candidate) => candidate.key === "progress")!;

    expect(lens.answer).toContain("uncertain");
    expect(lens.evidence.map((item) => item.label)).not.toContain(
      "Assisted Pull-up",
    );
    expect(lens.evidence.map((item) => item.label)).not.toContain("Plank");
  });

  it("reports only Program-linked states and never turns abandonment into deferral", () => {
    const lens = buildHistoryLenses(
      input({
        programFit: {
          completedSessions: 3,
          abandonedSessions: 1,
          unlinkedSessions: 2,
          asPlannedOccurrences: 8,
          substitutedOccurrences: 1,
          addedOccurrences: 1,
          skippedOccurrences: 2,
          unlinkedPlannedOccurrences: 1,
          skipReasons: [
            { reason: "pain", count: 1 },
            { reason: "time", count: 1 },
          ],
          substitutionReasons: [{ reason: "discomfort", count: 1 }],
        },
      }),
    ).find((candidate) => candidate.key === "program-fit")!;

    expect(lens.answer).toContain("3 Program workouts completed");
    expect(lens.answer).toContain("2 exercise changes");
    expect(lens.evidence.some((item) => item.value.includes("1 abandoned"))).toBe(
      true,
    );
    expect(lens.evidence.some((item) => item.label.includes("outside Program"))).toBe(
      true,
    );
    expect(lens.limitation).toContain("Deferred workouts are not recorded");
    expect(lens.limitation).toContain("not proof");
    expect(lens.answer.toLowerCase()).not.toContain("deferred");
  });

  it("attributes only explicitly linked pain and distinguishes a repeated pattern", () => {
    const lens = buildHistoryLenses(
      input({
        pain: {
          painEvents: 3,
          highPainEvents: 2,
          attributedPainEvents: 2,
          contexts: [
            {
              exercise: "Bench Press",
              bodyPart: "shoulder",
              events: 2,
              maxSeverity: 4,
            },
            {
              exercise: null,
              bodyPart: "knee",
              events: 1,
              maxSeverity: 3,
            },
          ],
          painSkips: [{ plannedExercise: "Dip", events: 1 }],
          discomfortSubstitutions: [
            {
              plannedExercise: "Overhead Press",
              actualExercise: "Landmine Press",
              events: 2,
            },
          ],
          constraints: [],
        },
      }),
    ).find((candidate) => candidate.key === "pain-constraints")!;

    expect(lens.answer).toContain("Bench Press (Shoulder)");
    expect(lens.limitation).toContain("2 of 3 positive pain reports name an exercise");
    expect(lens.evidence.map((item) => item.label)).not.toContain("Squat");
    expect(lens.evidence.some((item) => item.label === "Session-level · Knee")).toBe(
      true,
    );
    expect(lens.answer.toLowerCase()).not.toContain("caused");
  });

  it("does not call a single pain flag a repeated movement pattern", () => {
    const lens = buildHistoryLenses(
      input({
        pain: {
          painEvents: 1,
          highPainEvents: 1,
          attributedPainEvents: 1,
          contexts: [
            {
              exercise: "Squat",
              bodyPart: "knee",
              events: 1,
              maxSeverity: 4,
            },
          ],
          painSkips: [],
          discomfortSubstitutions: [],
          constraints: [],
        },
      }),
    ).find((candidate) => candidate.key === "pain-constraints")!;

    expect(lens.answer).toContain("no repeated movement pattern");
  });

  it("compares loaded workload, completed sets, and duration separately", () => {
    const weekly = Array.from({ length: 8 }, (_, index) => ({
      weekStartISO: `2026-0${index + 1}-01T00:00:00.000Z`,
      sessions: 1,
      sets: index < 4 ? 3 : 4,
      volume: index < 4 ? 1000 : 1200,
      durationMinutes: index < 4 ? 40 : 50,
      durationSessions: 1,
    }));
    const lens = buildHistoryLenses(
      input({
        completedSessions: 8,
        workingSets: 28,
        averageDurationMin: 45,
        weekly,
      }),
    ).find((candidate) => candidate.key === "work-capacity")!;

    expect(lens.answer).toContain("Loaded workload is rising");
    expect(lens.answer).toContain("completed sets are higher");
    expect(lens.answer).toContain("duration is longer");
    expect(lens.evidence.some((item) => item.value === "4,800 lb vs 4,000 lb")).toBe(
      true,
    );
    expect(lens.evidence.some((item) => item.value === "16 vs 12")).toBe(true);
    expect(lens.evidence.some((item) => item.value === "50 min vs 40 min")).toBe(
      true,
    );
    expect(lens.decision.supported).toBe(true);
  });

  it("keeps mixed capacity signals separate and withholds a decision when volume is not comparable", () => {
    const mixedWeeks = Array.from({ length: 8 }, (_, index) => ({
      weekStartISO: `2026-0${index + 1}-01T00:00:00.000Z`,
      sessions: 1,
      sets: index < 4 ? 4 : 2,
      volume: index < 4 ? 1000 : 1200,
      durationMinutes: 45,
      durationSessions: 1,
    }));
    const mixed = buildHistoryLenses(
      input({ completedSessions: 8, workingSets: 24, weekly: mixedWeeks }),
    ).find((candidate) => candidate.key === "work-capacity")!;
    expect(mixed.answer).toContain("workload is rising");
    expect(mixed.answer).toContain("sets are lower");
    expect(mixed.answer).toContain("duration is similar");

    const noPriorVolume = buildHistoryLenses(
      input({
        completedSessions: 8,
        weekly: mixedWeeks.map((week, index) => ({
          ...week,
          volume: index < 4 ? 0 : week.volume,
        })),
      }),
    ).find((candidate) => candidate.key === "work-capacity")!;
    expect(noPriorVolume.answer).toContain("Not enough comparable");
    expect(noPriorVolume.decision.supported).toBe(false);
  });

  it("compares equal halves and does not call a seven-week window eight weeks", () => {
    const sevenEqualWeeks = Array.from({ length: 7 }, (_, index) => ({
      weekStartISO: `2026-0${index + 1}-01T00:00:00.000Z`,
      sessions: 1,
      sets: 3,
      volume: 1000,
      durationMinutes: 45,
      durationSessions: 1,
    }));
    const lens = buildHistoryLenses(
      input({
        completedSessions: 7,
        workingSets: 21,
        averageDurationMin: 45,
        weekly: sevenEqualWeeks,
      }),
    ).find((candidate) => candidate.key === "work-capacity")!;

    expect(lens.answer).toContain("Loaded workload is steady");
    expect(lens.answer).toContain("available 6-week comparison");
    expect(lens.answer).not.toContain("rising");
    expect(lens.evidence).toContainEqual(
      expect.objectContaining({ value: "3,000 lb vs 3,000 lb" }),
    );
    expect(lens.evidence.map((item) => item.detail).join(" ")).not.toContain(
      "eight-week",
    );
  });

  it("labels records as selected-period observations and supports no decision", () => {
    const lens = buildHistoryLenses(
      input({
        records: [
          {
            exercise: "Bench Press",
            sessions: 3,
            localDate: "2026-07-10",
            metric: "estimated_strength",
            weight: 100,
            reps: 10,
            estimatedStrength: 133,
          },
        ],
      }),
    ).find((candidate) => candidate.key === "records")!;

    expect(lens.answer).toContain(
      "1 exact exercise variant",
    );
    expect(lens.evidence[0]).toMatchObject({
      label: "Bench Press",
      value: "100 lb × 10",
    });
    expect(lens.limitation).toContain("selected period");
    expect(lens.limitation).toContain("not durable all-time PR records");
    expect(lens.decision.supported).toBe(false);
  });

  it("states the bounded Records display count without calling one-off variants frequent", () => {
    const records = Array.from({ length: 8 }, (_, index) => ({
      exercise: `Exercise ${index + 1}`,
      sessions: 1,
      localDate: "2026-07-10",
      metric: "estimated_strength" as const,
      weight: 100 + index,
      reps: 5,
      estimatedStrength: 117 + index,
    }));
    const lens = buildHistoryLenses(input({ records })).find(
      (candidate) => candidate.key === "records",
    )!;

    expect(lens.evidence).toHaveLength(5);
    expect(lens.answer).toContain("5 exact exercise variants");
    expect(lens.answer).toContain("selected from 8 eligible variants");
    expect(lens.answer).not.toContain("frequently recorded");
  });
});
