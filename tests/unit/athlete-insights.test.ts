import { describe, expect, it } from "vitest";
import {
  athleteInsightFingerprint,
  buildAthleteInsightCoachDraft,
  buildMatchRecentBestInsight,
  buildPendingDecisionInsight,
  buildPostWorkoutSessionResultInsight,
  buildUsualRestInsight,
  selectAthleteInsight,
  type AthleteInsightCandidate,
  type ExactComparableWorkoutEvidence,
} from "@/lib/athlete-insights";

function previous(
  overrides: Partial<ExactComparableWorkoutEvidence> = {},
): ExactComparableWorkoutEvidence {
  return {
    exerciseId: "exercise-press",
    semantics: {
      version: 1,
      metricType: "weight_reps",
      loadType: "barbell",
      loadSemantics: "total",
      loadEntryMeaning: "total_system",
    },
    source: {
      workoutId: "workout-prior",
      localDate: "2026-08-20",
      historyHref: "/history/workout-prior",
      workoutSource: "tracker",
    },
    sets: [
      {
        setId: "prior-set-1",
        weight: 135,
        weightUnit: "lb",
        reps: 8,
        observedCompletionQuality: "trustworthy",
        correctionProvenance: { state: "original", count: 0 },
      },
      {
        setId: "prior-set-2",
        weight: 135,
        weightUnit: "lb",
        reps: 7,
        observedCompletionQuality: "trustworthy",
        correctionProvenance: { state: "original", count: 0 },
      },
    ],
    ...overrides,
  };
}

function candidate(
  overrides: Partial<AthleteInsightCandidate> = {},
): AthleteInsightCandidate {
  return {
    fingerprint: "candidate-a",
    kind: "pending_decision",
    placement: "today",
    headline: "Review one decision",
    detail: null,
    action: null,
    evidence: {
      exactExerciseId: null,
      sourceRecordIds: ["record-a"],
      comparisonWindow: "Retained evidence",
      unit: null,
      limitations: [],
    },
    strength: "supported",
    priority: 10,
    ...overrides,
  };
}

describe("athlete insight contract", () => {
  it("builds an order-independent fingerprint and selects one stable winner", () => {
    const left = athleteInsightFingerprint({
      kind: "pending_decision",
      placement: "today",
      exactExerciseId: "exercise-a",
      sourceRecordIds: ["set-b", "set-a", "set-a"],
    });
    const right = athleteInsightFingerprint({
      kind: "pending_decision",
      placement: "today",
      exactExerciseId: "exercise-a",
      sourceRecordIds: ["set-a", "set-b"],
    });
    expect(left).toBe(right);

    const selected = selectAthleteInsight(
      [
        candidate(),
        candidate({ fingerprint: "candidate-b", priority: 90 }),
        candidate({
          fingerprint: "candidate-c",
          placement: "active_set",
          priority: 100,
        }),
      ],
      { placement: "today" },
    );
    expect(selected?.fingerprint).toBe("candidate-b");
    expect(
      selectAthleteInsight([selected], {
        placement: "today",
        seenFingerprints: new Set(["candidate-b"]),
      }),
    ).toBeNull();
  });

  it("surfaces only eligibility-checked supported pending decisions", () => {
    const progression = buildPendingDecisionInsight({
      id: "recommendation-load",
      ruleId: "double_progression",
      exerciseId: "exercise-press",
      exerciseName: "Bench press",
      reason: "All retained working sets met the range.",
      payload: {
        kind: "load_change",
        fromLoad: 135,
        toLoad: 140,
        loadUnit: "lb",
      },
      evidence: {
        sessionIds: ["workout-a", "workout-b"],
        setIds: ["set-a", "set-b"],
        review: {
          schemaVersion: "review-evidence-v1",
          quality: "supported",
          limitations: [],
        },
      },
    });
    expect(progression).toMatchObject({
      kind: "progression_ready",
      placement: "today",
      headline: "A progression for Bench press is ready to review",
      action: {
        href: "/coach#recommendation-recommendation-load",
      },
      strength: "high",
    });
    expect(progression?.detail).toContain("your Program is unchanged");

    expect(
      buildPendingDecisionInsight({
        id: "recommendation-unsupported",
        ruleId: null,
        exerciseId: null,
        reason: "Unverified proposal",
        payload: { kind: "external_review" },
        evidence: {
          review: {
            schemaVersion: "review-evidence-v1",
            quality: "unverified_external",
          },
        },
      }),
    ).toBeNull();
  });

  it("matches a saved set only against the same exact load, unit, and exercise evidence", () => {
    const insight = buildMatchRecentBestInsight({
      exerciseId: "exercise-press",
      exerciseName: "Bench press",
      currentSets: [
        {
          setId: "current-set",
          metricType: "weight_reps",
          weight: 135,
          weightUnit: "lb",
          reps: 8,
          saveState: "saved",
        },
      ],
      previous: previous(),
    });
    expect(insight).toMatchObject({
      kind: "match_recent_best",
      placement: "active_set",
      headline: "Matched your recent Bench press best: 135 lb × 8",
      action: { label: "Explain", href: "#live-coach" },
    });
    expect(insight?.evidence.sourceRecordIds).toEqual([
      "current-set",
      "prior-set-1",
      "workout-prior",
    ]);

    for (const currentSets of [
      [
        {
          setId: "mixed-unit",
          metricType: "weight_reps" as const,
          weight: 135,
          weightUnit: "kg" as const,
          reps: 8,
          saveState: "saved" as const,
        },
      ],
      [
        {
          setId: "pain-set",
          metricType: "weight_reps" as const,
          weight: 135,
          weightUnit: "lb" as const,
          reps: 8,
          saveState: "saved" as const,
          hasPainOrLimitation: true,
        },
      ],
      [
        {
          setId: "pending-set",
          metricType: "weight_reps" as const,
          weight: 135,
          weightUnit: "lb" as const,
          reps: 8,
          saveState: "saving" as const,
        },
      ],
    ]) {
      expect(
        buildMatchRecentBestInsight({
          exerciseId: "exercise-press",
          exerciseName: "Bench press",
          currentSets,
          previous: previous(),
        }),
      ).toBeNull();
    }

    expect(
      buildMatchRecentBestInsight({
        exerciseId: "exercise-press",
        exerciseName: "Bench press",
        currentSets: [
          {
            setId: "current-set",
            metricType: "weight_reps",
            weight: 135,
            weightUnit: "lb",
            reps: 8,
            saveState: "saved",
          },
        ],
        previous: previous({
          sets: previous().sets.map((set) => ({
            ...set,
            hasPainOrLimitation: true,
          })),
        }),
      }),
    ).toBeNull();
  });

  it("requires four compatible rest samples across two workouts", () => {
    const samples = [
      { setId: "a", workoutId: "one", seconds: 85, compatible: true },
      { setId: "b", workoutId: "one", seconds: 90, compatible: true },
      { setId: "c", workoutId: "two", seconds: 95, compatible: true },
      { setId: "d", workoutId: "two", seconds: 100, compatible: true },
    ];
    expect(
      buildUsualRestInsight({
        exerciseId: "exercise-press",
        exerciseName: "Bench press",
        currentSets: [
          {
            setId: "current-set",
            metricType: "weight_reps",
            weight: 135,
            weightUnit: "lb",
            reps: 8,
            saveState: "saved",
          },
        ],
        samples,
      }),
    ).toMatchObject({
      kind: "usual_rest",
      headline: "You usually rest about 95 seconds for Bench press",
      evidence: { unit: "seconds" },
    });
    expect(
      buildUsualRestInsight({
        exerciseId: "exercise-press",
        exerciseName: "Bench press",
        currentSets: [
          {
            setId: "current-set",
            metricType: "weight_reps",
            weight: 135,
            weightUnit: "lb",
            reps: 8,
            saveState: "saved",
          },
        ],
        samples: samples.slice(0, 3),
      }),
    ).toBeNull();

    for (const currentSets of [
      [],
      [
        {
          setId: "pending",
          metricType: "weight_reps" as const,
          weight: 135,
          weightUnit: "lb" as const,
          reps: 8,
          saveState: "saving" as const,
        },
      ],
      [
        {
          setId: "pain",
          metricType: "weight_reps" as const,
          weight: 135,
          weightUnit: "lb" as const,
          reps: 8,
          saveState: "saved" as const,
          hasPainOrLimitation: true,
        },
      ],
    ]) {
      expect(
        buildUsualRestInsight({
          exerciseId: "exercise-press",
          exerciseName: "Bench press",
          currentSets,
          samples,
        }),
      ).toBeNull();
    }
  });

  it("classifies post-workout results while suppressing mixed-unit, legacy, pain, imported, sparse, and no-history evidence", () => {
    const result = buildPostWorkoutSessionResultInsight({
      sessionId: "workout-current",
      exercises: [
        {
          exerciseId: "exercise-press",
          exerciseName: "Bench press",
          currentSets: [
            {
              setId: "current-press",
              metricType: "weight_reps",
              weight: 140,
              weightUnit: "lb",
              reps: 8,
              comparisonEligible: true,
            },
          ],
          previous: previous(),
        },
        {
          exerciseId: "exercise-row",
          exerciseName: "Bodyweight row",
          currentSets: [
            {
              setId: "current-row",
              metricType: "reps",
              weight: null,
              weightUnit: null,
              reps: 10,
              comparisonEligible: true,
            },
          ],
          previous: previous({
            exerciseId: "exercise-row",
            semantics: {
              version: 1,
              metricType: "reps",
              loadType: "bodyweight",
              loadSemantics: "bodyweight",
              loadEntryMeaning: null,
            },
            sets: [
              {
                setId: "prior-row",
                weight: null,
                weightUnit: null,
                reps: 10,
                observedCompletionQuality: "trustworthy",
                correctionProvenance: { state: "original", count: 0 },
              },
            ],
          }),
        },
        {
          exerciseId: "exercise-legacy",
          exerciseName: "Legacy lift",
          currentSets: [
            {
              setId: "legacy-set",
              metricType: "weight_reps",
              weight: 100,
              weightUnit: "lb",
              reps: 8,
              comparisonEligible: false,
            },
          ],
          previous: previous({ exerciseId: "exercise-legacy" }),
        },
        {
          exerciseId: "exercise-import",
          exerciseName: "Unreviewed import",
          currentSets: [],
          previous: null,
        },
      ],
      targetOutcomes: {
        above: 1,
        at: 2,
        below: 0,
        unknown: 1,
        supported: 3,
      },
    });
    expect(result).toMatchObject({
      kind: "session_result",
      placement: "post_workout",
      headline: "1 improved · 1 held",
      strength: "supported",
    });
    expect(result?.detail).toContain("Saved-plan targets: 1 above · 2 at");
    expect(result?.evidence.limitations).toContain(
      "1 performed exercise was not compared because compatible evidence was unavailable.",
    );

    const suppressedInputs = [
      {
        setId: "mixed-unit",
        metricType: "weight_reps" as const,
        weight: 135,
        weightUnit: "kg" as const,
        reps: 8,
        comparisonEligible: true,
      },
      {
        setId: "pain",
        metricType: "weight_reps" as const,
        weight: 135,
        weightUnit: "lb" as const,
        reps: 8,
        comparisonEligible: true,
        hasPainOrLimitation: true,
      },
      {
        setId: "legacy-or-unreviewed-import",
        metricType: "weight_reps" as const,
        weight: 135,
        weightUnit: "lb" as const,
        reps: 8,
        comparisonEligible: false,
      },
    ];
    for (const currentSet of suppressedInputs) {
      expect(
        buildPostWorkoutSessionResultInsight({
          sessionId: "workout-current",
          exercises: [
            {
              exerciseId: "exercise-press",
              exerciseName: "Bench press",
              currentSets: [currentSet],
              previous: previous(),
            },
          ],
        }),
      ).toBeNull();
    }

    expect(
      buildPostWorkoutSessionResultInsight({
        sessionId: "workout-current",
        exercises: [
          {
            exerciseId: "exercise-press",
            exerciseName: "Bench press",
            currentSets: [
              {
                setId: "safe-current",
                metricType: "weight_reps",
                weight: 135,
                weightUnit: "lb",
                reps: 8,
                comparisonEligible: true,
              },
            ],
            previous: previous({
              sets: previous().sets.map((set) => ({
                ...set,
                hasPainOrLimitation: true,
              })),
            }),
          },
        ],
      }),
    ).toBeNull();

    expect(
      buildPostWorkoutSessionResultInsight({
        sessionId: "workout-current",
        exercises: [
          {
            exerciseId: "exercise-press",
            exerciseName: "Bench press",
            currentSets: [
              {
                setId: "no-history",
                metricType: "weight_reps",
                weight: 135,
                weightUnit: "lb",
                reps: 8,
                comparisonEligible: true,
              },
            ],
            previous: null,
          },
        ],
      }),
    ).toBeNull();
  });

  it("prefills a bounded evidence explanation without triggering a Coach request", () => {
    const draft = buildAthleteInsightCoachDraft(
      candidate({
        headline: "Matched a recent best",
        evidence: {
          exactExerciseId: "exercise-a",
          sourceRecordIds: Array.from(
            { length: 20 },
            (_, index) => `source-${index}`,
          ),
          comparisonWindow: "Most recent compatible workout",
          unit: "lb",
          limitations: [],
        },
      }),
    );
    expect(draft).toContain("Explain this deterministic Repbook training insight");
    expect(draft).toContain("Treat it as evidence, not as an automatic Program change");
    expect(draft.length).toBeLessThanOrEqual(800);
  });
});
