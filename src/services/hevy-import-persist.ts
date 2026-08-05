import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  exerciseFamilies,
  exercises,
  historyImportBatches,
  importEvents,
} from "@/db/schema";
import {
  extractExerciseIdentity,
  hevyMappingKey,
  normalizeExerciseText,
} from "@/services/exercise-map";
import {
  isSuspiciousSetDuration,
  parseHevyCsv,
  type HevyExerciseReview,
  type StagedHevyPayload,
} from "@/services/hevy-import";
import { catalogKey } from "@/services/exercise-catalog";
import { exerciseMatchesIdentityHints } from "@/services/exercise-compat";
import { workoutLocalDate } from "@/lib/workout-calendar";
import { historyRevisionLockSql } from "@/services/history-revision-lock";

const movementPattern = z.enum([
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

const equipmentType = z.enum([
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

const customExerciseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  familyId: z.string().uuid(),
  movementPattern,
  primaryMuscles: z.array(z.string().trim().min(1).max(60)).min(1).max(12),
  secondaryMuscles: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
  isUnilateral: z.boolean().default(false),
  loadType: z.enum([
    "barbell",
    "ez_bar",
    "dumbbell",
    "kettlebell",
    "band",
    "bodyweight",
    "external",
  ]),
  equipment: z.array(equipmentType).min(1).max(8),
  activityClass: z.enum([
    "strength",
    "conditioning",
    "mobility",
    "stretch",
    "activation",
    "warmup",
  ]),
  metricType: z.enum([
    "weight_reps",
    "reps",
    "assisted_reps",
    "duration",
    "distance_duration",
    "activity",
  ]),
  loadSemantics: z.enum([
    "total",
    "per_implement",
    "bodyweight",
    "added_weight",
    "assistance",
    "machine_stack",
    "resistance_band",
    "none",
  ]),
  promoteToMainLibrary: z.boolean().default(false),
}).superRefine((exercise, context) => {
  if (
    (exercise.loadSemantics === "assistance") !==
    (exercise.metricType === "assisted_reps")
  ) {
    context.addIssue({
      code: "custom",
      path: ["metricType"],
      message:
        "Assistance exercises must use assisted repetitions, and assisted repetitions must use assistance semantics.",
    });
  }
});

export const hevyResolutionSchema = z.discriminatedUnion("action", [
  z.object({
    key: z.string().min(1),
    action: z.literal("match"),
    exerciseId: z.string().uuid(),
  }),
  z.object({
    key: z.string().min(1),
    action: z.literal("create"),
    exercise: customExerciseSchema,
  }),
  z.object({
    key: z.string().min(1),
    action: z.literal("exclude"),
    reason: z.string().trim().min(3).max(300),
  }),
]);

export const confirmHevyImportSchema = z.object({
  importEventId: z.string().uuid(),
  resolutions: z.array(hevyResolutionSchema).min(1).max(1500),
});

export type ConfirmHevyImportInput = z.infer<typeof confirmHevyImportSchema>;

type CatalogExercise = Awaited<ReturnType<typeof loadExercisesForReview>>[number];

function stagedPayload(value: unknown): StagedHevyPayload | null {
  const payload = value as Partial<StagedHevyPayload> | null;
  return payload?.kind === "hevy_history" &&
    payload.schemaVersion === "1" &&
    typeof payload.timezone === "string" &&
    typeof payload.fileHash === "string"
    ? (payload as StagedHevyPayload)
    : null;
}

async function loadExercisesForReview(db: Db, userId: string, ids: string[]) {
  if (!ids.length) return [];
  return db.query.exercises.findMany({
    where: and(
      inArray(exercises.id, ids),
      or(isNull(exercises.userId), eq(exercises.userId, userId))
    ),
    with: { equipmentRequirements: true, family: true },
  });
}

function exerciseCompatible(exercise: CatalogExercise, review: HevyExerciseReview) {
  return exerciseMatchesIdentityHints(
    {
      equipment: exercise.equipmentRequirements.map((item) => item.equipmentType),
      loadType: exercise.loadType,
      loadSemantics: exercise.loadSemantics,
      metricType: exercise.metricType,
      variantAttributes: exercise.variantAttributes,
    },
    extractExerciseIdentity(review.rawName)
  );
}

export async function persistHevyImport(
  db: Db,
  user: { id: string; email: string },
  input: ConfirmHevyImportInput
) {
  const parsedInput = confirmHevyImportSchema.parse(input);
  const event = await db.query.importEvents.findFirst({
    where: and(
      eq(importEvents.id, parsedInput.importEventId),
      eq(importEvents.userId, user.id),
      eq(importEvents.source, "csv")
    ),
  });
  if (!event) return { ok: false as const, reason: "Hevy import not found." };
  if (event.status === "confirmed") {
    return { ok: false as const, reason: "This Hevy import was already confirmed." };
  }
  if (event.status !== "parsed") {
    return { ok: false as const, reason: "This Hevy import is not ready to confirm." };
  }
  const staged = stagedPayload(event.parsedPayload);
  if (!staged) return { ok: false as const, reason: "The staged Hevy review is invalid." };
  const parsed = parseHevyCsv(event.rawPayload, staged.timezone);
  if (parsed.fileHash !== staged.fileHash) {
    return { ok: false as const, reason: "The staged source file no longer matches its review." };
  }

  const activeBatch = await db.query.historyImportBatches.findFirst({
    where: and(
      eq(historyImportBatches.userId, user.id),
      eq(historyImportBatches.fileHash, parsed.fileHash),
      eq(historyImportBatches.status, "confirmed")
    ),
  });
  if (activeBatch) {
    return { ok: false as const, reason: "This Hevy file has already been imported." };
  }

  const expectedKeys = new Set(parsed.exercises.map((exercise) => exercise.key));
  const resolutionByKey = new Map(parsedInput.resolutions.map((resolution) => [resolution.key, resolution]));
  if (
    resolutionByKey.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !resolutionByKey.has(key))
  ) {
    return { ok: false as const, reason: "Every Hevy exercise must be resolved exactly once." };
  }

  const matchIds = [
    ...new Set(
      parsedInput.resolutions
        .filter((resolution) => resolution.action === "match")
        .map((resolution) => resolution.exerciseId)
    ),
  ];
  const matchedExercises = await loadExercisesForReview(db, user.id, matchIds);
  const matchedById = new Map(matchedExercises.map((exercise) => [exercise.id, exercise]));
  const reviewByKey = new Map(staged.exercises.map((exercise) => [exercise.key, exercise]));
  for (const resolution of parsedInput.resolutions) {
    if (resolution.action !== "match") continue;
    const exercise = matchedById.get(resolution.exerciseId);
    const review = reviewByKey.get(resolution.key);
    if (!exercise || !review) {
      return { ok: false as const, reason: "A selected exercise is unavailable." };
    }
    if (!exerciseCompatible(exercise, review)) {
      return {
        ok: false as const,
        reason: `${review.rawName} cannot be matched to ${exercise.name} because its equipment or assistance differs.`,
      };
    }
  }

  const customResolutions = parsedInput.resolutions.filter(
    (resolution): resolution is Extract<(typeof parsedInput.resolutions)[number], { action: "create" }> =>
      resolution.action === "create"
  );
  const familyIds = [...new Set(customResolutions.map((resolution) => resolution.exercise.familyId))];
  const families = familyIds.length
    ? await db.query.exerciseFamilies.findMany({
        where: inArray(exerciseFamilies.id, familyIds),
      })
    : [];
  const familyById = new Map(families.map((family) => [family.id, family]));
  if (families.length !== familyIds.length) {
    return { ok: false as const, reason: "A custom exercise family is unavailable." };
  }
  for (const resolution of customResolutions) {
    const family = familyById.get(resolution.exercise.familyId)!;
    if (family.movementPattern !== resolution.exercise.movementPattern) {
      return { ok: false as const, reason: `${resolution.exercise.name} does not match its selected movement family.` };
    }
  }

  const customNames = customResolutions.map((resolution) => resolution.exercise.name);
  if (new Set(customNames.map(normalizeExerciseText)).size !== customNames.length) {
    return { ok: false as const, reason: "Two staged custom exercises have the same name." };
  }
  if (customNames.length) {
    // Compare normalized so "bench press" cannot slip past an existing
    // "Bench Press"; the catalog is small enough to scan names in memory.
    const normalizedNew = new Set(customNames.map(normalizeExerciseText));
    const existingNames = await db.query.exercises.findMany({
      columns: { name: true },
    });
    const clash = existingNames.find((row) =>
      normalizedNew.has(normalizeExerciseText(row.name))
    );
    if (clash) {
      return {
        ok: false as const,
        reason: `${clash.name} already exists; match it instead of creating a duplicate.`,
      };
    }
  }

  const curatorEmails = (process.env.CATALOG_CURATOR_EMAILS ?? process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (
    customResolutions.some((resolution) => resolution.exercise.promoteToMainLibrary) &&
    !curatorEmails.includes(user.email.toLowerCase())
  ) {
    return { ok: false as const, reason: "Only the catalog curator can add a main-library exercise." };
  }

  const batchId = randomUUID();
  const exerciseIdByKey = new Map<string, string>();
  for (const resolution of parsedInput.resolutions) {
    if (resolution.action === "match") exerciseIdByKey.set(resolution.key, resolution.exerciseId);
  }

  const customExercises = customResolutions.map((resolution) => {
    const id = randomUUID();
    exerciseIdByKey.set(resolution.key, id);
    return {
      id,
      user_id: resolution.exercise.promoteToMainLibrary ? null : user.id,
      family_id: resolution.exercise.familyId,
      name: resolution.exercise.name,
      movement_pattern: resolution.exercise.movementPattern,
      primary_muscles: resolution.exercise.primaryMuscles,
      secondary_muscles: resolution.exercise.secondaryMuscles,
      is_unilateral: resolution.exercise.isUnilateral,
      load_type: resolution.exercise.loadType,
      activity_class: resolution.exercise.activityClass,
      metric_type: resolution.exercise.metricType,
      load_semantics: resolution.exercise.loadSemantics,
      variant_key: catalogKey(
        `${resolution.exercise.name}-${resolution.exercise.equipment.join("-")}`
      ),
      variant_attributes: {
        laterality: resolution.exercise.isUnilateral ? "unilateral" : "bilateral",
        assistance:
          resolution.exercise.loadSemantics === "assistance"
            ? "assisted"
            : resolution.exercise.loadSemantics === "added_weight"
              ? "weighted"
              : "none",
      },
      catalog_reviewed: resolution.exercise.promoteToMainLibrary,
      created_from_import_event_id: event.id,
      equipment: resolution.exercise.equipment,
    };
  });

  const excludedKeys = new Set(
    parsedInput.resolutions
      .filter((resolution) => resolution.action === "exclude")
      .map((resolution) => resolution.key)
  );
  const sessions: Array<Record<string, unknown>> = [];
  const sessionExercises: Array<Record<string, unknown>> = [];
  const completedSets: Array<Record<string, unknown>> = [];
  const sessionNotes: Array<Record<string, unknown>> = [];
  let importedOccurrences = 0;
  let importedSets = 0;
  let importedWarmupSets = 0;
  const importedSupersets = new Set<string>();

  for (const workout of parsed.workouts) {
    const sessionId = randomUUID();
    const kept = workout.occurrences.filter(
      (occurrence) => !excludedKeys.has(hevyMappingKey(occurrence.rawName))
    );
    const retainedSupersetMembers = new Map<string, Set<string>>();
    for (const occurrence of kept) {
      if (!occurrence.supersetId) continue;
      const members = retainedSupersetMembers.get(occurrence.supersetId) ?? new Set<string>();
      members.add(occurrence.rawName);
      retainedSupersetMembers.set(occurrence.supersetId, members);
    }
    const validSupersetIds = new Set(
      [...retainedSupersetMembers]
        .filter(([, members]) => members.size >= 2)
        .map(([id]) => id)
    );
    sessions.push({
      id: sessionId,
      user_id: user.id,
      import_batch_id: batchId,
      template_name: workout.title,
      source_workout_key: workout.sourceKey,
      data_quality_flags: workout.dataQualityFlags,
      exclude_duration_from_analytics: workout.excludeDurationFromAnalytics,
      started_at: workout.startedAt.toISOString(),
      finished_at: workout.finishedAt.toISOString(),
      timezone: staged.timezone,
      local_date: workoutLocalDate(workout.startedAt, staged.timezone),
    });
    if (workout.description) {
      sessionNotes.push({
        id: randomUUID(),
        session_id: sessionId,
        text: workout.description,
        created_at: workout.startedAt.toISOString(),
      });
    }
    for (const [orderIdx, occurrence] of kept.entries()) {
      const key = hevyMappingKey(occurrence.rawName);
      const exerciseId = exerciseIdByKey.get(key);
      if (!exerciseId) throw new Error(`Resolved exercise missing for ${occurrence.rawName}.`);
      const sessionExerciseId = randomUUID();
      sessionExercises.push({
        id: sessionExerciseId,
        session_id: sessionId,
        exercise_id: exerciseId,
        source_exercise_key: occurrence.sourceKey,
        source_exercise_name: occurrence.rawName,
        order_idx: orderIdx,
        superset_key:
          occurrence.supersetId && validSupersetIds.has(occurrence.supersetId)
            ? occurrence.supersetId
            : null,
        notes: occurrence.notes,
      });
      importedOccurrences += 1;
      if (occurrence.supersetId && validSupersetIds.has(occurrence.supersetId)) {
        importedSupersets.add(`${workout.sourceKey}:${occurrence.supersetId}`);
      }
      for (const [setOffset, row] of occurrence.rows.entries()) {
        const excludeFromAnalytics = isSuspiciousSetDuration({
          durationSeconds: row.durationSeconds,
          metricType: row.metricType,
          workoutSeconds: workout.durationMinutes * 60,
        });
        completedSets.push({
          id: randomUUID(),
          session_exercise_id: sessionExerciseId,
          set_no: setOffset + 1,
          weight: row.weightLbs,
          weight_unit: row.weightLbs == null ? null : "lb",
          reps: row.reps,
          metric_type: row.metricType,
          distance_km: row.distanceKm,
          duration_seconds: row.durationSeconds,
          rpe: row.rpe,
          is_warmup: row.setType === "warmup",
          note: row.exerciseNotes,
          source_set_index: row.setIndex,
          source_row: row.sourceRow,
          exclude_from_analytics: excludeFromAnalytics,
        });
        importedSets += 1;
        if (row.setType === "warmup") importedWarmupSets += 1;
      }
    }
  }

  const summary = {
    workouts: sessions.length,
    exerciseOccurrences: importedOccurrences,
    sets: importedSets,
    warmupSets: importedWarmupSets,
    supersetGroups: importedSupersets.size,
    excludedExercises: excludedKeys.size,
    warnings: parsed.profile.warnings.length,
  };

  const mappings = parsed.exercises
    .filter((review) => !excludedKeys.has(review.key))
    .map((review) => ({
      id: randomUUID(),
      version_id: randomUUID(),
      user_id: user.id,
      source_name: review.rawName,
      source_equipment: review.equipment,
      normalized_key: review.key,
      exercise_id: exerciseIdByKey.get(review.key),
    }));
  const customRequirements = customExercises.flatMap((exercise) =>
    exercise.equipment.map((type) => ({
      id: randomUUID(),
      exercise_id: exercise.id,
      equipment_type: type,
    }))
  );
  const customSources = customExercises.map((exercise) => ({
    id: randomUUID(),
    exercise_id: exercise.id,
    source_id: reviewByKey.get(
      customResolutions.find((resolution) => exerciseIdByKey.get(resolution.key) === exercise.id)!.key
    )!.key,
  }));

  const query = sql`
    WITH history_revision_lock AS MATERIALIZED (
      ${historyRevisionLockSql(user.id)}
    ), target_event AS MATERIALIZED (
      SELECT id
      FROM import_events
      CROSS JOIN history_revision_lock
      WHERE id = ${event.id}::uuid
        AND user_id = ${user.id}::uuid
        AND source = 'csv'
        AND status = 'parsed'
        AND parsed_payload = ${JSON.stringify(event.parsedPayload)}::jsonb
      FOR UPDATE
    ), new_batch AS (
      INSERT INTO history_import_batches (
        id, user_id, import_event_id, source, original_filename, file_hash,
        timezone, status, summary, confirmed_at
      )
      SELECT
        ${batchId}::uuid, ${user.id}::uuid, ${event.id}::uuid, 'hevy',
        ${staged.originalFilename}, ${parsed.fileHash}, ${staged.timezone},
        'confirmed', ${JSON.stringify(summary)}::jsonb, now()
      FROM target_event
      WHERE NOT EXISTS (
        SELECT 1 FROM history_import_batches
        WHERE user_id = ${user.id}::uuid
          AND file_hash = ${parsed.fileHash}
          AND status = 'confirmed'
      )
      RETURNING id
    ), custom_exercise_input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(customExercises)}::jsonb) AS x(
        id uuid, user_id uuid, family_id uuid, name text,
        movement_pattern movement_pattern, primary_muscles jsonb,
        secondary_muscles jsonb, is_unilateral boolean, load_type text,
        activity_class activity_class, metric_type metric_type,
        load_semantics load_semantics, variant_key text,
        variant_attributes jsonb, catalog_reviewed boolean,
        created_from_import_event_id uuid, equipment jsonb
      )
    ), inserted_exercises AS (
      INSERT INTO exercises (
        id, user_id, family_id, name, movement_pattern, primary_muscles,
        secondary_muscles, is_unilateral, load_type, activity_class,
        metric_type, load_semantics, variant_key, variant_attributes,
        catalog_reviewed, created_from_import_event_id
      )
      SELECT
        x.id, x.user_id, x.family_id, x.name, x.movement_pattern,
        x.primary_muscles, x.secondary_muscles, x.is_unilateral, x.load_type,
        x.activity_class, x.metric_type, x.load_semantics, x.variant_key,
        x.variant_attributes, x.catalog_reviewed, x.created_from_import_event_id
      FROM custom_exercise_input x
      WHERE EXISTS (SELECT 1 FROM new_batch)
      RETURNING id
    ), requirement_input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(customRequirements)}::jsonb) AS x(
        id uuid, exercise_id uuid, equipment_type equipment_type
      )
    ), inserted_requirements AS (
      INSERT INTO exercise_equipment_requirements (id, exercise_id, equipment_type)
      SELECT x.id, x.exercise_id, x.equipment_type
      FROM requirement_input x
      WHERE EXISTS (SELECT 1 FROM new_batch)
      RETURNING id
    ), source_input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(customSources)}::jsonb) AS x(
        id uuid, exercise_id uuid, source_id text
      )
    ), inserted_sources AS (
      INSERT INTO exercise_sources (
        id, exercise_id, source_name, source_id, license, reviewed_at
      )
      SELECT x.id, x.exercise_id, 'Hevy user history', x.source_id,
        'User-owned workout metadata', now()
      FROM source_input x
      WHERE EXISTS (SELECT 1 FROM new_batch)
      RETURNING id
    ), session_input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(sessions)}::jsonb) AS x(
        id uuid, user_id uuid, import_batch_id uuid, template_name text,
        source_workout_key text, data_quality_flags jsonb,
        exclude_duration_from_analytics boolean,
        started_at timestamptz, finished_at timestamptz,
        timezone text, local_date date
      )
    ), inserted_sessions AS (
      INSERT INTO workout_sessions (
        id, user_id, import_batch_id, template_name, source,
        source_workout_key, data_quality_flags, exclude_duration_from_analytics,
        status, started_at, finished_at, timezone, local_date
      )
      SELECT
        x.id, x.user_id, x.import_batch_id, x.template_name, 'hevy',
        x.source_workout_key, x.data_quality_flags,
        x.exclude_duration_from_analytics, 'completed', x.started_at, x.finished_at,
        x.timezone, x.local_date
      FROM session_input x
      WHERE EXISTS (SELECT 1 FROM new_batch)
      RETURNING id
    ), session_exercise_input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(sessionExercises)}::jsonb) AS x(
        id uuid, session_id uuid, exercise_id uuid, source_exercise_key text,
        source_exercise_name text, order_idx integer, superset_key text, notes text
      )
    ), inserted_session_exercises AS (
      INSERT INTO session_exercises (
        id, session_id, exercise_id, source_exercise_key, source_exercise_name,
        modification_type, order_idx, superset_key, rest_sec, notes
      )
      SELECT
        x.id, x.session_id, x.exercise_id, x.source_exercise_key,
        x.source_exercise_name, 'as_planned', x.order_idx, x.superset_key, 90, x.notes
      FROM session_exercise_input x
      WHERE EXISTS (SELECT 1 FROM new_batch)
      RETURNING id, session_id, exercise_id, order_idx
    ), set_input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(completedSets)}::jsonb) AS x(
        id uuid, session_exercise_id uuid, set_no integer, weight double precision,
        weight_unit unit, reps integer, metric_type metric_type,
        distance_km real, duration_seconds integer, rpe real,
        is_warmup boolean, note text, source_set_index integer, source_row integer,
        exclude_from_analytics boolean
      )
    ), inserted_sets AS (
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, weight, weight_unit, reps, metric_type,
        performed_semantics_version, performed_load_type,
        performed_load_semantics,
        distance_km, duration_seconds, rpe, is_warmup, note, source_set_index,
        source_row, exclude_from_analytics
      )
      SELECT
        x.id, x.session_exercise_id, x.set_no, x.weight, x.weight_unit, x.reps,
        x.metric_type, 1, definition.load_type, definition.load_semantics,
        x.distance_km, x.duration_seconds, x.rpe, x.is_warmup,
        x.note, x.source_set_index, x.source_row, x.exclude_from_analytics
      FROM set_input x
      JOIN inserted_session_exercises session_exercise
        ON session_exercise.id = x.session_exercise_id
      JOIN exercises definition
        ON definition.id = session_exercise.exercise_id
      WHERE EXISTS (SELECT 1 FROM new_batch)
      RETURNING id, session_exercise_id, set_no, is_warmup, logged_at
    ), inserted_occurrences AS (
      INSERT INTO session_occurrences (
        session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome, resolved_at,
        completed_set_id
      )
      SELECT
        exercise.session_id,
        exercise.id,
        'working_set',
        'imported',
        row_number() OVER (
          PARTITION BY exercise.session_id
          ORDER BY exercise.order_idx, completed.set_no, completed.id
        ) - 1,
        row_number() OVER (
          PARTITION BY exercise.id
          ORDER BY completed.set_no, completed.id
        ) - 1,
        exercise.exercise_id,
        'completed',
        completed.logged_at,
        completed.id
      FROM inserted_sets completed
      JOIN inserted_session_exercises exercise
        ON exercise.id = completed.session_exercise_id
      WHERE completed.is_warmup = false
      RETURNING id
    ), note_input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(sessionNotes)}::jsonb) AS x(
        id uuid, session_id uuid, text text, created_at timestamptz
      )
    ), inserted_notes AS (
      INSERT INTO session_notes (id, session_id, text, created_at)
      SELECT x.id, x.session_id, x.text, x.created_at
      FROM note_input x
      WHERE EXISTS (SELECT 1 FROM new_batch)
      RETURNING id
    ), mapping_input AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(mappings)}::jsonb) AS x(
        id uuid, version_id uuid, user_id uuid, source_name text, source_equipment text,
        normalized_key text, exercise_id uuid
      )
    ), current_mappings AS MATERIALIZED (
      SELECT current.*, to_jsonb(current) AS before_data
      FROM external_exercise_mappings current
      JOIN mapping_input input
        ON input.user_id = current.user_id
       AND current.source = 'hevy'
       AND input.normalized_key = current.normalized_key
    ), inserted_mappings AS (
      INSERT INTO external_exercise_mappings (
        id, user_id, source, source_name, source_equipment,
        normalized_key, exercise_id, confirmed_at
      )
      SELECT x.id, x.user_id, 'hevy', x.source_name, x.source_equipment,
        x.normalized_key, x.exercise_id, now()
      FROM mapping_input x
      WHERE EXISTS (SELECT 1 FROM new_batch)
      ON CONFLICT (user_id, source, normalized_key) DO UPDATE SET
        source_name = EXCLUDED.source_name,
        source_equipment = EXCLUDED.source_equipment,
        exercise_id = EXCLUDED.exercise_id,
        confirmed_at = now()
      WHERE ROW(
        external_exercise_mappings.source_name,
        external_exercise_mappings.source_equipment,
        external_exercise_mappings.exercise_id
      ) IS DISTINCT FROM ROW(
        EXCLUDED.source_name,
        EXCLUDED.source_equipment,
        EXCLUDED.exercise_id
      )
      RETURNING id, normalized_key
    ), versioned_mappings AS (
      INSERT INTO record_versions (
        id, user_id, entity_type, entity_id, action,
        before_data, after_data, changed_fields
      )
      SELECT
        input.version_id,
        input.user_id,
        'external_exercise_mapping',
        current.id,
        'mapping.update',
        current.before_data,
        current.before_data || jsonb_build_object(
          'source_name', input.source_name,
          'source_equipment', input.source_equipment,
          'exercise_id', input.exercise_id,
          'confirmed_at', now()
        ),
        ARRAY(
          SELECT old_value.key
          FROM jsonb_each(current.before_data) old_value
          JOIN jsonb_each(
            current.before_data || jsonb_build_object(
              'source_name', input.source_name,
              'source_equipment', input.source_equipment,
              'exercise_id', input.exercise_id,
              'confirmed_at', now()
            )
          ) new_value USING (key)
          WHERE old_value.value IS DISTINCT FROM new_value.value
          ORDER BY old_value.key
        )
      FROM current_mappings current
      JOIN mapping_input input
        ON input.user_id = current.user_id
       AND input.normalized_key = current.normalized_key
      JOIN inserted_mappings applied ON applied.id = current.id
      RETURNING id
    ), updated_event AS (
      UPDATE import_events SET
        status = 'confirmed',
        payload_sha256 = coalesce(
          payload_sha256,
          encode(sha256(convert_to(raw_payload, 'UTF8')), 'hex')
        ),
        raw_payload = '',
        parsed_payload = NULL,
        confirmed_payload = ${JSON.stringify({
          schemaVersion: "1",
          resolutions: parsedInput.resolutions,
        })}::jsonb,
        raw_redacted_at = now(),
        retention_expires_at = NULL
      WHERE id IN (SELECT id FROM target_event)
        AND EXISTS (SELECT 1 FROM new_batch)
      RETURNING id
    ), inserted_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary, cause_ref
      )
      SELECT
        ${user.id}::uuid,
        'user',
        'history_import.confirm',
        'history_import_batch',
        new_batch.id::text,
        'Imported ' || ${summary.workouts}::int || ' Hevy workouts and ' ||
          ${summary.sets}::int || ' set records',
        jsonb_build_object(
          'importEventId', ${event.id}::text,
          'summary', ${JSON.stringify(summary)}::jsonb
        )
      FROM new_batch
      RETURNING id
    )
    SELECT
      (SELECT count(*)::int FROM new_batch) AS batches,
      (SELECT count(*)::int FROM inserted_sessions) AS workouts,
      (SELECT count(*)::int FROM inserted_session_exercises) AS exercises,
      (SELECT count(*)::int FROM inserted_sets) AS sets,
      (SELECT count(*)::int FROM inserted_occurrences) AS occurrences,
      (SELECT count(*)::int FROM inserted_mappings) AS mappings,
      (SELECT count(*)::int FROM versioned_mappings) AS mapping_versions,
      (SELECT count(*)::int FROM inserted_audit) AS audits
  `;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = resultRows(await db.execute(query));
  } catch (error) {
    // A concurrent confirm of the same file trips the partial unique index
    // instead of the CTE's NOT EXISTS guard; report it as the duplicate it is.
    if (
      error instanceof Error &&
      error.message.includes("history_import_batches_confirmed_hash_uq")
    ) {
      return { ok: false as const, reason: "This Hevy file has already been imported." };
    }
    throw error;
  }
  const result = rows[0];
  if (!result || Number(result.batches) !== 1) {
    return { ok: false as const, reason: "This Hevy file has already been imported." };
  }
  if (
    Number(result.workouts) !== summary.workouts ||
    Number(result.exercises) !== summary.exerciseOccurrences ||
    Number(result.sets) !== summary.sets ||
    Number(result.occurrences) !== summary.sets - summary.warmupSets ||
    Number(result.audits) !== 1
  ) {
    // The statement has already committed, so the batch exists with an
    // unexpected shape. Point at the recovery path instead of claiming a
    // rollback that never happened.
    throw new Error(
      `Hevy import wrote an unexpected number of rows and the batch was still committed. Remove import batch ${batchId} from the Import screen, then retry.`
    );
  }
  return { ok: true as const, batchId, summary };
}
