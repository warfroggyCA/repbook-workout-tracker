import { randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  workoutSessions,
  completedSets,
  painLogs,
  exercises,
  exercisePrescriptions,
  equipmentItems,
  plateInventory,
  barbellConfigs,
  constraints as constraintsTable,
  recommendations,
  userProfiles,
  type RecommendationPayload,
  type RecommendationEvidence,
  type CoachingPrefs,
} from "@/db/schema";
import {
  evaluateSlot,
  type Exposure,
  type PainEvent,
} from "@/engine/progression/rules";
import { progressionConfig as cfg } from "@/engine/progression/config";
import {
  nextLoadUp as plateNextUp,
  achievableLoads,
  nextIncrementalUp,
  incrementalLoads,
  type PlateMathConfig,
} from "@/engine/plate-math";
import {
  buildEquipmentAvailability,
  exerciseIsAvailable,
} from "@/engine/equipment-filter";
import { platePairsPerSide } from "@/lib/equipment-inventory-contract";
import { isPatternAllowedForSuggestions } from "@/engine/constraint-filter";
import { audit } from "./audit";
import { convertWeight } from "@/lib/units";
import { PROGRESSION_JOB_MAX_ATTEMPTS } from "@/lib/progression-job-contract";
import { eligibleAutomaticProgressionSql } from "@/lib/set-metric-semantics-sql";
import { reconcilePendingPainRecommendations } from "@/services/recommendation-evidence-eligibility";

type LoadSteppers = {
  nextLoadUp: (current: number) => number | null;
  roundDown: (target: number) => number | null;
};

export type ProgressionReadObservation = {
  stage: string;
  rows: number;
};

type OnDemandProgressionResult =
  | { status: "completed" | "stale" | "lease_lost"; jobId: string }
  | { status: "unavailable"; jobId: string | null }
  | {
      status: "failed";
      jobId: string;
      retryScheduled: boolean;
      error: unknown;
    };

type OnDemandProgressionDependencies = {
  processJob?: (
    db: Db,
    jobId: string,
    dependencies: { userId: string },
  ) => Promise<OnDemandProgressionResult>;
};

async function recordProgressionRecommendation(
  db: Db,
  input: {
    userId: string;
    progressionJobId: string | null;
    sourceTemplateExerciseId: string;
    sourceSlotLineageId: string;
    ruleId: string;
    exerciseId: string;
    payload: RecommendationPayload;
    reason: string;
    evidence: RecommendationEvidence;
    sessionId: string;
    exerciseName: string;
  }
) {
  const recommendationId = randomUUID();
  const idempotencyKey = input.progressionJobId
    ? `progression:${input.progressionJobId}:${input.sourceSlotLineageId}:recommendation`
    : null;
  const evidenceSetIds = input.evidence.setIds ?? [];
  const evidenceSetIdsJson = JSON.stringify(evidenceSetIds);
  const requiresComparableLoadEvidence = input.payload.kind === "load_change";
  const query = sql`
    WITH eligible_evidence AS MATERIALIZED (
      SELECT true AS eligible
      WHERE NOT ${requiresComparableLoadEvidence}::boolean
        OR (
          jsonb_array_length(${evidenceSetIdsJson}::jsonb) > 0
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(${evidenceSetIdsJson}::jsonb) evidence_set(id)
            LEFT JOIN completed_sets completed
              ON completed.id = evidence_set.id::uuid
            LEFT JOIN session_exercises session_exercise
              ON session_exercise.id = completed.session_exercise_id
            LEFT JOIN workout_sessions session
              ON session.id = session_exercise.session_id
            LEFT JOIN exercises exercise
              ON exercise.id = session_exercise.exercise_id
            WHERE completed.id IS NULL
              OR session.user_id <> ${input.userId}::uuid
              OR session.status <> 'completed'
              OR session.archived_at IS NOT NULL
              OR session_exercise.modification_type <> 'as_planned'
              OR completed.archived_at IS NOT NULL
              OR NOT ${eligibleAutomaticProgressionSql({
                recordedMetricType: sql`completed.metric_type`,
                prescribedSemanticsVersion:
                  sql`session_exercise.prescribed_semantics_version`,
                performedSemanticsVersion: sql`completed.performed_semantics_version`,
                performedLoadType: sql`completed.performed_load_type`,
                performedLoadSemantics: sql`completed.performed_load_semantics`,
                exerciseMetricType: sql`exercise.metric_type`,
                loadType: sql`exercise.load_type`,
                loadSemantics: sql`exercise.load_semantics`,
                loadEntryMeaning: sql`completed.load_entry_meaning`,
                weight: sql`completed.weight`,
                reps: sql`completed.reps`,
                excludeFromAnalytics: sql`completed.exclude_from_analytics`,
              })}
          )
        )
    ), inserted AS (
      INSERT INTO recommendations (
        id, user_id, source, rule_id, exercise_id, progression_job_id,
        source_template_exercise_id, source_slot_lineage_id,
        payload, reason, evidence
      )
      SELECT
        ${recommendationId}::uuid,
        ${input.userId}::uuid,
        'rule',
        ${input.ruleId}::text,
        ${input.exerciseId}::uuid,
        ${input.progressionJobId}::uuid,
        ${input.sourceTemplateExerciseId}::uuid,
        ${input.sourceSlotLineageId}::uuid,
        ${JSON.stringify(input.payload)}::jsonb,
        ${input.reason}::text,
        ${JSON.stringify(input.evidence)}::jsonb
      FROM eligible_evidence
      ON CONFLICT (progression_job_id, source_slot_lineage_id)
        WHERE progression_job_id IS NOT NULL
          AND source_slot_lineage_id IS NOT NULL
      DO UPDATE SET
        source_template_exercise_id = excluded.source_template_exercise_id,
        rule_id = excluded.rule_id,
        exercise_id = excluded.exercise_id,
        payload = excluded.payload,
        reason = excluded.reason,
        evidence = excluded.evidence,
        status = 'pending',
        decided_at = NULL,
        reconciled_at = NULL,
        reconciliation_reason = NULL,
        reconciled_by_program_version_id = NULL
      WHERE recommendations.status = 'expired'
        AND recommendations.reconciliation_reason =
          'Superseded by progression re-evaluation.'
        AND recommendations.archived_at IS NULL
      RETURNING id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary,
        cause_ref, idempotency_key
      )
      SELECT
        ${input.userId}::uuid,
        'rule',
        'recommendation.create',
        'recommendation',
        inserted.id::text,
        ${`${input.exerciseName}: ${input.reason}`}::text,
        jsonb_build_object(
          'sessionId', ${input.sessionId}::uuid,
          'ruleId', ${input.ruleId}::text,
          'progressionJobId', ${input.progressionJobId}::uuid
        ),
        ${idempotencyKey}::text
      FROM inserted
      ON CONFLICT DO NOTHING
      RETURNING id
    )
    SELECT id FROM inserted
  `;
  const row = resultRows(await db.execute(query))[0];
  return row?.id ? String(row.id) : null;
}

type IncrementalEquipmentConfig = {
  minWeight?: number;
  maxWeight?: number;
  increments?: number[];
};

/**
 * Repeated dumbbell or kettlebell rows form one truthful set of achievable
 * loads. Progression must not depend on whichever same-type row happened to
 * be returned last by the database.
 */
export function mergeIncrementalEquipmentConfigs(
  items: Array<{
    type: string;
    available: boolean;
    attrs: IncrementalEquipmentConfig;
  }>
): Record<string, IncrementalEquipmentConfig> {
  const merged: Record<string, IncrementalEquipmentConfig> = {};
  for (const item of items) {
    if (
      (item.type !== "dumbbell" && item.type !== "kettlebell") ||
      !item.available
    ) {
      continue;
    }
    const existing = merged[item.type];
    const availableWeights = [
      ...(existing?.increments ?? []),
      ...(item.attrs.increments ?? []),
    ];
    merged[item.type] = {
      minWeight:
        existing?.minWeight == null
          ? item.attrs.minWeight
          : item.attrs.minWeight == null
            ? existing.minWeight
            : Math.min(existing.minWeight, item.attrs.minWeight),
      maxWeight:
        existing?.maxWeight == null
          ? item.attrs.maxWeight
          : item.attrs.maxWeight == null
            ? existing.maxWeight
            : Math.max(existing.maxWeight, item.attrs.maxWeight),
      increments:
        availableWeights.length > 0
          ? [...new Set(availableWeights)].sort((a, b) => a - b)
          : undefined,
    };
  }
  return merged;
}

export function steppersForLoadType(
  loadType: string,
  plateConfigs: Record<string, PlateMathConfig>,
  incrementals: Record<string, { minWeight?: number; maxWeight?: number; increments?: number[] }>
): LoadSteppers {
  const plateConfig = plateConfigs[loadType];
  if (plateConfig) {
    return {
      nextLoadUp: (current) => plateNextUp(current, plateConfig)?.totalLoad ?? null,
      roundDown: (target) => {
        const below = achievableLoads(plateConfig).filter((load) => load <= target);
        return below.length ? below[below.length - 1] : null;
      },
    };
  }
  const inc = incrementals[loadType];
  if (inc) {
    return {
      nextLoadUp: (current) => nextIncrementalUp(current, inc),
      roundDown: (target) => {
        const below = incrementalLoads(inc).filter((l) => l <= target);
        return below.length ? below[below.length - 1] : null;
      },
    };
  }
  return {
    nextLoadUp: (current) => current + cfg.defaultIncrement,
    roundDown: (target) =>
      Math.floor(target / cfg.defaultIncrement) * cfg.defaultIncrement,
  };
}

/**
 * Runs the deterministic rule engine over a just-completed session and files
 * pending Recommendations (plan §7). Never mutates prescriptions. Pain holds
 * remain visible as non-actionable Review status while their evidence applies.
 */
export async function evaluateSessionProgression(
  db: Db,
  userId: string,
  sessionId: string,
  coachingPrefs?: CoachingPrefs,
  progressionJobId?: string,
  observeRead?: (observation: ProgressionReadObservation) => void
): Promise<void> {
  const session = await db.query.workoutSessions.findFirst({
    where: and(
      eq(workoutSessions.id, sessionId),
      isNull(workoutSessions.archivedAt)
    ),
    with: {
      exercises: {
        with: {
          exercise: true,
          sets: { where: isNull(completedSets.archivedAt) },
        },
      },
    },
  });
  observeRead?.({ stage: "session", rows: session ? 1 : 0 });
  if (!session) return;

  const sourceExercises = session.exercises.filter(
    (exercise) =>
      exercise.sourceSlotLineageId != null &&
      exercise.modificationType === "as_planned"
  );
  const sourceLineageIds = sourceExercises.map(
    (exercise) => exercise.sourceSlotLineageId!
  );
  if (!sourceLineageIds.length || session.sourceProgramId == null) return;
  const sourceLineageList = sql.join(
    sourceLineageIds.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  const rawMappings = await db.execute(sql`
    SELECT
      current_slot.lineage_id AS lineage_id,
      current_slot.id AS current_slot_id
    FROM programs program
    JOIN program_versions current_version
      ON current_version.id = program.current_version_id
     AND current_version.program_id = program.id
    JOIN workout_templates current_template
      ON current_template.program_version_id = current_version.id
    JOIN workout_template_exercises current_slot
      ON current_slot.workout_template_id = current_template.id
    WHERE current_slot.lineage_id IN (${sourceLineageList})
      AND program.id = ${session.sourceProgramId}::uuid
      AND program.user_id = ${userId}::uuid
      AND program.status = 'active'
      AND program.archived_at IS NULL
  `);
  const mappingRows = resultRows<{
    lineage_id: string;
    current_slot_id: string;
  }>(rawMappings);
  observeRead?.({ stage: "lineage_mappings", rows: mappingRows.length });
  const mappingBySourceSlot = new Map(
    mappingRows.map((mapping) => [mapping.lineage_id, mapping])
  );
  const eligibleExercises = sourceExercises.flatMap((exercise) => {
    const mapping = mappingBySourceSlot.get(
      exercise.sourceSlotLineageId!
    );
    return mapping ? [{ exercise, mapping }] : [];
  });
  if (!eligibleExercises.length) return;
  await reconcilePendingPainRecommendations(db, userId);
  const slotIds = eligibleExercises.map(
    ({ mapping }) => mapping.current_slot_id
  );
  const lineageIds = [
    ...new Set(eligibleExercises.map(({ mapping }) => mapping.lineage_id)),
  ];
  const painExerciseIds = [
    ...new Set(eligibleExercises.map(({ exercise }) => exercise.exercise.id)),
  ];
  const movementPatterns = [
    ...new Set(
      eligibleExercises.map(
        ({ exercise }) => exercise.exercise.movementPattern
      )
    ),
  ];
  const slotList = sql.join(
    slotIds.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  const painWindowEnd = new Date();
  const painWindowStart = new Date(
    painWindowEnd.getTime() - cfg.painWindowDays * 24 * 60 * 60 * 1000
  );
  const snoozeStart = new Date(
    Date.now() - cfg.rejectionSnoozeDays * 24 * 60 * 60 * 1000
  );

  const [
    bars,
    plates,
    equipment,
    userConstraints,
    profile,
    recentPainRows,
    prescriptions,
    rawExposures,
    recommendationState,
    alternatives,
  ] = await Promise.all([
    db.query.barbellConfigs.findMany({ where: eq(barbellConfigs.userId, userId) }),
    db.query.plateInventory.findMany({ where: eq(plateInventory.userId, userId) }),
    db.query.equipmentItems.findMany({ where: eq(equipmentItems.userId, userId) }),
    db.query.constraints.findMany({ where: eq(constraintsTable.userId, userId) }),
    db.query.userProfiles.findFirst({ where: eq(userProfiles.userId, userId) }),
    db
      .select({
        id: painLogs.id,
        severity: painLogs.severity,
        createdAt: painLogs.createdAt,
        bodyPart: painLogs.bodyPart,
        exerciseId: painLogs.exerciseId,
        sessionId: painLogs.sessionId,
      })
      .from(painLogs)
      .innerJoin(
        workoutSessions,
        eq(painLogs.sessionId, workoutSessions.id),
      )
      .where(
        and(
          eq(painLogs.userId, userId),
          eq(workoutSessions.userId, userId),
          eq(workoutSessions.status, "completed"),
          isNull(workoutSessions.archivedAt),
          isNull(painLogs.archivedAt),
          gt(painLogs.severity, 0),
          lte(painLogs.severity, 10),
          sql`length(btrim(${painLogs.bodyPart})) BETWEEN 1 AND 50`,
          inArray(painLogs.exerciseId, painExerciseIds),
          gt(painLogs.createdAt, painWindowStart),
          lte(painLogs.createdAt, painWindowEnd)
        )
      )
      .orderBy(desc(painLogs.createdAt), desc(painLogs.id)),
    db.query.exercisePrescriptions.findMany({
      where: and(
        inArray(exercisePrescriptions.templateExerciseId, slotIds),
        isNull(exercisePrescriptions.supersededById)
      ),
    }),
    db.execute(sql`
      WITH requested_slots AS MATERIALIZED (
        SELECT
          current_slot.id AS current_slot_id,
          current_slot.lineage_id,
          current_slot.exercise_id,
          current_version.program_id
        FROM workout_template_exercises current_slot
        JOIN workout_templates current_template
          ON current_template.id = current_slot.workout_template_id
        JOIN program_versions current_version
          ON current_version.id = current_template.program_version_id
        JOIN programs program ON program.id = current_version.program_id
        WHERE current_slot.id IN (${slotList})
          AND program.user_id = ${userId}::uuid
          AND program.status = 'active'
          AND program.archived_at IS NULL
          AND program.current_version_id = current_version.id
      ), ranked_exposures AS (
        SELECT
          requested.current_slot_id AS slot_id,
          ws.id AS session_id,
          ws.started_at,
          cs.id AS set_id,
          cs.set_no,
          cs.weight,
          cs.weight_unit,
          cs.reps,
          cs.rpe,
          dense_rank() OVER (
            PARTITION BY requested.current_slot_id
            ORDER BY ws.started_at DESC, ws.id DESC
          ) AS exposure_rank
        FROM workout_sessions ws
        JOIN session_exercises se ON se.session_id = ws.id
        JOIN requested_slots requested
         ON requested.program_id = ws.source_program_id
         AND requested.lineage_id = se.source_slot_lineage_id
         AND requested.exercise_id = se.exercise_id
        JOIN completed_sets cs ON cs.session_exercise_id = se.id
        JOIN exercises source_exercise
          ON source_exercise.id = se.exercise_id
        JOIN session_occurrences occurrence
          ON occurrence.completed_set_id = cs.id
         AND occurrence.session_exercise_id = se.id
         AND occurrence.kind = 'working_set'
         AND occurrence.outcome = 'completed'
        WHERE ws.user_id = ${userId}::uuid
          AND ws.status = 'completed'
          AND ws.archived_at IS NULL
          AND se.modification_type = 'as_planned'
          AND se.exercise_id = requested.exercise_id
          AND cs.archived_at IS NULL
          AND NOT cs.is_warmup
          AND ${eligibleAutomaticProgressionSql({
            recordedMetricType: sql`cs.metric_type`,
            prescribedSemanticsVersion: sql`se.prescribed_semantics_version`,
            performedSemanticsVersion: sql`cs.performed_semantics_version`,
            performedLoadType: sql`cs.performed_load_type`,
            performedLoadSemantics: sql`cs.performed_load_semantics`,
            exerciseMetricType: sql`source_exercise.metric_type`,
            loadType: sql`source_exercise.load_type`,
            loadSemantics: sql`source_exercise.load_semantics`,
            loadEntryMeaning: sql`cs.load_entry_meaning`,
            weight: sql`cs.weight`,
            reps: sql`cs.reps`,
            excludeFromAnalytics: sql`cs.exclude_from_analytics`,
          })}
      )
      SELECT * FROM ranked_exposures
      WHERE exposure_rank <= 4
      ORDER BY slot_id, exposure_rank, set_no
    `),
    db.query.recommendations.findMany({
      where: and(
        eq(recommendations.userId, userId),
        isNull(recommendations.archivedAt),
        inArray(recommendations.sourceSlotLineageId, lineageIds),
        or(
          eq(recommendations.status, "pending"),
          gte(recommendations.decidedAt, snoozeStart)
        )
      ),
      orderBy: desc(recommendations.createdAt),
    }),
    db.query.exercises.findMany({
      where: inArray(exercises.movementPattern, movementPatterns),
      with: { equipmentRequirements: true },
    }),
  ]);
  const availabilityInventory = buildEquipmentAvailability(equipment, plates);
  observeRead?.({ stage: "bars", rows: bars.length });
  observeRead?.({ stage: "plates", rows: plates.length });
  observeRead?.({ stage: "equipment", rows: equipment.length });
  observeRead?.({ stage: "constraints", rows: userConstraints.length });
  observeRead?.({ stage: "profile", rows: profile ? 1 : 0 });
  observeRead?.({ stage: "pain", rows: recentPainRows.length });
  observeRead?.({ stage: "prescriptions", rows: prescriptions.length });
  const exposureRows = resultRows(rawExposures) as Array<{
    slot_id: string;
    session_id: string;
    started_at: Date | string;
    set_id: string;
    weight: number | null;
    weight_unit: "lb" | "kg" | null;
    reps: number;
    rpe: number | null;
  }>;
  observeRead?.({ stage: "exposures", rows: exposureRows.length });
  observeRead?.({ stage: "recommendations", rows: recommendationState.length });
  observeRead?.({ stage: "alternatives", rows: alternatives.length });
  if (!profile) return;
  const plateList = plates.map((p) => ({
    denomination: p.denomination,
    countPerSide: platePairsPerSide(p.quantity),
  }));
  const plateConfigs: Record<string, PlateMathConfig> = {};
  for (const bar of bars) {
    plateConfigs[bar.barType === "ez" ? "ez_bar" : "barbell"] = {
      barWeight: bar.barWeight,
      collarWeight: bar.collarWeight,
      plates: plateList,
    };
  }
  const incrementals = mergeIncrementalEquipmentConfigs(equipment);

  const prescriptionsBySlot = new Map(
    prescriptions.map((prescription) => [
      prescription.templateExerciseId,
      prescription,
    ])
  );
  const exposuresBySlot = new Map<string, Exposure[]>();
  for (const row of exposureRows) {
    const slotExposures = exposuresBySlot.get(row.slot_id) ?? [];
    let exposure = slotExposures.find(
      (candidate) => candidate.sessionId === row.session_id
    );
    if (!exposure) {
      exposure = {
        sessionId: row.session_id,
        date:
          row.started_at instanceof Date
            ? row.started_at
            : new Date(row.started_at),
        sets: [],
      };
      slotExposures.push(exposure);
      exposuresBySlot.set(row.slot_id, slotExposures);
    }
    exposure.sets.push({
      id: row.set_id,
      weight:
        row.weight != null && row.weight_unit != null
          ? convertWeight(row.weight, row.weight_unit, profile.unit)
          : null,
      reps: row.reps,
      rpe: row.rpe,
    });
  }

  for (const { exercise: se, mapping } of eligibleExercises) {
    const slotKey = mapping.current_slot_id;
    const lineageId = mapping.lineage_id;

    const prescription = prescriptionsBySlot.get(slotKey);
    if (!prescription) continue;
    if (prescription.progressionRuleId === "hold") continue;
    const exposures = exposuresBySlot.get(slotKey) ?? [];

    const recentPain: PainEvent[] = recentPainRows
      .filter((pain) => pain.exerciseId === se.exercise.id)
      .map((pain) => ({
        id: pain.id,
        sessionId: pain.sessionId!,
        severity: pain.severity,
        date: pain.createdAt,
        bodyPart: pain.bodyPart,
      }));

    const steppers = steppersForLoadType(se.exercise.loadType, plateConfigs, incrementals);
    const decision = evaluateSlot({
      exerciseName: se.exercise.name,
      prescription: {
        sets: prescription.sets,
        repRangeMin: prescription.repRangeMin,
        repRangeMax: prescription.repRangeMax,
        targetLoad:
          prescription.targetLoad != null && prescription.targetLoadUnit != null
            ? convertWeight(
                prescription.targetLoad,
                prescription.targetLoadUnit,
                profile.unit
              )
            : null,
      },
      exposures,
      recentPain,
      exposuresRequiredForIncrease:
        coachingPrefs?.aggressiveness === "aggressive"
          ? 1
          : cfg.exposuresRequiredForIncrease,
      ...steppers,
    });
    if (!decision) continue;

    // Suppressed substitution suggestions remain visible in the audit trail,
    // but a load hold is shown in Review so its evidence and release rule are
    // understandable without changing the Program.
    const substitutionSuggestionSuppressed =
      decision.ruleId === "pain_substitute" &&
      coachingPrefs?.substitutionSuggestions === false;
    if (substitutionSuggestionSuppressed) {
      await audit(db, {
        userId,
        actorType: "rule",
        action: "progression.substitution_suppressed",
        entityType: "exercise_prescription",
        entityId: prescription.id,
        summary: `${se.exercise.name}: ${decision.reason}`,
        causeRef: { sessionId, signals: decision.evidence.signals },
        idempotencyKey: progressionJobId
          ? `progression:${progressionJobId}:${lineageId}:suppressed`
          : undefined,
      });
    }

    // Dedupe: an identical pending rec, or a recently twice-rejected rule,
    // suppresses re-suggestion (plan §7 rejection snoozing).
    const existing = recommendationState.filter(
      (recommendation) =>
        recommendation.ruleId === decision.ruleId &&
        recommendation.sourceSlotLineageId === lineageId
    );
    const samePending = existing.some(
      (recommendation) => recommendation.status === "pending"
    );
    const recentRejections = existing.filter(
      (r) =>
        r.status === "rejected" &&
        r.decidedAt != null &&
        r.decidedAt >= snoozeStart
    );
    if (samePending || recentRejections.length >= cfg.rejectionSnoozeCount) continue;

    let payload: RecommendationPayload | null = null;
    if (decision.kind === "load_change" && decision.toLoad != null) {
      payload = {
        kind: "load_change",
        templateExerciseId: slotKey,
        fromLoad:
          prescription.targetLoad != null && prescription.targetLoadUnit != null
            ? convertWeight(
                prescription.targetLoad,
                prescription.targetLoadUnit,
                profile.unit
              )
            : null,
        toLoad: decision.toLoad,
        loadUnit: profile.unit,
      };
    } else if (decision.kind === "hold") {
      payload = {
        kind: "hold",
        templateExerciseId: slotKey,
        reason: decision.reason,
      };
    } else if (decision.kind === "substitution_needed") {
      if (substitutionSuggestionSuppressed) {
        payload = {
          kind: "hold",
          templateExerciseId: slotKey,
          reason: decision.reason,
        };
      } else {
      // Deterministic candidate pick: equipment- and constraint-legal, same
      // pattern, different loading style preferred (gentler variant).
      const legal = alternatives.filter(
        (c) =>
          c.movementPattern === se.exercise.movementPattern &&
          c.id !== se.exercise.id &&
          (c.userId == null || c.userId === userId) &&
          exerciseIsAvailable(c.equipmentRequirements, availabilityInventory) &&
          isPatternAllowedForSuggestions(c.movementPattern, userConstraints)
      );
      legal.sort((a, b) => {
        const gentler = (x: typeof a) =>
          x.loadType === "band" ? 0 : x.loadType === "dumbbell" ? 1 : 2;
        return gentler(a) - gentler(b) || a.name.localeCompare(b.name);
      });
      const pick = legal[0];
      if (pick) {
        payload = {
          kind: "substitution",
          templateExerciseId: slotKey,
          fromExerciseId: se.exercise.id,
          toExerciseId: pick.id,
        };
        decision.evidence.signals.suggestedExercise = pick.name;
        decision.evidence.signals.alternatives = legal.slice(1, 5).map((c) => c.name);
      } else {
        payload = {
          kind: "hold",
          templateExerciseId: slotKey,
          reason: decision.reason,
        };
      }
      }
    }
    if (!payload) continue;

    await recordProgressionRecommendation(db, {
      userId,
      progressionJobId: progressionJobId ?? null,
      sourceTemplateExerciseId: slotKey,
      sourceSlotLineageId: lineageId,
      ruleId: decision.ruleId,
      exerciseId: se.exercise.id,
      payload,
      reason: decision.reason,
      evidence: {
        signals: decision.evidence.signals,
        sessionIds: decision.evidence.sessionIds,
        setIds: decision.evidence.setIds,
        painLogIds: decision.evidence.painLogIds,
      },
      sessionId,
      exerciseName: se.exercise.name,
    });
  }
}

/**
 * Re-checks the latest completed real workout for each current template. This
 * makes the manual Coach review useful for history that predates the automatic
 * completion hook. Sample history has no template id and is never considered.
 */
export async function evaluateRecentProgression(
  db: Db,
  userId: string,
  coachingPrefs: CoachingPrefs,
  dependencies: OnDemandProgressionDependencies = {},
): Promise<number> {
  const selected = resultRows<{ id: string }>(
    await db.execute(sql`
      WITH current_days AS MATERIALIZED (
        SELECT current_day.lineage_id, version.program_id
        FROM programs program
        JOIN program_versions version
          ON version.id = program.current_version_id
         AND version.program_id = program.id
        JOIN workout_templates current_day
          ON current_day.program_version_id = version.id
        WHERE program.user_id = ${userId}::uuid
          AND program.status = 'active'
          AND program.archived_at IS NULL
      ), ranked AS MATERIALIZED (
        SELECT
          session.id AS session_id,
          session.history_revision,
          row_number() OVER (
            PARTITION BY current_day.lineage_id
            ORDER BY session.started_at DESC, session.id DESC
          ) AS recency
        FROM current_days current_day
        JOIN workout_sessions session
          ON session.source_program_id = current_day.program_id
         AND session.source_day_lineage_id = current_day.lineage_id
        WHERE session.user_id = ${userId}::uuid
          AND session.status = 'completed'
          AND session.archived_at IS NULL
      )
      , upserted AS (
      INSERT INTO progression_jobs (
        user_id, session_id, source_session_revision,
        coaching_prefs, next_attempt_at
      )
      SELECT
        ${userId}::uuid,
        ranked.session_id,
        ranked.history_revision,
        ${JSON.stringify(coachingPrefs)}::jsonb,
        statement_timestamp()
      FROM ranked
      WHERE ranked.recency = 1
      ON CONFLICT (session_id, source_session_revision)
      DO UPDATE SET
        coaching_prefs = excluded.coaching_prefs,
        status = CASE
          WHEN progression_jobs.status = 'completed'
            OR progression_jobs.status = 'processing'
            THEN 'pending'
          ELSE progression_jobs.status
        END,
        attempts = CASE
          WHEN progression_jobs.status = 'completed' THEN 0
          ELSE progression_jobs.attempts
        END,
        next_attempt_at = statement_timestamp(),
        last_error = CASE
          WHEN progression_jobs.status = 'completed' THEN NULL
          ELSE progression_jobs.last_error
        END,
        completed_at = CASE
          WHEN progression_jobs.status = 'completed' THEN NULL
          ELSE progression_jobs.completed_at
        END,
        lease_token = CASE
          WHEN progression_jobs.status = 'processing' THEN NULL
          ELSE progression_jobs.lease_token
        END,
        leased_until = CASE
          WHEN progression_jobs.status = 'processing' THEN NULL
          ELSE progression_jobs.leased_until
        END,
        updated_at = statement_timestamp()
      WHERE (
          progression_jobs.status IN ('pending', 'completed')
          OR (
            progression_jobs.status = 'processing'
            AND progression_jobs.leased_until < statement_timestamp()
            AND progression_jobs.attempts < ${PROGRESSION_JOB_MAX_ATTEMPTS}
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM recommendations decided
          WHERE decided.progression_job_id = progression_jobs.id
            AND (
              decided.status IN ('approved', 'edited', 'rejected')
              OR decided.archived_at IS NOT NULL
            )
        )
      RETURNING id
      ), cleared_inputs AS (
        DELETE FROM progression_job_input_sessions input
        USING upserted
        WHERE input.job_id = upserted.id
        RETURNING input.job_id
      )
      SELECT id FROM upserted
    `)
  );

  const processJob = dependencies.processJob
    ?? (await import("@/services/progression-jobs")).processProgressionJob;
  for (const job of selected) {
    const result = await processJob(db, job.id, { userId });
    if (result.status === "failed" && result.error instanceof Error) {
      throw result.error;
    }
    if (result.status !== "completed") {
      throw new Error(
        `On-demand progression evaluation did not complete (${result.status}).`,
      );
    }
  }

  return selected.length;
}
