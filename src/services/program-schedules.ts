import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import {
  programScheduleVersions,
  programSchedules,
  scheduledProgramEvents,
} from "@/db/schema";
import {
  materializeProgramScheduleWindow,
  parseProgramScheduleDocument,
  programScheduleCompletionDate,
  type ProgramScheduleDocument,
} from "@/lib/program-schedule";
import { isValidIanaTimezone } from "@/lib/workout-calendar";
import {
  canonicalJson,
  sha256Hex,
} from "@/services/snapshot-crypto";

const uuidSchema = z.string().uuid();
const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const instant = new Date(value + "T00:00:00.000Z");
    return !Number.isNaN(instant.getTime()) &&
      instant.toISOString().slice(0, 10) === value;
  });

const MAX_PROGRAM_SCHEDULE_DAYS = 3_650;

function dayCountInclusive(startsOn: string, endsOn: string) {
  return (
    Math.round(
      (Date.parse(endsOn + "T00:00:00.000Z") -
        Date.parse(startsOn + "T00:00:00.000Z")) /
        86_400_000,
    ) + 1
  );
}

function requestHash(value: unknown) {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

export type PublishProgramScheduleInput = {
  programId: string;
  sourceProgramVersionId: string;
  expectedCurrentScheduleVersionId: string | null;
  requestId: string;
  timezone: string;
  document: unknown;
};

export type PublishProgramScheduleResult =
  | {
      outcome: "published" | "replayed";
      scheduleId: string;
      scheduleVersionId: string;
      versionNo: number;
      eventCount: number;
      contentHash: string;
    }
  | { outcome: "conflict" | "invalid" };

type MaterializedEvent = {
  id: string;
  source_phase_id: string;
  source_phase_name: string;
  source_event_id: string;
  kind: "resistance" | "cardio" | "recovery" | "rest";
  schedule_kind: "fixed_7_day" | "rolling";
  routine_lineage_id: string | null;
  intent_snapshot: unknown;
  sequence_no: number;
  cycle_position: number;
  program_week: number;
  original_local_date: string;
  current_local_date: string;
};

function materialize(document: ProgramScheduleDocument): MaterializedEvent[] {
  const endsOn = programScheduleCompletionDate(document);
  const days = dayCountInclusive(document.startsOn, endsOn);
  if (days < 1 || days > MAX_PROGRAM_SCHEDULE_DAYS) {
    throw new Error(
      `Program schedules must contain between 1 and ${MAX_PROGRAM_SCHEDULE_DAYS} days.`,
    );
  }
  return materializeProgramScheduleWindow(document, {
    startsOn: document.startsOn,
    endsOn,
  }).map((occurrence, index) => {
    if (occurrence.state !== "scheduled") {
      throw new Error("Every date in a published Program schedule must resolve.");
    }
    return {
      id: randomUUID(),
      source_phase_id: occurrence.phaseId,
      source_phase_name: occurrence.phaseName,
      source_event_id: occurrence.eventId,
      kind: occurrence.eventKind,
      schedule_kind: occurrence.scheduleKind,
      routine_lineage_id: occurrence.routineLineageId,
      intent_snapshot: occurrence.intentSnapshot,
      sequence_no: index + 1,
      cycle_position: occurrence.cyclePosition,
      program_week: occurrence.nominalProgramWeek,
      original_local_date: occurrence.plannedLocalDate,
      current_local_date: occurrence.plannedLocalDate,
    };
  });
}

export async function publishProgramSchedule(
  db: Db,
  userId: string,
  input: PublishProgramScheduleInput,
): Promise<PublishProgramScheduleResult> {
  const ids = z
    .object({
      userId: uuidSchema,
      programId: uuidSchema,
      sourceProgramVersionId: uuidSchema,
      expectedCurrentScheduleVersionId: uuidSchema.nullable(),
      requestId: uuidSchema,
    })
    .safeParse({ userId, ...input });
  if (!ids.success || !isValidIanaTimezone(input.timezone)) {
    return { outcome: "invalid" };
  }

  let document: ProgramScheduleDocument;
  let events: MaterializedEvent[];
  try {
    document = parseProgramScheduleDocument(input.document);
    events = materialize(document);
  } catch {
    return { outcome: "invalid" };
  }

  const scheduleId = randomUUID();
  const scheduleVersionId = randomUUID();
  const contentHash = requestHash(document);
  const semanticHash = requestHash({
    programId: input.programId,
    sourceProgramVersionId: input.sourceProgramVersionId,
    expectedCurrentScheduleVersionId:
      input.expectedCurrentScheduleVersionId,
    timezone: input.timezone,
    contentHash,
  });
  const idempotencyKey =
    "program-schedule:publish:" + input.requestId.toLowerCase();
  const eventJson = JSON.stringify(events);

  const rows = resultRows(await db.execute(sql`
    WITH event_input AS MATERIALIZED (
      SELECT *
      FROM jsonb_to_recordset(${eventJson}::jsonb) AS event(
        id uuid,
        source_phase_id uuid,
        source_phase_name text,
        source_event_id uuid,
        kind text,
        schedule_kind text,
        routine_lineage_id uuid,
        intent_snapshot jsonb,
        sequence_no integer,
        cycle_position integer,
        program_week integer,
        original_local_date date,
        current_local_date date
      )
    ), existing_receipt AS MATERIALIZED (
      SELECT audit.cause_ref
      FROM audit_logs audit
      WHERE audit.user_id = ${userId}::uuid
        AND audit.idempotency_key = ${idempotencyKey}
      LIMIT 1
    ), active_program AS MATERIALIZED (
      SELECT program.id, program.current_version_id
      FROM programs program
      WHERE program.id = ${input.programId}::uuid
        AND program.user_id = ${userId}::uuid
        AND program.status = 'active'
        AND program.archived_at IS NULL
        AND program.current_version_id =
          ${input.sourceProgramVersionId}::uuid
        AND NOT EXISTS (SELECT 1 FROM existing_receipt)
      FOR UPDATE OF program
    ), lineage_validation AS MATERIALIZED (
      SELECT
        count(*) FILTER (
          WHERE event.kind = 'resistance'
        )::integer AS expected_count,
        count(template.lineage_id)::integer AS valid_count
      FROM event_input event
      LEFT JOIN workout_templates template
        ON template.program_version_id =
          ${input.sourceProgramVersionId}::uuid
       AND template.lineage_id = event.routine_lineage_id
      WHERE event.kind = 'resistance'
    ), inserted_root AS (
      INSERT INTO program_schedules (
        id, user_id, program_id
      )
      SELECT
        ${scheduleId}::uuid,
        ${userId}::uuid,
        program.id
      FROM active_program program
      CROSS JOIN lineage_validation validation
      WHERE validation.expected_count = validation.valid_count
        AND ${input.expectedCurrentScheduleVersionId}::uuid IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM program_schedules existing
          WHERE existing.program_id = program.id
        )
      ON CONFLICT (program_id) DO NOTHING
      RETURNING *
    ), locked_root AS MATERIALIZED (
      SELECT root.*
      FROM program_schedules root
      JOIN active_program program ON program.id = root.program_id
      CROSS JOIN lineage_validation validation
      WHERE root.user_id = ${userId}::uuid
        AND validation.expected_count = validation.valid_count
        AND root.current_version_id IS NOT DISTINCT FROM
          ${input.expectedCurrentScheduleVersionId}::uuid
      FOR UPDATE OF root
    ), selected_root AS MATERIALIZED (
      SELECT * FROM locked_root
      UNION ALL
      SELECT inserted.*
      FROM inserted_root inserted
    ), locked_current_events AS MATERIALIZED (
      SELECT event.*
      FROM selected_root root
      JOIN scheduled_program_events event
        ON event.schedule_id = root.id
       AND event.schedule_version_id = root.current_version_id
       AND event.user_id = root.user_id
      ORDER BY event.sequence_no, event.id
      FOR UPDATE OF event
    ), parent_version AS MATERIALIZED (
      SELECT version.id, version.version_no
      FROM selected_root root
      JOIN program_schedule_versions version
        ON version.id = root.current_version_id
       AND version.schedule_id = root.id
       AND version.user_id = root.user_id
       AND version.program_id = root.program_id
    ), replacement_validation AS MATERIALIZED (
      SELECT root.id
      FROM selected_root root
      WHERE root.current_version_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM locked_current_events event
          WHERE event.schedule_id = root.id
            AND event.schedule_version_id = root.current_version_id
            AND (
              event.status <> 'scheduled'
              OR event.revision <> 0
              OR event.adjustment_kind IS NOT NULL
              OR event.resolved_at IS NOT NULL
            )
        )
    ), inserted_version AS (
      INSERT INTO program_schedule_versions (
        id, user_id, program_id, schedule_id, version_no,
        parent_version_id, source_program_version_id,
        schema_version, document, content_hash
      )
      SELECT
        ${scheduleVersionId}::uuid,
        root.user_id,
        root.program_id,
        root.id,
        coalesce(parent.version_no + 1, 1),
        parent.id,
        ${input.sourceProgramVersionId}::uuid,
        1,
        ${JSON.stringify(document)}::jsonb,
        ${contentHash}
      FROM selected_root root
      JOIN replacement_validation replacement ON replacement.id = root.id
      LEFT JOIN parent_version parent ON true
      WHERE (
        root.current_version_id IS NULL
        AND parent.id IS NULL
      ) OR parent.id = root.current_version_id
      RETURNING *
    ), inserted_events AS (
      INSERT INTO scheduled_program_events (
        id, user_id, program_id, schedule_id, schedule_version_id,
        source_program_version_id, source_phase_id, source_phase_name,
        source_event_id, kind, schedule_kind, routine_lineage_id,
        intent_snapshot, sequence_no, cycle_position, program_week,
        original_local_date, current_local_date, timezone
      )
      SELECT
        event.id,
        version.user_id,
        version.program_id,
        version.schedule_id,
        version.id,
        version.source_program_version_id,
        event.source_phase_id,
        event.source_phase_name,
        event.source_event_id,
        event.kind,
        event.schedule_kind,
        event.routine_lineage_id,
        event.intent_snapshot,
        event.sequence_no,
        event.cycle_position,
        event.program_week,
        event.original_local_date,
        event.current_local_date,
        ${input.timezone}
      FROM inserted_version version
      CROSS JOIN event_input event
      RETURNING id
    ), superseded_events AS (
      UPDATE scheduled_program_events event
      SET status = 'superseded',
          revision = event.revision + 1,
          resolved_at = statement_timestamp(),
          updated_at = statement_timestamp()
      FROM selected_root root
      CROSS JOIN inserted_version version
      WHERE root.current_version_id IS NOT NULL
        AND event.schedule_id = root.id
        AND event.schedule_version_id = root.current_version_id
        AND event.user_id = root.user_id
        AND event.status = 'scheduled'
        AND event.revision = 0
        AND event.adjustment_kind IS NULL
        AND event.resolved_at IS NULL
      RETURNING event.id
    ), updated_root AS (
      UPDATE program_schedules root
      SET current_version_id = version.id,
          updated_at = statement_timestamp()
      FROM inserted_version version
      WHERE root.id = version.schedule_id
        AND root.user_id = version.user_id
        AND root.program_id = version.program_id
        AND (SELECT count(*) FROM inserted_events) =
          (SELECT count(*) FROM event_input)
        AND (SELECT count(*) FROM superseded_events) =
          (SELECT count(*) FROM locked_current_events)
      RETURNING root.id, version.id AS version_id, version.version_no
    ), advanced_root AS MATERIALIZED (
      SELECT * FROM updated_root
      UNION ALL
      SELECT
        root.id,
        version.id AS version_id,
        version.version_no
      FROM inserted_root root
      JOIN inserted_version version ON version.schedule_id = root.id
      WHERE (SELECT count(*) FROM inserted_events) =
        (SELECT count(*) FROM event_input)
    ), recorded AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id,
        summary, cause_ref, idempotency_key
      )
      SELECT
        ${userId}::uuid,
        'user',
        'program_schedule.publish',
        'program_schedule_version',
        advanced.version_id::text,
        'Published a Program schedule',
        jsonb_build_object(
          'requestHash', ${semanticHash}::text,
          'scheduleId', advanced.id,
          'scheduleVersionId', advanced.version_id,
          'versionNo', advanced.version_no,
          'eventCount', (SELECT count(*) FROM inserted_events),
          'contentHash', ${contentHash}::text
        ),
        ${idempotencyKey}
      FROM advanced_root advanced
      RETURNING cause_ref
    ), integrity AS MATERIALIZED (
      SELECT 1 / CASE
        WHEN EXISTS (SELECT 1 FROM advanced_root)
          AND NOT EXISTS (SELECT 1 FROM recorded)
        THEN 0 ELSE 1 END AS valid
    )
    SELECT
      'replayed'::text AS outcome,
      receipt.cause_ref
    FROM existing_receipt receipt
    CROSS JOIN integrity
    UNION ALL
    SELECT
      'published'::text AS outcome,
      recorded.cause_ref
    FROM recorded
    CROSS JOIN integrity
  `));

  if (rows.length !== 1) return { outcome: "conflict" };
  const row = rows[0];
  const causeRef = row.cause_ref as Record<string, unknown>;
  if (causeRef.requestHash !== semanticHash) return { outcome: "conflict" };
  return {
    outcome: String(row.outcome) as "published" | "replayed",
    scheduleId: String(causeRef.scheduleId),
    scheduleVersionId: String(causeRef.scheduleVersionId),
    versionNo: Number(causeRef.versionNo),
    eventCount: Number(causeRef.eventCount),
    contentHash: String(causeRef.contentHash),
  };
}

export async function getCurrentProgramSchedule(
  db: Db,
  userId: string,
  programId: string,
) {
  if (
    !uuidSchema.safeParse(userId).success ||
    !uuidSchema.safeParse(programId).success
  ) {
    return null;
  }
  const [current] = await db
    .select({
      schedule: programSchedules,
      version: programScheduleVersions,
      nextEvent: scheduledProgramEvents,
    })
    .from(programSchedules)
    .innerJoin(
      programScheduleVersions,
      eq(programScheduleVersions.id, programSchedules.currentVersionId),
    )
    .leftJoin(
      scheduledProgramEvents,
      and(
        eq(scheduledProgramEvents.userId, userId),
        eq(
          scheduledProgramEvents.scheduleVersionId,
          programScheduleVersions.id,
        ),
        eq(scheduledProgramEvents.status, "scheduled"),
      ),
    )
    .where(
      and(
        eq(programSchedules.userId, userId),
        eq(programSchedules.programId, programId),
      ),
    )
    .orderBy(
      asc(scheduledProgramEvents.currentLocalDate),
      asc(scheduledProgramEvents.sequenceNo),
    )
    .limit(1);
  return current ?? null;
}

export async function getProgramScheduleEditorState(
  db: Db,
  userId: string,
  programId: string,
) {
  const current = await getCurrentProgramSchedule(db, userId, programId);
  if (!current) return null;
  const usage = resultRows(await db.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM scheduled_program_events event
      WHERE event.user_id = ${userId}::uuid
        AND event.program_id = ${programId}::uuid
        AND event.schedule_version_id = ${current.version.id}::uuid
        AND (
          event.status <> 'scheduled'
          OR event.revision <> 0
          OR event.adjustment_kind IS NOT NULL
          OR event.resolved_at IS NOT NULL
        )
    ) AS in_use
  `))[0];
  return { ...current, inUse: usage?.in_use === true };
}

export type ScheduledEventAdjustment =
  | { kind: "skip" }
  | { kind: "manual_reschedule"; toLocalDate: string }
  | { kind: "shift_rolling"; days: number };

export type ScheduledEventMutationResult =
  | { outcome: "applied" | "replayed"; affected: number }
  | { outcome: "conflict" | "invalid" };

function validateAdjustment(adjustment: ScheduledEventAdjustment) {
  if (adjustment.kind === "skip") return true;
  if (adjustment.kind === "manual_reschedule") {
    return localDateSchema.safeParse(adjustment.toLocalDate).success;
  }
  return Number.isInteger(adjustment.days) &&
    adjustment.days >= 1 &&
    adjustment.days <= 3_650;
}

export async function adjustScheduledProgramEvent(
  db: Db,
  userId: string,
  input: {
    eventId: string;
    expectedRevision: number;
    requestId: string;
    adjustment: ScheduledEventAdjustment;
  },
): Promise<ScheduledEventMutationResult> {
  if (
    !uuidSchema.safeParse(userId).success ||
    !uuidSchema.safeParse(input.eventId).success ||
    !uuidSchema.safeParse(input.requestId).success ||
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !validateAdjustment(input.adjustment)
  ) {
    return { outcome: "invalid" };
  }
  const hash = requestHash(input);
  const key = "program-schedule:adjust:" + input.requestId.toLowerCase();
  const isSkip = input.adjustment.kind === "skip";
  const isManual = input.adjustment.kind === "manual_reschedule";
  const isShift = input.adjustment.kind === "shift_rolling";
  const toLocalDate =
    input.adjustment.kind === "manual_reschedule"
      ? input.adjustment.toLocalDate
      : null;
  const shiftDays =
    input.adjustment.kind === "shift_rolling"
      ? input.adjustment.days
      : null;

  const rows = resultRows(await db.execute(sql`
    WITH existing AS MATERIALIZED (
      SELECT cause_ref
      FROM audit_logs
      WHERE user_id = ${userId}::uuid
        AND idempotency_key = ${key}
      LIMIT 1
    ), locked_schedule AS MATERIALIZED (
      SELECT schedule.*
      FROM program_schedules schedule
      JOIN scheduled_program_events event
        ON event.schedule_id = schedule.id
       AND event.schedule_version_id = schedule.current_version_id
       AND event.user_id = schedule.user_id
      WHERE event.id = ${input.eventId}::uuid
        AND event.user_id = ${userId}::uuid
        AND NOT EXISTS (SELECT 1 FROM existing)
      FOR UPDATE OF schedule
    ), locked_current_events AS MATERIALIZED (
      SELECT event.*
      FROM locked_schedule schedule
      JOIN scheduled_program_events event
        ON event.schedule_id = schedule.id
       AND event.schedule_version_id = schedule.current_version_id
       AND event.user_id = schedule.user_id
      ORDER BY event.sequence_no, event.id
      FOR UPDATE OF event
    ), selected AS MATERIALIZED (
      SELECT event.*
      FROM locked_current_events event
      JOIN locked_schedule schedule
        ON schedule.id = event.schedule_id
       AND schedule.current_version_id = event.schedule_version_id
       AND schedule.user_id = event.user_id
      WHERE event.id = ${input.eventId}::uuid
        AND event.user_id = ${userId}::uuid
        AND event.status = 'scheduled'
        AND event.revision = ${input.expectedRevision}
        AND NOT EXISTS (SELECT 1 FROM existing)
        AND (
          NOT ${isShift}::boolean
          OR event.schedule_kind = 'rolling'
        )
        AND (
          NOT ${isManual}::boolean
          OR event.current_local_date <> ${toLocalDate}::date
        )
    ), collision AS MATERIALIZED (
      SELECT 1
      FROM selected chosen
      WHERE (
        ${isManual}::boolean
        AND chosen.kind = 'resistance'
        AND EXISTS (
          SELECT 1
          FROM locked_current_events other
          WHERE other.schedule_version_id = chosen.schedule_version_id
            AND other.id <> chosen.id
            AND other.kind = 'resistance'
            AND other.status IN ('scheduled', 'started')
            AND other.current_local_date = ${toLocalDate}::date
        )
      ) OR (
        ${isShift}::boolean
        AND EXISTS (
          SELECT 1
          FROM locked_current_events moving
          JOIN locked_current_events other
            ON other.schedule_version_id = moving.schedule_version_id
           AND other.id <> moving.id
           AND other.kind = 'resistance'
           AND other.status IN ('scheduled', 'started')
           AND NOT (
             other.status = 'scheduled'
             AND other.source_phase_id = chosen.source_phase_id
             AND other.sequence_no >= chosen.sequence_no
           )
           AND other.current_local_date =
             moving.current_local_date + ${shiftDays}::integer
          WHERE moving.schedule_version_id = chosen.schedule_version_id
            AND moving.source_phase_id = chosen.source_phase_id
            AND moving.sequence_no >= chosen.sequence_no
            AND moving.status = 'scheduled'
            AND moving.kind = 'resistance'
        )
      )
    ), updated AS (
      UPDATE scheduled_program_events event
      SET
        status = CASE
          WHEN ${isSkip}::boolean THEN 'skipped'
          ELSE event.status
        END,
        current_local_date = CASE
          WHEN ${isManual}::boolean THEN ${toLocalDate}::date
          WHEN ${isShift}::boolean
            THEN event.current_local_date + ${shiftDays}::integer
          ELSE event.current_local_date
        END,
        adjustment_kind = CASE
          WHEN ${isManual}::boolean THEN 'manual'
          WHEN ${isShift}::boolean THEN 'shift'
          ELSE event.adjustment_kind
        END,
        revision = event.revision + 1,
        resolved_at = CASE
          WHEN ${isSkip}::boolean THEN statement_timestamp()
          ELSE event.resolved_at
        END,
        updated_at = statement_timestamp()
      FROM selected chosen
      WHERE event.schedule_version_id = chosen.schedule_version_id
        AND (
          event.id = chosen.id
          OR (
            ${isShift}::boolean
            AND event.sequence_no > chosen.sequence_no
            AND event.source_phase_id = chosen.source_phase_id
            AND event.status = 'scheduled'
          )
        )
        AND NOT EXISTS (SELECT 1 FROM collision)
      RETURNING event.id
    ), recorded AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id,
        summary, cause_ref, idempotency_key
      )
      SELECT
        ${userId}::uuid,
        'user',
        'program_schedule.adjust',
        'scheduled_program_event',
        ${input.eventId},
        'Adjusted a scheduled Program event',
        jsonb_build_object(
          'requestHash', ${hash}::text,
          'affected', (SELECT count(*) FROM updated)
        ),
        ${key}
      WHERE EXISTS (SELECT 1 FROM selected)
        AND NOT EXISTS (SELECT 1 FROM collision)
        AND EXISTS (SELECT 1 FROM updated)
      RETURNING cause_ref
    )
    SELECT 'replayed'::text AS outcome, cause_ref FROM existing
    UNION ALL
    SELECT 'applied'::text AS outcome, cause_ref FROM recorded
  `));
  if (rows.length !== 1) return { outcome: "conflict" };
  const causeRef = rows[0].cause_ref as Record<string, unknown>;
  if (causeRef.requestHash !== hash) return { outcome: "conflict" };
  return {
    outcome: String(rows[0].outcome) as "applied" | "replayed",
    affected: Number(causeRef.affected),
  };
}

export async function completeNonResistanceScheduledEvent(
  db: Db,
  userId: string,
  input: {
    eventId: string;
    expectedRevision: number;
    requestId: string;
    completedAt?: Date;
  },
): Promise<ScheduledEventMutationResult> {
  if (
    !uuidSchema.safeParse(userId).success ||
    !uuidSchema.safeParse(input.eventId).success ||
    !uuidSchema.safeParse(input.requestId).success ||
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    return { outcome: "invalid" };
  }
  const completedAt = input.completedAt ?? new Date();
  if (Number.isNaN(completedAt.getTime())) return { outcome: "invalid" };
  const hash = requestHash({
    eventId: input.eventId,
    expectedRevision: input.expectedRevision,
  });
  const key = "program-schedule:complete:" + input.requestId.toLowerCase();
  const rows = resultRows(await db.execute(sql`
    WITH existing AS MATERIALIZED (
      SELECT cause_ref
      FROM audit_logs
      WHERE user_id = ${userId}::uuid
        AND idempotency_key = ${key}
      LIMIT 1
    ), locked_schedule AS MATERIALIZED (
      SELECT schedule.*
      FROM program_schedules schedule
      JOIN scheduled_program_events event
        ON event.schedule_id = schedule.id
       AND event.schedule_version_id = schedule.current_version_id
       AND event.user_id = schedule.user_id
      WHERE event.id = ${input.eventId}::uuid
        AND event.user_id = ${userId}::uuid
        AND NOT EXISTS (SELECT 1 FROM existing)
      FOR UPDATE OF schedule
    ), updated AS (
      UPDATE scheduled_program_events event
      SET status = 'completed',
          revision = event.revision + 1,
          resolved_at = ${completedAt.toISOString()}::timestamptz,
          updated_at = statement_timestamp()
      FROM locked_schedule schedule
      WHERE event.id = ${input.eventId}::uuid
        AND event.user_id = ${userId}::uuid
        AND event.status = 'scheduled'
        AND event.kind <> 'resistance'
        AND event.revision = ${input.expectedRevision}
        AND schedule.id = event.schedule_id
        AND schedule.current_version_id = event.schedule_version_id
        AND schedule.user_id = event.user_id
      RETURNING event.id
    ), recorded AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id,
        summary, cause_ref, idempotency_key
      )
      SELECT
        ${userId}::uuid,
        'user',
        'program_schedule.complete_non_resistance',
        'scheduled_program_event',
        ${input.eventId},
        'Completed a non-resistance Program event',
        jsonb_build_object('requestHash', ${hash}::text, 'affected', 1),
        ${key}
      FROM updated
      RETURNING cause_ref
    )
    SELECT 'replayed'::text AS outcome, cause_ref FROM existing
    UNION ALL
    SELECT 'applied'::text AS outcome, cause_ref FROM recorded
  `));
  if (rows.length !== 1) return { outcome: "conflict" };
  const causeRef = rows[0].cause_ref as Record<string, unknown>;
  if (causeRef.requestHash !== hash) return { outcome: "conflict" };
  return {
    outcome: String(rows[0].outcome) as "applied" | "replayed",
    affected: Number(causeRef.affected),
  };
}

export type CurrentProgramSchedule = NonNullable<
  Awaited<ReturnType<typeof getCurrentProgramSchedule>>
>;
