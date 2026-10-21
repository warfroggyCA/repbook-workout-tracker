import type { ExerciseDiscoveryItem } from "@/lib/exercise-discovery";
import { handheldLoadPresentation } from "@/lib/focused-workout";
import { PERFORMED_METRIC_TYPES, resolveFutureSetWriterMetricType } from "@/lib/set-metric-semantics";

/** Review only. The existing replacement command owns all saved changes. */
export function WorkoutSwapSummary({
  item,
  currentExerciseName,
}: {
  item: ExerciseDiscoveryItem;
  currentExerciseName: string;
}) {
  const handheld = handheldLoadPresentation(item);
  const knownMetric = PERFORMED_METRIC_TYPES.find((value) => value === item.metricType);
  const metric = knownMetric == null ? null : resolveFutureSetWriterMetricType({
    metricType: knownMetric, loadSemantics: item.loadSemantics,
  });
  const recordsLoad = metric === "weight_reps" || metric === "assisted_reps" || metric === "weight_duration_per_side";
  return (
    <div className="one-next-swap-summary space-y-4" data-testid="workout-swap-summary">
      <div className="one-next-swap-equipment">
        <p className="one-next-eyebrow">
          {item.constraintBlocked
            ? "Check your constraints"
            : item.available ? "Fits your saved equipment" : "Equipment needs checking"}
        </p>
        <p className="mt-2 text-lg font-semibold">
          {item.equipment.map((value) => value.replaceAll("_", " ")).join(" + ") || "No equipment needed"}
        </p>
        {!item.available && <p className="mt-2 text-sm">{item.unavailableReason ?? "Check the required equipment before choosing this exercise."}</p>}
      </div>
      {handheld && recordsLoad && (
        <p className="text-sm leading-relaxed" data-testid="swap-load-convention">
          <strong>{handheld.label}.</strong> {handheld.explanation}
        </p>
      )}
      <div className="one-next-swap-history">
        <h4 className="font-semibold">Separate exercise histories</h4>
        <p className="mt-2 text-sm leading-relaxed">
          Replacing {currentExerciseName}. These exercises keep separate records.
          {recordsLoad ? " The old exercise’s weight does not transfer." : " Results stay with the exercise you performed."}
        </p>
        <details className="mt-2 text-sm leading-relaxed text-muted-foreground">
          <summary className="min-h-11 cursor-pointer py-2 font-medium text-primary">How the starting entry is chosen</summary>
          <p>
          {recordsLoad
            ? "After the swap, RepBook checks this exercise’s own comparable sets for a starting entry. If no load can be carried forward safely, enter your starting load or assistance."
            : metric == null || metric === "activity"
              ? "Review the tracking details below. A numeric starting load cannot be inferred for this exercise."
              : "Follow the new exercise’s reps or time entry. No weight is invented from the exercise you are replacing."}
          </p>
        </details>
      </div>
      <p className="text-sm leading-relaxed text-muted-foreground">
        This workout only. Completed sets keep their original exercise, and your saved routine stays unchanged.
      </p>
    </div>
  );
}
