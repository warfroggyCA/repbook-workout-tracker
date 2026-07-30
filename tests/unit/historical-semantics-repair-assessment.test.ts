import { describe, expect, it } from "vitest";
import type { CanonicalSnapshotPayload } from "@/services/snapshot-capture";
import {
  assessHistoricalSemanticsRepairPayload,
  HISTORICAL_SEMANTICS_REPAIR_RULE_VERSION,
  rejectHistoricalSemanticsRepairActivation,
} from "@/services/historical-semantics-repair-assessment";

const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const sessionExerciseId = "00000000-0000-4000-8000-000000000003";
const setId = "00000000-0000-4000-8000-000000000004";

function payload(
  completedSet: Record<string, unknown>,
  overrides: Record<string, unknown[]> = {},
): CanonicalSnapshotPayload {
  return {
    schemaVersion: "27",
    capturedAt: "2026-07-29T22:00:00.000Z",
    appVersion: "test",
    tables: {
      workout_sessions: [{
        id: sessionId,
        user_id: userId,
        status: "completed",
        history_revision: 7,
      }],
      session_exercises: [{
        id: sessionExerciseId,
        session_id: sessionId,
      }],
      completed_sets: [{
        id: setId,
        session_exercise_id: sessionExerciseId,
        target_met: true,
        ...completedSet,
      }],
      recommendations: [],
      user_decisions: [],
      adaptation_events: [],
      coaching_insights: [],
      record_versions: [],
      export_events: [],
      data_snapshots: [],
      ...overrides,
    },
  };
}

describe("historical semantics repair assessment", () => {
  it("keeps legacy rows ambiguous and produces deterministic pre-mutation evidence", () => {
    const source = payload({
      metric_type: "assisted_reps",
      performed_semantics_version: null,
      performed_load_type: null,
      performed_load_semantics: null,
    });
    const before = structuredClone(source);
    const first = assessHistoricalSemanticsRepairPayload(source, userId);
    const second = assessHistoricalSemanticsRepairPayload(source, userId);

    expect(first).toMatchObject({
      assessmentVersion: HISTORICAL_SEMANTICS_REPAIR_RULE_VERSION,
      mutationAuthorized: false,
      contractActivationAuthorized: false,
      decision: "blocked_no_proven_rows",
      counts: {
        candidates: 1,
        provablyRepairable: 0,
        ambiguous: 1,
        unsupported: 0,
      },
      candidates: [{
        setId,
        workoutSessionId: sessionId,
        parentHistoryRevision: 7,
        classification: "ambiguous",
        reason: "no_immutable_performed_time_evidence",
        proposedAfter: null,
        immutableEvidence: [],
        excludedEvidence: ["current_mutable_exercise_catalog"],
      }],
    });
    expect(first.candidates[0]?.idempotencyKey).toBe(
      second.candidates[0]?.idempotencyKey,
    );
    expect(source).toEqual(before);
    expect(() => rejectHistoricalSemanticsRepairActivation()).toThrow(
      /activation is blocked.*assessment-only/i,
    );
  });

  it.each([
    {
      name: "incomplete",
      tuple: {
        metric_type: "weight_reps",
        performed_semantics_version: 1,
        performed_load_type: "barbell",
        performed_load_semantics: null,
      },
      classification: "ambiguous",
      reason: "incomplete_performed_semantics",
    },
    {
      name: "unsupported",
      tuple: {
        metric_type: "weight_reps",
        performed_semantics_version: 2,
        performed_load_type: "barbell",
        performed_load_semantics: "total",
      },
      classification: "unsupported",
      reason: "unsupported_performed_semantics_version",
    },
  ])(
    "refuses a $name tuple without inventing repair provenance",
    ({ tuple, classification, reason }) => {
      const report = assessHistoricalSemanticsRepairPayload(
        payload(tuple),
        userId,
      );
      expect(report.candidates[0]).toMatchObject({
        classification,
        reason,
        proposedAfter: null,
        immutableEvidence: [],
      });
      expect(report.counts.provablyRepairable).toBe(0);
    },
  );

  it("does not turn ordinary record versions into performed-time proof", () => {
    const report = assessHistoricalSemanticsRepairPayload(
      payload(
        {
          metric_type: "weight_reps",
          performed_semantics_version: null,
          performed_load_type: null,
          performed_load_semantics: null,
        },
        {
          record_versions: [{
            id: "00000000-0000-4000-8000-000000000005",
            user_id: userId,
            entity_type: "completed_set",
            entity_id: setId,
            action: "set.update",
            before_data: { target_met: true },
            after_data: { target_met: false },
          }],
        },
      ),
      userId,
    );

    expect(report.counts.provablyRepairable).toBe(0);
    expect(report.candidates[0]?.excludedEvidence).toContain(
      "record_version_without_performed_time_proof",
    );
    expect(report.consequenceGraph.counts.recordVersions).toBe(1);
  });

  it("does not classify complete supported rows as repair candidates", () => {
    const report = assessHistoricalSemanticsRepairPayload(
      payload({
        metric_type: "weight_reps",
        performed_semantics_version: 1,
        performed_load_type: "barbell",
        performed_load_semantics: "total",
      }),
      userId,
    );

    expect(report).toMatchObject({
      decision: "not_required_no_candidates",
      counts: {
        candidates: 0,
        provablyRepairable: 0,
        ambiguous: 0,
        unsupported: 0,
      },
    });
  });

  it("keeps missing parent revision evidence explicit instead of inventing a fence", () => {
    const source = payload({
      metric_type: "weight_reps",
      performed_semantics_version: null,
      performed_load_type: null,
      performed_load_semantics: null,
    });
    delete (source.tables.workout_sessions[0] as Record<string, unknown>)
      .history_revision;

    const report = assessHistoricalSemanticsRepairPayload(source, userId);

    expect(report.candidates[0]).toMatchObject({
      classification: "ambiguous",
      parentHistoryRevision: null,
      proposedAfter: null,
    });
  });

  it("preserves accepted and edited consequences and Program lineage in the reused graph", () => {
    const recommendationId = "00000000-0000-4000-8000-000000000010";
    const programId = "00000000-0000-4000-8000-000000000011";
    const programVersionId = "00000000-0000-4000-8000-000000000012";
    const report = assessHistoricalSemanticsRepairPayload(
      payload(
        {
          metric_type: "weight_reps",
          performed_semantics_version: null,
          performed_load_type: null,
          performed_load_semantics: null,
        },
        {
          recommendations: [{
            id: recommendationId,
            user_id: userId,
            status: "edited",
            evidence: { setIds: [setId], sessionIds: [sessionId] },
            reconciled_by_program_version_id: programVersionId,
          }],
          user_decisions: [{
            id: "00000000-0000-4000-8000-000000000013",
            recommendation_id: recommendationId,
            decision: "edit",
          }],
          programs: [{ id: programId, user_id: userId }],
          program_versions: [{
            id: programVersionId,
            program_id: programId,
            publication_source: "recommendation",
          }],
        },
      ),
      userId,
    );

    expect(report.programCorrectionPolicy).toBe(
      "new_reviewed_proposal_required",
    );
    expect(report.consequenceGraph.counts).toMatchObject({
      recommendations: 1,
      acceptedOrEditedDecisions: 1,
      recommendationProgramVersions: 1,
    });
  });
});
