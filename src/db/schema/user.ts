import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  bigint,
  timestamp,
  jsonb,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { unitEnum, experienceEnum } from "./enums";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    analysisEvidenceRevision: bigint("analysis_evidence_revision", {
      mode: "number",
    })
      .notNull()
      .default(0),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)]
);

export type CoachingPrefs = {
  aggressiveness: "conservative" | "moderate" | "aggressive";
  deloadSuggestions: boolean;
  substitutionSuggestions: boolean;
  weeklyReview: boolean;
};

export type RoutineWarmupSet = {
  label: string;
  reps: number | null;
  load: number | null;
  loadUnit: "lb" | "kg" | null;
  loadPercent: number | null;
  loadText: string | null;
  notes: string | null;
};

export type RoutineWarmup = {
  notes: string | null;
  sets: RoutineWarmupSet[];
};

/** One exercise row in the setup wizard's draft routine (plan §4 step 4). */
export type RoutineDraftExercise = {
  exerciseId: string;
  name: string;
  sets: number;
  repMin: number;
  repMax: number;
  targetLoad: number | null;
  targetLoadUnit: "lb" | "kg" | null;
  restSec: number;
  /** Letter group within the day ("A", "B", …); null = straight sets. */
  supersetGroup: string | null;
  notes: string | null;
  warmup: RoutineWarmup | null;
  setNotes: Array<string | null>;
};

export type RoutineDraftDay = {
  name: string;
  notes?: string | null;
  warmupNotes?: string | null;
  exercises: RoutineDraftExercise[];
};

/**
 * Guided-setup progress (plan §4: "Progress is persisted per step so setup
 * can be resumed"). The routine draft lives here — nothing enters the
 * program tables until step 6 activation.
 */
export type SetupState = {
  completedSteps: string[];
  routineDraft: { days: RoutineDraftDay[] } | null;
};

export const userProfiles = pgTable(
  "user_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ageRange: text("age_range"), // e.g. "50-59"
    experience: experienceEnum("experience").notNull().default("intermediate"),
    goals: jsonb("goals").$type<string[]>().notNull().default([]),
    sessionLengthMin: integer("session_length_min").notNull().default(45),
    weeklyFrequency: integer("weekly_frequency").notNull().default(3),
    unit: unitEnum("unit").notNull().default("lb"),
    timezone: text("timezone").notNull().default("America/Toronto"),
    fontSize: text("font_size").notNull().default("default"),
    coachingPrefs: jsonb("coaching_prefs")
      .$type<CoachingPrefs>()
      .notNull()
      .default({
        aggressiveness: "conservative",
        deloadSuggestions: true,
        substitutionSuggestions: true,
        weeklyReview: true,
      }),
    setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
    setupState: jsonb("setup_state")
      .$type<SetupState>()
      .notNull()
      .default({ completedSteps: [], routineDraft: null }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("user_profiles_user_idx").on(t.userId),
    check(
      "user_profiles_font_size_valid",
      sql`${t.fontSize} in ('compact', 'default', 'large', 'extra-large')`
    ),
    check(
      "user_profiles_setup_target_unit_check",
      sql`NOT jsonb_path_exists(${t.setupState}, '$.routineDraft.days[*].exercises[*] ? ((@.targetLoad != null && (!exists(@.targetLoadUnit) || @.targetLoadUnit == null)) || (@.targetLoad == null && exists(@.targetLoadUnit) && @.targetLoadUnit != null))')`
    ),
    check(
      "user_profiles_setup_warmup_unit_check",
      sql`NOT jsonb_path_exists(${t.setupState}, '$.routineDraft.days[*].exercises[*].warmup.sets[*] ? ((@.load != null && (!exists(@.loadUnit) || @.loadUnit == null)) || (@.load == null && exists(@.loadUnit) && @.loadUnit != null))')`
    ),
  ]
);

/**
 * Injury/joint constraints mapped to movement patterns (plan §4 step 3).
 * `avoid` = never suggest; `cautious` = progression capped, flagged in UI.
 */
export const constraints = pgTable("constraints", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  bodyPart: text("body_part").notNull(), // "shoulder", "knee", "back", ...
  affectedPatterns: jsonb("affected_patterns").$type<string[]>().notNull(),
  avoid: boolean("avoid").notNull().default(false),
  cautious: boolean("cautious").notNull().default(true),
  painStopThreshold: integer("pain_stop_threshold").notNull().default(3), // 0-10
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
