import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { equipmentItems } from "./equipment";
import { exercises } from "./exercise";
import { users } from "./user";

export const EXERCISE_EQUIPMENT_FIT_VERDICTS = [
  "compatible",
  "incompatible",
] as const;

export type ExerciseEquipmentFitVerdict =
  (typeof EXERCISE_EQUIPMENT_FIT_VERDICTS)[number];

export const EXERCISE_EQUIPMENT_FIT_REASON_CODES = [
  "owner_verified",
  "geometry_limit",
  "missing_capability",
  "attachment_limit",
  "range_of_motion_limit",
  "space_limit",
  "safety_constraint",
  "other",
] as const;

export type ExerciseEquipmentFitReasonCode =
  (typeof EXERCISE_EQUIPMENT_FIT_REASON_CODES)[number];

/**
 * Owner-reviewed truth for one stable exercise and one exact owned equipment
 * item. A missing row is unknown; it is never interpreted as compatible.
 */
export const exerciseEquipmentFitAssertions = pgTable(
  "exercise_equipment_fit_assertions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    exerciseId: uuid("exercise_id")
      .notNull()
      .references(() => exercises.id, { onDelete: "cascade" }),
    equipmentItemId: uuid("equipment_item_id").notNull(),
    verdict: text("verdict").$type<ExerciseEquipmentFitVerdict>().notNull(),
    reasonCode: text("reason_code")
      .$type<ExerciseEquipmentFitReasonCode>()
      .notNull(),
    reasonNote: text("reason_note"),
    provenance: text("provenance").notNull().default("owner_review"),
    semanticsVersion: integer("semantics_version").notNull().default(1),
    evidenceRevision: text("evidence_revision").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("exercise_equipment_fit_assertions_owner_exercise_item_uq").on(
      t.userId,
      t.exerciseId,
      t.equipmentItemId,
    ),
    uniqueIndex("exercise_equipment_fit_assertions_id_user_uq").on(
      t.id,
      t.userId,
    ),
    index("exercise_equipment_fit_assertions_owner_exercise_idx").on(
      t.userId,
      t.exerciseId,
    ),
    foreignKey({
      name: "exercise_equipment_fit_assertions_item_owner_fk",
      columns: [t.equipmentItemId, t.userId],
      foreignColumns: [equipmentItems.id, equipmentItems.userId],
    }).onDelete("cascade"),
    check(
      "exercise_equipment_fit_assertions_verdict_check",
      sql`${t.verdict} IN ('compatible', 'incompatible')`,
    ),
    check(
      "exercise_equipment_fit_assertions_reason_code_check",
      sql`${t.reasonCode} IN ('owner_verified', 'geometry_limit', 'missing_capability', 'attachment_limit', 'range_of_motion_limit', 'space_limit', 'safety_constraint', 'other')`,
    ),
    check(
      "exercise_equipment_fit_assertions_state_check",
      sql`(${t.verdict} = 'compatible' AND ${t.reasonCode} = 'owner_verified') OR (${t.verdict} = 'incompatible' AND ${t.reasonCode} <> 'owner_verified')`,
    ),
    check(
      "exercise_equipment_fit_assertions_reason_note_check",
      sql`${t.reasonNote} IS NULL OR (length(btrim(${t.reasonNote})) BETWEEN 1 AND 500)`,
    ),
    check(
      "exercise_equipment_fit_assertions_other_note_check",
      sql`${t.reasonCode} <> 'other' OR ${t.reasonNote} IS NOT NULL`,
    ),
    check(
      "exercise_equipment_fit_assertions_provenance_check",
      sql`${t.provenance} = 'owner_review'`,
    ),
    check(
      "exercise_equipment_fit_assertions_semantics_version_check",
      sql`${t.semanticsVersion} = 1`,
    ),
    check(
      "exercise_equipment_fit_assertions_evidence_revision_check",
      sql`${t.evidenceRevision} ~ '^[0-9a-f]{32}$'`,
    ),
    check(
      "exercise_equipment_fit_assertions_revision_check",
      sql`${t.revision} >= 1`,
    ),
    check(
      "exercise_equipment_fit_assertions_timestamps_check",
      sql`${t.createdAt} <= ${t.updatedAt} AND ${t.reviewedAt} <= ${t.updatedAt}`,
    ),
  ],
);
