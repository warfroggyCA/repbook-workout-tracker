import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { aiParsingEvents, exercises } from "@/db/schema";
import {
  logParseData,
  logParseSchema,
  RPE_HINT_VALUES,
} from "@/ai/tasks/log-parse/schema";
import {
  resolveFutureSetWriterMetricType,
  validateSetWriterShape,
  type PerformedMetricType,
} from "@/lib/set-metric-semantics";

export type ApplyQuickLogData = {
  parsingEventId: string;
  exerciseByEntry: Record<string, string>;
  discardedEntries: number[];
  painSeverityByEntry: Record<string, number>;
};

export type QuickLogCheckpoint = (boundary: string) => void | Promise<void>;

export type QuickLogApplyDependencies = {
  checkpoint?: QuickLogCheckpoint;
  /** Test-only database failure injection. Any non-null value aborts the statement. */
  failureAt?: string;
};

type PreparedQuickLogEntry = {
  index: number;
  kind: "sets" | "skip" | "pain" | "note";
  sessionExerciseId?: string;
  exerciseId?: string;
  metricType?: PerformedMetricType;
  skipReason?: string;
  sets?: Array<{
    id: string;
    setNo: number;
    weight: number | null;
    weightUnit: "lb" | "kg" | null;
    reps: number;
    rpe: number | null;
  }>;
  bodyPart?: string;
  severity?: number;
  text?: string;
};

async function findParsingEvent(db: Db, userId: string, parsingEventId: string) {
  return db.query.aiParsingEvents.findFirst({
    where: and(
      eq(aiParsingEvents.id, parsingEventId),
      eq(aiParsingEvents.userId, userId),
      eq(aiParsingEvents.scope, "log")
    ),
  });
}

export async function applyQuickLogToDatabase(
  db: Db,
  userId: string,
  input: ApplyQuickLogData,
  dependencies: QuickLogApplyDependencies = {}
): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
  const checkpoint = dependencies.checkpoint ?? (() => undefined);
  const event = await findParsingEvent(db, userId, input.parsingEventId);
  if (!event) return { ok: false, reason: "Parse not found." };
  if (event.confirmed) {
    return event.resultSessionId
      ? { ok: true, sessionId: event.resultSessionId }
      : { ok: false, reason: "This older quick log was already saved." };
  }

  const envelope = logParseSchema.safeParse(event.parsedJson);
  if (!envelope.success) {
    return { ok: false, reason: "Stored parse is invalid and cannot be saved." };
  }
  const dataCheck = logParseData.safeParse(envelope.data.data);
  if (!dataCheck.success) {
    return { ok: false, reason: "Stored parse is invalid and cannot be saved." };
  }

  const entryCount = envelope.data.data.entries.length;
  const discarded = new Set(input.discardedEntries);
  if (
    discarded.size !== input.discardedEntries.length ||
    input.discardedEntries.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= entryCount
    )
  ) {
    return { ok: false, reason: "The discarded-entry selection is invalid." };
  }

  for (const key of [
    ...Object.keys(input.exerciseByEntry),
    ...Object.keys(input.painSeverityByEntry),
  ]) {
    const index = Number(key);
    if (!Number.isInteger(index) || String(index) !== key || index < 0 || index >= entryCount) {
      return { ok: false, reason: "The entry selection is invalid." };
    }
  }

  const selected = envelope.data.data.entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => !discarded.has(index));
  if (!selected.length) return { ok: false, reason: "Nothing left to save." };

  const selectedExerciseIds = [
    ...new Set(
      selected.flatMap(({ entry, index }) => {
        if (entry.kind !== "sets" && entry.kind !== "skip") return [];
        const exerciseId = input.exerciseByEntry[String(index)];
        return exerciseId ? [exerciseId] : [];
      }),
    ),
  ];
  const exerciseDefinitions = selectedExerciseIds.length
    ? await db.query.exercises.findMany({
        where: and(
          inArray(exercises.id, selectedExerciseIds),
          or(isNull(exercises.userId), eq(exercises.userId, userId)),
        ),
        columns: { id: true, metricType: true, loadSemantics: true },
      })
    : [];
  const exerciseDefinitionById = new Map(
    exerciseDefinitions.map((exercise) => [exercise.id, exercise]),
  );

  const prepared: PreparedQuickLogEntry[] = [];
  for (const { entry, index } of selected) {
    if (entry.kind === "sets" || entry.kind === "skip") {
      const exerciseId = input.exerciseByEntry[String(index)];
      if (!exerciseId) {
        return {
          ok: false,
          reason: `"${entry.rawExercise}" isn't matched to an exercise yet — pick one or discard that entry.`,
        };
      }
      const exerciseDefinition = exerciseDefinitionById.get(exerciseId);
      if (!exerciseDefinition) {
        return {
          ok: false,
          reason:
            "That exercise is no longer available for this account. Pick another exercise or discard the entry.",
        };
      }
      if (entry.kind === "sets") {
        const performedMetricType = resolveFutureSetWriterMetricType({
          metricType: exerciseDefinition.metricType,
          loadSemantics: exerciseDefinition.loadSemantics,
        });
        for (const set of entry.sets) {
          const supported = validateSetWriterShape({
            metricType: performedMetricType,
            loadSemantics: exerciseDefinition.loadSemantics,
            weight: set.weight,
            weightUnit: set.weightUnit,
            reps: set.reps,
          });
          if (!supported.ok) {
            return {
              ok: false,
              reason: `"${entry.rawExercise}" cannot be saved with those measurements. ${supported.message}`,
            };
          }
        }
        prepared.push({
          index,
          kind: "sets",
          sessionExerciseId: randomUUID(),
          exerciseId,
          metricType: performedMetricType,
          sets: entry.sets.map((set, setIndex) => ({
            id: randomUUID(),
            setNo: setIndex + 1,
            weight: set.weight,
            weightUnit: set.weightUnit,
            reps: set.reps,
            rpe: set.rpeHint ? RPE_HINT_VALUES[set.rpeHint] : null,
          })),
        });
      } else {
        prepared.push({
          index,
          kind: "skip",
          sessionExerciseId: randomUUID(),
          exerciseId,
          skipReason: entry.reason ?? "other",
        });
      }
      continue;
    }
    if (entry.kind === "pain") {
      const severity =
        entry.severity ?? input.painSeverityByEntry[String(index)];
      if (severity == null) {
        return {
          ok: false,
          reason: "Set a severity for the pain entry (or discard it).",
        };
      }
      prepared.push({
        index,
        kind: "pain",
        bodyPart: entry.bodyPart,
        severity,
      });
      continue;
    }
    prepared.push({ index, kind: "note", text: entry.text });
  }

  const candidateSessionId = randomUUID();
  const expectedParsedJson = JSON.stringify(event.parsedJson);
  const preparedJson = JSON.stringify(prepared);
  const confirmedPayload = JSON.stringify({
    exerciseByEntry: input.exerciseByEntry,
    discardedEntries: input.discardedEntries,
    painSeverityByEntry: input.painSeverityByEntry,
  });

  await checkpoint("quick-log-ready");
  const query = sql`
    WITH prepared AS MATERIALIZED (
      SELECT value
      FROM jsonb_array_elements(${preparedJson}::jsonb) item(value)
    ), profile AS MATERIALIZED (
      SELECT user_id, timezone
      FROM user_profiles
      WHERE user_id = ${userId}::uuid
    ), active_session AS MATERIALIZED (
      SELECT session.id
      FROM workout_sessions session
      WHERE session.user_id = ${userId}::uuid
        AND session.status = 'in_progress'
        AND session.archived_at IS NULL
      ORDER BY session.started_at, session.id
      LIMIT 1
      FOR UPDATE
    ), target AS MATERIALIZED (
      SELECT
        coalesce((SELECT id FROM active_session), ${candidateSessionId}::uuid) AS session_id,
        EXISTS (SELECT 1 FROM active_session) AS appending,
        profile.timezone
      FROM profile
    ), eligible AS MATERIALIZED (
      SELECT event.id
      FROM ai_parsing_events event
      CROSS JOIN target
      WHERE event.id = ${input.parsingEventId}::uuid
        AND event.user_id = ${userId}::uuid
        AND event.scope = 'log'
        AND event.confirmed = false
        AND event.parsed_json = ${expectedParsedJson}::jsonb
        AND NOT EXISTS (
          SELECT 1
          FROM prepared item
          WHERE item.value->>'kind' IN ('sets', 'skip')
            AND NOT EXISTS (
              SELECT 1
              FROM exercises exercise
              WHERE exercise.id = (item.value->>'exerciseId')::uuid
                AND (exercise.user_id IS NULL OR exercise.user_id = ${userId}::uuid)
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM prepared item
          JOIN exercises exercise
            ON exercise.id = (item.value->>'exerciseId')::uuid
          WHERE item.value->>'kind' = 'sets'
            AND CASE
              WHEN exercise.metric_type::text = 'weight_reps'
                AND exercise.load_semantics::text = 'resistance_band'
                THEN 'reps'
              ELSE exercise.metric_type::text
            END <> item.value->>'metricType'
        )
    ), claimed AS (
      UPDATE ai_parsing_events event
      SET confirmed = true,
          result_session_id = target.session_id,
          confirmed_payload = ${confirmedPayload}::jsonb || jsonb_build_object(
            'sessionId', target.session_id,
            'entryCount', ${prepared.length}::integer
          ),
          raw_input = '',
          raw_output = NULL,
          parsed_json = NULL,
          ambiguities = '[]'::jsonb,
          raw_redacted_at = now(),
          retention_expires_at = NULL
      FROM eligible, target
      WHERE event.id = eligible.id
        AND event.confirmed = false
      RETURNING event.id, target.session_id, target.appending, target.timezone
    ), created_session AS (
      INSERT INTO workout_sessions (
        id, user_id, template_name, status, source, started_at, finished_at,
        timezone, local_date
      )
      SELECT
        claimed.session_id,
        ${userId}::uuid,
        'Quick log',
        'completed',
        'tracker',
        now(),
        now(),
        claimed.timezone,
        timezone(claimed.timezone, now())::date
      FROM claimed
      WHERE NOT claimed.appending
      RETURNING id
    ), ready_session AS MATERIALIZED (
      SELECT claimed.session_id
      FROM claimed
      WHERE claimed.appending OR EXISTS (SELECT 1 FROM created_session)
    ), base_order AS MATERIALIZED (
      SELECT coalesce(max(exercise.order_idx), -1) + 1 AS next_order
      FROM ready_session
      LEFT JOIN session_exercises exercise
        ON exercise.session_id = ready_session.session_id
    ), inserted_exercises AS (
      INSERT INTO session_exercises (
        id, session_id, exercise_id, modification_type, skip_reason, order_idx
      )
      SELECT
        (item.value->>'sessionExerciseId')::uuid,
        ready_session.session_id,
        (item.value->>'exerciseId')::uuid,
        CASE item.value->>'kind'
          WHEN 'skip' THEN 'skipped'::modification_type
          ELSE 'added'::modification_type
        END,
        CASE
          WHEN item.value->>'kind' = 'skip'
            THEN (item.value->>'skipReason')::skip_reason
          ELSE NULL
        END,
        base_order.next_order
          + row_number() OVER (ORDER BY (item.value->>'index')::integer) - 1
      FROM prepared item
      CROSS JOIN ready_session
      CROSS JOIN base_order
      WHERE item.value->>'kind' IN ('sets', 'skip')
      RETURNING id, session_id, exercise_id, skip_reason
    ), inserted_sets AS (
      INSERT INTO completed_sets (
        id, session_exercise_id, set_no, weight, weight_unit, reps, rpe,
        metric_type, performed_semantics_version, performed_load_type,
        performed_load_semantics
      )
      SELECT
        (set_item.value->>'id')::uuid,
        inserted_exercises.id,
        (set_item.value->>'setNo')::integer,
        (set_item.value->>'weight')::double precision,
        (set_item.value->>'weightUnit')::unit,
        (set_item.value->>'reps')::integer,
        (set_item.value->>'rpe')::real,
        (item.value->>'metricType')::metric_type,
        1,
        definition.load_type,
        definition.load_semantics
      FROM prepared item
      JOIN inserted_exercises
        ON inserted_exercises.id = (item.value->>'sessionExerciseId')::uuid
      JOIN exercises definition
        ON definition.id = inserted_exercises.exercise_id
      CROSS JOIN LATERAL jsonb_array_elements(item.value->'sets') set_item(value)
      WHERE item.value->>'kind' = 'sets'
      RETURNING id, session_exercise_id, set_no, logged_at
    ), occurrence_base AS MATERIALIZED (
      SELECT
        ready_session.session_id,
        coalesce(max(occurrence.sequence_idx), -1) + 1 AS next_sequence
      FROM ready_session
      LEFT JOIN session_occurrences occurrence
        ON occurrence.session_id = ready_session.session_id
      GROUP BY ready_session.session_id
    ), occurrence_rows AS MATERIALIZED (
      SELECT
        exercise.session_id,
        exercise.id AS session_exercise_id,
        exercise.exercise_id AS planned_exercise_id,
        completed.id AS completed_set_id,
        completed.set_no - 1 AS kind_ordinal,
        'completed'::text AS outcome,
        NULL::text AS outcome_reason,
        completed.logged_at AS resolved_at,
        (item.value->>'index')::integer AS entry_order,
        completed.set_no AS set_order
      FROM inserted_sets completed
      JOIN inserted_exercises exercise
        ON exercise.id = completed.session_exercise_id
      JOIN prepared item
        ON (item.value->>'sessionExerciseId')::uuid = exercise.id
      WHERE item.value->>'kind' = 'sets'
      UNION ALL
      SELECT
        exercise.session_id,
        exercise.id,
        exercise.exercise_id,
        NULL::uuid,
        0,
        'skipped'::text,
        exercise.skip_reason::text,
        now(),
        (item.value->>'index')::integer,
        0
      FROM inserted_exercises exercise
      JOIN prepared item
        ON (item.value->>'sessionExerciseId')::uuid = exercise.id
      WHERE item.value->>'kind' = 'skip'
    ), inserted_occurrences AS (
      INSERT INTO session_occurrences (
        session_id, session_exercise_id, kind, origin, sequence_idx,
        kind_ordinal, planned_exercise_id, outcome, outcome_reason,
        resolved_at, completed_set_id
      )
      SELECT
        row.session_id,
        row.session_exercise_id,
        'working_set',
        'ad_hoc',
        base.next_sequence
          + row_number() OVER (ORDER BY row.entry_order, row.set_order, row.session_exercise_id) - 1,
        row.kind_ordinal,
        row.planned_exercise_id,
        row.outcome,
        row.outcome_reason,
        row.resolved_at,
        row.completed_set_id
      FROM occurrence_rows row
      JOIN occurrence_base base ON base.session_id = row.session_id
      RETURNING id
    ), inserted_pain AS (
      INSERT INTO pain_logs (
        user_id, session_id, body_part, severity, source
      )
      SELECT
        ${userId}::uuid,
        ready_session.session_id,
        item.value->>'bodyPart',
        (item.value->>'severity')::integer,
        'session_note'
      FROM prepared item
      CROSS JOIN ready_session
      WHERE item.value->>'kind' = 'pain'
      RETURNING id
    ), inserted_notes AS (
      INSERT INTO session_notes (session_id, text)
      SELECT ready_session.session_id, item.value->>'text'
      FROM prepared item
      CROSS JOIN ready_session
      WHERE item.value->>'kind' = 'note'
      RETURNING id
    ), write_counts AS MATERIALIZED (
      SELECT
        (SELECT count(*) FROM prepared WHERE value->>'kind' IN ('sets', 'skip')) AS expected_exercises,
        (SELECT count(*) FROM inserted_exercises) AS actual_exercises,
        (SELECT coalesce(sum(jsonb_array_length(value->'sets')), 0) FROM prepared WHERE value->>'kind' = 'sets') AS expected_sets,
        (SELECT count(*) FROM inserted_sets) AS actual_sets,
        (SELECT coalesce(sum(jsonb_array_length(value->'sets')), 0) FROM prepared WHERE value->>'kind' = 'sets')
          + (SELECT count(*) FROM prepared WHERE value->>'kind' = 'skip') AS expected_occurrences,
        (SELECT count(*) FROM inserted_occurrences) AS actual_occurrences,
        (SELECT count(*) FROM prepared WHERE value->>'kind' = 'pain') AS expected_pain,
        (SELECT count(*) FROM inserted_pain) AS actual_pain,
        (SELECT count(*) FROM prepared WHERE value->>'kind' = 'note') AS expected_notes,
        (SELECT count(*) FROM inserted_notes) AS actual_notes
    ), recorded_audit AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id, summary,
        cause_ref, idempotency_key
      )
      SELECT
        CASE
          WHEN counts.expected_exercises = counts.actual_exercises
            AND counts.expected_sets = counts.actual_sets
            AND counts.expected_occurrences = counts.actual_occurrences
            AND counts.expected_pain = counts.actual_pain
            AND counts.expected_notes = counts.actual_notes
            AND ${dependencies.failureAt ?? null}::text IS NULL
          THEN ${userId}::uuid
          ELSE NULL::uuid
        END,
        'user',
        'quicklog.apply',
        'workout_session',
        claimed.session_id::text,
        'Saved quick log (' || ${prepared.length}::integer ||
          CASE WHEN ${prepared.length}::integer = 1 THEN ' entry)' ELSE ' entries)' END,
        jsonb_build_object('parsingEventId', claimed.id),
        'quicklog:' || claimed.id::text
      FROM claimed
      CROSS JOIN write_counts counts
      RETURNING id
    )
    SELECT claimed.session_id
    FROM claimed
    WHERE EXISTS (SELECT 1 FROM recorded_audit)
  `;

  const row = resultRows(await db.execute(query))[0];
  if (row?.session_id) {
    await checkpoint("quick-log-applied");
    return { ok: true, sessionId: String(row.session_id) };
  }

  // A simultaneous request may have won the conditional claim while this
  // statement waited. Returning its durable result makes retry idempotent.
  const latest = await findParsingEvent(db, userId, input.parsingEventId);
  if (latest?.confirmed && latest.resultSessionId) {
    return { ok: true, sessionId: latest.resultSessionId };
  }
  return {
    ok: false,
    reason:
      "The quick log was not saved because its exercise choices or workout state changed. Review it and try again.",
  };
}
