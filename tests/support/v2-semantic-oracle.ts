export const V2_CONTRACT_VERSION = "repbook-semantic-contract/2.0.0";

export type SemanticOutcome = {
  durableFacts: string[];
  derivedStates: string[];
  prohibitedMutations: string[];
  lifecycleOutcomes: string[];
};

export type SemanticFixture = {
  fixtureId: string;
  title: string;
  contractVersion: string;
  concerns: string[];
  input: {
    syntheticOwnerIds: string[];
    events: Array<Record<string, unknown> & { type: string }>;
  };
  expected: SemanticOutcome;
};

type Event = SemanticFixture["input"]["events"][number];

function text(event: Event, key: string): string {
  const value = event[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${event.type}.${key} must be a non-empty string`);
  }
  return value;
}

function texts(event: Event, key: string): string[] {
  const value = event[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${event.type}.${key} must be a string array`);
  }
  return value;
}

function numberValue(event: Event, key: string): number {
  const value = event[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${event.type}.${key} must be a finite number`);
  }
  return value;
}

function sorted(values: Set<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function normalizeSemanticOutcome(value: SemanticOutcome): SemanticOutcome {
  return {
    durableFacts: [...new Set(value.durableFacts)].sort(),
    derivedStates: [...new Set(value.derivedStates)].sort(),
    prohibitedMutations: [...new Set(value.prohibitedMutations)].sort(),
    lifecycleOutcomes: [...new Set(value.lifecycleOutcomes)].sort(),
  };
}

export function evaluateSemanticFixture(fixture: SemanticFixture): SemanticOutcome {
  if (fixture.contractVersion !== V2_CONTRACT_VERSION) {
    throw new Error(`${fixture.fixtureId} has an unratified contract version`);
  }

  const durableFacts = new Set<string>();
  const derivedStates = new Set<string>();
  const prohibitedMutations = new Set<string>();
  const lifecycleOutcomes = new Set<string>();

  for (const event of fixture.input.events) {
    const id = text(event, "id");
    switch (event.type) {
      case "ordinary_workout":
        durableFacts.add(`${id}:prescription_and_acknowledged_result_distinct`);
        durableFacts.add(`${id}:performed_measure:${text(event, "measurement")}`);
        durableFacts.add(`${id}:rest_seconds:${numberValue(event, "restSeconds")}`);
        derivedStates.add(`${id}:completed_evidence_eligible`);
        derivedStates.add(`${id}:exception_context:unknown`);
        prohibitedMutations.add(`${id}:prescription_as_performance`);
        prohibitedMutations.add(`${id}:omitted_context_as_none`);
        lifecycleOutcomes.add(`${id}:preview_read_only_start_snapshot_finish`);
        break;
      case "bodyweight_substitution":
        durableFacts.add(`${id}:prescribed:${text(event, "prescribedExercise")}`);
        durableFacts.add(`${id}:performed:${text(event, "performedExercise")}:repetitions_only`);
        durableFacts.add(`${id}:repetitions:${numberValue(event, "repetitions")}`);
        derivedStates.add(`${id}:supported_without_load`);
        prohibitedMutations.add(`${id}:invent_zero_load`);
        prohibitedMutations.add(`${id}:collapse_exercise_identities`);
        lifecycleOutcomes.add(`${id}:substitution_retains_both_identities`);
        break;
      case "grouped_extra_retry":
        durableFacts.add(`${id}:group_order:${texts(event, "orderedOccurrences").join(",")}`);
        durableFacts.add(`${id}:rounds:${numberValue(event, "rounds")}:rest_seconds:${numberValue(event, "restSeconds")}`);
        durableFacts.add(`${id}:extra:${text(event, "extraOccurrence")}:ad_hoc`);
        derivedStates.add(`${id}:next_after_acknowledgement:${text(event, "nextOccurrence")}`);
        prohibitedMutations.add(`${id}:skip_as_zero`);
        prohibitedMutations.add(`${id}:retry_duplicate_fact`);
        prohibitedMutations.add(`${id}:extra_as_planned_ordinal`);
        lifecycleOutcomes.add(`${id}:retry_idempotent_skip_and_extra_preserved`);
        break;
      case "warmup_lifecycle":
        durableFacts.add(`${id}:day_and_exercise_occurrences_distinct`);
        durableFacts.add(`${id}:note:${text(event, "note")}`);
        derivedStates.add(`${id}:restored_occurrence_current_again`);
        prohibitedMutations.add(`${id}:duplicate_actionable_warmup`);
        lifecycleOutcomes.add(`${id}:acknowledge_skip_restore`);
        break;
      case "interrupted_retry":
        durableFacts.add(`${id}:one_acknowledged_result`);
        derivedStates.add(`${id}:same_session_resumed`);
        prohibitedMutations.add(`${id}:advance_while_saving_or_failed`);
        prohibitedMutations.add(`${id}:unknown_commit_duplicate`);
        lifecycleOutcomes.add(`${id}:${texts(event, "states").join("_")}`);
        break;
      case "correction":
        durableFacts.add(`${id}:original_retained`);
        durableFacts.add(`${id}:correction:${text(event, "correctionId")}:effective`);
        durableFacts.add(`${id}:prior_decision_retained`);
        derivedStates.add(`${id}:dependent_conclusions_invalidated`);
        prohibitedMutations.add(`${id}:destructive_overwrite`);
        prohibitedMutations.add(`${id}:rewrite_prior_decision`);
        lifecycleOutcomes.add(`${id}:corrected_with_lineage`);
        break;
      case "supported_import":
        durableFacts.add(`${id}:source:${text(event, "source")}:${text(event, "sourceVersion")}`);
        durableFacts.add(`${id}:exercise:owner:${text(event, "exerciseId")}`);
        durableFacts.add(`${id}:recorded_unit:${text(event, "unit")}`);
        if (event.mappingReviewed !== true) {
          throw new Error(`${event.type}.mappingReviewed must be true`);
        }
        derivedStates.add(`${id}:reviewed_mapping_supported`);
        prohibitedMutations.add(`${id}:erase_import_provenance`);
        prohibitedMutations.add(`${id}:assume_shared_exercise`);
        lifecycleOutcomes.add(`${id}:import_export_restore_round_trip`);
        break;
      case "legacy_partial":
        durableFacts.add(`${id}:raw_evidence_retained`);
        durableFacts.add(`${id}:raw_fields:${texts(event, "rawFields").join(",")}`);
        derivedStates.add(`${id}:dependent_conclusion:unknown`);
        prohibitedMutations.add(`${id}:infer_current_semantics`);
        prohibitedMutations.add(`${id}:invent_zero`);
        lifecycleOutcomes.add(`${id}:unsupported_export_restore_preserved`);
        break;
      case "measurement_boundary": {
        const kg = numberValue(event, "kg");
        durableFacts.add(`${id}:recorded:${kg}:kg:total_bar_load`);
        durableFacts.add(`${id}:assistance_direction:decreases_resistance`);
        derivedStates.add(`${id}:display_lb:${(kg * 2.2046226218).toFixed(3)}`);
        derivedStates.add(`${id}:incompatible_conversion_refused`);
        prohibitedMutations.add(`${id}:rewrite_recorded_unit`);
        prohibitedMutations.add(`${id}:coerce_assistance_to_external_load`);
        lifecycleOutcomes.add(`${id}:declared_meaning_controls_comparison`);
        break;
      }
      case "timezone_boundary":
        durableFacts.add(`${id}:zone:${text(event, "zone")}`);
        durableFacts.add(`${id}:local_date:${text(event, "localDate")}`);
        durableFacts.add(`${id}:instant:${text(event, "instant")}`);
        durableFacts.add(`${id}:boundary:${text(event, "boundary")}`);
        derivedStates.add(`${id}:calendar_group:${text(event, "localDate")}`);
        prohibitedMutations.add(`${id}:regroup_by_viewer_zone`);
        lifecycleOutcomes.add(`${id}:viewer:${text(event, "viewerZone")}:invariant`);
        break;
      case "program_snapshot":
        durableFacts.add(`${id}:active_snapshot:${text(event, "startedRevision")}`);
        durableFacts.add(`${id}:later_program:${text(event, "publishedRevision")}`);
        derivedStates.add(`${id}:completion_uses_started_revision`);
        prohibitedMutations.add(`${id}:preview_create_session`);
        prohibitedMutations.add(`${id}:later_program_rewrite_active_session`);
        lifecycleOutcomes.add(`${id}:preview_start_publish_finish`);
        break;
      case "recommendation_decision":
        durableFacts.add(`${id}:decisions:${texts(event, "decisions").join(",")}`);
        durableFacts.add(`${id}:accepted_effect_future_only`);
        derivedStates.add(`${id}:defer_pending_no_adaptation`);
        derivedStates.add(`${id}:stale_prohibited_unknown_non_actionable`);
        prohibitedMutations.add(`${id}:silent_apply`);
        prohibitedMutations.add(`${id}:history_or_active_snapshot_effect`);
        lifecycleOutcomes.add(`${id}:preview_freshness_explicit_decision`);
        break;
      case "ai_exchange":
        durableFacts.add(`${id}:manifest_owner:${text(event, "ownerId")}`);
        durableFacts.add(`${id}:digest:${text(event, "digest")}:retention_days:30`);
        durableFacts.add(`${id}:schema:${text(event, "schemaVersion")}:cutoff:${text(event, "evidenceCutoff")}`);
        durableFacts.add(`${id}:included:${texts(event, "includedDomains").join(",")}`);
        durableFacts.add(`${id}:omitted:${texts(event, "omittedDomains").join(",")}`);
        durableFacts.add(`${id}:exercise_identities:${texts(event, "exerciseIdentities").join(",")}`);
        durableFacts.add(`${id}:validated_allowlisted_proposal`);
        derivedStates.add(`${id}:duplicate_idempotent`);
        derivedStates.add(`${id}:responses:${texts(event, "responseStates").join(",")}`);
        prohibitedMutations.add(`${id}:retain_raw_training_copy`);
        prohibitedMutations.add(`${id}:automatic_fact_or_plan_change`);
        lifecycleOutcomes.add(`${id}:export_validate_preview_explicit_accept`);
        break;
      case "snapshot_restore":
        durableFacts.add(`${id}:facts_restored_once:${texts(event, "factIds").join(",")}`);
        durableFacts.add(`${id}:correction_lineage_restored`);
        derivedStates.add(`${id}:derived_recomputed_or_unknown`);
        derivedStates.add(`${id}:recommendations_expired`);
        prohibitedMutations.add(`${id}:resurrect_stale_conclusions`);
        lifecycleOutcomes.add(`${id}:snapshot_restore_record_version_round_trip`);
        break;
      case "owner_boundary":
        durableFacts.add(`${id}:owners:${texts(event, "owners").join(",")}`);
        durableFacts.add(`${id}:shared:${text(event, "sharedExercise")}`);
        durableFacts.add(`${id}:owner_created:${text(event, "ownerCreatedExercise")}`);
        durableFacts.add(`${id}:import_created:${text(event, "importCreatedExercise")}`);
        derivedStates.add(`${id}:same_owner_allowed`);
        derivedStates.add(`${id}:cross_owner_rejected`);
        prohibitedMutations.add(`${id}:read_or_bind_cross_owner_record`);
        prohibitedMutations.add(`${id}:cross_owner_ai_package`);
        lifecycleOutcomes.add(`${id}:two_owner_fail_closed`);
        break;
      case "diagnostic_bundle": {
        const fields = texts(event, "fields");
        const optIn = new Set(texts(event, "optInFields"));
        const allowed = new Set(["appVersion", "correlationId", "errorCode", "routeTemplate"]);
        const included = fields.filter((field) => allowed.has(field) || optIn.has(field)).sort();
        const omitted = fields.filter((field) => !allowed.has(field) && !optIn.has(field)).sort();
        durableFacts.add(`${id}:preview_included:${included.join(",")}`);
        durableFacts.add(`${id}:preview_omitted:${omitted.join(",")}`);
        derivedStates.add(`${id}:minimum_necessary`);
        prohibitedMutations.add(`${id}:automatic_upload`);
        prohibitedMutations.add(`${id}:unknown_field_passthrough`);
        lifecycleOutcomes.add(`${id}:preview_then_explicit_send`);
        break;
      }
      case "abandoned_session":
        durableFacts.add(`${id}:acknowledged:${text(event, "acknowledgedResult")}:retained_correctable`);
        durableFacts.add(`${id}:unresolved:${texts(event, "unresolvedOccurrences").join(",")}:abandoned`);
        derivedStates.add(`${id}:excluded_from_completed_progression_review_adaptation`);
        prohibitedMutations.add(`${id}:delete_acknowledged_work`);
        prohibitedMutations.add(`${id}:unknown_commit:${text(event, "unknownMutation")}:as_zero`);
        lifecycleOutcomes.add(`${id}:abandon_preview_export_archive_restore`);
        break;
      default:
        throw new Error(`${fixture.fixtureId} has unsupported event ${event.type}`);
    }
  }

  return {
    durableFacts: sorted(durableFacts),
    derivedStates: sorted(derivedStates),
    prohibitedMutations: sorted(prohibitedMutations),
    lifecycleOutcomes: sorted(lifecycleOutcomes),
  };
}
