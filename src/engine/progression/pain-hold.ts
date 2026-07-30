const PAIN_HOLD_WINDOW_DAYS = 14;
const PAIN_HOLD_THRESHOLD = 3;
const PAIN_SUBSTITUTION_THRESHOLD = 5;
const PAIN_RECURRENCE_SESSION_COUNT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PainHoldEvidence = {
  id: string;
  sessionId: string | null;
  severity: number | null;
  createdAt: Date;
};

export type PainHoldState = "clear" | "hold" | "substitution_review";

export type PainHoldClassification = {
  state: PainHoldState;
  blocksProgression: boolean;
  explanation: string | null;
  evidenceIds: string[];
  sessionIds: string[];
  releaseAt: Date | null;
  signals: {
    windowDays: typeof PAIN_HOLD_WINDOW_DAYS;
    positiveReports: number;
    holdReports: number;
    linkedSessions: number;
    worstSeverity: number | null;
    triggerEvidenceId: string | null;
    triggerSessionId: string | null;
    releaseAt: string | null;
    highSeverityReview: boolean;
    repeatedSessionReview: boolean;
  };
};

function compareEvidence(
  left: PainHoldEvidence,
  right: PainHoldEvidence
): number {
  const severityDifference = (right.severity ?? 0) - (left.severity ?? 0);
  if (severityDifference !== 0) return severityDifference;

  const timeDifference = right.createdAt.getTime() - left.createdAt.getTime();
  if (timeDifference !== 0) return timeDifference;

  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function addWindow(date: Date): Date {
  return new Date(date.getTime() + PAIN_HOLD_WINDOW_DAYS * DAY_MS);
}

function pluralizedWorkouts(count: number): string {
  return `${count} workout${count === 1 ? "" : "s"}`;
}

/**
 * Classifies exact-exercise pain evidence supplied by the caller.
 *
 * Recording time is the only time boundary used here. Missing and zero-valued
 * observations are not evidence that a later workout was pain-free.
 */
export function classifyPainHold(input: {
  exerciseName: string;
  now: Date;
  evidence: PainHoldEvidence[];
}): PainHoldClassification {
  const nowMs = input.now.getTime();
  const windowStartMs = nowMs - PAIN_HOLD_WINDOW_DAYS * DAY_MS;
  const positiveEvidence = input.evidence
    .filter((entry) => {
      const createdAtMs = entry.createdAt.getTime();
      return (
        Number.isFinite(createdAtMs) &&
        createdAtMs > windowStartMs &&
        createdAtMs <= nowMs &&
        entry.severity != null &&
        Number.isFinite(entry.severity) &&
        entry.severity > 0
      );
    })
    .sort(compareEvidence);
  const holdEvidence = positiveEvidence.filter(
    (entry) => (entry.severity ?? 0) >= PAIN_HOLD_THRESHOLD
  );
  const linkedSessionIds = [
    ...new Set(
      positiveEvidence.flatMap((entry) =>
        entry.sessionId == null ? [] : [entry.sessionId]
      )
    ),
  ];
  const worstSeverity = positiveEvidence[0]?.severity ?? null;
  const trigger = positiveEvidence[0] ?? null;
  const highSeverityReview =
    (worstSeverity ?? 0) >= PAIN_SUBSTITUTION_THRESHOLD;
  const repeatedSessionReview =
    linkedSessionIds.length >= PAIN_RECURRENCE_SESSION_COUNT;
  const latestHoldEvidence = holdEvidence.reduce<PainHoldEvidence | null>(
    (latest, entry) =>
      latest == null || entry.createdAt > latest.createdAt ? entry : latest,
    null
  );
  const releaseAt =
    latestHoldEvidence == null ? null : addWindow(latestHoldEvidence.createdAt);

  let state: PainHoldState = "clear";
  let explanation: string | null = null;

  if (highSeverityReview || repeatedSessionReview) {
    state = "substitution_review";
    const reason = highSeverityReview
      ? `a ${worstSeverity}/10 pain flag was saved in the last 14 days`
      : `pain was flagged in ${pluralizedWorkouts(linkedSessionIds.length)} in the last 14 days`;
    const releaseExplanation =
      releaseAt == null
        ? "Progression stays paused while those flags are in the 14-day window."
        : "The pain hold clears 14 days after the latest 3/10 or higher flag.";
    explanation =
      `${input.exerciseName} needs an alternative review because ${reason}. ` +
      `${releaseExplanation} A workout with no pain entry doesn't shorten that time.`;
  } else if (holdEvidence.length > 0) {
    state = "hold";
    explanation =
      `${input.exerciseName} is on hold because a ${worstSeverity}/10 pain flag was saved in the last 14 days. ` +
      "It comes off hold 14 days after the latest 3/10 or higher flag. " +
      "A workout with no pain entry doesn't shorten that time.";
  }

  return {
    state,
    blocksProgression: state !== "clear",
    explanation,
    evidenceIds: positiveEvidence.map((entry) => entry.id),
    sessionIds: linkedSessionIds,
    releaseAt,
    signals: {
      windowDays: PAIN_HOLD_WINDOW_DAYS,
      positiveReports: positiveEvidence.length,
      holdReports: holdEvidence.length,
      linkedSessions: linkedSessionIds.length,
      worstSeverity,
      triggerEvidenceId: trigger?.id ?? null,
      triggerSessionId: trigger?.sessionId ?? null,
      releaseAt: releaseAt?.toISOString() ?? null,
      highSeverityReview,
      repeatedSessionReview,
    },
  };
}
