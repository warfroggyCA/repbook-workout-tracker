import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { sessionCompilerProposals } from "@/db/schema";
import { compileSession, SESSION_COMPILER_ALGORITHM_VERSION, type SessionCompilerInput } from "@/lib/session-compiler";
import { isSessionCompilerEnabled } from "@/lib/session-compiler-feature";
import { isValidIanaTimezone } from "@/lib/workout-calendar";
import { getActiveProgramVersion, getTemplatesWithSlots } from "@/services/program";
import { getCurrentProgramDocument } from "@/services/program-documents";
import { hashProgramDocument } from "@/services/program-document-hash";
import { loadProgramPreflightContext } from "@/services/program-preflight";
import { runProgramPreflight } from "@/lib/program-preflight";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";
import {
  hasGeneratedOverviewWarmupItems,
  projectIntentProgramDocumentV2,
  upgradeStoredProgramDocumentToV3,
} from "@/lib/program-document";
import { sessionEquipmentRequirementsSnapshotExpression } from "@/services/session-equipment-requirements";

export class SessionCompilerIneligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCompilerIneligibleError";
  }
}

function hashValue(value: unknown) {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

function proposalContentHash(input: SessionCompilerInput, output: ReturnType<typeof compileSession>) {
  return hashValue({
    input: { ...input, preflight: { ...input.preflight, checkedAt: "evidence-time-excluded-from-identity" } },
    output,
  });
}

function preflightEvidenceTokenQuery(
  userId: string,
  exerciseIds: string[] | SQL,
) {
  const exerciseList = Array.isArray(exerciseIds)
    ? exerciseIds.length === 0
      ? sql`NULL::uuid`
      : sql.join(exerciseIds.map((id) => sql`${id}::uuid`), sql`, `)
    : exerciseIds;
  return sql`
    SELECT md5(concat_ws('|',
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(item.id, item.type, item.definition_id, item.quantity, item.attrs, item.available, item.updated_at) ORDER BY item.id), '[]'::jsonb)::text FROM equipment_items item WHERE item.user_id = ${userId}::uuid),
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(plate.id, plate.denomination, plate.quantity) ORDER BY plate.id), '[]'::jsonb)::text FROM plate_inventory plate WHERE plate.user_id = ${userId}::uuid),
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(barbell.id, barbell.bar_type, barbell.bar_weight, barbell.collar_weight, barbell.quantity) ORDER BY barbell.id), '[]'::jsonb)::text FROM barbell_configs barbell WHERE barbell.user_id = ${userId}::uuid),
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(constraint_row.id, constraint_row.body_part, constraint_row.affected_patterns, constraint_row.avoid, constraint_row.cautious, constraint_row.pain_stop_threshold) ORDER BY constraint_row.id), '[]'::jsonb)::text FROM constraints constraint_row WHERE constraint_row.user_id = ${userId}::uuid),
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(
        pain.id,
        pain.session_id,
        pain.exercise_id,
        pain.completed_set_id,
        pain.body_part,
        pain.severity,
        pain.source,
        pain.archived_at,
        pain.created_at
      ) ORDER BY pain.id), '[]'::jsonb)::text FROM pain_logs pain WHERE pain.user_id = ${userId}::uuid AND pain.source <> 'set_exception'::pain_source),
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(session_row.id, session_row.template_id, session_row.started_at, session_row.finished_at, session_row.active_duration_semantics_version, session_row.active_duration_seconds, session_row.active_duration_basis, session_row.exclude_duration_from_analytics) ORDER BY session_row.id), '[]'::jsonb)::text FROM workout_sessions session_row WHERE session_row.user_id = ${userId}::uuid AND session_row.status = 'completed' AND session_row.archived_at IS NULL),
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(exercise.id, exercise.movement_pattern) ORDER BY exercise.id), '[]'::jsonb)::text FROM exercises exercise WHERE exercise.id IN (${exerciseList})),
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(requirement.id, requirement.exercise_id, requirement.equipment_type, requirement.equipment_definition_id, requirement.min_weight) ORDER BY requirement.id), '[]'::jsonb)::text FROM exercise_equipment_requirements requirement WHERE requirement.exercise_id IN (${exerciseList})),
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(requirement.id, requirement.exercise_id, requirement.required_profile_kind, requirement.required_equipment_definition_id, requirement.required_attachment_kind, requirement.required_attachment_definition_id, requirement.requires_known_geometry, requirement.updated_at) ORDER BY requirement.id), '[]'::jsonb)::text FROM exercise_execution_requirements requirement WHERE requirement.exercise_id IN (${exerciseList})),
      (SELECT COALESCE(jsonb_agg(jsonb_build_array(definition.id, definition.key, definition.label) ORDER BY definition.id), '[]'::jsonb)::text
         FROM equipment_definitions definition
        WHERE definition.id IN (
          SELECT requirement.equipment_definition_id
          FROM exercise_equipment_requirements requirement
          WHERE requirement.exercise_id IN (${exerciseList})
            AND requirement.equipment_definition_id IS NOT NULL
          UNION
          SELECT requirement.required_equipment_definition_id
          FROM exercise_execution_requirements requirement
          WHERE requirement.exercise_id IN (${exerciseList})
            AND requirement.required_equipment_definition_id IS NOT NULL
          UNION
          SELECT requirement.required_attachment_definition_id
          FROM exercise_execution_requirements requirement
          WHERE requirement.exercise_id IN (${exerciseList})
            AND requirement.required_attachment_definition_id IS NOT NULL
        ))
    )) AS token
  `;
}

async function loadPreflightEvidenceToken(db: Db, userId: string, exerciseIds: string[]) {
  const row = resultRows(await db.execute(preflightEvidenceTokenQuery(userId, exerciseIds)))[0];
  if (typeof row?.token !== "string") throw new Error("Current Preflight evidence identity is unavailable.");
  return row.token;
}

export async function buildSessionCompilerInput(
  db: Db,
  userId: string,
  request: {
    dayLineageId: string;
    requestedMinutes: number;
    energy: "low" | "usual" | "good";
    confirmedConstraintSlotLineageIds?: string[];
    busyEquipmentSlotLineageIds?: string[];
  },
): Promise<SessionCompilerInput> {
  if (!isSessionCompilerEnabled()) throw new SessionCompilerIneligibleError("Session Compiler is not enabled.");
  const [active, document] = await Promise.all([
    getActiveProgramVersion(db, userId),
    getCurrentProgramDocument(db, userId),
  ]);
  if (!active || !document) throw new SessionCompilerIneligibleError("No active Program is available.");
  if (
    !["2", "3"].includes(document.schemaVersion) ||
    ![2, 3].includes(active.version.documentSchemaVersion)
  ) {
    throw new SessionCompilerIneligibleError("Reviewed schema-2 or schema-3 Program intent is required before a session can be compiled.");
  }
  const compilerDocument = upgradeStoredProgramDocumentToV3(document);
  const preflightDocument = projectIntentProgramDocumentV2(compilerDocument);
  const day = compilerDocument.days.find((candidate) => candidate.lineageId === request.dayLineageId);
  if (!day) throw new SessionCompilerIneligibleError("That Program day is no longer current.");
  const templates = await getTemplatesWithSlots(db, active.version.id);
  const source = templates.find(({ template }) => template.lineageId === day.lineageId);
  if (!source) throw new SessionCompilerIneligibleError("The selected Program day is unavailable.");
  const exerciseIds = [...new Set(document.days.flatMap((programDay) => programDay.exercises.map((slot) => slot.exerciseId)))];
  // Keep these reads sequential. The disposable PGlite adapter, like a single
  // PostgreSQL connection, must not multiplex independent statements.
  const preflightContext = await loadProgramPreflightContext(db, userId, preflightDocument);
  const preflightEvidenceToken = await loadPreflightEvidenceToken(db, userId, exerciseIds);
  const preflight = runProgramPreflight(preflightDocument, preflightContext);
  const slotsByLineage = new Map(source.slots.map((row) => [row.slot.lineageId, row]));
  const exercises = day.exercises.map((slot, orderIdx) => {
    const row = slotsByLineage.get(slot.lineageId);
    if (!row) throw new SessionCompilerIneligibleError("A reviewed Program slot is missing from the current version.");
    return {
      slotLineageId: slot.lineageId,
      templateExerciseId: row.slot.id,
      exerciseId: slot.exerciseId,
      exerciseName: row.exercise.name,
      metricType: row.exercise.metricType,
      loadType: row.exercise.loadType,
      loadSemantics: row.exercise.loadSemantics,
      orderIdx,
      supersetKey: slot.supersetKey,
      groupMemberOrderIdx: slot.groupMemberOrderIdx,
      sets: slot.sets,
      repMin: slot.repMin,
      repMax: slot.repMax,
      targetLoad: slot.targetLoad,
      targetLoadUnit: slot.targetLoadUnit,
      restSec: slot.restSec,
      notes: slot.notes,
      warmupNotes: slot.warmupNotes,
      warmupSets: slot.warmupSets,
      setNotes: slot.setNotes,
      intent: slot.intent,
    };
  });
  return {
    algorithmVersion: SESSION_COMPILER_ALGORITHM_VERSION,
    userId,
    programId: active.program.id,
    programVersionId: active.version.id,
    programVersionNo: active.version.versionNo,
    programReviewHash: active.version.reviewHash,
    programDocumentHash: hashProgramDocument(document),
    documentSchemaVersion: active.version.documentSchemaVersion as 2 | 3,
    templateId: source.template.id,
    day,
    exercises,
    requestedMinutes: request.requestedMinutes,
    energy: request.energy,
    confirmedConstraintSlotLineageIds: request.confirmedConstraintSlotLineageIds ?? [],
    busyEquipmentSlotLineageIds: request.busyEquipmentSlotLineageIds ?? [],
    preflight,
    preflightEvidenceToken,
  };
}

export async function createSessionCompilerProposal(
  db: Db,
  userId: string,
  request: Parameters<typeof buildSessionCompilerInput>[2] & { clientMutationId: string },
) {
  const input = await buildSessionCompilerInput(db, userId, request);
  const output = compileSession(input);
  const contentHash = proposalContentHash(input, output);
  const [proposal] = await db.insert(sessionCompilerProposals).values({
    userId,
    programId: input.programId,
    programVersionId: input.programVersionId,
    workoutTemplateId: input.templateId,
    algorithmVersion: input.algorithmVersion,
    status: output.status === "ready" ? "ready" : "unable",
    inputSnapshot: input,
    outputSnapshot: output,
    preflightSnapshot: input.preflight,
    contentHash,
    clientMutationId: request.clientMutationId,
  }).onConflictDoNothing({
    target: [sessionCompilerProposals.userId, sessionCompilerProposals.clientMutationId],
  }).returning();
  if (proposal) return proposal;
  const replay = await db.query.sessionCompilerProposals.findFirst({
    where: and(eq(sessionCompilerProposals.userId, userId), eq(sessionCompilerProposals.clientMutationId, request.clientMutationId)),
  });
  if (!replay) throw new Error("The proposal retry could not be resolved.");
  if (replay.contentHash !== contentHash) {
    throw new Error("That proposal retry identity was already used for different inputs.");
  }
  return replay;
}

export async function getOwnedSessionCompilerProposal(db: Db, userId: string, proposalId: string) {
  return db.query.sessionCompilerProposals.findFirst({
    where: and(eq(sessionCompilerProposals.id, proposalId), eq(sessionCompilerProposals.userId, userId)),
  });
}

export type AcceptCompilerResult =
  | { outcome: "accepted" | "already_accepted"; sessionId: string }
  | { outcome: "stale" | "active_workout_exists" | "not_ready" };

export type SessionCompilerAcceptDependencies = {
  checkpoint?: (name: "before-accept-statement") => void | Promise<void>;
};

export async function acceptSessionCompilerProposal(
  db: Db,
  userId: string,
  proposalId: string,
  acceptanceKey: string,
  timezone: string,
  dependencies: SessionCompilerAcceptDependencies = {},
): Promise<AcceptCompilerResult> {
  if (!isSessionCompilerEnabled()) return { outcome: "not_ready" };
  if (!isValidIanaTimezone(timezone)) throw new Error("A valid timezone is required.");
  const proposal = await getOwnedSessionCompilerProposal(db, userId, proposalId);
  if (!proposal || proposal.status === "unable" || proposal.status === "discarded") return { outcome: "not_ready" };
  if (proposal.status === "accepted" && proposal.acceptedSessionId) {
    return { outcome: "already_accepted", sessionId: proposal.acceptedSessionId };
  }
  if (proposal.algorithmVersion !== SESSION_COMPILER_ALGORITHM_VERSION) {
    await db.update(sessionCompilerProposals)
      .set({ status: "stale", updatedAt: new Date() })
      .where(and(
        eq(sessionCompilerProposals.id, proposal.id),
        eq(sessionCompilerProposals.status, "ready"),
      ));
    return { outcome: "stale" };
  }
  let input: SessionCompilerInput;
  try {
    input = await buildSessionCompilerInput(db, userId, {
      dayLineageId: proposal.inputSnapshot.day.lineageId,
      requestedMinutes: proposal.inputSnapshot.requestedMinutes,
      energy: proposal.inputSnapshot.energy,
      confirmedConstraintSlotLineageIds: proposal.inputSnapshot.confirmedConstraintSlotLineageIds,
      busyEquipmentSlotLineageIds: proposal.inputSnapshot.busyEquipmentSlotLineageIds,
    });
  } catch (error) {
    if (!(error instanceof SessionCompilerIneligibleError)) throw error;
    await db.update(sessionCompilerProposals).set({ status: "stale", updatedAt: new Date() }).where(and(eq(sessionCompilerProposals.id, proposal.id), eq(sessionCompilerProposals.status, "ready")));
    return { outcome: "stale" };
  }
  const output = compileSession(input);
  const currentHash = proposalContentHash(input, output);
  if (currentHash !== proposal.contentHash || output.status !== "ready") {
    await db.update(sessionCompilerProposals).set({ status: "stale", updatedAt: new Date() }).where(and(eq(sessionCompilerProposals.id, proposal.id), eq(sessionCompilerProposals.status, "ready")));
    return { outcome: "stale" };
  }
  const acceptedAt = new Date();
  const sessionId = randomUUID();
  const snapshot = {
    proposalId: proposal.id,
    proposalHash: proposal.contentHash,
    acceptedAt: acceptedAt.toISOString(),
    input: proposal.inputSnapshot,
    output: proposal.outputSnapshot,
  };
  const rowsJson = JSON.stringify(output.exercises.map((exercise) => ({
    slot_lineage_id: exercise.slotLineageId,
    exercise_id: exercise.exerciseId,
    prescribed_exercise_name: exercise.exerciseName,
    prescribed_metric_type: exercise.metricType,
    prescribed_load_type: exercise.loadType,
    prescribed_load_semantics: exercise.loadSemantics,
    template_exercise_id: exercise.templateExerciseId,
    order_idx: exercise.orderIdx,
    superset_key: exercise.supersetKey,
    group_member_order_idx: exercise.groupMemberOrderIdx ?? null,
    rest_sec: exercise.restSec,
    sets: exercise.sets,
    rep_min: exercise.repMin,
    rep_max: exercise.repMax,
    target_load: exercise.targetLoad,
    target_load_unit: exercise.targetLoadUnit,
    notes: exercise.notes,
    warmup_notes: exercise.warmupNotes,
    warmup_sets: exercise.warmupSets,
    set_notes: exercise.setNotes,
  })));
  const groupsJson = JSON.stringify(input.day.supersets.map((group, orderIdx) => {
    const members = output.exercises.filter((exercise) => exercise.supersetKey === group.key);
    const structureStatus = "structureStatus" in group
      ? group.structureStatus
      : "legacy_unequal";
    return {
      lineage_id: group.key,
      name: group.name,
      order_idx: orderIdx,
      structure_status: structureStatus,
      planned_rounds: structureStatus === "canonical" && members.length > 0
        ? members[0].sets
        : null,
      member_count: members.length,
      rest_between_members_sec: "restBetweenMembersSec" in group
        ? group.restBetweenMembersSec
        : 0,
      rest_between_rounds_sec: "restBetweenRoundsSec" in group
        ? group.restBetweenRoundsSec
        : group.restAfterRoundSec,
    };
  }));
  const dayWarmupItems = "warmupItems" in input.day &&
      !hasGeneratedOverviewWarmupItems(input.day, [input.templateId])
    ? input.day.warmupItems
    : [];
  const dayWarmupsJson = JSON.stringify(dayWarmupItems);
  const snapshotJson = JSON.stringify(snapshot);
  await dependencies.checkpoint?.("before-accept-statement");
  const result = resultRows(await db.execute(sql`
    WITH replay AS MATERIALIZED (
      SELECT ws.id
      FROM workout_sessions ws
      WHERE ws.user_id = ${userId}::uuid
        AND ws.compilation_acceptance_key = ${acceptanceKey}
      LIMIT 1
    ), owned_proposal AS MATERIALIZED (
      SELECT proposal.*
      FROM session_compiler_proposals proposal
      JOIN programs program ON program.id = proposal.program_id
      JOIN program_versions version ON version.id = proposal.program_version_id
      JOIN workout_templates template ON template.id = proposal.workout_template_id
      WHERE proposal.id = ${proposal.id}::uuid
        AND proposal.user_id = ${userId}::uuid
        AND proposal.status = 'ready'
        AND proposal.algorithm_version = ${SESSION_COMPILER_ALGORITHM_VERSION}
        AND proposal.content_hash = ${currentHash}
        AND program.user_id = ${userId}::uuid
        AND program.status = 'active'
        AND program.archived_at IS NULL
        AND program.current_version_id = version.id
        AND version.document_schema_version = ${input.documentSchemaVersion}
        AND template.program_version_id = version.id
        AND (${preflightEvidenceTokenQuery(
          userId,
          sql`SELECT DISTINCT slot.exercise_id
              FROM workout_template_exercises slot
              JOIN workout_templates evidence_template
                ON evidence_template.id = slot.workout_template_id
              WHERE evidence_template.program_version_id =
                ${input.programVersionId}::uuid`,
        )}) = ${input.preflightEvidenceToken}
      FOR UPDATE OF proposal
    ), active_other AS MATERIALIZED (
      SELECT id FROM workout_sessions
      WHERE user_id = ${userId}::uuid
        AND status = 'in_progress'
        AND archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM replay)
      LIMIT 1
    ), inserted_session AS (
      INSERT INTO workout_sessions (
        id, user_id, template_id, template_name, day_warmup_notes,
        day_warmup_items, source,
        time_budget_min, compilation_acceptance_key, compilation_snapshot,
        started_at, timezone, local_date,
        source_program_id, source_program_version_id, source_day_lineage_id
      )
      SELECT
        ${sessionId}::uuid, ${userId}::uuid, template.id, template.name,
        template.warmup_notes, ${dayWarmupsJson}::jsonb, 'compiler',
        ${input.requestedMinutes}::integer,
        ${acceptanceKey}, ${snapshotJson}::jsonb, ${acceptedAt.toISOString()}::timestamptz,
        ${timezone}, timezone(${timezone}, ${acceptedAt.toISOString()}::timestamptz)::date,
        proposal.program_id, proposal.program_version_id, template.lineage_id
      FROM owned_proposal proposal
      JOIN workout_templates template ON template.id = proposal.workout_template_id
      WHERE NOT EXISTS (SELECT 1 FROM replay)
        AND NOT EXISTS (SELECT 1 FROM active_other)
      ON CONFLICT (user_id, compilation_acceptance_key)
        WHERE compilation_acceptance_key IS NOT NULL
      DO NOTHING
      RETURNING id
    ), inserted_groups AS (
      INSERT INTO session_exercise_groups (
        session_id, source_group_id, lineage_id, provenance, name, order_idx,
        planned_rounds, member_count, rest_between_members_sec,
        rest_between_rounds_sec
      )
      SELECT
        session.id,
        source_group.id,
        row.lineage_id::uuid,
        CASE WHEN row.structure_status = 'canonical'
          THEN 'compiler'
          ELSE 'legacy'
        END,
        row.name,
        row.order_idx,
        row.planned_rounds,
        row.member_count,
        row.rest_between_members_sec,
        row.rest_between_rounds_sec
      FROM inserted_session session
      CROSS JOIN jsonb_to_recordset(${groupsJson}::jsonb) AS row(
        lineage_id text, name text, order_idx integer, structure_status text,
        planned_rounds integer, member_count integer,
        rest_between_members_sec integer, rest_between_rounds_sec integer
      )
      JOIN owned_proposal proposal ON true
      LEFT JOIN superset_groups source_group
        ON source_group.workout_template_id = proposal.workout_template_id
       AND source_group.lineage_id = row.lineage_id::uuid
      RETURNING id, session_id, lineage_id, rest_between_members_sec,
                rest_between_rounds_sec
    ), inserted_exercises AS (
      INSERT INTO session_exercises (
        session_id, exercise_id, planned_from_template_exercise_id, modification_type,
        source_slot_lineage_id,
        prescribed_semantics_version, prescribed_exercise_name,
        prescribed_metric_type, prescribed_load_type,
        prescribed_load_semantics,
        equipment_requirements_semantics_version,
        equipment_requirements_snapshot,
        order_idx, superset_key, group_snapshot_id, group_member_order_idx,
        rest_sec, target_sets, target_reps_min,
        target_reps_max, target_load, target_load_unit, notes, warmup_notes,
        warmup_sets, set_notes
      )
      SELECT
        session.id,
        row.exercise_id::uuid,
        row.template_exercise_id::uuid,
        'as_planned'::modification_type,
        row.slot_lineage_id::uuid,
        1,
        row.prescribed_exercise_name,
        row.prescribed_metric_type::metric_type,
        row.prescribed_load_type,
        row.prescribed_load_semantics::load_semantics,
        1,
        ${sessionEquipmentRequirementsSnapshotExpression(sql`row.exercise_id::uuid`)},
        row.order_idx,
        row.superset_key,
        session_group.id,
        row.group_member_order_idx,
        row.rest_sec,
        row.sets,
        row.rep_min,
        row.rep_max,
        row.target_load,
        row.target_load_unit::unit,
        row.notes,
        row.warmup_notes,
        row.warmup_sets,
        row.set_notes
      FROM inserted_session session
      CROSS JOIN jsonb_to_recordset(${rowsJson}::jsonb) AS row(
        slot_lineage_id text, exercise_id text, template_exercise_id text, order_idx integer,
        prescribed_exercise_name text, prescribed_metric_type text,
        prescribed_load_type text, prescribed_load_semantics text,
        superset_key text, group_member_order_idx integer, rest_sec integer,
        sets integer, rep_min integer,
        rep_max integer, target_load numeric, target_load_unit text, notes text,
        warmup_notes text, warmup_sets jsonb, set_notes jsonb
      )
      LEFT JOIN inserted_groups session_group
        ON session_group.lineage_id = row.superset_key::uuid
      RETURNING *
    ), day_warmup_source AS MATERIALIZED (
      SELECT
        session.id AS session_id,
        item.value,
        item.ordinality::integer - 1 AS ordinal
      FROM inserted_session session
      CROSS JOIN LATERAL jsonb_array_elements(${dayWarmupsJson}::jsonb)
        WITH ORDINALITY AS item(value, ordinality)
    ), exercise_warmup_source AS MATERIALIZED (
      SELECT
        exercise.id AS session_exercise_id,
        exercise.session_id,
        exercise.exercise_id AS planned_exercise_id,
        exercise.order_idx,
        item.ordinality::integer - 1 AS local_order,
        item.value
      FROM inserted_exercises exercise
      CROSS JOIN LATERAL jsonb_array_elements(exercise.warmup_sets)
        WITH ORDINALITY AS item(value, ordinality)
    ), ordered_exercise_warmups AS MATERIALIZED (
      SELECT source.*,
        row_number() OVER (
          ORDER BY source.order_idx, source.local_order, source.session_exercise_id
        )::integer - 1 AS global_ordinal,
        row_number() OVER (
          PARTITION BY source.session_exercise_id
          ORDER BY source.local_order
        )::integer - 1 AS kind_ordinal
      FROM exercise_warmup_source source
    ), working_source AS MATERIALIZED (
      SELECT
        exercise.id AS session_exercise_id,
        exercise.session_id,
        exercise.exercise_id AS planned_exercise_id,
        exercise.order_idx,
        exercise.target_reps_min,
        exercise.target_reps_max,
        exercise.target_load,
        exercise.target_load_unit,
        exercise.rest_sec,
        exercise.notes,
        exercise.set_notes,
        exercise.group_snapshot_id,
        exercise.group_member_order_idx,
        session_group.rest_between_members_sec,
        session_group.rest_between_rounds_sec,
        series.round_number,
        coalesce(group_anchor.first_order_idx, exercise.order_idx) AS unit_order_idx
      FROM inserted_exercises exercise
      CROSS JOIN LATERAL generate_series(1, coalesce(exercise.target_sets, 0))
        AS series(round_number)
      LEFT JOIN LATERAL (
        SELECT min(member.order_idx)::integer AS first_order_idx
        FROM inserted_exercises member
        WHERE member.group_snapshot_id = exercise.group_snapshot_id
      ) group_anchor ON exercise.group_snapshot_id IS NOT NULL
      LEFT JOIN inserted_groups session_group
        ON session_group.id = exercise.group_snapshot_id
    ), ordered_working AS MATERIALIZED (
      SELECT source.*,
        row_number() OVER (
          ORDER BY source.unit_order_idx, source.round_number,
            coalesce(source.group_member_order_idx, 0), source.order_idx,
            source.session_exercise_id
        )::integer - 1 AS global_ordinal,
        lead(source.group_snapshot_id) OVER (
          ORDER BY source.unit_order_idx, source.round_number,
            coalesce(source.group_member_order_idx, 0), source.order_idx,
            source.session_exercise_id
        ) AS next_group_snapshot_id,
        lead(source.round_number) OVER (
          ORDER BY source.unit_order_idx, source.round_number,
            coalesce(source.group_member_order_idx, 0), source.order_idx,
            source.session_exercise_id
        ) AS next_round_number
      FROM working_source source
    ), inserted_occurrences AS (
      INSERT INTO session_occurrences (
        session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, label, planned_exercise_id, planned_reps_min,
        planned_reps_max, planned_load, planned_load_unit,
        planned_load_percent, planned_load_text, planned_rest_sec,
        planned_note, group_snapshot_id, group_round,
        group_member_order_idx, outcome
      )
      SELECT
        source.session_id, NULL::uuid, 'day_warmup', 'planned',
        source.ordinal, source.ordinal, source.value->>'label', NULL::uuid,
        (source.value->>'reps')::integer, (source.value->>'reps')::integer,
        (source.value->>'load')::numeric, (source.value->>'loadUnit')::unit,
        (source.value->>'loadPercent')::numeric, source.value->>'loadText',
        NULL::integer, source.value->>'notes', NULL::uuid, NULL::integer,
        NULL::integer, 'pending'
      FROM day_warmup_source source
      UNION ALL
      SELECT
        source.session_id, source.session_exercise_id, 'exercise_warmup',
        'planned', (SELECT count(*) FROM day_warmup_source) + source.global_ordinal,
        source.kind_ordinal, source.value->>'label', source.planned_exercise_id,
        (source.value->>'reps')::integer, (source.value->>'reps')::integer,
        (source.value->>'load')::numeric, (source.value->>'loadUnit')::unit,
        (source.value->>'loadPercent')::numeric, source.value->>'loadText',
        NULL::integer, source.value->>'notes', NULL::uuid, NULL::integer,
        NULL::integer, 'pending'
      FROM ordered_exercise_warmups source
      UNION ALL
      SELECT
        source.session_id, source.session_exercise_id, 'working_set', 'planned',
        (SELECT count(*) FROM day_warmup_source)
          + (SELECT count(*) FROM ordered_exercise_warmups)
          + source.global_ordinal,
        source.round_number - 1, NULL::text, source.planned_exercise_id,
        source.target_reps_min, source.target_reps_max, source.target_load,
        source.target_load_unit, NULL::numeric, NULL::text,
        CASE
          WHEN source.group_snapshot_id IS NULL THEN source.rest_sec
          WHEN source.next_group_snapshot_id IS DISTINCT FROM source.group_snapshot_id THEN 0
          WHEN source.next_round_number = source.round_number THEN source.rest_between_members_sec
          ELSE source.rest_between_rounds_sec
        END,
        coalesce(source.set_notes->>(source.round_number - 1), source.notes),
        source.group_snapshot_id,
        CASE WHEN source.group_snapshot_id IS NULL THEN NULL ELSE source.round_number END,
        source.group_member_order_idx, 'pending'
      FROM ordered_working source
      RETURNING id
    ), creation_counts AS MATERIALIZED (
      SELECT
        jsonb_array_length(${rowsJson}::jsonb) AS expected_exercises,
        (SELECT count(*) FROM inserted_exercises) AS inserted_exercises,
        jsonb_array_length(${groupsJson}::jsonb) AS expected_groups,
        (SELECT count(*) FROM inserted_groups) AS inserted_groups,
        jsonb_array_length(${dayWarmupsJson}::jsonb)
          + (SELECT count(*) FROM ordered_exercise_warmups)
          + (SELECT count(*) FROM ordered_working) AS expected_occurrences,
        (SELECT count(*) FROM inserted_occurrences) AS inserted_occurrences
    ), creation_gate AS MATERIALIZED (
      SELECT 1 / CASE WHEN
        NOT EXISTS (SELECT 1 FROM inserted_session)
        OR (
          expected_exercises = inserted_exercises
          AND expected_groups = inserted_groups
          AND expected_occurrences = inserted_occurrences
        )
      THEN 1 ELSE 0 END AS complete
      FROM creation_counts
    ), accepted AS (
      UPDATE session_compiler_proposals proposal
      SET status = 'accepted', reviewed_at = ${acceptedAt.toISOString()}::timestamptz,
          review_hash = ${currentHash}, accepted_session_id = session.id,
          acceptance_key = ${acceptanceKey}, accepted_at = ${acceptedAt.toISOString()}::timestamptz,
          updated_at = ${acceptedAt.toISOString()}::timestamptz
      FROM inserted_session session
      CROSS JOIN creation_gate gate
      WHERE proposal.id = ${proposal.id}::uuid
        AND gate.complete = 1
      RETURNING session.id
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary,
        cause_ref, idempotency_key
      )
      SELECT
        ${userId}::uuid, 'user'::actor_type, 'session_compiler.accept',
        'workout_session', accepted.id::text,
        'Accepted a reviewed Session Compiler proposal without changing the Program.',
        jsonb_build_object(
          'proposalId', ${proposal.id}::text,
          'proposalHash', ${currentHash}::text,
          'programVersionId', ${input.programVersionId}::text,
          'dayLineageId', ${input.day.lineageId}::text
        ),
        ${`session-compiler:${acceptanceKey}`}::text
      FROM accepted
      ON CONFLICT (user_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING id
    )
    SELECT id, 'already_accepted'::text AS outcome FROM replay
    UNION ALL
    SELECT id, 'accepted'::text AS outcome FROM accepted
    UNION ALL
    SELECT id, 'active_workout_exists'::text AS outcome FROM active_other
    LIMIT 1
  `));
  const row = result[0];
  if (!row) {
    await db.update(sessionCompilerProposals)
      .set({ status: "stale", updatedAt: new Date() })
      .where(and(
        eq(sessionCompilerProposals.id, proposal.id),
        eq(sessionCompilerProposals.status, "ready"),
      ));
    return { outcome: "stale" };
  }
  if (row.outcome === "active_workout_exists") return { outcome: "active_workout_exists" };
  return { outcome: row.outcome === "accepted" ? "accepted" : "already_accepted", sessionId: String(row.id) };
}

export async function discardSessionCompilerProposal(db: Db, userId: string, proposalId: string) {
  const [discarded] = await db.update(sessionCompilerProposals).set({ status: "discarded", discardedAt: new Date(), updatedAt: new Date() }).where(and(
    eq(sessionCompilerProposals.id, proposalId),
    eq(sessionCompilerProposals.userId, userId),
    sql`${sessionCompilerProposals.status} IN ('ready', 'unable', 'stale')`,
  )).returning({ id: sessionCompilerProposals.id });
  return Boolean(discarded);
}
