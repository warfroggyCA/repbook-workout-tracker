import catalogJson from "@/data/extended-exercise-catalog.json";
import {
  extractExerciseIdentity,
  normalizeExerciseText,
  scoreExerciseCandidate,
} from "@/services/exercise-map";

type CatalogRecord = (typeof catalogJson)[number];

const EQUIPMENT: Record<
  string,
  { type: string; loadType: string; semantics: string }
> = {
  barbell: { type: "barbell", loadType: "barbell", semantics: "total" },
  dumbbell: { type: "dumbbell", loadType: "dumbbell", semantics: "per_implement" },
  cable: { type: "cable", loadType: "external", semantics: "machine_stack" },
  machine: { type: "machine", loadType: "external", semantics: "machine_stack" },
  kettlebells: { type: "kettlebell", loadType: "kettlebell", semantics: "per_implement" },
  bands: { type: "bands", loadType: "band", semantics: "resistance_band" },
  "body only": { type: "bodyweight", loadType: "bodyweight", semantics: "bodyweight" },
  "e-z curl bar": { type: "ez_bar", loadType: "ez_bar", semantics: "total" },
  "medicine ball": { type: "medicine_ball", loadType: "external", semantics: "total" },
  "exercise ball": { type: "stability_ball", loadType: "bodyweight", semantics: "bodyweight" },
  "foam roll": { type: "foam_roller", loadType: "bodyweight", semantics: "none" },
  other: { type: "other", loadType: "external", semantics: "total" },
};

function movementPattern(name: string, category: string | null) {
  if (category === "stretching") return "stretch";
  if (category === "plyometrics") return "plyometric";
  if (category === "olympic weightlifting") return "olympic_lift";
  if (/squat|leg press/i.test(name)) return "squat";
  if (/deadlift|good morning|hip thrust|pull-through|hyperextension/i.test(name)) return "hinge";
  if (/lunge|split squat|step-up/i.test(name)) return "lunge";
  if (/bench press|push-up|chest press|fly/i.test(name)) return "horizontal_push";
  if (/shoulder press|overhead press|handstand|push press/i.test(name)) return "vertical_push";
  if (/row/i.test(name)) return "horizontal_pull";
  if (/pull-up|chin-up|pulldown|pullover/i.test(name)) return "vertical_pull";
  if (/curl|triceps|extension|pushdown|dip/i.test(name)) return "isolation_arms";
  if (/raise|rear delt|face pull|shrug|rotation/i.test(name)) return "isolation_shoulders";
  if (/leg curl|leg extension|calf|abduct|adduct/i.test(name)) return "isolation_legs";
  if (/twist|woodchop|crunch|plank|sit-up|leg raise|rollout/i.test(name)) return "core";
  if (category === "cardio") return "conditioning";
  return "conditioning";
}

function transform(record: CatalogRecord) {
  const equipment = record.equipment ? EQUIPMENT[record.equipment] : undefined;
  const activityClass = record.category === "stretching"
    ? "stretch"
    : record.category === "cardio" || record.category === "plyometrics"
      ? "conditioning"
      : "strength";
  const metricType = record.category === "stretching"
    ? "duration"
    : record.category === "cardio"
      ? "distance_duration"
      : equipment?.type === "bodyweight"
        ? "reps"
        : "weight_reps";
  return {
    sourceId: record.sourceId,
    sourceUrl: record.sourceUrl,
    license: record.license,
    name: record.name,
    equipment: [equipment?.type ?? "other"],
    loadType: equipment?.loadType ?? "external",
    loadSemantics: equipment?.semantics ?? "total",
    movementPattern: movementPattern(record.name, record.category),
    activityClass,
    metricType,
    primaryMuscles: record.primaryMuscles,
    secondaryMuscles: record.secondaryMuscles,
  };
}

export type ExtendedExerciseCandidate = ReturnType<typeof transform>;

export function searchExtendedExerciseCatalog(query: string, limit = 12) {
  const normalized = normalizeExerciseText(query);
  if (normalized.length < 2) return [];
  const hints = extractExerciseIdentity(query);
  return catalogJson
    .map((record) => {
      const transformed = transform(record);
      const compatible = !hints.equipment || transformed.equipment.includes(hints.equipment);
      const score = compatible ? scoreExerciseCandidate(query, record.name) : 0;
      const exactBonus = normalizeExerciseText(record.name) === normalized ? 2000 : 0;
      return { transformed, score: score + exactBonus };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || a.transformed.name.localeCompare(b.transformed.name)
    )
    .slice(0, Math.max(1, Math.min(30, limit)))
    .map((entry) => entry.transformed);
}
