import { estimateOneRepMax } from "@/lib/one-rep-max";
import type {
  PerformedLoadSemantics,
  PerformedMetricType,
  SetLoadEntryMeaning,
  SupportedSetWriterMetric,
} from "@/lib/set-metric-semantics";
import type { LoadUnit } from "@/lib/units";

export type AthleteInsightCandidate = {
  fingerprint: string;
  kind:
    | "match_recent_best"
    | "progression_ready"
    | "hold_load"
    | "usual_rest"
    | "session_result"
    | "pending_decision"
    | "evidence_limit";
  placement: "today" | "active_set" | "post_workout" | "history" | "review";
  headline: string;
  detail: string | null;
  action: { label: string; href: string } | null;
  evidence: {
    exactExerciseId: string | null;
    sourceRecordIds: string[];
    comparisonWindow: string;
    unit: "lb" | "kg" | "reps" | "seconds" | null;
    limitations: string[];
  };
  strength: "high" | "supported";
  priority: number;
};

export type AthleteInsightPlacement = AthleteInsightCandidate["placement"];

type CandidateInput = Omit<AthleteInsightCandidate, "fingerprint">;

function uniqueSorted(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function stableFingerprint(value: string) {
  // Two seeded FNV-1a passes keep the key compact and deterministic without a
  // runtime-specific crypto dependency. The unhashed source IDs remain on the
  // candidate as the reproducible evidence contract.
  const hash = (seed: number) => {
    let output = seed >>> 0;
    for (let index = 0; index < value.length; index += 1) {
      output ^= value.charCodeAt(index);
      output = Math.imul(output, 0x01000193) >>> 0;
    }
    return output.toString(16).padStart(8, "0");
  };
  return `${hash(0x811c9dc5)}${hash(0x9e3779b1)}`;
}

export function athleteInsightFingerprint(input: {
  kind: AthleteInsightCandidate["kind"];
  placement: AthleteInsightPlacement;
  exactExerciseId: string | null;
  sourceRecordIds: string[];
}) {
  const sourceRecordIds = uniqueSorted(input.sourceRecordIds);
  const parts = [
    input.kind,
    input.placement,
    input.exactExerciseId ?? "none",
    ...sourceRecordIds,
  ];
  const canonical = parts.map((part) => `${part.length}:${part}`).join("|");
  return `athlete-insight-v1-${stableFingerprint(canonical)}`;
}

function candidate(input: CandidateInput): AthleteInsightCandidate | null {
  const sourceRecordIds = uniqueSorted(input.evidence.sourceRecordIds);
  if (
    input.headline.trim().length === 0 ||
    input.priority < 0 ||
    sourceRecordIds.length === 0
  ) {
    return null;
  }
  const limitations = uniqueSorted(input.evidence.limitations);
  return {
    ...input,
    headline: input.headline.trim(),
    detail: input.detail?.trim() || null,
    evidence: {
      ...input.evidence,
      sourceRecordIds,
      comparisonWindow: input.evidence.comparisonWindow.trim(),
      limitations,
    },
    fingerprint: athleteInsightFingerprint({
      kind: input.kind,
      placement: input.placement,
      exactExerciseId: input.evidence.exactExerciseId,
      sourceRecordIds,
    }),
  };
}

export function selectAthleteInsight(
  candidates: Array<AthleteInsightCandidate | null | undefined>,
  input: {
    placement: AthleteInsightPlacement;
    exactExerciseId?: string | null;
    seenFingerprints?: ReadonlySet<string>;
  },
) {
  const unique = new Map<string, AthleteInsightCandidate>();
  for (const insight of candidates) {
    if (insight == null || insight.placement !== input.placement) continue;
    if (
      input.exactExerciseId !== undefined &&
      insight.evidence.exactExerciseId !== input.exactExerciseId
    ) {
      continue;
    }
    if (input.seenFingerprints?.has(insight.fingerprint)) continue;
    unique.set(insight.fingerprint, insight);
  }
  return [...unique.values()].sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    if (left.strength !== right.strength) {
      return left.strength === "high" ? -1 : 1;
    }
    return left.fingerprint.localeCompare(right.fingerprint);
  })[0] ?? null;
}

type PendingDecisionInsightInput = {
  id: string;
  ruleId: string | null;
  exerciseId: string | null;
  exerciseName?: string | null;
  reason: string;
  payload: {
    kind: string;
    fromLoad?: number | null;
    toLoad?: number;
    loadUnit?: LoadUnit;
  };
  evidence: {
    sessionIds?: string[];
    setIds?: string[];
    painLogIds?: string[];
    review?: {
      schemaVersion?: string;
      quality?: string;
      limitations?: string[];
    };
  };
};

export function buildPendingDecisionInsight(
  recommendation: PendingDecisionInsightInput,
): AthleteInsightCandidate | null {
  const review = recommendation.evidence.review;
  if (
    review?.schemaVersion !== "review-evidence-v1" ||
    review.quality !== "supported"
  ) {
    return null;
  }
  const exercise = recommendation.exerciseName?.trim() || "this exercise";
  const sourceRecordIds = [
    recommendation.id,
    ...(recommendation.evidence.sessionIds ?? []),
    ...(recommendation.evidence.setIds ?? []),
    ...(recommendation.evidence.painLogIds ?? []),
  ];

  if (
    recommendation.payload.kind === "load_change" &&
    recommendation.payload.toLoad != null &&
    recommendation.payload.loadUnit != null
  ) {
    const from = recommendation.payload.fromLoad == null
      ? "the current target"
      : `${recommendation.payload.fromLoad} ${recommendation.payload.loadUnit}`;
    return candidate({
      kind: "progression_ready",
      placement: "today",
      headline: `A progression for ${exercise} is ready to review`,
      detail: `${from} → ${recommendation.payload.toLoad} ${recommendation.payload.loadUnit} · review only; your Program is unchanged.`,
      action: {
        label: "Review decision",
        href: `/coach#recommendation-${recommendation.id}`,
      },
      evidence: {
        exactExerciseId: recommendation.exerciseId,
        sourceRecordIds,
        comparisonWindow: "The retained evidence window for this pending decision",
        unit: recommendation.payload.loadUnit,
        limitations: review.limitations ?? [],
      },
      strength: "high",
      priority: 90,
    });
  }

  if (recommendation.payload.kind === "hold") {
    return candidate({
      kind: "hold_load",
      placement: "today",
      headline: `A load hold for ${exercise} is ready to review`,
      detail: "Review only; your Program is unchanged.",
      action: {
        label: "Review hold",
        href: `/coach#recommendation-${recommendation.id}`,
      },
      evidence: {
        exactExerciseId: recommendation.exerciseId,
        sourceRecordIds,
        comparisonWindow: "The retained evidence window for this pending decision",
        unit: null,
        limitations: review.limitations ?? [],
      },
      strength: "high",
      priority: recommendation.ruleId === "pain_freeze" ? 95 : 85,
    });
  }

  return candidate({
    kind: "pending_decision",
    placement: "today",
    headline: "A Program decision is ready to review",
    detail: "Review only; nothing changes without your approval.",
    action: {
      label: "Review decision",
      href: `/coach#recommendation-${recommendation.id}`,
    },
    evidence: {
      exactExerciseId: recommendation.exerciseId,
      sourceRecordIds,
      comparisonWindow: "The retained evidence window for this pending decision",
      unit: null,
      limitations: review.limitations ?? [],
    },
    strength: "supported",
    priority: 70,
  });
}

export type ExactComparableWorkoutEvidence = {
  exerciseId: string;
  semantics: {
    version: 1;
    metricType: SupportedSetWriterMetric;
    loadType: string;
    loadSemantics: PerformedLoadSemantics;
    loadEntryMeaning: SetLoadEntryMeaning | null;
  };
  source: {
    workoutId: string;
    localDate: string;
    historyHref: string;
    workoutSource: string;
  };
  sets: Array<{
    setId: string;
    weight: number | null;
    weightUnit: LoadUnit | null;
    reps: number | null;
    observedCompletionQuality: "trustworthy" | "owner_reported" | "unknown";
    hasPainOrLimitation?: boolean;
    correctionProvenance: {
      state: "original" | "corrected" | "version_restored" | "snapshot_restored";
      count: number;
    };
  }>;
};

export type AthleteInsightSetEvidence = {
  setId: string;
  metricType: PerformedMetricType;
  weight: number | null;
  weightUnit: LoadUnit | null;
  reps: number | null;
  saveState?: "pending" | "saving" | "retrying" | "failed" | "saved";
  comparisonEligible?: boolean;
  hasPainOrLimitation?: boolean;
};

function sourceLimitations(previous: ExactComparableWorkoutEvidence) {
  const limitations: string[] = [];
  if (previous.source.workoutSource === "hevy") {
    limitations.push(
      "The source workout was imported through an owner-reviewed exercise mapping.",
    );
  }
  if (
    previous.sets.some(
      (set) => set.observedCompletionQuality === "owner_reported",
    )
  ) {
    limitations.push("At least one source result was owner reported.");
  }
  if (
    previous.sets.some(
      (set) => set.correctionProvenance.state !== "original",
    )
  ) {
    limitations.push("At least one source result has retained correction history.");
  }
  return limitations;
}

function metricSupportsRecentBest(previous: ExactComparableWorkoutEvidence) {
  if (previous.semantics.metricType === "weight_reps") {
    return (
      previous.semantics.loadType === "barbell" &&
      previous.semantics.loadSemantics === "total" &&
      previous.semantics.loadEntryMeaning === "total_system"
    );
  }
  return (
    previous.semantics.metricType === "reps" &&
    (previous.semantics.loadSemantics === "bodyweight" ||
      previous.semantics.loadSemantics === "none")
  );
}

export function buildMatchRecentBestInsight(input: {
  exerciseId: string;
  exerciseName: string;
  currentSets: AthleteInsightSetEvidence[];
  previous: ExactComparableWorkoutEvidence | null;
}): AthleteInsightCandidate | null {
  const previous = input.previous;
  if (
    previous == null ||
    previous.exerciseId !== input.exerciseId ||
    !metricSupportsRecentBest(previous) ||
    input.currentSets.some((set) => set.hasPainOrLimitation) ||
    previous.sets.length === 0 ||
    previous.sets.some(
      (set) =>
        set.observedCompletionQuality === "unknown" ||
        set.hasPainOrLimitation,
    )
  ) {
    return null;
  }
  const currentSets = input.currentSets.filter(
    (set) =>
      (set.saveState == null || set.saveState === "saved") &&
      set.metricType === previous.semantics.metricType &&
      !set.hasPainOrLimitation,
  );
  if (currentSets.length === 0) return null;

  let matchedCurrent: AthleteInsightSetEvidence | null = null;
  let matchedPrevious: ExactComparableWorkoutEvidence["sets"] = [];
  let value = "";
  let unit: AthleteInsightCandidate["evidence"]["unit"] = null;

  if (previous.semantics.metricType === "weight_reps") {
    for (const current of currentSets) {
      if (
        current.weight == null ||
        current.weightUnit == null ||
        current.reps == null
      ) {
        continue;
      }
      const sameLoad = previous.sets.filter(
        (set) =>
          set.weight === current.weight &&
          set.weightUnit === current.weightUnit &&
          set.reps != null,
      );
      const best = Math.max(...sameLoad.map((set) => set.reps ?? -1));
      if (sameLoad.length > 0 && current.reps === best) {
        matchedCurrent = current;
        matchedPrevious = sameLoad.filter((set) => set.reps === best);
        value = `${current.weight} ${current.weightUnit} × ${current.reps}`;
        unit = current.weightUnit;
        break;
      }
    }
  } else {
    const best = Math.max(...previous.sets.map((set) => set.reps ?? -1));
    matchedCurrent = currentSets.find(
      (set) =>
        set.weight == null &&
        set.weightUnit == null &&
        set.reps != null &&
        set.reps === best,
    ) ?? null;
    matchedPrevious = previous.sets.filter((set) => set.reps === best);
    if (matchedCurrent?.reps != null) {
      value = `${matchedCurrent.reps} reps`;
      unit = "reps";
    }
  }

  if (matchedCurrent == null || matchedPrevious.length === 0) return null;
  const limitations = sourceLimitations(previous);
  return candidate({
    kind: "match_recent_best",
    placement: "active_set",
    headline: `Matched your recent ${input.exerciseName} best: ${value}`,
    detail: `Compared with ${previous.source.localDate}; exact exercise variant and performed load meaning only.`,
    action: { label: "Explain", href: "#live-coach" },
    evidence: {
      exactExerciseId: input.exerciseId,
      sourceRecordIds: [
        matchedCurrent.setId,
        previous.source.workoutId,
        ...matchedPrevious.map((set) => set.setId),
      ],
      comparisonWindow: `Most recent comparable workout on ${previous.source.localDate}`,
      unit,
      limitations,
    },
    strength:
      limitations.length === 0 &&
      previous.sets.every(
        (set) => set.observedCompletionQuality === "trustworthy",
      )
      ? "high"
      : "supported",
    priority: 80,
  });
}

export function buildUsualRestInsight(input: {
  exerciseId: string;
  exerciseName: string;
  currentSets: AthleteInsightSetEvidence[];
  samples: Array<{
    setId: string;
    workoutId: string;
    seconds: number | null;
    compatible: boolean;
  }>;
}): AthleteInsightCandidate | null {
  const savedCurrentSets = input.currentSets.filter(
    (set) => set.saveState == null || set.saveState === "saved",
  );
  if (
    savedCurrentSets.length === 0 ||
    input.currentSets.some((set) => set.hasPainOrLimitation)
  ) {
    return null;
  }
  const samples = input.samples.filter(
    (sample) =>
      sample.compatible &&
      sample.seconds != null &&
      Number.isInteger(sample.seconds) &&
      sample.seconds >= 15 &&
      sample.seconds <= 1_800,
  ) as Array<{
    setId: string;
    workoutId: string;
    seconds: number;
    compatible: boolean;
  }>;
  const workoutIds = uniqueSorted(samples.map((sample) => sample.workoutId));
  if (samples.length < 4 || workoutIds.length < 2) return null;
  const values = samples.map((sample) => sample.seconds).sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median = values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
  const seconds = Math.round(median / 5) * 5;
  return candidate({
    kind: "usual_rest",
    placement: "active_set",
    headline: `You usually rest about ${seconds} seconds for ${input.exerciseName}`,
    detail: `Based on ${samples.length} compatible sets across ${workoutIds.length} workouts.`,
    action: { label: "Explain", href: "#live-coach" },
    evidence: {
      exactExerciseId: input.exerciseId,
      sourceRecordIds: [
        ...workoutIds,
        ...samples.map((sample) => sample.setId),
      ],
      comparisonWindow: "Compatible completed sets across at least two workouts",
      unit: "seconds",
      limitations: [
        "This describes recorded rest; it is not a recommendation to change the Program.",
      ],
    },
    strength: "supported",
    priority: 40,
  });
}

type ExerciseResult = {
  classification: "improved" | "held" | "below";
  exerciseId: string;
  exerciseName: string;
  sourceWorkoutId: string;
  sourceHistoryHref: string;
  sourceRecordIds: string[];
  limitations: string[];
  unit: LoadUnit | "reps";
};

function compareScore(current: number, previous: number) {
  const tolerance = Math.max(0.01, Math.abs(previous) * 0.001);
  if (current > previous + tolerance) return "improved" as const;
  if (current < previous - tolerance) return "below" as const;
  return "held" as const;
}

function classifyExerciseResult(input: {
  exerciseId: string;
  exerciseName: string;
  currentSets: AthleteInsightSetEvidence[];
  previous: ExactComparableWorkoutEvidence | null;
}): ExerciseResult | null {
  const previous = input.previous;
  if (
    previous == null ||
    previous.exerciseId !== input.exerciseId ||
    !metricSupportsRecentBest(previous) ||
    input.currentSets.length === 0 ||
    input.currentSets.some(
      (set) => !set.comparisonEligible || set.hasPainOrLimitation,
    ) ||
    previous.sets.length === 0 ||
    previous.sets.some(
      (set) =>
        set.observedCompletionQuality === "unknown" ||
        set.hasPainOrLimitation,
    )
  ) {
    return null;
  }

  let currentScore: number | null = null;
  let previousScore: number | null = null;
  let unit: LoadUnit | "reps";

  if (previous.semantics.metricType === "weight_reps") {
    const units = uniqueSorted([
      ...input.currentSets.flatMap((set) => set.weightUnit ? [set.weightUnit] : []),
      ...previous.sets.flatMap((set) => set.weightUnit ? [set.weightUnit] : []),
    ]);
    if (units.length !== 1 || (units[0] !== "lb" && units[0] !== "kg")) {
      return null;
    }
    const currentScores = input.currentSets.flatMap((set) => {
      if (
        set.metricType !== "weight_reps" ||
        set.weight == null ||
        set.weightUnit !== units[0] ||
        set.reps == null
      ) {
        return [];
      }
      const score = estimateOneRepMax(set.weight, set.reps);
      return score == null ? [] : [score];
    });
    const previousScores = previous.sets.flatMap((set) => {
      if (
        set.weight == null ||
        set.weightUnit !== units[0] ||
        set.reps == null
      ) {
        return [];
      }
      const score = estimateOneRepMax(set.weight, set.reps);
      return score == null ? [] : [score];
    });
    if (
      currentScores.length !== input.currentSets.length ||
      previousScores.length !== previous.sets.length
    ) {
      return null;
    }
    currentScore = Math.max(...currentScores);
    previousScore = Math.max(...previousScores);
    unit = units[0] as LoadUnit;
  } else {
    const currentReps = input.currentSets.flatMap((set) =>
      set.metricType === "reps" &&
      set.weight == null &&
      set.weightUnit == null &&
      set.reps != null
        ? [set.reps]
        : [],
    );
    const previousReps = previous.sets.flatMap((set) =>
      set.weight == null && set.weightUnit == null && set.reps != null
        ? [set.reps]
        : [],
    );
    if (
      currentReps.length !== input.currentSets.length ||
      previousReps.length !== previous.sets.length
    ) {
      return null;
    }
    currentScore = Math.max(...currentReps);
    previousScore = Math.max(...previousReps);
    unit = "reps";
  }

  return {
    classification: compareScore(currentScore, previousScore),
    exerciseId: input.exerciseId,
    exerciseName: input.exerciseName,
    sourceWorkoutId: previous.source.workoutId,
    sourceHistoryHref: previous.source.historyHref,
    sourceRecordIds: [
      ...input.currentSets.map((set) => set.setId),
      previous.source.workoutId,
      ...previous.sets.map((set) => set.setId),
    ],
    limitations: sourceLimitations(previous),
    unit,
  };
}

export function buildPostWorkoutSessionResultInsight(input: {
  sessionId: string;
  exercises: Array<{
    exerciseId: string;
    exerciseName: string;
    currentSets: AthleteInsightSetEvidence[];
    previous: ExactComparableWorkoutEvidence | null;
  }>;
  targetOutcomes?: {
    above: number;
    at: number;
    below: number;
    unknown: number;
    supported: number;
  };
}): AthleteInsightCandidate | null {
  const results = input.exercises.flatMap((exercise) => {
    const result = classifyExerciseResult(exercise);
    return result == null ? [] : [result];
  });
  if (results.length === 0) return null;
  const improved = results.filter(
    (result) => result.classification === "improved",
  ).length;
  const held = results.filter((result) => result.classification === "held").length;
  const below = results.filter(
    (result) => result.classification === "below",
  ).length;
  const parts = [
    improved > 0 ? `${improved} improved` : null,
    held > 0 ? `${held} held` : null,
    below > 0 ? `${below} below recent performance` : null,
  ].filter((part): part is string => part != null);
  const performedExerciseCount = input.exercises.filter(
    (exercise) => exercise.currentSets.length > 0,
  ).length;
  const unavailableCount = Math.max(performedExerciseCount - results.length, 0);
  const target = input.targetOutcomes;
  const targetDetail = target && target.supported > 0
    ? ` Saved-plan targets: ${[
        target.above > 0 ? `${target.above} above` : null,
        target.at > 0 ? `${target.at} at` : null,
        target.below > 0 ? `${target.below} below` : null,
      ].filter((part): part is string => part != null).join(" · ")}.`
    : "";
  const sourceWorkoutIds = uniqueSorted(
    results.map((result) => result.sourceWorkoutId),
  );
  const historyHrefs = uniqueSorted(
    results.map((result) => result.sourceHistoryHref),
  );
  const units = uniqueSorted(results.map((result) => result.unit));
  return candidate({
    kind: "session_result",
    placement: "post_workout",
    headline: parts.join(" · "),
    detail: `Compared ${results.length} exact exercise ${results.length === 1 ? "variant" : "variants"} with each one's newest compatible workout.${targetDetail}`,
    action: sourceWorkoutIds.length === 1 && historyHrefs.length === 1
      ? { label: "View comparison workout", href: historyHrefs[0] }
      : null,
    evidence: {
      exactExerciseId: results.length === 1 ? results[0].exerciseId : null,
      sourceRecordIds: [
        input.sessionId,
        ...results.flatMap((result) => result.sourceRecordIds),
      ],
      comparisonWindow: "Newest earlier comparable workout for each exact exercise",
      unit: units.length === 1
        ? (units[0] as AthleteInsightCandidate["evidence"]["unit"])
        : null,
      limitations: [
        ...results.flatMap((result) => result.limitations),
        ...(unavailableCount > 0
          ? [
              `${unavailableCount} performed ${unavailableCount === 1 ? "exercise was" : "exercises were"} not compared because compatible evidence was unavailable.`,
            ]
          : []),
        ...(target?.unknown
          ? [`${target.unknown} saved-plan outcomes remained unknown.`]
          : []),
      ],
    },
    strength: unavailableCount === 0 && results.every(
      (result) => result.limitations.length === 0,
    )
      ? "high"
      : "supported",
    priority: below > 0 ? 85 : improved > 0 ? 75 : 65,
  });
}

export function buildAthleteInsightCoachDraft(
  insight: AthleteInsightCandidate,
) {
  const sourceIds = insight.evidence.sourceRecordIds;
  const shownIds = sourceIds.slice(0, 8);
  const omitted = sourceIds.length - shownIds.length;
  return [
    "Explain this deterministic Repbook training insight in plain language.",
    `Insight: ${insight.headline}${insight.detail ? ` — ${insight.detail}` : ""}`,
    `Comparison window: ${insight.evidence.comparisonWindow}.`,
    `Source records: ${shownIds.join(", ")}${omitted > 0 ? `, plus ${omitted} more retained source records` : ""}.`,
    "Treat it as evidence, not as an automatic Program change.",
  ].join("\n").slice(0, 800);
}
