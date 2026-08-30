export type WorkoutSummaryTerminalState =
  | "in_progress"
  | "completed"
  | "completed_without_prescription"
  | "completed_with_remaining_work"
  | "legacy_incomplete_outcome_unknown"
  | "abandoned";

export type WorkoutSummaryTone =
  | "neutral"
  | "positive"
  | "attention";

export type WorkoutSummaryAnswer = {
  value: string;
  detail: string;
  tone: WorkoutSummaryTone;
  href?: string;
  actionLabel?: string;
};

export type WorkoutSummaryViewModel = {
  happened: WorkoutSummaryAnswer;
  changed: WorkoutSummaryAnswer;
  notable: WorkoutSummaryAnswer;
  next: WorkoutSummaryAnswer;
  recordContext: string[];
};

type TargetOutcomes = {
  below: number;
  at: number;
  above: number;
  unknown: number;
  supported: number;
};

export type WorkoutSummaryInput = {
  terminalState: WorkoutSummaryTerminalState;
  terminalLabel: string;
  performedExerciseCount: number;
  workingSetCount: number;
  warmupCount: number;
  durationSummary: string;
  durationExcluded: boolean;
  targetOutcomes: TargetOutcomes;
  targetDenominatorComplete: boolean;
  positivePainEvidenceCount: number;
  setExceptionEvidenceCount: number;
  explicitNoIssueEvidenceCount: number;
  painEvidenceUnknown: boolean;
  correctionLabel: string;
  hasCorrections: boolean;
  provenanceLabel: string;
  showProvenance: boolean;
  programLinkLabel: string | null;
  hasMixedWeightUnits: boolean;
  pendingDecisionCount: number;
  incompleteReasonLabel: string | null;
  timingCanBeReviewed: boolean;
};

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function changedAnswer(input: WorkoutSummaryInput): WorkoutSummaryAnswer {
  if (
    input.terminalState === "abandoned" ||
    input.terminalState === "in_progress"
  ) {
    return {
      value: "No completed comparison",
      detail:
        input.terminalState === "abandoned"
          ? "Abandoned-workout evidence stays visible, but it is excluded from completed metrics and progression."
          : "A comparison is available only after the workout reaches a completed state.",
      tone: "neutral",
    };
  }

  const outcomes = input.targetOutcomes;
  if (outcomes.supported === 0) {
    const limitation = outcomes.unknown > 0
      ? `${countLabel(outcomes.unknown, "planned outcome")} could not be compared safely.`
      : "This workout has no compatible planned target evidence to compare.";
    return {
      value: "No comparable evidence",
      detail: limitation,
      tone: "neutral",
    };
  }

  const parts = [
    outcomes.above > 0 ? `${outcomes.above} above target` : null,
    outcomes.at > 0 ? `${outcomes.at} at target` : null,
    outcomes.below > 0 ? `${outcomes.below} below target` : null,
  ].filter((part): part is string => part != null);
  const limitations = [
    outcomes.unknown > 0
      ? `${countLabel(outcomes.unknown, "outcome")} unknown`
      : null,
    !input.targetDenominatorComplete
      ? "the full planned denominator is unavailable"
      : null,
  ].filter((part): part is string => part != null);

  return {
    value:
      outcomes.below > 0
        ? "Some work finished below target"
        : outcomes.above > 0
          ? "Some work finished above target"
          : "Supported targets were held",
    detail: `${parts.join(" · ")}${
      limitations.length > 0 ? `. Limits: ${limitations.join("; ")}.` : "."
    }`,
    tone: outcomes.below > 0 ? "attention" : "positive",
  };
}

function notableAnswer(input: WorkoutSummaryInput): WorkoutSummaryAnswer {
  if (input.positivePainEvidenceCount > 0) {
    return {
      value: "Pain or limitation was recorded",
      detail: `${countLabel(
        input.positivePainEvidenceCount,
        "pain observation",
      )} remains attached to the performed record.`,
      tone: "attention",
      href: input.pendingDecisionCount > 0 ? "#pain-evidence" : undefined,
      actionLabel:
        input.pendingDecisionCount > 0 ? "Review pain evidence" : undefined,
    };
  }

  if (input.setExceptionEvidenceCount > 0) {
    return {
      value: "Technique or limitation was recorded",
      detail: `Retained technique or limitation context is attached to ${countLabel(
        input.setExceptionEvidenceCount,
        "performed set",
      )}.`,
      tone: "attention",
      href: "#technical-record",
      actionLabel: "Review set context",
    };
  }

  if (input.terminalState === "abandoned") {
    return {
      value: "The workout was abandoned",
      detail:
        "Acknowledged work remains correctable evidence, without becoming a completed workout.",
      tone: "attention",
    };
  }

  if (
    input.terminalState === "completed_with_remaining_work" ||
    input.terminalState === "legacy_incomplete_outcome_unknown"
  ) {
    return {
      value: "Planned work remained",
      detail:
        input.incompleteReasonLabel == null
          ? "The historical cause is unsupported; completed work remains intact."
          : `Recorded finish reason: ${input.incompleteReasonLabel}.`,
      tone: "attention",
    };
  }

  if (input.durationExcluded) {
    return {
      value: "Active time is unavailable",
      detail:
        "Duration insights exclude this workout; source timing evidence remains unchanged.",
      tone: "attention",
      href:
        input.pendingDecisionCount > 0 && input.timingCanBeReviewed
          ? "#technical-record"
          : undefined,
      actionLabel:
        input.pendingDecisionCount > 0 && input.timingCanBeReviewed
          ? "Review timing options"
          : undefined,
    };
  }

  if (input.hasCorrections) {
    return {
      value: "This record has corrections",
      detail: `${input.correctionLabel}. Earlier values remain available in its edit history.`,
      tone: "neutral",
      href: "#technical-record",
      actionLabel: "Open technical record",
    };
  }

  if (input.painEvidenceUnknown) {
    return {
      value: "No notable issue was recorded",
      detail:
        "Pain was not recorded, so this is not evidence that the workout was pain-free.",
      tone: "neutral",
    };
  }

  return {
    value: "No notable issue was recorded",
    detail:
      input.explicitNoIssueEvidenceCount > 0
        ? "The workout contains explicit no-issue evidence."
        : "No interpretation-changing issue is present in the available evidence.",
    tone: "positive",
  };
}

function nextAnswer(input: WorkoutSummaryInput): WorkoutSummaryAnswer {
  if (input.pendingDecisionCount > 0) {
    return {
      value: `${countLabel(input.pendingDecisionCount, "Program decision")} ${
        input.pendingDecisionCount === 1 ? "needs" : "need"
      } review`,
      detail: "Nothing changes unless you approve it.",
      tone: "attention",
      href: "/coach",
      actionLabel: "Review decisions",
    };
  }

  if (input.positivePainEvidenceCount > 0) {
    return {
      value: "Review the recorded issue before next time",
      detail:
        "The evidence is available for your judgment; Repbook has not changed the Program.",
      tone: "attention",
      href: "#pain-evidence",
      actionLabel: "Review pain evidence",
    };
  }

  if (input.durationExcluded && input.timingCanBeReviewed) {
    return {
      value: "Review workout timing when useful",
      detail:
        "This is a record correction option, not a required Program change.",
      tone: "neutral",
      href: "#technical-record",
      actionLabel: "Review timing options",
    };
  }

  return {
    value: "Nothing needs a decision",
    detail: "Repbook has not proposed a Program change from this workout.",
    tone: "positive",
  };
}

export function buildWorkoutSummaryViewModel(
  input: WorkoutSummaryInput,
): WorkoutSummaryViewModel {
  const performedParts = [
    countLabel(input.performedExerciseCount, "exercise"),
    countLabel(input.workingSetCount, "working set"),
    input.warmupCount > 0
      ? countLabel(input.warmupCount, "completed warm-up")
      : null,
    input.durationSummary,
  ].filter((part): part is string => part != null);

  const recordContext = [
    input.showProvenance ? input.provenanceLabel : null,
    input.programLinkLabel,
    input.hasCorrections ? input.correctionLabel : null,
    input.hasMixedWeightUnits
      ? "Mixed recorded load units remain separate"
      : null,
  ].filter((part): part is string => part != null);

  return {
    happened: {
      value: input.terminalLabel,
      detail: performedParts.join(" · "),
      tone:
        input.terminalState === "completed" ||
        input.terminalState === "completed_without_prescription"
          ? "positive"
          : input.terminalState === "abandoned"
            ? "attention"
            : "neutral",
    },
    changed: changedAnswer(input),
    notable: notableAnswer(input),
    next: nextAnswer(input),
    recordContext,
  };
}
