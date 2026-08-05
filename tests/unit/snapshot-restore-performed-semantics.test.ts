import { describe, expect, it } from "vitest";
import type { CanonicalSnapshotPayload } from "@/services/snapshot-capture";
import { reconcileSnapshotCompletedSetOutcomes } from "@/services/snapshot-restore";

function payload(
  completedSet: Record<string, unknown>,
): CanonicalSnapshotPayload {
  return {
    schemaVersion: "27",
    capturedAt: "2026-07-29T20:00:00.000Z",
    appVersion: "test",
    tables: {
      session_exercises: [{
        id: "session-exercise",
        modification_type: "as_planned",
        target_reps_min: 8,
        target_load: 100,
        target_load_unit: "lb",
      }],
      completed_sets: [{
        id: "set",
        session_exercise_id: "session-exercise",
        metric_type: "weight_reps",
        load_entry_meaning: "total_system",
        weight: 100,
        weight_unit: "lb",
        reps: 8,
        is_warmup: false,
        target_met: false,
        ...completedSet,
      }],
      session_occurrences: [{
        id: "occurrence",
        session_exercise_id: "session-exercise",
        kind: "working_set",
        origin: "planned",
        outcome: "completed",
        completed_set_id: "set",
        planned_reps_min: 8,
        planned_reps_max: 8,
        planned_load: 100,
        planned_load_unit: "lb",
      }],
    },
  };
}

describe("snapshot restore performed outcome reconciliation", () => {
  it("invalidates a legacy boolean rather than resurrecting it", () => {
    const restored = reconcileSnapshotCompletedSetOutcomes(
      payload({
        performed_semantics_version: null,
        performed_load_type: null,
        performed_load_semantics: null,
        target_met: true,
      }),
    );
    expect(restored.tables.completed_sets[0]).toMatchObject({
      weight: 100,
      reps: 8,
      target_met: null,
    });
  });

  it("recomputes a stale boolean under retained versioned meaning", () => {
    const restored = reconcileSnapshotCompletedSetOutcomes(
      payload({
        performed_semantics_version: 1,
        performed_load_type: "barbell",
        performed_load_semantics: "total",
        target_met: false,
      }),
    );
    expect(restored.tables.completed_sets[0]).toMatchObject({
      weight: 100,
      reps: 8,
      target_met: true,
    });
  });

  it("keeps unsupported assistance and missing targets unknown", () => {
    expect(
      reconcileSnapshotCompletedSetOutcomes(
        payload({
          metric_type: "assisted_reps",
          performed_semantics_version: 1,
          performed_load_type: "machine",
          performed_load_semantics: "assistance",
          target_met: true,
        }),
      ).tables.completed_sets[0],
    ).toMatchObject({ target_met: null });
    const missingTarget = payload({
      performed_semantics_version: 1,
      performed_load_type: "barbell",
      performed_load_semantics: "total",
      target_met: true,
    });
    (missingTarget.tables.session_occurrences[0] as Record<string, unknown>)
      .planned_reps_min = null;
    expect(
      reconcileSnapshotCompletedSetOutcomes(missingTarget)
        .tables.completed_sets[0],
    ).toMatchObject({ target_met: null });
  });

  it("keeps target outcome unknown when an older payload lacks occurrence evidence", () => {
    const older = payload({
      performed_semantics_version: 1,
      performed_load_type: "barbell",
      performed_load_semantics: "total",
      target_met: true,
    });
    delete older.tables.session_occurrences;
    expect(
      reconcileSnapshotCompletedSetOutcomes(older).tables.completed_sets[0],
    ).toMatchObject({ target_met: null });
  });
});
