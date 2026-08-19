import { describe, expect, it } from "vitest";
import {
  buildHistoryCorrectionEvidenceRows,
  classifyCalculationEligibility,
  classifyHistoryCorrectionFacet,
  classifyHistoryProvenance,
  classifyHistoryTerminalState,
  classifyPerformedSemanticFacet,
  completedWarmupOccurrences,
  performedWorkingSetIds,
} from "@/lib/history-workout-evidence";
import type { SetMetricContainment } from "@/lib/set-metric-semantics";

const supportedLoaded: SetMetricContainment = {
  measurementMeaning: "weight_reps",
  difficultyDirection: "higher_load_is_harder",
  prescriptionOutcomeEligible: true,
  longitudinalComparable: true,
  loadedWorkEligible: true,
  estimatedStrengthEligible: true,
  personalRecordEligible: true,
  automaticProgressionEligible: true,
  evidenceProvenance: "performed_semantics_snapshot",
  exclusionReason: null,
};

describe("H01 performed-first History evidence", () => {
  it("keeps structured completion separate from unsupported legacy terminal text", () => {
    const skipped = {
      id: "skip",
      kind: "working_set",
      outcome: "skipped",
      outcomeReason: "pain",
      completedSetId: null,
    };
    const finishedEarly = {
      ...skipped,
      id: "early",
      outcome: "abandoned",
      outcomeReason: "finished_early",
    };

    expect(classifyHistoryTerminalState("completed", [skipped])).toBe(
      "completed",
    );
    expect(classifyHistoryTerminalState("completed", [finishedEarly])).toBe(
      "legacy_incomplete_outcome_unknown",
    );
    expect(classifyHistoryTerminalState("completed", [skipped], {
      semanticsVersion: 1,
      state: "completed_with_remaining_work",
      reason: "time_limit_reached",
    })).toBe("completed_with_remaining_work");
    expect(classifyHistoryTerminalState("completed", [], {
      semanticsVersion: 1,
      state: "completed_without_prescription",
      reason: null,
    })).toBe("completed_without_prescription");
    expect(classifyHistoryTerminalState("abandoned", [finishedEarly])).toBe(
      "abandoned",
    );
    expect(classifyHistoryTerminalState("in_progress", [])).toBe(
      "in_progress",
    );
  });

  it("counts only linked completed working sets and keeps warm-ups distinct", () => {
    const occurrences = [
      {
        id: "warmup",
        kind: "exercise_warmup",
        outcome: "completed",
        outcomeReason: null,
        completedSetId: null,
      },
      {
        id: "working",
        kind: "working_set",
        outcome: "completed",
        outcomeReason: null,
        completedSetId: "set-linked",
      },
      {
        id: "skipped",
        kind: "working_set",
        outcome: "skipped",
        outcomeReason: "time",
        completedSetId: null,
      },
    ];

    expect(
      [...performedWorkingSetIds(occurrences, new Set(["set-linked", "set-unlinked"]))],
    ).toEqual(["set-linked"]);
    expect(completedWarmupOccurrences(occurrences).map(({ id }) => id)).toEqual([
      "warmup",
    ]);
  });

  it("keeps supported repetitions distinct from legacy partial and unsupported tuples", () => {
    expect(
      classifyPerformedSemanticFacet({
        performedSemanticsVersion: 1,
        performedLoadType: "bodyweight",
        performedLoadSemantics: "bodyweight",
      }),
    ).toBe("supported");
    expect(
      classifyPerformedSemanticFacet({
        performedSemanticsVersion: null,
        performedLoadType: null,
        performedLoadSemantics: null,
      }),
    ).toBe("legacy_partial");
    expect(
      classifyPerformedSemanticFacet({
        performedSemanticsVersion: 2,
        performedLoadType: "bodyweight",
        performedLoadSemantics: "bodyweight",
      }),
    ).toBe("unsupported");
    expect(
      classifyPerformedSemanticFacet({
        performedSemanticsVersion: 1,
        performedLoadType: null,
        performedLoadSemantics: "bodyweight",
      }),
    ).toBe("unsupported");
  });

  it("keeps provenance and correction facets orthogonal", () => {
    expect(
      classifyHistoryProvenance({ source: "tracker", importBatchId: null }),
    ).toBe("native");
    expect(
      classifyHistoryProvenance({ source: "compiler", importBatchId: null }),
    ).toBe("native");
    expect(
      classifyHistoryProvenance({
        source: "history_manual",
        importBatchId: null,
      }),
    ).toBe("manual");
    expect(
      classifyHistoryProvenance({ source: "hevy", importBatchId: "batch" }),
    ).toBe("imported");
    expect(
      classifyHistoryProvenance({ source: "older_source", importBatchId: null }),
    ).toBe("legacy");

    expect(classifyHistoryCorrectionFacet([])).toBe("original");
    expect(
      classifyHistoryCorrectionFacet(["set.completed_correction"]),
    ).toBe("corrected");
    expect(
      classifyHistoryCorrectionFacet([
        "set.version_restore",
        "set.completed_correction",
      ]),
    ).toBe("version_restored");
    expect(
      classifyHistoryCorrectionFacet([
        "set.snapshot_restore",
        "set.completed_correction",
      ]),
    ).toBe("snapshot_restored");
    expect(
      classifyHistoryCorrectionFacet([
        "set.completed_correction",
        "set.snapshot_restore",
      ]),
    ).toBe("corrected");
    expect(
      classifyHistoryCorrectionFacet([
        "workout_session.timing_correction",
      ]),
    ).toBe("corrected");
    expect(
      classifyHistoryCorrectionFacet([
        "workout_session.duration_correction",
      ]),
    ).toBe("corrected");
    expect(
      classifyHistoryCorrectionFacet([
        "workout_session.snapshot_restore",
        "workout_session.duration_correction",
      ]),
    ).toBe("snapshot_restored");
    expect(
      classifyHistoryCorrectionFacet([
        "workout_session.version_restore",
        "workout_session.timing_correction",
      ]),
    ).toBe("version_restored");
  });

  it("preserves exact calculation eligibility and lets abandonment override it", () => {
    expect(
      classifyCalculationEligibility("completed", supportedLoaded, "supported"),
    ).toEqual({
      kind: "included",
      label:
        "Eligible for target comparison, exercise progression, loaded workload, estimated strength, selected-period records, automatic progression.",
      claims: [
        "target comparison",
        "exercise progression",
        "loaded workload",
        "estimated strength",
        "selected-period records",
        "automatic progression",
      ],
    });
    expect(
      classifyCalculationEligibility(
        "completed",
        {
          ...supportedLoaded,
          measurementMeaning: "reps",
          difficultyDirection: "higher_repetitions_may_be_harder",
          loadedWorkEligible: false,
          estimatedStrengthEligible: false,
          automaticProgressionEligible: false,
          exclusionReason: "repetitions_only",
        },
        "supported",
      ),
    ).toMatchObject({
      kind: "limited",
      claims: ["target comparison", "exercise progression", "selected-period records"],
    });
    expect(
      classifyCalculationEligibility("abandoned", supportedLoaded, "supported"),
    ).toEqual({
      kind: "excluded",
      label:
        "Excluded from completed metrics, progression, and Review because the workout was abandoned.",
      claims: [],
    });
    expect(
      classifyCalculationEligibility(
        "completed",
        supportedLoaded,
        "legacy_partial",
      ),
    ).toEqual({
      kind: "excluded",
      label:
        "Not used in completed calculations because this legacy set's performed meaning is incomplete.",
      claims: [],
    });
    expect(
      classifyCalculationEligibility(
        "completed",
        supportedLoaded,
        "unsupported",
      ),
    ).toEqual({
      kind: "excluded",
      label:
        "Not used in completed calculations because this set's performed meaning is unsupported.",
      claims: [],
    });
  });

  it("renders reviewed correction and restore deltas without exposing raw envelopes", () => {
    const versionId = "00000000-0000-4000-8000-000000000201";
    const snapshotId = "00000000-0000-4000-8000-000000000202";
    const envelope = {
      schemaVersion: 1,
      writerVersion: "repbook-v2-t02/1",
      category: "restore_snapshot",
      reasonNote: null,
      actorType: "owner",
      source: "snapshot_restore",
      decidedAt: "2026-08-04T14:00:00.000Z",
      decisionTimezone: "America/Toronto",
      decisionLocalDate: "2026-08-04",
      sourceHistoryRevision: 3,
      resultHistoryRevision: 4,
      sourceLedgerRevision: 1,
      resultLedgerRevision: 2,
      dependentConclusions: "snapshot_state_reconciled",
      expiredRecommendationCount: 1,
      progressionJobId: null,
      restoredFromVersionId: null,
      restoredFromSnapshotId: snapshotId,
    };
    const [row] = buildHistoryCorrectionEvidenceRows([
      {
        id: versionId,
        action: "set.snapshot_restore",
        beforeData: { weight: 100, weight_unit: "lb" },
        afterData: {
          weight: 105,
          weight_unit: "lb",
          repbook_correction: envelope,
        },
        changedFields: ["weight", "repbook_correction"],
        sourceVersionId: null,
        createdAt: new Date("2026-08-04T14:00:00.000Z"),
      },
    ]);

    expect(row).toMatchObject({
      actionLabel: "Recovery snapshot restored",
      categoryLabel: "Restored recovery snapshot evidence",
      restoreReference: snapshotId,
      readableEnvelope: true,
      deltas: [{ label: "Load", before: "100", after: "105" }],
    });
    expect(JSON.stringify(row)).not.toContain("repbook_correction");
  });

  it("keeps unreadable legacy correction evidence inspectable by field name only", () => {
    const [row] = buildHistoryCorrectionEvidenceRows([
      {
        id: "legacy",
        action: "set.completed_correction",
        beforeData: { note: "before", private_blob: { secret: true } },
        afterData: { note: "after", private_blob: { secret: false } },
        changedFields: ["note", "private_blob"],
        sourceVersionId: null,
        createdAt: new Date("2026-08-04T14:00:00.000Z"),
      },
    ]);

    expect(row.readableEnvelope).toBe(false);
    expect(row.changedFieldLabels).toEqual(["Set note"]);
    expect(row.deltas).toEqual([
      { field: "note", label: "Set note", before: "before", after: "after" },
    ]);
    expect(JSON.stringify(row)).not.toContain("private_blob");
  });
});
