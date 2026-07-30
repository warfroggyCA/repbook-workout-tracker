import type { Db } from "@/db";
import {
  captureUserSnapshot,
  type CanonicalSnapshotPayload,
} from "@/services/snapshot-capture";

export const HISTORICAL_SEMANTICS_GATE_VERSION =
  "historical-semantics-gate-v1";

export type HistoricalSemanticsNodeKind =
  | "completed_set"
  | "workout_session"
  | "calculated_output"
  | "progression_job"
  | "recommendation"
  | "user_decision"
  | "adaptation_event"
  | "program_version"
  | "coaching_insight"
  | "record_version"
  | "export_artifact"
  | "snapshot_artifact";

export type HistoricalSemanticsNode = {
  kind: HistoricalSemanticsNodeKind;
  id: string;
  certainty: "direct" | "declared_consumer" | "potential_artifact";
  provenance: string[];
};

export type HistoricalSemanticsEdge = {
  from: string;
  to: string;
  relation: string;
  provenance: string;
};

export type HistoricalSemanticsConsequenceReport = {
  gateVersion: typeof HISTORICAL_SEMANTICS_GATE_VERSION;
  mutationAuthorized: false;
  programCorrectionPolicy: "new_reviewed_proposal_required";
  generatedFrom: {
    snapshotSchemaVersion: string;
    snapshotCapturedAt: string;
  };
  counts: {
    completedSets: number;
    workoutSessions: number;
    calculatedOutputs: number;
    progressionJobs: number;
    recommendations: number;
    userDecisions: number;
    acceptedOrEditedDecisions: number;
    adaptationEvents: number;
    recommendationProgramVersions: number;
    coachingInsights: number;
    recordVersions: number;
    rollbackVersions: number;
    exportArtifacts: number;
    snapshotArtifacts: number;
  };
  nodes: HistoricalSemanticsNode[];
  edges: HistoricalSemanticsEdge[];
};

export type HistoricalSemanticsMutationOperation =
  | "historical_repair"
  | "historical_backfill"
  | "existing_row_rewrite"
  | "automatic_program_reversal";

type Row = Record<string, unknown>;

function rows(payload: CanonicalSnapshotPayload, table: string): Row[] {
  return (payload.tables[table] ?? []).filter(
    (value): value is Row =>
      value != null && typeof value === "object" && !Array.isArray(value),
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nodeKey(kind: HistoricalSemanticsNodeKind, id: string) {
  return `${kind}:${id}`;
}

function evidenceIds(value: unknown, key: "setIds" | "sessionIds"): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const candidate = (value as Row)[key];
  return Array.isArray(candidate)
    ? candidate.filter((id): id is string => typeof id === "string")
    : [];
}

function digestContainsId(value: unknown, ids: Set<string>): boolean {
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) {
    return value.some((item) => digestContainsId(item, ids));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => digestContainsId(item, ids));
  }
  return false;
}

function digestIds(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    result.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) digestIds(item, result);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) digestIds(item, result);
  }
  return result;
}

function performedTupleReason(row: Row): string | null {
  const version = row.performed_semantics_version;
  const loadType = stringValue(row.performed_load_type);
  const loadSemantics = stringValue(row.performed_load_semantics);
  const hasAny = version != null || loadType != null || loadSemantics != null;
  if (!hasAny) return "legacy_performed_semantics_unknown";
  if (version !== 1) return "unsupported_performed_semantics_version";
  if (loadType == null || loadSemantics == null) {
    return "incomplete_performed_semantics";
  }
  return null;
}

/**
 * Produces an inspectable graph from a point-in-time payload. This function is
 * deliberately pure: it cannot repair, backfill, publish, or otherwise write.
 */
export function analyzeHistoricalSemanticsPayload(
  payload: CanonicalSnapshotPayload,
  userId: string,
): HistoricalSemanticsConsequenceReport {
  const allSessions = rows(payload, "workout_sessions").filter(
    (row) => row.user_id === userId,
  );
  const ownedSessionIds = new Set(
    allSessions.map((row) => stringValue(row.id)).filter(Boolean) as string[],
  );
  const sessionExercises = rows(payload, "session_exercises").filter((row) => {
    const sessionId = stringValue(row.session_id);
    return sessionId != null && ownedSessionIds.has(sessionId);
  });
  const sessionExerciseById = new Map(
    sessionExercises
      .map((row) => [stringValue(row.id), row] as const)
      .filter((entry): entry is readonly [string, Row] => entry[0] != null),
  );
  const affectedSets = rows(payload, "completed_sets")
    .map((row) => ({ row, reason: performedTupleReason(row) }))
    .filter(({ row, reason }) => {
      const sessionExerciseId = stringValue(row.session_exercise_id);
      return (
        reason != null &&
        sessionExerciseId != null &&
        sessionExerciseById.has(sessionExerciseId)
      );
    }) as Array<{ row: Row; reason: string }>;
  const affectedSetIds = new Set(
    affectedSets.map(({ row }) => stringValue(row.id)).filter(Boolean) as string[],
  );
  const affectedSessionIds = new Set<string>();
  const setSession = new Map<string, string>();
  const affectedLineageIds = new Set<string>();
  const affectedSetIdsByLineage = new Map<string, Set<string>>();
  for (const { row } of affectedSets) {
    const setId = stringValue(row.id);
    const sessionExercise = sessionExerciseById.get(
      stringValue(row.session_exercise_id) ?? "",
    );
    const sessionId = stringValue(sessionExercise?.session_id);
    if (setId && sessionId) {
      affectedSessionIds.add(sessionId);
      setSession.set(setId, sessionId);
    }
    const lineageId = stringValue(sessionExercise?.source_slot_lineage_id);
    if (lineageId) {
      affectedLineageIds.add(lineageId);
      if (setId) {
        const setIds = affectedSetIdsByLineage.get(lineageId) ?? new Set();
        setIds.add(setId);
        affectedSetIdsByLineage.set(lineageId, setIds);
      }
    }
  }
  const insights = rows(payload, "coaching_insights").filter(
    (row) =>
      row.user_id === userId &&
      (affectedSetIds.has(stringValue(row.completed_set_id) ?? "") ||
        affectedSessionIds.has(stringValue(row.session_id) ?? "") ||
        digestContainsId(row.data_digest, affectedSetIds) ||
        digestContainsId(row.data_digest, affectedSessionIds)),
  );
  const affectedInsightIds = new Set(
    insights.map((row) => stringValue(row.id)).filter(Boolean) as string[],
  );

  const nodes = new Map<string, HistoricalSemanticsNode>();
  const edges = new Map<string, HistoricalSemanticsEdge>();
  const addNode = (
    kind: HistoricalSemanticsNodeKind,
    id: string | null,
    provenance: string,
    certainty: HistoricalSemanticsNode["certainty"] = "direct",
  ) => {
    if (!id) return;
    const key = nodeKey(kind, id);
    const existing = nodes.get(key);
    if (existing) {
      if (!existing.provenance.includes(provenance)) {
        existing.provenance.push(provenance);
      }
    } else {
      nodes.set(key, { kind, id, certainty, provenance: [provenance] });
    }
  };
  const addEdge = (
    from: string,
    to: string,
    relation: string,
    provenance: string,
  ) => {
    edges.set(`${from}|${to}|${relation}`, { from, to, relation, provenance });
  };

  for (const { row, reason } of affectedSets) {
    const setId = stringValue(row.id);
    if (!setId) continue;
    addNode("completed_set", setId, reason);
    const sessionId = setSession.get(setId);
    addNode("workout_session", sessionId ?? null, "contains_affected_set");
    if (sessionId) {
      addEdge(
        nodeKey("completed_set", setId),
        nodeKey("workout_session", sessionId),
        "belongs_to",
        "session_exercises.session_id",
      );
    }
  }

  const outputSurfaces = [
    "dashboard",
    "history",
    "coach",
    "review",
    "records_prs_progression",
  ];
  for (const surface of affectedSets.length > 0 ? outputSurfaces : []) {
    addNode(
      "calculated_output",
      surface,
      "reads_affected_historical_evidence",
      "declared_consumer",
    );
    for (const setId of affectedSetIds) {
      addEdge(
        nodeKey("completed_set", setId),
        nodeKey("calculated_output", surface),
        "may_change_output",
        "performed-semantics consumer inventory",
      );
    }
  }

  const progressionJobSessions = new Map<string, Set<string>>();
  const progressionJobs = rows(payload, "progression_jobs").filter((row) => {
    if (row.user_id !== userId) return false;
    const sessionId = stringValue(row.session_id);
    const affected = sessionId != null && affectedSessionIds.has(sessionId);
    if (affected) {
      const jobId = stringValue(row.id);
      if (jobId && sessionId) {
        progressionJobSessions.set(jobId, new Set([sessionId]));
      }
    }
    return affected;
  });
  const affectedProgressionJobIds = new Set(
    progressionJobs.map((row) => stringValue(row.id)).filter(Boolean) as string[],
  );
  for (const input of rows(payload, "progression_job_input_sessions")) {
    if (input.user_id !== userId) continue;
    const sessionId = stringValue(input.session_id);
    const jobId = stringValue(input.job_id);
    if (sessionId && jobId && affectedSessionIds.has(sessionId)) {
      affectedProgressionJobIds.add(jobId);
      const sessions = progressionJobSessions.get(jobId) ?? new Set();
      sessions.add(sessionId);
      progressionJobSessions.set(jobId, sessions);
    }
  }
  for (const jobId of affectedProgressionJobIds) {
    addNode("progression_job", jobId, "consumed_affected_session");
    for (const sessionId of progressionJobSessions.get(jobId) ?? []) {
      addEdge(
        nodeKey("workout_session", sessionId),
        nodeKey("progression_job", jobId),
        "consumed_by",
        "progression_jobs.session_id or progression_job_input_sessions.session_id",
      );
    }
  }

  const recommendations = rows(payload, "recommendations").filter((row) => {
    if (row.user_id !== userId) return false;
    const setEvidence = evidenceIds(row.evidence, "setIds");
    const sessionEvidence = evidenceIds(row.evidence, "sessionIds");
    return (
      setEvidence.some((id) => affectedSetIds.has(id)) ||
      sessionEvidence.some((id) => affectedSessionIds.has(id)) ||
      affectedProgressionJobIds.has(stringValue(row.progression_job_id) ?? "") ||
      affectedLineageIds.has(stringValue(row.source_slot_lineage_id) ?? "") ||
      affectedInsightIds.has(stringValue(row.insight_id) ?? "")
    );
  });
  const recommendationIds = new Set(
    recommendations.map((row) => stringValue(row.id)).filter(Boolean) as string[],
  );
  for (const recommendation of recommendations) {
    const id = stringValue(recommendation.id);
    if (!id) continue;
    addNode("recommendation", id, "evidence_or_lineage_intersects");
    for (const setId of evidenceIds(recommendation.evidence, "setIds")) {
      if (affectedSetIds.has(setId)) {
        addEdge(
          nodeKey("completed_set", setId),
          nodeKey("recommendation", id),
          "evidence_for",
          "recommendations.evidence.setIds",
        );
      }
    }
    for (const sessionId of evidenceIds(
      recommendation.evidence,
      "sessionIds",
    )) {
      if (affectedSessionIds.has(sessionId)) {
        addEdge(
          nodeKey("workout_session", sessionId),
          nodeKey("recommendation", id),
          "evidence_for",
          "recommendations.evidence.sessionIds",
        );
      }
    }
    const progressionJobId = stringValue(recommendation.progression_job_id);
    if (
      progressionJobId &&
      affectedProgressionJobIds.has(progressionJobId)
    ) {
      addEdge(
        nodeKey("progression_job", progressionJobId),
        nodeKey("recommendation", id),
        "produced",
        "recommendations.progression_job_id",
      );
    }
    const lineageId = stringValue(recommendation.source_slot_lineage_id);
    if (lineageId && affectedLineageIds.has(lineageId)) {
      for (const setId of affectedSetIdsByLineage.get(lineageId) ?? []) {
        addEdge(
          nodeKey("completed_set", setId),
          nodeKey("recommendation", id),
          "shares_slot_lineage",
          "session_exercises.source_slot_lineage_id and recommendations.source_slot_lineage_id",
        );
      }
    }
    const insightId = stringValue(recommendation.insight_id);
    if (insightId && affectedInsightIds.has(insightId)) {
      addEdge(
        nodeKey("coaching_insight", insightId),
        nodeKey("recommendation", id),
        "proposed_from",
        "recommendations.insight_id",
      );
    }
  }

  const decisions = rows(payload, "user_decisions").filter((row) =>
    recommendationIds.has(stringValue(row.recommendation_id) ?? ""),
  );
  for (const decision of decisions) {
    const id = stringValue(decision.id);
    const recommendationId = stringValue(decision.recommendation_id);
    addNode("user_decision", id, "decision_on_affected_recommendation");
    if (id && recommendationId) {
      addEdge(
        nodeKey("recommendation", recommendationId),
        nodeKey("user_decision", id),
        "decided_as",
        "user_decisions.recommendation_id",
      );
    }
  }

  const adaptations = rows(payload, "adaptation_events").filter(
    (row) =>
      row.user_id === userId &&
      recommendationIds.has(stringValue(row.recommendation_id) ?? ""),
  );
  for (const event of adaptations) {
    const id = stringValue(event.id);
    const recommendationId = stringValue(event.recommendation_id);
    addNode("adaptation_event", id, "event_from_affected_recommendation");
    if (id && recommendationId) {
      addEdge(
        nodeKey("recommendation", recommendationId),
        nodeKey("adaptation_event", id),
        "produced",
        "adaptation_events.recommendation_id",
      );
    }
  }

  const programIds = new Set(
    rows(payload, "programs")
      .filter((row) => row.user_id === userId)
      .map((row) => stringValue(row.id))
      .filter(Boolean) as string[],
  );
  const allProgramVersions = rows(payload, "program_versions").filter((row) =>
    programIds.has(stringValue(row.program_id) ?? ""),
  );
  const seedProgramVersions = allProgramVersions.filter((row) => {
    if (!programIds.has(stringValue(row.program_id) ?? "")) return false;
    const id = stringValue(row.id);
    return recommendations.some(
      (recommendation) =>
        stringValue(recommendation.reconciled_by_program_version_id) === id,
    );
  });
  const affectedProgramVersionIds = new Set(
    seedProgramVersions
      .map((row) => stringValue(row.id))
      .filter(Boolean) as string[],
  );
  let addedLineage = true;
  while (addedLineage) {
    addedLineage = false;
    for (const version of allProgramVersions) {
      const id = stringValue(version.id);
      const parent = stringValue(version.parent_version_id);
      const restored = stringValue(version.restored_from_version_id);
      if (
        id &&
        !affectedProgramVersionIds.has(id) &&
        ((parent != null && affectedProgramVersionIds.has(parent)) ||
          (restored != null && affectedProgramVersionIds.has(restored)))
      ) {
        affectedProgramVersionIds.add(id);
        addedLineage = true;
      }
    }
  }
  const programVersions = allProgramVersions.filter((row) =>
    affectedProgramVersionIds.has(stringValue(row.id) ?? ""),
  );
  for (const version of programVersions) {
    const id = stringValue(version.id);
    const seeded = seedProgramVersions.includes(version);
    addNode(
      "program_version",
      id,
      seeded
        ? "published_recommendation_consequence"
        : "descends_from_affected_program_version",
    );
    if (!id) continue;
    for (const recommendation of recommendations) {
      if (recommendation.reconciled_by_program_version_id === id) {
        const recommendationId = stringValue(recommendation.id);
        if (recommendationId) {
          addEdge(
            nodeKey("recommendation", recommendationId),
            nodeKey("program_version", id),
            "published_as",
            "recommendations.reconciled_by_program_version_id",
          );
        }
      }
    }
    for (const [column, relation] of [
      ["parent_version_id", "descends_from"],
      ["restored_from_version_id", "restores_from"],
    ] as const) {
      const sourceId = stringValue(version[column]);
      if (sourceId && affectedProgramVersionIds.has(sourceId)) {
        addEdge(
          nodeKey("program_version", sourceId),
          nodeKey("program_version", id),
          relation,
          `program_versions.${column}`,
        );
      }
    }
  }

  for (const insight of insights) {
    const insightId = stringValue(insight.id);
    addNode(
      "coaching_insight",
      insightId,
      "persisted_text_references_affected_evidence",
    );
    if (!insightId) continue;
    const setId = stringValue(insight.completed_set_id);
    if (setId && affectedSetIds.has(setId)) {
      addEdge(
        nodeKey("completed_set", setId),
        nodeKey("coaching_insight", insightId),
        "evidence_for",
        "coaching_insights.completed_set_id",
      );
    }
    const sessionId = stringValue(insight.session_id);
    if (sessionId && affectedSessionIds.has(sessionId)) {
      addEdge(
        nodeKey("workout_session", sessionId),
        nodeKey("coaching_insight", insightId),
        "evidence_for",
        "coaching_insights.session_id",
      );
    }
    const retainedDigestIds = digestIds(insight.data_digest);
    for (const affectedSetId of affectedSetIds) {
      if (retainedDigestIds.has(affectedSetId)) {
        addEdge(
          nodeKey("completed_set", affectedSetId),
          nodeKey("coaching_insight", insightId),
          "digest_evidence_for",
          "coaching_insights.data_digest retained completed-set identity",
        );
      }
    }
    for (const affectedSessionId of affectedSessionIds) {
      if (retainedDigestIds.has(affectedSessionId)) {
        addEdge(
          nodeKey("workout_session", affectedSessionId),
          nodeKey("coaching_insight", insightId),
          "digest_evidence_for",
          "coaching_insights.data_digest retained session identity",
        );
      }
    }
  }

  const versions = rows(payload, "record_versions").filter(
    (row) =>
      row.user_id === userId &&
      row.entity_type === "completed_set" &&
      affectedSetIds.has(stringValue(row.entity_id) ?? ""),
  );
  for (const version of versions) {
    const id = stringValue(version.id);
    addNode(
      "record_version",
      id,
      "version_of_affected_raw_fact",
    );
    const setId = stringValue(version.entity_id);
    if (id && setId) {
      addEdge(
        nodeKey("completed_set", setId),
        nodeKey("record_version", id),
        "versioned_as",
        "record_versions.entity_id",
      );
    }
  }

  const exportArtifacts = rows(payload, "export_events").filter(
    (row) => row.user_id === userId,
  );
  for (const artifact of exportArtifacts) {
    addNode(
      "export_artifact",
      stringValue(artifact.id),
      "artifact_payload_not_retained_for_row_level_proof",
      "potential_artifact",
    );
  }
  const snapshotArtifacts = rows(payload, "data_snapshots").filter(
    (row) => row.user_id === userId,
  );
  for (const artifact of snapshotArtifacts) {
    addNode(
      "snapshot_artifact",
      stringValue(artifact.id),
      "encrypted_artifact_requires_restore_preview_reanalysis",
      "potential_artifact",
    );
  }

  return {
    gateVersion: HISTORICAL_SEMANTICS_GATE_VERSION,
    mutationAuthorized: false,
    programCorrectionPolicy: "new_reviewed_proposal_required",
    generatedFrom: {
      snapshotSchemaVersion: payload.schemaVersion,
      snapshotCapturedAt: payload.capturedAt,
    },
    counts: {
      completedSets: affectedSets.length,
      workoutSessions: affectedSessionIds.size,
      calculatedOutputs: affectedSets.length > 0 ? outputSurfaces.length : 0,
      progressionJobs: affectedProgressionJobIds.size,
      recommendations: recommendations.length,
      userDecisions: decisions.length,
      acceptedOrEditedDecisions: decisions.filter((row) =>
        row.decision === "accept" || row.decision === "edit"
      ).length,
      adaptationEvents: adaptations.length,
      recommendationProgramVersions: programVersions.length,
      coachingInsights: insights.length,
      recordVersions: versions.length,
      rollbackVersions: versions.filter(
        (row) => row.action === "set.version_restore",
      ).length,
      exportArtifacts: exportArtifacts.length,
      snapshotArtifacts: snapshotArtifacts.length,
    },
    nodes: [...nodes.values()].sort((a, b) =>
      nodeKey(a.kind, a.id).localeCompare(nodeKey(b.kind, b.id)),
    ),
    edges: [...edges.values()].sort((a, b) =>
      `${a.from}|${a.to}|${a.relation}`.localeCompare(
        `${b.from}|${b.to}|${b.relation}`,
      ),
    ),
  };
}

export async function analyzeHistoricalSemanticsConsequences(
  db: Db,
  userId: string,
  now = new Date(),
): Promise<HistoricalSemanticsConsequenceReport> {
  const payload = await captureUserSnapshot(
    db,
    userId,
    now,
    HISTORICAL_SEMANTICS_GATE_VERSION,
    {
      normalizeProgramDrafts: false,
      retainCoachEvidenceIds: true,
    },
  );
  return analyzeHistoricalSemanticsPayload(payload, userId);
}

export function rejectHistoricalSemanticsMutation(
  operation: HistoricalSemanticsMutationOperation,
): never {
  throw new Error(
    `Historical performed-semantics operation "${operation}" is blocked. Run the consequence analysis first; this release authorizes no historical mutation.`,
  );
}
