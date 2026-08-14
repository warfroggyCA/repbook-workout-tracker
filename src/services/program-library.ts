import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db";
import { programs } from "@/db/schema";
import { resultRows } from "@/db/result";
import { canonicalJson, sha256Hex } from "@/services/snapshot-crypto";

const uuidSchema = z.string().uuid();

export type ProgramLibraryItem = {
  id: string;
  name: string;
  status: "active" | "inactive";
  versionNo: number;
  routineNames: string[];
  scheduleKind: "fixed_7_day" | "rolling" | "advanced" | null;
};

/** The owner's usable Programs. Archived records remain recovery/history data. */
export async function listProgramLibrary(
  db: Db,
  userId: string,
): Promise<ProgramLibraryItem[]> {
  const rows = await db.query.programs.findMany({
    where: and(
      eq(programs.userId, userId),
      inArray(programs.status, ["active", "inactive"]),
      isNull(programs.archivedAt),
    ),
    orderBy: [desc(programs.createdAt), desc(programs.id)],
    with: {
      currentVersion: { with: { templates: true } },
      schedule: { with: { currentVersion: true } },
    },
  });

  return rows.flatMap((program) => {
    if (
      (program.status !== "active" && program.status !== "inactive") ||
      !program.currentVersion ||
      program.currentVersion.id !== program.currentVersionId ||
      program.currentVersion.programId !== program.id
    ) {
      return [];
    }
    const schedulePhases =
      program.schedule?.currentVersion?.document.phases ?? [];
    return [{
      id: program.id,
      name: program.name,
      status: program.status,
      versionNo: program.currentVersion.versionNo,
      routineNames: [...program.currentVersion.templates]
        .sort((left, right) => left.orderIdx - right.orderIdx)
        .map((template) => template.name),
      scheduleKind:
        schedulePhases.length > 1
          ? "advanced"
          : (schedulePhases[0]?.schedule.kind ?? null),
    }];
  });
}

export type SwitchActiveProgramResult =
  | { outcome: "switched" | "replayed" | "already_active" }
  | { outcome: "active_workout" | "conflict" | "invalid" };

/**
 * Switches the one active Program without editing either Program version.
 * The owner mutex and one statement make the two status changes indivisible.
 */
export async function switchActiveProgram(
  db: Db,
  userId: string,
  input: {
    targetProgramId: string;
    expectedActiveProgramId: string;
    requestId: string;
  },
): Promise<SwitchActiveProgramResult> {
  const parsed = z
    .object({
      userId: uuidSchema,
      targetProgramId: uuidSchema,
      expectedActiveProgramId: uuidSchema,
      requestId: uuidSchema,
    })
    .safeParse({ userId, ...input });
  if (!parsed.success) return { outcome: "invalid" };

  const requestHash = sha256Hex(Buffer.from(canonicalJson({
    targetProgramId: input.targetProgramId,
    expectedActiveProgramId: input.expectedActiveProgramId,
  }), "utf8"));
  const idempotencyKey =
    `program-library:switch:${input.requestId.toLowerCase()}`;

  const rows = resultRows(await db.execute(sql`
    WITH existing_receipt AS MATERIALIZED (
      SELECT cause_ref
      FROM audit_logs
      WHERE user_id = ${userId}::uuid
        AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    ), switch_authorization AS MATERIALIZED (
      SELECT set_config('workout_tracker.program_publish', 'authorized', true) AS allowed
      WHERE NOT EXISTS (SELECT 1 FROM existing_receipt)
    ), owner_mutex AS MATERIALIZED (
      SELECT profile.id
      FROM user_profiles profile
      CROSS JOIN switch_authorization
      WHERE profile.user_id = ${userId}::uuid
        AND NOT EXISTS (SELECT 1 FROM existing_receipt)
      FOR UPDATE OF profile
    ), locked_programs AS MATERIALIZED (
      SELECT program.*
      FROM programs program
      CROSS JOIN owner_mutex
      WHERE program.user_id = ${userId}::uuid
        AND program.status IN ('active', 'inactive')
        AND program.archived_at IS NULL
      ORDER BY program.id
      FOR UPDATE OF program
    ), current_program AS MATERIALIZED (
      SELECT program.*
      FROM locked_programs program
      WHERE program.id = ${input.expectedActiveProgramId}::uuid
        AND program.status = 'active'
    ), target_program AS MATERIALIZED (
      SELECT program.*
      FROM locked_programs program
      WHERE program.id = ${input.targetProgramId}::uuid
        AND program.status = 'inactive'
        AND program.current_version_id IS NOT NULL
    ), active_workout AS MATERIALIZED (
      SELECT session.id
      FROM workout_sessions session
      WHERE session.user_id = ${userId}::uuid
        AND session.status = 'in_progress'
        AND session.archived_at IS NULL
      LIMIT 1
    ), eligible AS MATERIALIZED (
      SELECT target.id AS target_id, current.id AS current_id
      FROM target_program target
      CROSS JOIN current_program current
      WHERE target.id <> current.id
        AND NOT EXISTS (SELECT 1 FROM active_workout)
    ), deactivated AS (
      UPDATE programs program
      SET status = 'inactive'
      FROM eligible switch
      WHERE program.id = switch.current_id
        AND program.user_id = ${userId}::uuid
        AND program.status = 'active'
      RETURNING program.id
    ), activated AS (
      UPDATE programs program
      SET status = 'active'
      FROM eligible switch
      CROSS JOIN deactivated
      WHERE program.id = switch.target_id
        AND program.user_id = ${userId}::uuid
        AND program.status = 'inactive'
      RETURNING program.id
    ), reconciled_recommendations AS (
      UPDATE recommendations recommendation
      SET status = 'expired',
          reconciled_at = statement_timestamp(),
          reconciliation_reason = 'The active Program changed, so this suggestion no longer refers to the current plan.',
          reconciled_by_program_version_id = target.current_version_id
      FROM activated
      JOIN locked_programs target ON target.id = activated.id
      WHERE recommendation.user_id = ${userId}::uuid
        AND recommendation.status = 'pending'
        AND recommendation.archived_at IS NULL
      RETURNING recommendation.id
    ), recorded AS (
      INSERT INTO audit_logs (
        user_id, actor_type, action, entity_type, entity_id,
        summary, cause_ref, idempotency_key
      )
      SELECT
        CASE WHEN
          (SELECT count(*) FROM deactivated) = 1
          AND (SELECT count(*) FROM activated) = 1
          THEN ${userId}::uuid ELSE NULL::uuid END,
        'user',
        'program.switch_active',
        'program',
        activated.id::text,
        'Switched the active Program',
        jsonb_build_object(
          'requestHash', ${requestHash}::text,
          'previousProgramId', ${input.expectedActiveProgramId}::text,
          'activeProgramId', activated.id
        ),
        ${idempotencyKey}
      FROM activated
      CROSS JOIN (SELECT count(*) FROM reconciled_recommendations) reconciled
      RETURNING cause_ref
    )
    SELECT 'replayed'::text AS outcome, receipt.cause_ref,
           false AS active_workout
    FROM existing_receipt receipt
    UNION ALL
    SELECT 'switched'::text AS outcome, recorded.cause_ref,
           false AS active_workout
    FROM recorded
    UNION ALL
    SELECT
      CASE
        WHEN EXISTS (
          SELECT 1 FROM locked_programs program
          WHERE program.id = ${input.targetProgramId}::uuid
            AND program.status = 'active'
        ) THEN 'already_active'
        ELSE 'conflict'
      END::text AS outcome,
      NULL::jsonb AS cause_ref,
      EXISTS (SELECT 1 FROM active_workout) AS active_workout
    WHERE NOT EXISTS (SELECT 1 FROM existing_receipt)
      AND NOT EXISTS (SELECT 1 FROM recorded)
  `));

  if (rows.length !== 1) return { outcome: "conflict" };
  const row = rows[0];
  if (row.outcome === "replayed" || row.outcome === "switched") {
    const causeRef = row.cause_ref as Record<string, unknown> | null;
    if (causeRef?.requestHash !== requestHash) return { outcome: "conflict" };
    return { outcome: String(row.outcome) as "switched" | "replayed" };
  }
  if (row.outcome === "already_active") return { outcome: "already_active" };
  if (row.active_workout === true) return { outcome: "active_workout" };
  return { outcome: "conflict" };
}
