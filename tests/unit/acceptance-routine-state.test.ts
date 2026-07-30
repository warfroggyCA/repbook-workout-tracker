import { describe, expect, it } from "vitest";
import type { CanonicalSnapshotPayload } from "@/services/snapshot-capture";
import { summarizeAcceptanceRoutineSnapshot } from "@/services/acceptance-routine-state";

function payload(
  tables: CanonicalSnapshotPayload["tables"],
): CanonicalSnapshotPayload {
  return {
    schemaVersion: "22",
    capturedAt: new Date(0).toISOString(),
    appVersion: "test",
    tables,
  };
}

describe("acceptance routine durable state", () => {
  it("summarizes the active Program tree, draft state, proposals, recommendations, and workout records", () => {
    const state = summarizeAcceptanceRoutineSnapshot(
      payload({
        programs: [
          {
            id: "program-1",
            status: "active",
            archived_at: null,
            current_version_id: "version-1",
          },
        ],
        program_versions: [
          { id: "version-1", program_id: "program-1", version_no: 1 },
        ],
        workout_templates: [{ id: "day-1" }, { id: "day-2" }],
        superset_groups: [{ id: "group-1" }],
        workout_template_exercises: [{ id: "slot-1" }, { id: "slot-2" }],
        exercise_prescriptions: [{ id: "dose-1" }, { id: "dose-2" }],
        program_drafts: [{ id: "draft-1", status: "open", revision: 1 }],
        session_compiler_proposals: [],
        recommendations: [{ id: "recommendation-1" }],
        workout_sessions: [{ id: "session-1" }],
        session_exercises: [{ id: "occurrence-1" }],
        completed_sets: [{ id: "set-1" }, { id: "set-2" }],
      }),
    );

    expect(state).toMatchObject({
      programTree: {
        programs: 1,
        versions: 1,
        currentVersionNumbers: [1],
        days: 2,
        groups: 1,
        slots: 2,
        prescriptions: 2,
      },
      drafts: { count: 1, states: [{ status: "open", revision: 1 }] },
      proposals: { count: 0 },
      recommendations: { count: 1 },
      workouts: { sessions: 1, occurrences: 1, sets: 2 },
    });
  });

  it("changes only the affected digest when a draft is revised", () => {
    const baseTables = {
      programs: [{ id: "program-1", status: "active", archived_at: null }],
      program_versions: [],
      workout_templates: [],
      superset_groups: [],
      workout_template_exercises: [],
      exercise_prescriptions: [],
      program_drafts: [{ id: "draft-1", status: "open", revision: 1 }],
      session_compiler_proposals: [],
      recommendations: [],
      workout_sessions: [],
      session_exercises: [],
      completed_sets: [],
    };
    const before = summarizeAcceptanceRoutineSnapshot(payload(baseTables));
    const after = summarizeAcceptanceRoutineSnapshot(
      payload({
        ...baseTables,
        program_drafts: [{ id: "draft-1", status: "open", revision: 2 }],
      }),
    );

    expect(after.drafts.digest).not.toBe(before.drafts.digest);
    expect(after.programTree.digest).toBe(before.programTree.digest);
    expect(after.proposals.digest).toBe(before.proposals.digest);
    expect(after.recommendations.digest).toBe(before.recommendations.digest);
    expect(after.workouts.digest).toBe(before.workouts.digest);
  });
});
