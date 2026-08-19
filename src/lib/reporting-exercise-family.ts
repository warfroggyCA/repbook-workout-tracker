/**
 * Broad, versioned reporting projection for movement-pattern exposure.
 *
 * The exact exercise name remains the progression identity. This projection is
 * intentionally unsuitable for load progression, personal records, or merging
 * performed histories. Changing this rule must increment the version so a
 * rendered report can explain how its higher-level grouping was derived.
 */
export const REPORTING_EXERCISE_FAMILY_RULE_VERSION =
  "reporting-exercise-family/1" as const;

export type ReportingExerciseFamily =
  | "Chest Press"
  | "Chest Isolation"
  | "Squat"
  | "Row"
  | "Vertical Pull"
  | "Hinge"
  | "Vertical Press"
  | "Curl"
  | "Triceps Extension"
  | "Arm Isolation"
  | "Calf Raise"
  | "Leg Isolation"
  | "Core"
  | "Lunge"
  | "Carry"
  | "Shoulder Isolation"
  | "Rotation"
  | "Conditioning"
  | "Locomotion"
  | "Olympic Lift"
  | "Plyometric"
  | "Mobility"
  | "Stretch"
  | "Unclassified";

export type ReportingExerciseFamilyProjection = {
  family: ReportingExerciseFamily;
  ruleVersion: typeof REPORTING_EXERCISE_FAMILY_RULE_VERSION;
  /** Exact stored variant label. It remains the progression unit. */
  variant: string;
  /** Existing catalog family is retained as evidence, not used as a variant merge. */
  catalogFamily: string | null;
  movementPattern: string | null;
};

export function projectReportingExerciseFamily(input: {
  exerciseName: string;
  catalogFamily?: string | null;
  movementPattern?: string | null;
}): ReportingExerciseFamilyProjection {
  const searchable = `${input.catalogFamily ?? ""} ${input.exerciseName}`;
  let family: ReportingExerciseFamily;

  switch (input.movementPattern) {
    case "horizontal_push":
      family = /fly|flye|pec deck|crossover/iu.test(searchable)
        ? "Chest Isolation"
        : "Chest Press";
      break;
    case "squat":
      family = "Squat";
      break;
    case "horizontal_pull":
      family = "Row";
      break;
    case "vertical_pull":
      family = "Vertical Pull";
      break;
    case "hinge":
      family = "Hinge";
      break;
    case "vertical_push":
      family = "Vertical Press";
      break;
    case "isolation_arms":
      family = /curl/iu.test(searchable)
        ? "Curl"
        : /tricep|pushdown|pressdown|extension|skull|kickback/iu.test(
              searchable,
            )
          ? "Triceps Extension"
          : "Arm Isolation";
      break;
    case "isolation_legs":
      family = /calf/iu.test(searchable) ? "Calf Raise" : "Leg Isolation";
      break;
    case "core":
      family = "Core";
      break;
    case "lunge":
      family = "Lunge";
      break;
    case "carry":
      family = "Carry";
      break;
    case "isolation_shoulders":
      family = "Shoulder Isolation";
      break;
    case "rotation":
      family = "Rotation";
      break;
    case "conditioning":
      family = "Conditioning";
      break;
    case "locomotion":
      family = "Locomotion";
      break;
    case "olympic_lift":
      family = "Olympic Lift";
      break;
    case "plyometric":
      family = "Plyometric";
      break;
    case "mobility":
      family = "Mobility";
      break;
    case "stretch":
      family = "Stretch";
      break;
    default:
      family = /bench press|chest press|push[- ]?up/iu.test(input.exerciseName)
        ? "Chest Press"
        : /\bsquat\b/iu.test(input.exerciseName)
          ? "Squat"
          : /row/iu.test(input.exerciseName)
            ? "Row"
            : /pull[- ]?up|chin[- ]?up|pulldown/iu.test(input.exerciseName)
              ? "Vertical Pull"
              : /deadlift|hinge|good morning/iu.test(input.exerciseName)
                ? "Hinge"
                : /overhead press|shoulder press|military press/iu.test(input.exerciseName)
                  ? "Vertical Press"
                  : /curl/iu.test(input.exerciseName)
                    ? "Curl"
                    : /tricep|pushdown|pressdown|skull crusher/iu.test(input.exerciseName)
                      ? "Triceps Extension"
                      : /calf raise/iu.test(input.exerciseName)
                        ? "Calf Raise"
                        : /dead bug|plank|crunch|sit[- ]?up/iu.test(input.exerciseName)
                          ? "Core"
                          : "Unclassified";
  }

  return {
    family,
    ruleVersion: REPORTING_EXERCISE_FAMILY_RULE_VERSION,
    variant: input.exerciseName,
    catalogFamily: input.catalogFamily ?? null,
    movementPattern: input.movementPattern ?? null,
  };
}
