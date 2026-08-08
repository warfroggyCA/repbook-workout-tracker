export const PAIN_EVIDENCE_ALGORITHM_VERSION = "pain-evidence-v1";

export const PAIN_EVIDENCE_SOURCES = [
  "set_flag",
  "set_exception",
  "session_note",
  "checkin",
] as const;

export type PainEvidenceSource = (typeof PAIN_EVIDENCE_SOURCES)[number];
export type PainEvidenceMeaning =
  | "unknown"
  | "explicit_no_issue"
  | "pain"
  | "unsupported";

export type PainEvidenceInput = {
  bodyPart?: string | null;
  severity?: number | null;
  source?: string | null;
};

export type PainEvidenceClassification = {
  meaning: PainEvidenceMeaning;
  algorithmVersion: typeof PAIN_EVIDENCE_ALGORITHM_VERSION;
  bodyPart: string | null;
  severity: number | null;
  source: PainEvidenceSource | null;
};

function supportedSource(value: string | null | undefined): PainEvidenceSource | null {
  return PAIN_EVIDENCE_SOURCES.includes(value as PainEvidenceSource)
    ? (value as PainEvidenceSource)
    : null;
}

/**
 * Classifies retained pain/no-issue evidence without inventing a fact when no
 * record exists. Set exceptions are intentionally positive-only because their
 * writer contract accepts severity 1–10, while the general pain writer also
 * supports an explicit severity-zero no-issue report.
 */
export function classifyPainEvidence(
  input: PainEvidenceInput | null | undefined,
): PainEvidenceClassification {
  if (input == null) {
    return {
      meaning: "unknown",
      algorithmVersion: PAIN_EVIDENCE_ALGORITHM_VERSION,
      bodyPart: null,
      severity: null,
      source: null,
    };
  }

  const bodyPart = input.bodyPart?.trim() || null;
  const severity = input.severity ?? null;
  const source = supportedSource(input.source);
  const supported =
    bodyPart != null &&
    bodyPart.length <= 50 &&
    Number.isInteger(severity) &&
    severity != null &&
    severity >= 0 &&
    severity <= 10 &&
    source != null &&
    !(source === "set_exception" && severity === 0);

  if (!supported) {
    return {
      meaning: "unsupported",
      algorithmVersion: PAIN_EVIDENCE_ALGORITHM_VERSION,
      bodyPart,
      severity,
      source,
    };
  }

  return {
    meaning: severity === 0 ? "explicit_no_issue" : "pain",
    algorithmVersion: PAIN_EVIDENCE_ALGORITHM_VERSION,
    bodyPart,
    severity,
    source,
  };
}

export function isPositivePainEvidence(
  input: PainEvidenceInput | PainEvidenceClassification | null | undefined,
): boolean {
  return classifyPainEvidence(input).meaning === "pain";
}

export function formatPainEvidence(
  input: PainEvidenceInput | PainEvidenceClassification | null | undefined,
): string {
  const evidence = classifyPainEvidence(input);
  if (evidence.meaning === "unknown") return "Pain not recorded (unknown)";
  if (evidence.meaning === "unsupported") {
    return "Unsupported pain evidence retained for review";
  }
  if (evidence.meaning === "explicit_no_issue") {
    return `Explicit no-issue report: ${evidence.bodyPart} 0/10`;
  }
  return `Pain: ${evidence.bodyPart} ${evidence.severity}/10`;
}
