import type { LoadUnit } from "@/lib/units";

export type HistoryLensKey =
  | "progress"
  | "program-fit"
  | "pain-constraints"
  | "work-capacity"
  | "records";

export type HistoryLensEvidenceItem = {
  label: string;
  value: string;
  detail?: string;
};

export type HistoryLens = {
  key: HistoryLensKey;
  title: string;
  question: string;
  answer: string;
  tone: "positive" | "neutral" | "watch";
  evidence: HistoryLensEvidenceItem[];
  limitation: string;
  decision: {
    supported: boolean;
    statement: string;
    href?: "/coach";
    linkLabel?: string;
  };
};

export type HistoryExerciseProgressEvidence = {
  exerciseId?: string;
  exercise: string;
  sessions: number;
  metric: "estimated_strength" | "reps";
  metricType?:
    | "weight_reps"
    | "reps"
    | "assisted_reps"
    | "duration"
    | "distance_duration"
    | "activity";
  loadSemantics?: string;
  first: {
    sourceSessionId?: string;
    localDate?: string;
    weight: number | null;
    reps: number;
    estimatedStrength: number | null;
  };
  latest: {
    sourceSessionId?: string;
    localDate?: string;
    weight: number | null;
    reps: number;
    estimatedStrength: number | null;
  };
  changePercent: number | null;
  repChange: number | null;
};

export type HistoryProgramFitEvidence = {
  completedSessions: number;
  abandonedSessions: number;
  unlinkedSessions: number;
  asPlannedOccurrences: number;
  substitutedOccurrences: number;
  addedOccurrences: number;
  skippedOccurrences: number;
  unlinkedPlannedOccurrences: number;
  skipReasons: Array<{ reason: string; count: number }>;
  substitutionReasons: Array<{ reason: string; count: number }>;
};

export type HistoryPainContextEvidence = {
  exercise: string | null;
  bodyPart: string;
  events: number;
  maxSeverity: number;
};

export type HistoryPainModificationEvidence = {
  plannedExercise: string;
  actualExercise?: string;
  events: number;
};

export type HistoryConstraintEvidence = {
  bodyPart: string;
  affectedPatterns: string[];
  avoid: boolean;
  cautious: boolean;
};

export type HistoryPainEvidence = {
  painEvents: number;
  highPainEvents: number;
  attributedPainEvents: number;
  contexts: HistoryPainContextEvidence[];
  painSkips: HistoryPainModificationEvidence[];
  discomfortSubstitutions: HistoryPainModificationEvidence[];
  constraints: HistoryConstraintEvidence[];
};

export type HistoryRecordEvidence = {
  exerciseId?: string;
  sourceSessionId?: string;
  exercise: string;
  sessions: number;
  localDate: string;
  metric: "estimated_strength" | "reps";
  weight: number | null;
  reps: number;
  estimatedStrength: number | null;
};

export type BuildHistoryLensesInput = {
  unit: LoadUnit;
  completedSessions: number;
  abandonedSessions: number;
  workingSets: number;
  averageDurationMin: number | null;
  weekly: Array<{
    weekStartISO: string;
    sessions: number;
    sets: number;
    volume: number;
    durationMinutes?: number;
    durationSessions?: number;
  }>;
  exerciseProgress: HistoryExerciseProgressEvidence[];
  programFit: HistoryProgramFitEvidence;
  pain: HistoryPainEvidence;
  records: HistoryRecordEvidence[];
};

const number = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${number.format(count)} ${count === 1 ? singular : pluralForm}`;
}

function titleCase(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatPerformance(
  performance: { weight: number | null; reps: number },
  unit: LoadUnit,
) {
  return performance.weight == null
    ? plural(performance.reps, "rep")
    : `${number.format(performance.weight)} ${unit} × ${number.format(performance.reps)}`;
}

function formatReasons(reasons: Array<{ reason: string; count: number }>) {
  return reasons
    .map(({ reason, count }) => `${titleCase(reason)} (${number.format(count)})`)
    .join(" · ");
}

function noDecision() {
  return {
    supported: false as const,
    statement: "No decision is supported by this evidence.",
  };
}

function buildProgressLens(input: BuildHistoryLensesInput): HistoryLens {
  const supportedProgress = input.exerciseProgress.filter(
    (exercise) =>
      (exercise.metricType == null ||
        exercise.metricType === "weight_reps" ||
        exercise.metricType === "reps") &&
      exercise.loadSemantics !== "assistance",
  );
  const comparable = supportedProgress.filter(
    (exercise) => exercise.changePercent != null,
  );
  const improving = comparable.filter(
    (exercise) => (exercise.changePercent ?? 0) > 1,
  );
  const stable = comparable.filter(
    (exercise) => Math.abs(exercise.changePercent ?? 0) <= 1,
  );
  const lower = comparable.filter(
    (exercise) => (exercise.changePercent ?? 0) < -1,
  );
  const uncertain = supportedProgress.filter(
    (exercise) => exercise.changePercent == null,
  );

  const answer =
    input.completedSessions === 0
      ? "No strength-progress answer is available yet."
      : comparable.length === 0
        ? "Progress is uncertain; no exact exercise has two comparable best-set observations."
        : [
            improving.length ? `${plural(improving.length, "exercise")} improved` : null,
            stable.length
              ? `${plural(stable.length, "exercise")} stayed broadly stable`
              : null,
            lower.length ? `${plural(lower.length, "exercise")} moved lower` : null,
            uncertain.length
              ? `${plural(uncertain.length, "exercise")} ${uncertain.length === 1 ? "remains" : "remain"} uncertain`
              : null,
          ]
            .filter(Boolean)
            .join("; ") + ".";

  const featured = [
    [...improving].sort(
      (a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0),
    )[0],
    stable[0],
    [...lower].sort(
      (a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0),
    )[0],
    uncertain[0],
  ].filter(
    (exercise, index, all): exercise is HistoryExerciseProgressEvidence =>
      exercise != null &&
      all.findIndex((candidate) => candidate?.exercise === exercise.exercise) ===
        index,
  );

  const evidence = featured.slice(0, 4).map((exercise) => ({
    label: exercise.exercise,
    value: `${formatPerformance(exercise.first, input.unit)} → ${formatPerformance(exercise.latest, input.unit)}`,
    detail:
      exercise.changePercent == null
        ? `${plural(exercise.sessions, "session")} · needs two comparable observations`
        : exercise.metric === "reps"
          ? `${plural(exercise.sessions, "session")} · ${(exercise.repChange ?? 0) >= 0 ? "+" : ""}${exercise.repChange ?? 0} reps`
          : `${plural(exercise.sessions, "session")} · ${(exercise.changePercent ?? 0) >= 0 ? "+" : ""}${exercise.changePercent}% estimated strength`,
  }));

  if (evidence.length === 0) {
    evidence.push({
      label: "Comparable observations",
      value: "None yet",
      detail: "A single workout or unmatched metric cannot establish a trend.",
    });
  }

  return {
    key: "progress",
    title: "Progress",
    question: "What is improving, stable, or uncertain?",
    answer,
    tone: lower.length > 0 ? "watch" : improving.length > 0 ? "positive" : "neutral",
    evidence,
    limitation: `${plural(comparable.length, "exact-exercise comparison")} use the first and latest best eligible set in this period. Above +1% is described as improving, below −1% as lower, and the band between them as broadly stable. Variants stay separate, estimated strength uses Epley, and independent activities are excluded.`,
    decision:
      lower.length > 0
        ? {
            supported: true,
            statement: `Possible decision: review ${lower[0].exercise}'s target and context before changing the Program.`,
            href: "/coach",
            linkLabel: "Open Review and decisions",
          }
        : noDecision(),
  };
}

function buildProgramFitLens(input: BuildHistoryLensesInput): HistoryLens {
  const program = input.programFit;
  const linkedSessions = program.completedSessions + program.abandonedSessions;
  const changed = program.substitutedOccurrences + program.addedOccurrences;
  const plannedOccurrences =
    program.asPlannedOccurrences +
    program.substitutedOccurrences +
    program.skippedOccurrences;

  const evidence: HistoryLensEvidenceItem[] = [];
  if (linkedSessions > 0) {
    evidence.push({
      label: "Program-linked workouts",
      value: `${number.format(program.completedSessions)} completed · ${number.format(program.abandonedSessions)} abandoned`,
      detail: "Validated through the recorded historical Program template.",
    });
    evidence.push({
      label: "Recorded planned occurrences",
      value: `${number.format(program.asPlannedOccurrences)} as planned · ${number.format(program.substitutedOccurrences)} substituted · ${number.format(program.skippedOccurrences)} skipped`,
      detail: `${plural(plannedOccurrences, "planned occurrence")} in total; ${plural(program.addedOccurrences, "added exercise")} shown separately.`,
    });
  } else {
    evidence.push({
      label: "Program-linked workouts",
      value: "None in this period",
      detail: "Template-less and imported workouts are not treated as Program behavior.",
    });
  }
  if (program.skipReasons.length > 0) {
    evidence.push({
      label: "Recorded skip reasons",
      value: formatReasons(program.skipReasons),
    });
  }
  if (program.substitutionReasons.length > 0) {
    evidence.push({
      label: "Recorded substitution reasons",
      value: formatReasons(program.substitutionReasons),
    });
  }
  if (program.unlinkedSessions > 0) {
    evidence.push({
      label: "Other workouts kept outside Program fit",
      value: plural(program.unlinkedSessions, "workout"),
      detail: "They remain in History and strength reporting, but not in Program-fit evidence.",
    });
  }

  return {
    key: "program-fit",
    title: "Program fit",
    question: "What is consistently completed, changed, skipped, or deferred?",
    answer:
      linkedSessions === 0
        ? "No Program-linked history is available in this period."
        : `${plural(program.completedSessions, "Program workout")} completed; ${plural(changed, "exercise change")} and ${plural(program.skippedOccurrences, "skip")} ${changed + program.skippedOccurrences === 1 ? "was" : "were"} recorded.`,
    tone:
      linkedSessions === 0
        ? "neutral"
        : changed + program.skippedOccurrences > 0
          ? "watch"
          : "positive",
    evidence,
    limitation: `Deferred workouts are not recorded, so no deferral conclusion is supported. “As planned” is an occurrence state, not proof that every prescribed set was completed.${program.unlinkedPlannedOccurrences > 0 ? ` ${plural(program.unlinkedPlannedOccurrences, "occurrence")} could not be matched to its historical slot and is excluded.` : ""}`,
    decision:
      changed + program.skippedOccurrences > 0
        ? {
            supported: true,
            statement:
              "Possible decision: review whether the recorded changes should remain one-offs or become an explicit Program edit.",
            href: "/coach",
            linkLabel: "Open Review and decisions",
          }
        : {
            supported: false,
            statement:
              linkedSessions === 0
                ? "No decision is supported by this evidence."
                : "No Program change is supported by this history alone.",
          },
  };
}

function buildPainLens(input: BuildHistoryLensesInput): HistoryLens {
  const pain = input.pain;
  const repeatedContext = pain.contexts.find((context) => context.events >= 2);
  const repeatedSkip = pain.painSkips.find((entry) => entry.events >= 2);
  const repeatedSubstitution = pain.discomfortSubstitutions.find(
    (entry) => entry.events >= 2,
  );
  const discomfortChanges =
    pain.painSkips.reduce((total, entry) => total + entry.events, 0) +
    pain.discomfortSubstitutions.reduce(
      (total, entry) => total + entry.events,
      0,
    );
  const hasSignal = pain.painEvents > 0 || discomfortChanges > 0;
  const repeatedLabel = repeatedContext
    ? repeatedContext.exercise
      ? `${repeatedContext.exercise} (${titleCase(repeatedContext.bodyPart)})`
      : `${titleCase(repeatedContext.bodyPart)} in session-level logs`
    : repeatedSkip
      ? repeatedSkip.plannedExercise
      : repeatedSubstitution
        ? repeatedSubstitution.plannedExercise
        : null;

  const evidence: HistoryLensEvidenceItem[] = pain.contexts.slice(0, 3).map(
    (context) => ({
      label: context.exercise
        ? `${context.exercise} · ${titleCase(context.bodyPart)}`
        : `Session-level · ${titleCase(context.bodyPart)}`,
      value: `${plural(context.events, "positive pain report")} · max ${context.maxSeverity}/10`,
      detail: context.exercise
        ? "The pain log names this exact exercise."
        : "No movement is attributed to this pain log.",
    }),
  );
  for (const entry of pain.painSkips.slice(0, 2)) {
    evidence.push({
      label: entry.plannedExercise,
      value: plural(entry.events, "pain-related skip"),
    });
  }
  for (const entry of pain.discomfortSubstitutions.slice(0, 2)) {
    evidence.push({
      label: entry.plannedExercise,
      value: plural(entry.events, "discomfort substitution"),
      detail: entry.actualExercise
        ? `Recorded substitute: ${entry.actualExercise}`
        : undefined,
    });
  }
  for (const constraint of pain.constraints.slice(0, 2)) {
    evidence.push({
      label: `Current constraint · ${titleCase(constraint.bodyPart)}`,
      value: constraint.avoid ? "Avoid" : constraint.cautious ? "Cautious" : "Recorded",
      detail:
        constraint.affectedPatterns.length > 0
          ? constraint.affectedPatterns.map(titleCase).join(" · ")
          : "No movement patterns named.",
    });
  }
  if (evidence.length === 0) {
    evidence.push({
      label: "Recorded pain or discomfort-linked changes",
      value: "None in this period",
    });
  }

  return {
    key: "pain-constraints",
    title: "Pain and constraints",
    question:
      "Which movements and contexts are repeatedly associated with discomfort or substitution?",
    answer: repeatedLabel
      ? `Repeated recorded discomfort is associated with ${repeatedLabel}.`
      : hasSignal
        ? "A discomfort signal was recorded, but no repeated movement pattern is established."
        : "No pain or discomfort-linked exercise changes were recorded in this period.",
    tone: hasSignal ? "watch" : "neutral",
    evidence: evidence.slice(0, 5),
    limitation: `${number.format(pain.attributedPainEvents)} of ${number.format(pain.painEvents)} positive pain reports name an exercise. These are recorded associations, not causes or a medical assessment; no pain record does not mean pain-free.`,
    decision:
      hasSignal || pain.constraints.some((constraint) => constraint.avoid)
        ? {
            supported: true,
            statement:
              "Possible decision: bring the named movement, context, and constraint evidence into Review before the next Program change.",
            href: "/coach",
            linkLabel: "Open Review and decisions",
          }
        : noDecision(),
  };
}

function workloadComparison(weekly: BuildHistoryLensesInput["weekly"]) {
  const availableWeeks = weekly.slice(-8);
  if (availableWeeks.length < 6) return null;
  const evenWeekCount =
    availableWeeks.length % 2 === 0
      ? availableWeeks.length
      : availableWeeks.length - 1;
  const comparisonWeeks = availableWeeks.slice(-evenWeekCount);
  const midpoint = Math.floor(comparisonWeeks.length / 2);
  const priorVolume = comparisonWeeks
    .slice(0, midpoint)
    .reduce((total, week) => total + week.volume, 0);
  const recentVolume = comparisonWeeks
    .slice(midpoint)
    .reduce((total, week) => total + week.volume, 0);
  const priorSets = comparisonWeeks
    .slice(0, midpoint)
    .reduce((total, week) => total + week.sets, 0);
  const recentSets = comparisonWeeks
    .slice(midpoint)
    .reduce((total, week) => total + week.sets, 0);
  const priorDurationMinutes = comparisonWeeks
    .slice(0, midpoint)
    .reduce((total, week) => total + (week.durationMinutes ?? 0), 0);
  const recentDurationMinutes = comparisonWeeks
    .slice(midpoint)
    .reduce((total, week) => total + (week.durationMinutes ?? 0), 0);
  const priorDurationSessions = comparisonWeeks
    .slice(0, midpoint)
    .reduce((total, week) => total + (week.durationSessions ?? 0), 0);
  const recentDurationSessions = comparisonWeeks
    .slice(midpoint)
    .reduce((total, week) => total + (week.durationSessions ?? 0), 0);
  const priorAverageDuration = priorDurationSessions
    ? priorDurationMinutes / priorDurationSessions
    : null;
  const recentAverageDuration = recentDurationSessions
    ? recentDurationMinutes / recentDurationSessions
    : null;
  return {
    weeks: comparisonWeeks.length,
    priorVolume,
    recentVolume,
    volumeChangePercent:
      priorVolume > 0
        ? Math.round(((recentVolume - priorVolume) / priorVolume) * 100)
        : null,
    priorSets,
    recentSets,
    setChangePercent:
      priorSets > 0
        ? Math.round(((recentSets - priorSets) / priorSets) * 100)
        : null,
    priorAverageDuration,
    recentAverageDuration,
    durationChangePercent:
      priorAverageDuration && recentAverageDuration != null
        ? Math.round(
            ((recentAverageDuration - priorAverageDuration) /
              priorAverageDuration) *
              100,
          )
        : null,
  };
}

function direction(
  change: number | null,
  words: { rising: string; easing: string; steady: string; unavailable: string },
) {
  if (change == null) return words.unavailable;
  if (change > 10) return words.rising;
  if (change < -10) return words.easing;
  return words.steady;
}

function buildWorkCapacityLens(input: BuildHistoryLensesInput): HistoryLens {
  const comparison = workloadComparison(input.weekly);
  const workloadDirection = comparison
    ? direction(comparison.volumeChangePercent, {
        rising: "rising",
        easing: "easing",
        steady: "steady",
        unavailable: "not comparable",
      })
    : null;
  const setDirection = comparison
    ? direction(comparison.setChangePercent, {
        rising: "higher",
        easing: "lower",
        steady: "steady",
        unavailable: "not comparable",
      })
    : null;
  const durationDirection = comparison
    ? direction(comparison.durationChangePercent, {
        rising: "longer",
        easing: "shorter",
        steady: "similar",
        unavailable: "not comparable",
      })
    : null;
  const evidence: HistoryLensEvidenceItem[] = [
    {
      label: "Completed strength work",
      value: `${plural(input.completedSessions, "workout")} · ${plural(input.workingSets, "working set")}`,
      detail:
        input.abandonedSessions > 0
          ? `${plural(input.abandonedSessions, "abandoned workout")} shown separately.`
          : "Only completed workouts contribute sets and workload.",
    },
    {
      label: "Average completed-workout duration",
      value:
        input.averageDurationMin == null
          ? "Not available"
          : `${number.format(input.averageDurationMin)} min`,
      detail: "Uses completed workouts with usable start and finish times.",
    },
  ];
  if (comparison) {
    evidence.push({
      label: "Loaded workload · latest half vs prior half",
      value: `${number.format(comparison.recentVolume)} ${input.unit} vs ${number.format(comparison.priorVolume)} ${input.unit}`,
      detail:
        comparison.volumeChangePercent == null
          ? "No non-zero prior loaded workload is available for comparison."
          : `${comparison.volumeChangePercent >= 0 ? "+" : ""}${comparison.volumeChangePercent}% across the available ${comparison.weeks}-week comparison.`,
    });
    evidence.push({
      label: "Completed working sets · latest half vs prior half",
      value: `${number.format(comparison.recentSets)} vs ${number.format(comparison.priorSets)}`,
      detail:
        comparison.setChangePercent == null
          ? "No non-zero prior set count is available for comparison."
          : `${comparison.setChangePercent >= 0 ? "+" : ""}${comparison.setChangePercent}% across the same weeks.`,
    });
    evidence.push({
      label: "Average duration · latest half vs prior half",
      value:
        comparison.recentAverageDuration == null ||
        comparison.priorAverageDuration == null
          ? "Not comparable"
          : `${number.format(comparison.recentAverageDuration)} min vs ${number.format(comparison.priorAverageDuration)} min`,
      detail:
        comparison.durationChangePercent == null
          ? "Both halves need completed workouts with usable finish times."
          : `${comparison.durationChangePercent >= 0 ? "+" : ""}${comparison.durationChangePercent}% across the same weeks.`,
    });
  } else {
    evidence.push({
      label: "Comparable loaded-workload trend",
      value: "Not available",
      detail: "The period needs enough weeks and a non-zero prior comparison.",
    });
  }

  return {
    key: "work-capacity",
    title: "Work capacity",
    question: "How are duration, completed work, and workload changing?",
    answer:
      comparison && comparison.volumeChangePercent != null
        ? `Loaded workload is ${workloadDirection}; completed sets are ${setDirection}; average workout duration is ${durationDirection} in the available ${comparison.weeks}-week comparison.`
        : "Not enough comparable completed strength work is available to establish a workload trend.",
    tone:
      workloadDirection === "rising"
        ? "positive"
        : workloadDirection === "easing"
          ? "watch"
          : "neutral",
    evidence,
    limitation:
      "Loaded workload is descriptive weight × reps from eligible strength sets; bodyweight, band, excluded sets, and independent activities are not included. Duration and workload do not prove adaptation or readiness.",
    decision: comparison?.volumeChangePercent != null
      ? {
          supported: true,
          statement:
            "Possible decision: check whether this workload direction matches your intent, recovery, and pain evidence before changing Program volume.",
          href: "/coach",
          linkLabel: "Open Review and decisions",
        }
      : noDecision(),
  };
}

function buildRecordsLens(input: BuildHistoryLensesInput): HistoryLens {
  const displayedRecords = input.records.slice(0, 5);
  const evidence: HistoryLensEvidenceItem[] = displayedRecords.map((record) => ({
      label: record.exercise,
      value: formatPerformance(record, input.unit),
      detail:
        record.metric === "estimated_strength"
          ? `${record.localDate} · ${number.format(record.estimatedStrength ?? 0)} ${input.unit} estimated strength · ${plural(record.sessions, "session")}`
          : `${record.localDate} · repetition record · ${plural(record.sessions, "session")}`,
    }));
  if (evidence.length === 0) {
    evidence.push({
      label: "Eligible performance observations",
      value: "None in this period",
    });
  }

  return {
    key: "records",
    title: "Records",
    question: "What are the best observed performances?",
    answer:
      input.records.length > 0
        ? `Showing best observed performances for ${plural(displayedRecords.length, "exact exercise variant")}${input.records.length > displayedRecords.length ? `, selected from ${number.format(input.records.length)} eligible variants` : ""}.`
        : "No eligible supported performance observations are available in this period.",
    tone: input.records.length > 0 ? "positive" : "neutral",
    evidence,
    limitation:
      "This bounded list favors exact variants with more recorded sessions. These are best eligible observations inside the selected period, not durable all-time PR records. Warm-ups, excluded sets, assistance, timed work, distance work, and independent activities are excluded. Estimated strength uses Epley.",
    decision: {
      supported: false,
      statement: "No Program decision is supported by records alone.",
    },
  };
}

export function buildHistoryLenses(
  input: BuildHistoryLensesInput,
): HistoryLens[] {
  return [
    buildProgressLens(input),
    buildProgramFitLens(input),
    buildPainLens(input),
    buildWorkCapacityLens(input),
    buildRecordsLens(input),
  ];
}
