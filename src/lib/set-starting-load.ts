import type {
  SessionExerciseData,
  SessionOccurrenceData,
} from "@/components/session/types";
import {
  resolveFutureSetWriterMetricType,
  type SetLoadEntryMeaning,
} from "@/lib/set-metric-semantics";
import { convertWeight, type LoadUnit } from "@/lib/units";

export type SetStartingLoadSource =
  | "Previous set in this workout"
  | "Program target"
  | "Previous comparable set";

export type SetStartingLoadPreview =
  | {
      status: "available";
      weight: number;
      unit: LoadUnit;
      source: SetStartingLoadSource;
    }
  | {
      status: "loading";
    }
  | {
      status: "not_applicable";
    }
  | {
      status: "unavailable";
    };

/**
 * Resolves the same truthful starting load for both the active set editor and
 * read-only previews. Program evidence wins over history, and incompatible or
 * missing evidence remains visibly unavailable rather than becoming zero.
 */
export function resolveSetStartingLoad(input: {
  exercise: SessionExerciseData;
  setNumber: number;
  unit: LoadUnit;
  loadEntryMeaning: SetLoadEntryMeaning | null;
  occurrence?: SessionOccurrenceData | null;
  comparisonTemporarilyUnavailable?: boolean;
}): SetStartingLoadPreview {
  const metricType = resolveFutureSetWriterMetricType({
    metricType: input.exercise.metricType ?? "weight_reps",
    loadSemantics: input.exercise.loadSemantics,
  });
  if (metricType !== "weight_reps" && metricType !== "assisted_reps" && metricType !== "weight_duration_per_side") {
    return { status: "not_applicable" };
  }

  const previousWorkoutSet = [...input.exercise.sets]
    .filter(
      (set) =>
        set.setNo < input.setNumber &&
        set.weight != null &&
        set.weightUnit != null,
    )
    .sort((left, right) => right.setNo - left.setNo)[0];
  if (
    previousWorkoutSet?.weight != null &&
    previousWorkoutSet.weightUnit != null
  ) {
    return {
      status: "available",
      weight: convertWeight(
        previousWorkoutSet.weight,
        previousWorkoutSet.weightUnit,
        input.unit,
      ),
      unit: input.unit,
      source: "Previous set in this workout",
    };
  }

  const occurrenceMatchesExercise =
    input.occurrence?.plannedExerciseId === input.exercise.exerciseId;
  const plannedLoad = input.exercise.targetLoad ??
    (occurrenceMatchesExercise ? input.occurrence?.plannedLoad : null);
  const plannedLoadUnit =
    input.exercise.targetLoadUnit ??
    (occurrenceMatchesExercise ? input.occurrence?.plannedLoadUnit : null);
  if (plannedLoad != null && plannedLoadUnit != null) {
    return {
      status: "available",
      weight: convertWeight(plannedLoad, plannedLoadUnit, input.unit),
      unit: input.unit,
      source: "Program target",
    };
  }

  if (input.comparisonTemporarilyUnavailable) return { status: "loading" };

  const comparable = input.exercise.previousComparable;
  const semanticsMatch =
    comparable?.status === "available" &&
    comparable.exerciseId === input.exercise.exerciseId &&
    (comparable.semantics.metricType !== "weight_reps" &&
    comparable.semantics.metricType !== "assisted_reps"
      ? true
      : comparable.semantics.loadEntryMeaning === input.loadEntryMeaning);
  if (comparable?.status !== "available" || !semanticsMatch) {
    return { status: "unavailable" };
  }
  const previousComparableSet =
    comparable.sets.find((set) => set.setNo === input.setNumber) ??
    comparable.sets.at(-1) ??
    null;
  if (
    previousComparableSet?.weight == null ||
    previousComparableSet.weightUnit == null
  ) {
    return { status: "unavailable" };
  }
  return {
    status: "available",
    weight: convertWeight(
      previousComparableSet.weight,
      previousComparableSet.weightUnit,
      input.unit,
    ),
    unit: input.unit,
    source: "Previous comparable set",
  };
}

export function setStartingLoadPreviewText(preview: SetStartingLoadPreview) {
  if (preview.status === "available") {
    return `${preview.weight} ${preview.unit} · ${preview.source}`;
  }
  if (preview.status === "loading") return "Checking previous comparable load…";
  if (preview.status === "not_applicable") return "No weight entry for this exercise";
  return "No starting load available";
}
