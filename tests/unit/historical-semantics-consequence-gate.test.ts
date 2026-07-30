import { describe, expect, it } from "vitest";
import type { CanonicalSnapshotPayload } from "@/services/snapshot-capture";
import {
  analyzeHistoricalSemanticsPayload,
  HISTORICAL_SEMANTICS_GATE_VERSION,
  rejectHistoricalSemanticsMutation,
} from "@/services/historical-semantics-gate";

const userId = "00000000-0000-4000-8000-000000000001";
const setId = "00000000-0000-4000-8000-000000000010";
const sessionExerciseId = "00000000-0000-4000-8000-000000000011";
const sessionId = "00000000-0000-4000-8000-000000000012";
const occurrenceId = "00000000-0000-4000-8000-000000000013";
const progressionJobId = "00000000-0000-4000-8000-000000000014";
const recommendationId = "00000000-0000-4000-8000-000000000015";
const decisionId = "00000000-0000-4000-8000-000000000016";
const adaptationId = "00000000-0000-4000-8000-000000000017";
const programId = "00000000-0000-4000-8000-000000000018";
const programVersionId = "00000000-0000-4000-8000-000000000019";
const descendantProgramVersionId = "00000000-0000-4000-8000-000000000025";
const insightId = "00000000-0000-4000-8000-000000000020";
const versionId = "00000000-0000-4000-8000-000000000021";
const exportId = "00000000-0000-4000-8000-000000000022";
const snapshotId = "00000000-0000-4000-8000-000000000023";
const slotLineageId = "00000000-0000-4000-8000-000000000024";
const otherUserId = "00000000-0000-4000-8000-000000000200";

function payload(overrides: Record<string, unknown[]> = {}): CanonicalSnapshotPayload {
  return {
    schemaVersion: "27",
    capturedAt: "2026-07-29T20:00:00.000Z",
    appVersion: "test",
    tables: {
      completed_sets: [{
        id: setId,
        session_exercise_id: sessionExerciseId,
        metric_type: "assisted_reps",
        performed_semantics_version: null,
        performed_load_type: null,
        performed_load_semantics: null,
        target_met: true,
      }],
      session_exercises: [{
        id: sessionExerciseId,
        session_id: sessionId,
        source_slot_lineage_id: slotLineageId,
      }],
      workout_sessions: [{
        id: sessionId,
        user_id: userId,
        status: "completed",
        archived_at: null,
      }],
      session_occurrences: [{
        id: occurrenceId,
        session_id: sessionId,
        session_exercise_id: sessionExerciseId,
        completed_set_id: setId,
        kind: "working_set",
        outcome: "completed",
      }],
      progression_jobs: [{
        id: progressionJobId,
        user_id: userId,
        session_id: sessionId,
      }],
      progression_job_input_sessions: [{
        job_id: progressionJobId,
        user_id: userId,
        source_slot_lineage_id: slotLineageId,
        session_id: sessionId,
      }],
      recommendations: [{
        id: recommendationId,
        user_id: userId,
        progression_job_id: progressionJobId,
        source_slot_lineage_id: slotLineageId,
        status: "edited",
        evidence: { setIds: [setId], sessionIds: [sessionId] },
        reconciled_by_program_version_id: programVersionId,
      }],
      user_decisions: [{
        id: decisionId,
        recommendation_id: recommendationId,
        decision: "edit",
      }],
      adaptation_events: [{
        id: adaptationId,
        user_id: userId,
        recommendation_id: recommendationId,
      }],
      programs: [{ id: programId, user_id: userId }],
      program_versions: [
        {
          id: programVersionId,
          program_id: programId,
          publication_source: "recommendation",
        },
        {
          id: descendantProgramVersionId,
          program_id: programId,
          parent_version_id: programVersionId,
          publication_source: "editor",
        },
      ],
      coaching_insights: [{
        id: insightId,
        user_id: userId,
        session_id: sessionId,
        completed_set_id: setId,
        data_digest: { sessionId, completedSetId: setId },
      }],
      record_versions: [{
        id: versionId,
        user_id: userId,
        entity_type: "completed_set",
        entity_id: setId,
        action: "set.version_restore",
        source_version_id: "00000000-0000-4000-8000-000000000099",
      }],
      export_events: [{
        id: exportId,
        user_id: userId,
        kind: "json",
        filters: {},
      }],
      data_snapshots: [{
        id: snapshotId,
        user_id: userId,
        schema_version: "26",
        record_counts: { completed_sets: 1 },
      }],
      ...overrides,
    },
  };
}

describe("historical performed-semantics consequence gate", () => {
  it("enumerates the complete accepted-and-edited consequence graph without authorizing mutation", () => {
    const source = payload();
    const before = structuredClone(source);
    const report = analyzeHistoricalSemanticsPayload(source, userId);

    expect(report.gateVersion).toBe(HISTORICAL_SEMANTICS_GATE_VERSION);
    expect(report.mutationAuthorized).toBe(false);
    expect(report.programCorrectionPolicy).toBe("new_reviewed_proposal_required");
    expect(report.counts).toMatchObject({
      completedSets: 1,
      workoutSessions: 1,
      progressionJobs: 1,
      recommendations: 1,
      userDecisions: 1,
      acceptedOrEditedDecisions: 1,
      adaptationEvents: 1,
      recommendationProgramVersions: 2,
      coachingInsights: 1,
      recordVersions: 1,
      rollbackVersions: 1,
      exportArtifacts: 1,
      snapshotArtifacts: 1,
    });
    expect(report.nodes.map((node) => `${node.kind}:${node.id}`)).toEqual(
      expect.arrayContaining([
        `completed_set:${setId}`,
        `workout_session:${sessionId}`,
        `progression_job:${progressionJobId}`,
        `recommendation:${recommendationId}`,
        `user_decision:${decisionId}`,
        `adaptation_event:${adaptationId}`,
        `program_version:${programVersionId}`,
        `program_version:${descendantProgramVersionId}`,
        `coaching_insight:${insightId}`,
        `record_version:${versionId}`,
        `export_artifact:${exportId}`,
        `snapshot_artifact:${snapshotId}`,
      ]),
    );
    expect(report.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: `completed_set:${setId}`,
          to: `recommendation:${recommendationId}`,
          relation: "evidence_for",
        }),
        expect.objectContaining({
          from: `workout_session:${sessionId}`,
          to: `progression_job:${progressionJobId}`,
          relation: "consumed_by",
        }),
        expect.objectContaining({
          from: `progression_job:${progressionJobId}`,
          to: `recommendation:${recommendationId}`,
          relation: "produced",
        }),
        expect.objectContaining({
          from: `recommendation:${recommendationId}`,
          to: `program_version:${programVersionId}`,
          relation: "published_as",
        }),
        expect.objectContaining({
          from: `program_version:${programVersionId}`,
          to: `program_version:${descendantProgramVersionId}`,
          relation: "descends_from",
        }),
      ]),
    );
    for (const node of report.nodes.filter(
      (candidate) =>
        candidate.certainty === "direct" &&
        candidate.kind !== "completed_set",
    )) {
      expect(
        report.edges.some(
          (edge) => edge.to === `${node.kind}:${node.id}`,
        ),
        `${node.kind}:${node.id} must have inspectable incoming provenance`,
      ).toBe(true);
    }
    expect(source).toEqual(before);
    expect(() =>
      rejectHistoricalSemanticsMutation("historical_repair"),
    ).toThrow(/blocked.*no historical mutation/i);
  });

  it("closes Coach-insight-only advice through decisions and Program lineage", () => {
    const report = analyzeHistoricalSemanticsPayload(
      payload({
        recommendations: [{
          id: recommendationId,
          user_id: userId,
          insight_id: insightId,
          status: "accepted",
          evidence: {},
          progression_job_id: null,
          source_slot_lineage_id: null,
          reconciled_by_program_version_id: programVersionId,
        }],
      }),
      userId,
    );

    expect(report.counts).toMatchObject({
      coachingInsights: 1,
      recommendations: 1,
      userDecisions: 1,
      adaptationEvents: 1,
      recommendationProgramVersions: 2,
    });
    expect(report.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: `coaching_insight:${insightId}`,
          to: `recommendation:${recommendationId}`,
          relation: "proposed_from",
        }),
        expect.objectContaining({
          from: `recommendation:${recommendationId}`,
          to: `program_version:${programVersionId}`,
          relation: "published_as",
        }),
      ]),
    );
  });

  it("gives a digest-only Coach insight typed incoming provenance", () => {
    const report = analyzeHistoricalSemanticsPayload(
      payload({
        coaching_insights: [{
          id: insightId,
          user_id: userId,
          session_id: null,
          completed_set_id: null,
          data_digest: {
            retainedEvidence: { completedSetId: setId },
          },
        }],
      }),
      userId,
    );

    expect(report.counts.coachingInsights).toBe(1);
    expect(report.edges).toContainEqual(
      expect.objectContaining({
        from: `completed_set:${setId}`,
        to: `coaching_insight:${insightId}`,
        relation: "digest_evidence_for",
      }),
    );
  });

  it.each(["accept", "edit"] as const)(
    "retains an explicitly %s recommendation decision as historical evidence",
    (decision) => {
      const report = analyzeHistoricalSemanticsPayload(
        payload({
          user_decisions: [{
            id: decisionId,
            recommendation_id: recommendationId,
            decision,
          }],
        }),
        userId,
      );
      expect(report.counts.acceptedOrEditedDecisions).toBe(1);
      expect(
        report.nodes.find(
          (node) => node.kind === "user_decision" && node.id === decisionId,
        ),
      ).toMatchObject({ certainty: "direct" });
      expect(report.programCorrectionPolicy).toBe(
        "new_reviewed_proposal_required",
      );
    },
  );

  it("does not expose another owner's historical graph", () => {
    const source = payload();
    source.tables.workout_sessions.push({
      id: "00000000-0000-4000-8000-000000000201",
      user_id: otherUserId,
      status: "completed",
    });
    source.tables.session_exercises.push({
      id: "00000000-0000-4000-8000-000000000202",
      session_id: "00000000-0000-4000-8000-000000000201",
    });
    source.tables.completed_sets.push({
      id: "00000000-0000-4000-8000-000000000203",
      session_exercise_id: "00000000-0000-4000-8000-000000000202",
      performed_semantics_version: null,
      performed_load_type: null,
      performed_load_semantics: null,
    });
    source.tables.recommendations.push({
      id: "00000000-0000-4000-8000-000000000204",
      user_id: otherUserId,
      evidence: {
        setIds: ["00000000-0000-4000-8000-000000000203"],
      },
    });

    const report = analyzeHistoricalSemanticsPayload(source, userId);
    expect(report.counts.completedSets).toBe(1);
    expect(
      report.nodes.some((node) =>
        new Set([
          "00000000-0000-4000-8000-000000000201",
          "00000000-0000-4000-8000-000000000202",
          "00000000-0000-4000-8000-000000000203",
          "00000000-0000-4000-8000-000000000204",
        ]).has(node.id),
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "supported performed semantics",
      tuple: {
        metric_type: "weight_reps",
        performed_semantics_version: 1,
        performed_load_type: "barbell",
        performed_load_semantics: "total",
      },
      affected: 0,
    },
    {
      name: "legacy performed semantics",
      tuple: {
        metric_type: "weight_reps",
        performed_semantics_version: null,
        performed_load_type: null,
        performed_load_semantics: null,
      },
      affected: 1,
    },
    {
      name: "unsupported performed semantics version",
      tuple: {
        metric_type: "weight_reps",
        performed_semantics_version: 2,
        performed_load_type: "barbell",
        performed_load_semantics: "total",
      },
      affected: 1,
    },
    {
      name: "incomplete performed semantics",
      tuple: {
        metric_type: "weight_reps",
        performed_semantics_version: 1,
        performed_load_type: "barbell",
        performed_load_semantics: null,
      },
      affected: 1,
    },
  ])("classifies $name without inventing provenance", ({ tuple, affected }) => {
    const report = analyzeHistoricalSemanticsPayload(
      payload({
        completed_sets: [{
          id: setId,
          session_exercise_id: sessionExerciseId,
          target_met: true,
          ...tuple,
        }],
        recommendations: [],
        user_decisions: [],
        adaptation_events: [],
        coaching_insights: [],
        record_versions: [],
        export_events: [],
        data_snapshots: [],
      }),
      userId,
    );
    expect(report.counts.completedSets).toBe(affected);
  });
});
