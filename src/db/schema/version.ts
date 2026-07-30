import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./user";

export type RecordVersionData = Record<string, unknown>;

/** Immutable before/after evidence for meaningful edits and rollbacks. */
export const recordVersions = pgTable(
  "record_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    beforeData: jsonb("before_data").$type<RecordVersionData>().notNull(),
    afterData: jsonb("after_data").$type<RecordVersionData>().notNull(),
    changedFields: text("changed_fields")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    sourceVersionId: uuid("source_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("record_versions_user_created_idx").on(t.userId, t.createdAt),
    index("record_versions_entity_idx").on(
      t.userId,
      t.entityType,
      t.entityId,
      t.createdAt
    ),
    check(
      "record_versions_before_load_unit_check",
      sql`NOT (${t.entityType} = 'completed_set' AND jsonb_path_exists(${t.beforeData}, '$ ? ((@.weight != null && (!exists(@.weight_unit) || @.weight_unit == null)) || (@.weight == null && exists(@.weight_unit) && @.weight_unit != null))')) AND NOT (${t.entityType} = 'session_exercise' AND jsonb_path_exists(${t.beforeData}, '$ ? ((@.target_load != null && (!exists(@.target_load_unit) || @.target_load_unit == null)) || (@.target_load == null && exists(@.target_load_unit) && @.target_load_unit != null))'))`
    ),
    check(
      "record_versions_after_load_unit_check",
      sql`NOT (${t.entityType} = 'completed_set' AND jsonb_path_exists(${t.afterData}, '$ ? ((@.weight != null && (!exists(@.weight_unit) || @.weight_unit == null)) || (@.weight == null && exists(@.weight_unit) && @.weight_unit != null))')) AND NOT (${t.entityType} = 'session_exercise' AND jsonb_path_exists(${t.afterData}, '$ ? ((@.target_load != null && (!exists(@.target_load_unit) || @.target_load_unit == null)) || (@.target_load == null && exists(@.target_load_unit) && @.target_load_unit != null))'))`
    ),
  ]
);
