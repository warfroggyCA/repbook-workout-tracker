import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { equipmentDefinitions } from "./equipment";
import { exercises } from "./exercise";

/**
 * Reviewed execution facts that are stricter than broad equipment ownership.
 *
 * A row exists only when an exercise variant needs an exact executable setup.
 * Broad `exercise_equipment_requirements` remain the first availability gate;
 * these predicates then prevent a generic machine or cable item from being
 * treated as proof of an exact machine, attachment, or known geometry.
 */
export const exerciseExecutionRequirements = pgTable(
  "exercise_execution_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id, { onDelete: "cascade" }),
    requiredProfileKind: text("required_profile_kind"),
    requiredEquipmentDefinitionId: uuid(
      "required_equipment_definition_id",
    ).references(() => equipmentDefinitions.id, { onDelete: "restrict" }),
    requiredAttachmentKind: text("required_attachment_kind"),
    requiredAttachmentDefinitionId: uuid(
      "required_attachment_definition_id",
    ).references(() => equipmentDefinitions.id, { onDelete: "restrict" }),
    requiresKnownGeometry: boolean("requires_known_geometry")
      .notNull()
      .default(false),
    reviewNotes: text("review_notes"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("exercise_execution_requirements_exercise_uq").on(
      t.exerciseId,
    ),
    index("exercise_execution_requirements_equipment_definition_idx").on(
      t.requiredEquipmentDefinitionId,
    ),
    index("exercise_execution_requirements_attachment_definition_idx").on(
      t.requiredAttachmentDefinitionId,
    ),
    check(
      "exercise_execution_requirements_exact_predicate_check",
      sql`${t.requiredProfileKind} IS NOT NULL
        OR ${t.requiredEquipmentDefinitionId} IS NOT NULL
        OR ${t.requiredAttachmentKind} IS NOT NULL
        OR ${t.requiredAttachmentDefinitionId} IS NOT NULL
        OR ${t.requiresKnownGeometry}`,
    ),
    check(
      "exercise_execution_requirements_profile_kind_check",
      sql`${t.requiredProfileKind} IS NULL OR length(btrim(${t.requiredProfileKind})) > 0`,
    ),
    check(
      "exercise_execution_requirements_attachment_kind_check",
      sql`${t.requiredAttachmentKind} IS NULL OR length(btrim(${t.requiredAttachmentKind})) > 0`,
    ),
  ],
);
