import type { Db } from "@/db";
import { logWorkoutSet } from "@/services/session-lifecycle";
import type { T01RecordingTruthFixture } from "./v2-t01-recording-truth";

export const U02_EXCEPTION_CONTEXT = {
  rir: 2,
  techniqueIssue: "bracing",
  limitationCause: "strength_fatigue",
  pain: {
    bodyPart: "back",
    severity: 4,
    note: "Sharp only at the bottom",
  },
  note: "Stopped before technique degraded further",
} as const;

export async function recordU02Exception(
  db: Db,
  fixture: T01RecordingTruthFixture,
) {
  const result = await logWorkoutSet(db, fixture.userId, {
    ...fixture.commands.loaded,
    clientKey: "v2-u02-exception",
    rpe: null,
    ...U02_EXCEPTION_CONTEXT,
  });
  if (result.outcome !== "saved") {
    throw new Error(`U02 exception set was not saved: ${result.outcome}`);
  }
  return result;
}

