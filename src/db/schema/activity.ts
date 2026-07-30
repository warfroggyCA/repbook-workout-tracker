import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./user";
import { archiveOperations } from "./archive";

export type ActivityOriginalMetrics = {
  distanceValue?: number;
  distanceUnit?: "km" | "mi";
  elevationValue?: number;
  elevationUnit?: "m" | "ft";
};

/** Independent health activity; never participates in strength progression. */
export const healthActivities = pgTable(
  "health_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activityType: text("activity_type").notNull(),
    title: text("title"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    distanceKm: doublePrecision("distance_km"),
    averagePaceSecondsPerKm: doublePrecision("average_pace_seconds_per_km"),
    intensity: text("intensity"),
    elevationGainM: doublePrecision("elevation_gain_m"),
    averageHeartRateBpm: integer("average_heart_rate_bpm"),
    energyKcal: doublePrecision("energy_kcal"),
    notes: text("notes"),
    source: text("source").notNull().default("manual"),
    sourceRecordId: text("source_record_id"),
    sourceMetadata: jsonb("source_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    originalMetrics: jsonb("original_metrics")
      .$type<ActivityOriginalMetrics>()
      .notNull()
      .default({}),
    fingerprint: text("fingerprint").notNull(),
    excludeFromAnalytics: boolean("exclude_from_analytics")
      .notNull()
      .default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archiveOperationId: uuid("archive_operation_id").references(
      () => archiveOperations.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("health_activities_user_started_idx").on(t.userId, t.startedAt),
    index("health_activities_active_user_started_idx")
      .on(t.userId, t.startedAt)
      .where(sql`${t.archivedAt} IS NULL`),
    index("health_activities_user_fingerprint_idx").on(
      t.userId,
      t.fingerprint
    ),
    uniqueIndex("health_activities_manual_fingerprint_uq")
      .on(t.userId, t.fingerprint)
      .where(sql`${t.source} = 'manual'`),
    uniqueIndex("health_activities_source_record_uq")
      .on(t.userId, t.source, t.sourceRecordId)
      .where(sql`${t.sourceRecordId} is not null`),
    check("health_activities_duration_positive", sql`${t.durationSeconds} > 0`),
    check(
      "health_activities_distance_nonnegative",
      sql`${t.distanceKm} is null or ${t.distanceKm} >= 0`
    ),
    check(
      "health_activities_pace_positive",
      sql`${t.averagePaceSecondsPerKm} is null or ${t.averagePaceSecondsPerKm} > 0`
    ),
    check(
      "health_activities_elevation_nonnegative",
      sql`${t.elevationGainM} is null or ${t.elevationGainM} >= 0`
    ),
    check(
      "health_activities_heart_rate_range",
      sql`${t.averageHeartRateBpm} is null or ${t.averageHeartRateBpm} between 20 and 260`
    ),
    check(
      "health_activities_energy_nonnegative",
      sql`${t.energyKcal} is null or ${t.energyKcal} >= 0`
    ),
  ]
);
