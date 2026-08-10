import { pgEnum } from "drizzle-orm/pg-core";

export const unitEnum = pgEnum("unit", ["lb", "kg"]);

export const experienceEnum = pgEnum("experience", [
  "novice",
  "intermediate",
  "advanced",
]);

export const movementPatternEnum = pgEnum("movement_pattern", [
  "squat",
  "hinge",
  "horizontal_push",
  "vertical_push",
  "horizontal_pull",
  "vertical_pull",
  "lunge",
  "carry",
  "core",
  "isolation_arms",
  "isolation_shoulders",
  "isolation_legs",
  "conditioning",
  "rotation",
  "locomotion",
  "olympic_lift",
  "plyometric",
  "mobility",
  "stretch",
]);

export const activityClassEnum = pgEnum("activity_class", [
  "strength",
  "conditioning",
  "mobility",
  "stretch",
  "activation",
  "warmup",
]);

export const metricTypeEnum = pgEnum("metric_type", [
  "weight_reps",
  "reps",
  "assisted_reps",
  "duration",
  "distance_duration",
  "activity",
]);

export const loadSemanticsEnum = pgEnum("load_semantics", [
  "total",
  "per_implement",
  "bodyweight",
  "added_weight",
  "assistance",
  "machine_stack",
  "resistance_band",
  "none",
]);

export const equipmentTypeEnum = pgEnum("equipment_type", [
  "barbell",
  "ez_bar",
  "rack",
  "bench",
  "dumbbell",
  "kettlebell",
  "plates",
  "bands",
  "jump_rope",
  "elliptical",
  "pullup_bar",
  "cable",
  "machine",
  "bodyweight",
  "other",
  "trap_bar",
  "smith_machine",
  "suspension",
  "medicine_ball",
  "stability_ball",
  "foam_roller",
  "sled",
  "rowing_machine",
  "stationary_bike",
  "treadmill",
  "stair_machine",
  "dip_station",
  "box",
  "landmine",
  "battle_rope",
]);

export const sessionStatusEnum = pgEnum("session_status", [
  "in_progress",
  "completed",
  "abandoned",
]);

export const modificationTypeEnum = pgEnum("modification_type", [
  "as_planned",
  "substituted",
  "added",
  "skipped",
]);

export const skipReasonEnum = pgEnum("skip_reason", [
  "time",
  "pain",
  "fatigue",
  "equipment",
  "other",
]);

export const substitutionReasonEnum = pgEnum("substitution_reason", [
  "variety",
  "equipment_busy",
  "discomfort",
  "other",
]);

export const recommendationStatusEnum = pgEnum("recommendation_status", [
  "pending",
  "approved",
  "rejected",
  "edited",
  "expired",
]);

export const recommendationSourceEnum = pgEnum("recommendation_source", [
  "rule",
  "ai",
]);

export const decisionEnum = pgEnum("decision", ["approve", "reject", "edit"]);

export const actorTypeEnum = pgEnum("actor_type", [
  "user",
  "rule",
  "ai",
  "system",
]);

export const painSourceEnum = pgEnum("pain_source", [
  "set_flag",
  "set_exception",
  "session_note",
  "checkin",
]);

export const importSourceEnum = pgEnum("import_source", [
  "paste",
  "csv",
  "json",
  "backup",
]);

export const importStatusEnum = pgEnum("import_status", [
  "raw",
  "parsed",
  "confirmed",
  "discarded",
  "removed",
]);

export const exportKindEnum = pgEnum("export_kind", ["csv", "json", "markdown"]);

export const aiTaskScopeEnum = pgEnum("ai_task_scope", [
  "setup",
  "import",
  "log",
  "review",
]);

export const exerciseMediaTypeEnum = pgEnum("exercise_media_type", [
  "image",
  "video",
]);

export const exerciseMediaStatusEnum = pgEnum("exercise_media_status", [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
]);

export const exerciseMediaHostingEnum = pgEnum("exercise_media_hosting", [
  "app_managed",
  "external",
]);

export const exerciseMediaMatchScopeEnum = pgEnum("exercise_media_match_scope", [
  "exact_variant",
  "equivalent_family",
]);
