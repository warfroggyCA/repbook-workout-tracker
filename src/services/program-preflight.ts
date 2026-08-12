import "server-only";

import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import type { ProgramDocument } from "@/lib/program-document";
import type { ProgramPreflightContext } from "@/lib/program-preflight";
import { getLibraryWithAvailability } from "@/services/routine-import";
import { MAX_ANALYTICS_WORKOUT_DURATION_MINUTES } from "@/lib/workout-duration-quality";

export async function loadProgramPreflightContext(
  db: Db,
  userId: string,
  document: ProgramDocument,
): Promise<ProgramPreflightContext> {
  const dayLineages = document.days.map((day) => day.lineageId);
  const exerciseIds = [...new Set(document.days.flatMap((day) => day.exercises.map((slot) => slot.exerciseId)))];
  const [library, durationResult, painResult] = await Promise.all([
    getLibraryWithAvailability(db, userId),
    db.execute(sql`
      WITH eligible AS (
        SELECT template.lineage_id,
               CASE
                 WHEN session.active_duration_semantics_version = 1
                   THEN session.active_duration_seconds / 60.0
                 ELSE NULL::numeric
               END AS minutes,
               row_number() OVER (
                 PARTITION BY template.lineage_id
                 ORDER BY session.local_date DESC, session.started_at DESC,
                   session.id DESC
               ) AS recency
        FROM workout_sessions session
        JOIN workout_templates template ON template.id = session.template_id
        JOIN program_versions version ON version.id = template.program_version_id
        JOIN programs program ON program.id = version.program_id
        WHERE session.user_id = ${userId}::uuid
          AND program.user_id = ${userId}::uuid
          AND session.status = 'completed'
          AND session.archived_at IS NULL
          AND NOT session.exclude_duration_from_analytics
          AND CASE
            WHEN session.active_duration_semantics_version = 1
              THEN session.active_duration_seconds / 60.0
            ELSE NULL::numeric
          END > 0
          AND CASE
            WHEN session.active_duration_semantics_version = 1
              THEN session.active_duration_seconds / 60.0
            ELSE NULL::numeric
          END <= ${MAX_ANALYTICS_WORKOUT_DURATION_MINUTES}
          AND template.lineage_id IN (${sql.join(dayLineages.map((id) => sql`${id}::uuid`), sql`, `)})
      )
      SELECT lineage_id, minutes
      FROM eligible
      WHERE recency <= 8
      ORDER BY lineage_id, recency DESC
    `),
    db.execute(sql`
      SELECT pain.exercise_id, count(*)::int AS evidence_count
      FROM pain_logs pain
      JOIN workout_sessions session ON session.id = pain.session_id
      WHERE pain.user_id = ${userId}::uuid
        AND session.user_id = ${userId}::uuid
        AND session.status = 'completed'
        AND session.archived_at IS NULL
        AND pain.archived_at IS NULL
        AND pain.source <> 'set_exception'::pain_source
        AND pain.severity > 0
        AND pain.exercise_id IS NOT NULL
        AND pain.exercise_id IN (${sql.join(exerciseIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND pain.created_at > statement_timestamp() - interval '14 days'
        AND pain.created_at <= statement_timestamp()
      GROUP BY pain.exercise_id
    `),
  ]);

  const libraryById = new Map(library.map((exercise) => [exercise.id, exercise]));
  const unavailableSlotLineageIds = new Set<string>();
  const avoidedSlotLineageIds = new Set<string>();
  const cautiousSlotLineageIds = new Set<string>();
  const painByExercise = new Map(
    resultRows(painResult).map((row) => [String(row.exercise_id), Number(row.evidence_count)]),
  );
  const painEvidenceBySlot: Record<string, number> = {};
  const equipmentFitBySlot: NonNullable<
    ProgramPreflightContext["equipmentFitBySlot"]
  > = {};

  for (const day of document.days) {
    for (const slot of day.exercises) {
      const exercise = libraryById.get(slot.exerciseId);
      if (!exercise) {
        unavailableSlotLineageIds.add(slot.lineageId);
      } else {
        if (
          exercise.equipmentFitStatus === "incompatible" ||
          exercise.equipmentFitStatus === "unknown" ||
          exercise.equipmentFitStatus === "missing"
        ) {
          equipmentFitBySlot[slot.lineageId] = {
            status: exercise.equipmentFitStatus,
            reason: exercise.equipmentFitReason,
            equipmentItemIds:
              exercise.equipmentFitStatus === "incompatible"
                ? exercise.equipmentFit.incompatibleEquipmentItemIds
                : exercise.equipmentFit.candidateEquipmentItemIds,
          };
        }
        if (exercise.constraintBlocked) {
          avoidedSlotLineageIds.add(slot.lineageId);
        } else if (
          !exercise.available &&
          exercise.equipmentFitStatus !== "incompatible" &&
          exercise.equipmentFitStatus !== "unknown" &&
          exercise.equipmentFitStatus !== "missing"
        ) {
          unavailableSlotLineageIds.add(slot.lineageId);
        }
      }
      if ((exercise?.cautionBodyParts.length ?? 0) > 0) {
        cautiousSlotLineageIds.add(slot.lineageId);
      }
      const painCount = painByExercise.get(slot.exerciseId) ?? 0;
      if (painCount > 0) painEvidenceBySlot[slot.lineageId] = painCount;
    }
  }

  const comparableDurationsByDay: Record<string, number[]> = {};
  for (const row of resultRows(durationResult)) {
    const lineageId = String(row.lineage_id);
    const minutes = Number(row.minutes);
    if (!Number.isFinite(minutes)) continue;
    (comparableDurationsByDay[lineageId] ??= []).push(minutes);
  }

  return {
    comparableDurationsByDay,
    unavailableSlotLineageIds,
    avoidedSlotLineageIds,
    cautiousSlotLineageIds,
    painEvidenceBySlot,
    equipmentFitBySlot,
    equipmentEvidenceCount: library.length,
    constraintEvidenceCount:
      avoidedSlotLineageIds.size + cautiousSlotLineageIds.size,
  };
}
