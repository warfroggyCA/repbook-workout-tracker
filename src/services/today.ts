import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  recommendations,
  sessionOccurrences,
  workoutSessions,
  workoutTemplates,
} from "@/db/schema";
import {
  getActiveProgramVersionWithSchedule,
  getTemplatesWithSlots,
  type TemplateWithSlots,
} from "./program";
import { localDateDifference, workoutLocalDate } from "@/lib/workout-calendar";
import { filterRecommendationsEligibleForAction } from "./recommendation-evidence-eligibility";
import {
  classifyActiveSessionTiming,
  type ActiveSessionTiming,
} from "@/lib/active-session-timing";
import type { ScheduledProgramEventIntentSnapshot } from "@/lib/program-schedule";

export type TodayData = {
  programName: string;
  nextTemplate: TemplateWithSlots | null;
  nextTemplateReason:
    | {
        kind: "after_completed_program_day";
        previousTemplateName: string;
        previousLocalDate: string;
      }
    | { kind: "no_completed_program_day" }
    | { kind: "program_changed" };
  allTemplates: TemplateWithSlots[];
  lastDoneByTemplateId: Record<string, string>;
  currentLocalDate: string;
  daysSinceLastSession: number | null;
  inProgressSessionId: string | null;
  inProgressSessionName: string | null;
  inProgressSessionStartedAtISO: string | null;
  inProgressTiming: ActiveSessionTiming | null;
  schedule: {
    scheduleVersionId: string;
    scheduleVersionHash: string;
    complete: boolean;
    nextEvent: {
      id: string;
      kind: "resistance" | "cardio" | "recovery" | "rest";
      scheduleKind: "fixed_7_day" | "rolling";
      revision: number;
      phaseName: string;
      currentLocalDate: string;
      originalLocalDate: string;
      programWeek: number;
      cyclePosition: number;
      routineLineageId: string | null;
      intentSnapshot: ScheduledProgramEventIntentSnapshot;
      sourceProgramVersionChanged: boolean;
      routineUnavailable: boolean;
    } | null;
  } | null;
  inProgressOccurrences: Array<{
    id: string;
    kind: string;
    outcome: string;
    label: string | null;
    plannedExerciseName: string | null;
    kindOrdinal: number;
    plannedRepsMin: number | null;
    plannedRepsMax: number | null;
    plannedLoad: number | null;
    plannedLoadUnit: "lb" | "kg" | null;
    plannedLoadPercent: number | null;
    plannedLoadText: string | null;
    plannedRestSec: number | null;
    groupRound: number | null;
    groupMemberOrderIdx: number | null;
  }>;
};

/**
 * Rotation rule: the next workout is the day lineage after the most recently
 * completed planned day, cycling in current-version order. Template-less
 * sessions (quick logs) must not reset the rotation — but they do count as
 * training days for the gap calculation, which uses the newest session of
 * any kind. The values are lineage IDs even though this legacy helper keeps
 * its original name. Pure so the rule is unit-testable.
 */
export function pickNextTemplateId(
  templateIdsInOrder: string[],
  recentCompletedTemplateIds: Array<string | null>
): string {
  const lastTemplated = recentCompletedTemplateIds.find((id) => id != null);
  if (lastTemplated != null) {
    const idx = templateIdsInOrder.indexOf(lastTemplated);
    if (idx >= 0) {
      return templateIdsInOrder[(idx + 1) % templateIdsInOrder.length];
    }
  }
  return templateIdsInOrder[0];
}

/**
 * Next workout = the template after the most recently completed one, cycling
 * in template order. Gap days feed the deterministic gap rule (plan §7).
 */
export async function getTodayData(
  db: Db,
  userId: string,
  timezone: string,
  now = new Date(),
): Promise<TodayData | null> {
  const [active, inProgress, recent] = await Promise.all([
    getActiveProgramVersionWithSchedule(db, userId),
    db.query.workoutSessions.findFirst({
      where: and(
        eq(workoutSessions.userId, userId),
        eq(workoutSessions.status, "in_progress"),
        isNull(workoutSessions.archivedAt)
      ),
      columns: { id: true, templateName: true, startedAt: true },
      with: {
        occurrences: {
          orderBy: asc(sessionOccurrences.sequenceIdx),
          with: { plannedExercise: { columns: { name: true } } },
        },
      },
    }),
    db.query.workoutSessions.findMany({
      where: and(
        eq(workoutSessions.userId, userId),
        eq(workoutSessions.status, "completed"),
        isNull(workoutSessions.archivedAt)
      ),
      orderBy: desc(workoutSessions.startedAt),
      limit: 50,
    }),
  ]);
  if (!active) return null;
  const currentLocalDate = workoutLocalDate(now, timezone);

  const historicalTemplateIds = [
    ...new Set(
      recent
        .map((session) => session.templateId)
        .filter((id): id is string => id != null)
    ),
  ];
  const [templates, historicalTemplates] = await Promise.all([
    getTemplatesWithSlots(db, active.version.id),
    historicalTemplateIds.length
      ? db.query.workoutTemplates.findMany({
          where: inArray(workoutTemplates.id, historicalTemplateIds),
          with: { programVersion: true },
        })
      : Promise.resolve([]),
  ]);
  if (!templates.length) return null;
  const historicalLineageByTemplateId = new Map(
    historicalTemplates
      .filter(
        (template) => template.programVersion.programId === active.program.id
      )
      .map((template) => [template.id, template.lineageId])
  );
  const currentTemplateByLineage = new Map(
    templates.map((template) => [
      template.template.lineageId,
      template,
    ])
  );
  const lineageForSession = (session: (typeof recent)[number]) =>
    session.sourceProgramId === active.program.id &&
    session.sourceDayLineageId != null
      ? session.sourceDayLineageId
      : session.templateId
        ? (historicalLineageByTemplateId.get(session.templateId) ?? null)
        : null;

  const lastDoneByTemplateId: Record<string, string> = {};
  for (const s of recent) {
    const lineageId = lineageForSession(s);
    const currentTemplate = lineageId
      ? currentTemplateByLineage.get(lineageId)
      : null;
    if (
      currentTemplate &&
      !lastDoneByTemplateId[currentTemplate.template.id]
    ) {
      lastDoneByTemplateId[currentTemplate.template.id] = s.localDate;
    }
  }

  const nextTemplateLineageId = pickNextTemplateId(
    templates.map((t) => t.template.lineageId),
    recent.map(lineageForSession)
  );
  const legacyNextTemplate =
    currentTemplateByLineage.get(nextTemplateLineageId) ?? templates[0];
  const scheduledTemplate =
    active.schedule?.nextEvent?.kind === "resistance" &&
    active.schedule.nextEvent.routineLineageId
      ? (currentTemplateByLineage.get(
          active.schedule.nextEvent.routineLineageId,
        ) ?? null)
      : null;
  const nextTemplate = active.schedule
    ? scheduledTemplate
    : legacyNextTemplate;

  const lastCompletedProgramDay =
    recent.find((session) => lineageForSession(session) != null) ?? null;
  const previousLineageId = lastCompletedProgramDay
    ? lineageForSession(lastCompletedProgramDay)
    : null;
  const previousCurrentTemplate = previousLineageId
    ? currentTemplateByLineage.get(previousLineageId)
    : null;
  const nextTemplateReason: TodayData["nextTemplateReason"] =
    previousCurrentTemplate && lastCompletedProgramDay
      ? {
          kind: "after_completed_program_day",
          previousTemplateName: previousCurrentTemplate.template.name,
          previousLocalDate: lastCompletedProgramDay.localDate,
        }
      : lastCompletedProgramDay
        ? { kind: "program_changed" }
        : { kind: "no_completed_program_day" };

  // Gap days count ANY completed session — a quick log is still training.
  const lastCompleted = recent[0] ?? null;
  const daysSinceLastSession = lastCompleted
    ? localDateDifference(currentLocalDate, lastCompleted.localDate)
    : null;

  return {
    programName: active.program.name,
    nextTemplate,
    nextTemplateReason,
    allTemplates: templates,
    lastDoneByTemplateId,
    currentLocalDate,
    daysSinceLastSession,
    inProgressSessionId: inProgress?.id ?? null,
    inProgressSessionName: inProgress?.templateName ?? null,
    inProgressSessionStartedAtISO: inProgress?.startedAt.toISOString() ?? null,
    inProgressTiming: inProgress
      ? classifyActiveSessionTiming(inProgress.startedAt, now)
      : null,
    schedule: active.schedule
      ? {
          scheduleVersionId: active.schedule.version.id,
          scheduleVersionHash: active.schedule.version.contentHash,
          complete: active.schedule.nextEvent == null,
          nextEvent: active.schedule.nextEvent
            ? {
                id: active.schedule.nextEvent.id,
                kind: active.schedule.nextEvent.kind as "resistance" | "cardio" | "recovery" | "rest",
                scheduleKind: active.schedule.nextEvent.scheduleKind as "fixed_7_day" | "rolling",
                revision: active.schedule.nextEvent.revision,
                phaseName: active.schedule.nextEvent.sourcePhaseName,
                currentLocalDate: active.schedule.nextEvent.currentLocalDate,
                originalLocalDate: active.schedule.nextEvent.originalLocalDate,
                programWeek: active.schedule.nextEvent.programWeek,
                cyclePosition: active.schedule.nextEvent.cyclePosition,
                routineLineageId: active.schedule.nextEvent.routineLineageId,
                intentSnapshot: active.schedule.nextEvent.intentSnapshot,
                sourceProgramVersionChanged:
                  active.schedule.nextEvent.sourceProgramVersionId !== active.version.id,
                routineUnavailable:
                  active.schedule.nextEvent.kind === "resistance" &&
                  scheduledTemplate == null,
              }
            : null,
        }
      : null,
    inProgressOccurrences: (inProgress?.occurrences ?? []).map((occurrence) => ({
      id: occurrence.id,
      kind: occurrence.kind,
      outcome: occurrence.outcome,
      label: occurrence.label,
      plannedExerciseName: occurrence.plannedExercise?.name ?? null,
      kindOrdinal: occurrence.kindOrdinal,
      plannedRepsMin: occurrence.plannedRepsMin,
      plannedRepsMax: occurrence.plannedRepsMax,
      plannedLoad: occurrence.plannedLoad,
      plannedLoadUnit: occurrence.plannedLoadUnit,
      plannedLoadPercent: occurrence.plannedLoadPercent,
      plannedLoadText: occurrence.plannedLoadText,
      plannedRestSec: occurrence.plannedRestSec,
      groupRound: occurrence.groupRound,
      groupMemberOrderIdx: occurrence.groupMemberOrderIdx,
    })),
  };
}

/** One post-authentication wave for every independent Today-page read. */
export async function getTodayPageData(
  db: Db,
  userId: string,
  timezone: string,
  now = new Date(),
) {
  const [today, pendingRows] = await Promise.all([
    getTodayData(db, userId, timezone, now),
    db.query.recommendations.findMany({
      where: and(
        eq(recommendations.userId, userId),
        eq(recommendations.status, "pending"),
        isNull(recommendations.archivedAt)
      ),
      with: { exercise: true },
    }),
  ]);
  const pendingRecs = await filterRecommendationsEligibleForAction(
    db,
    userId,
    pendingRows,
  );
  return { today, pendingRecs };
}

export type LastPerformance = {
  date: Date;
  sets: Array<{
    weight: number | null;
    weightUnit: "lb" | "kg" | null;
    reps: number;
    rpe: number | null;
  }>;
};

/**
 * Most recent completed performance per current logical slot ("last time" on
 * the session screen). Historical physical slots participate only when they
 * belong to the same Program, carry the same lineage, and still represent the
 * same exercise. Results remain keyed by the requested current physical ID.
 */
export async function getLastPerformances(
  db: Db,
  userId: string,
  templateExerciseIds: string[]
): Promise<Record<string, LastPerformance>> {
  if (!templateExerciseIds.length) return {};

  const slotList = sql.join(
    templateExerciseIds.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  const executed = await db.execute(sql`
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
    )
    SELECT
      requested.current_slot_id AS slot_id,
      exposure.started_at,
      exposure.session_exercise_id,
      cs.weight,
      cs.weight_unit,
      cs.reps,
      cs.rpe,
      cs.set_no
    FROM requested_slots requested
    JOIN LATERAL (
      SELECT
        ws.started_at,
        se.id AS session_exercise_id
      FROM session_exercises se
      JOIN workout_sessions ws ON ws.id = se.session_id
      JOIN workout_template_exercises historical_slot
        ON historical_slot.id = se.planned_from_template_exercise_id
      JOIN workout_templates historical_template
        ON historical_template.id = historical_slot.workout_template_id
      JOIN program_versions historical_version
        ON historical_version.id = historical_template.program_version_id
      WHERE ws.user_id = ${userId}::uuid
        AND ws.status = 'completed'
        AND ws.archived_at IS NULL
        AND historical_version.program_id = requested.program_id
        AND historical_slot.lineage_id = requested.lineage_id
        AND historical_slot.exercise_id = requested.exercise_id
        AND se.modification_type = 'as_planned'
        AND se.exercise_id = requested.exercise_id
        AND EXISTS (
          SELECT 1
          FROM completed_sets qualifying_set
          JOIN session_occurrences qualifying_occurrence
            ON qualifying_occurrence.completed_set_id = qualifying_set.id
           AND qualifying_occurrence.session_exercise_id = se.id
           AND qualifying_occurrence.kind = 'working_set'
           AND qualifying_occurrence.outcome = 'completed'
          WHERE qualifying_set.session_exercise_id = se.id
            AND qualifying_set.archived_at IS NULL
            AND NOT qualifying_set.is_warmup
            AND qualifying_set.reps IS NOT NULL
        )
      ORDER BY ws.started_at DESC, se.id DESC
      LIMIT 1
    ) exposure ON true
    JOIN completed_sets cs ON cs.session_exercise_id = exposure.session_exercise_id
    JOIN session_occurrences occurrence
      ON occurrence.completed_set_id = cs.id
     AND occurrence.session_exercise_id = exposure.session_exercise_id
     AND occurrence.kind = 'working_set'
     AND occurrence.outcome = 'completed'
    WHERE cs.archived_at IS NULL
      AND NOT cs.is_warmup
      AND cs.reps IS NOT NULL
    ORDER BY requested.current_slot_id, cs.set_no
  `);
  const rows = resultRows<{
    slot_id: string;
    started_at: Date | string;
    session_exercise_id: string;
    weight: number | null;
    weight_unit: "lb" | "kg" | null;
    reps: number;
    rpe: number | null;
  }>(executed);

  const result: Record<string, LastPerformance> = {};
  for (const row of rows) {
    if (!result[row.slot_id]) {
      result[row.slot_id] = {
        date:
          row.started_at instanceof Date
            ? row.started_at
            : new Date(row.started_at),
        sets: [],
      };
    }
    result[row.slot_id].sets.push({
        weight: row.weight,
        weightUnit: row.weight_unit,
        reps: row.reps,
        rpe: row.rpe,
    });
  }
  return result;
}
