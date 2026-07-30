import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { resultRows } from "@/db/result";
import { importEvents } from "@/db/schema";
import { isValidIanaTimezone } from "@/lib/workout-calendar";
import {
  buildHevyExerciseReviews,
  parseHevyCsv,
  type StagedHevyPayload,
} from "@/services/hevy-import";

export type HevyStageCheckpoint = (boundary: string) => void | Promise<void>;

function stageConflict(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (
      current instanceof Error &&
      current.message.includes("import_events_current_hevy_stage_uq")
    ) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return false;
}

export function validateHevyUploadMetadata(input: {
  timezone: string;
  originalFilename: string;
}) {
  if (!isValidIanaTimezone(input.timezone)) {
    throw new Error("Choose a valid IANA timezone for the Hevy export.");
  }
  if (
    input.originalFilename.length < 1 ||
    input.originalFilename.length > 255 ||
    /[\\/\0-\x1f\x7f]/.test(input.originalFilename) ||
    !input.originalFilename.toLowerCase().endsWith(".csv")
  ) {
    throw new Error("Hevy history must use a safe .csv filename.");
  }
}

export async function stageHevyImport(
  db: Db,
  userId: string,
  input: { csv: string; timezone: string; originalFilename: string },
  checkpoint: HevyStageCheckpoint = () => undefined
): Promise<
  | { ok: true; stage: { importEventId: string } & StagedHevyPayload }
  | { ok: false; reason: string; status: 400 | 409 }
> {
  try {
    validateHevyUploadMetadata(input);
    const parsed = parseHevyCsv(input.csv, input.timezone);
    await checkpoint("hevy-stage-parsed");
    const reviews = await buildHevyExerciseReviews(db, userId, parsed);
    const payload: StagedHevyPayload = {
      kind: "hevy_history",
      schemaVersion: "1",
      originalFilename: input.originalFilename,
      fileHash: parsed.fileHash,
      timezone: input.timezone,
      profile: parsed.profile,
      exercises: reviews,
    };
    const eventId = randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const query = sql`
      WITH duplicate AS MATERIALIZED (
        SELECT batch.id
        FROM history_import_batches batch
        WHERE batch.user_id = ${userId}::uuid
          AND batch.file_hash = ${parsed.fileHash}
          AND batch.status = 'confirmed'
        LIMIT 1
      ), superseded AS (
        UPDATE import_events current
        SET status = 'discarded',
            raw_payload = '',
            parsed_payload = NULL,
            raw_redacted_at = now(),
            retention_expires_at = NULL
        WHERE current.user_id = ${userId}::uuid
          AND current.source = 'csv'
          AND current.status = 'parsed'
          AND NOT EXISTS (SELECT 1 FROM duplicate)
        RETURNING current.id
      ), inserted AS (
        INSERT INTO import_events (
          id, user_id, source, raw_payload, payload_sha256, parsed_payload,
          status, retention_expires_at
        )
        SELECT
          ${eventId}::uuid, ${userId}::uuid, 'csv', ${input.csv},
          ${createHash("sha256").update(input.csv).digest("hex")},
          ${JSON.stringify(payload)}::jsonb, 'parsed',
          ${expiresAt.toISOString()}::timestamptz
        WHERE NOT EXISTS (SELECT 1 FROM duplicate)
        RETURNING id
      )
      SELECT
        EXISTS (SELECT 1 FROM duplicate) AS duplicate,
        (SELECT id::text FROM inserted LIMIT 1) AS inserted_id,
        (SELECT count(*)::int FROM superseded) AS superseded_count
    `;

    let row: Record<string, unknown> | undefined;
    try {
      row = resultRows(await db.execute(query))[0];
    } catch (error) {
      if (stageConflict(error)) {
        return {
          ok: false,
          reason:
            "Another Hevy upload became the current review first. Review that file before replacing it.",
          status: 409,
        };
      }
      throw error;
    }
    if (row?.duplicate === true) {
      return {
        ok: false,
        reason: "This Hevy file has already been imported.",
        status: 409,
      };
    }
    if (String(row?.inserted_id ?? "") !== eventId) {
      throw new Error("The Hevy review could not be staged.");
    }

    await checkpoint("hevy-stage-guarded");
    const current = await db.query.importEvents.findFirst({
      where: and(
        eq(importEvents.id, eventId),
        eq(importEvents.userId, userId),
        eq(importEvents.source, "csv"),
        eq(importEvents.status, "parsed")
      ),
      columns: { id: true },
    });
    if (!current) {
      return {
        ok: false,
        reason:
          "Another Hevy upload replaced this review before it opened. The newer review is ready instead.",
        status: 409,
      };
    }
    return { ok: true, stage: { importEventId: eventId, ...payload } };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? error.message
          : "The Hevy export could not be read.",
      status: 400,
    };
  }
}
