export const TECHNIQUE_ISSUES = [
  "bracing",
  "range_of_motion",
  "control",
  "balance",
  "positioning",
  "tempo",
  "other",
] as const;

export type TechniqueIssue = (typeof TECHNIQUE_ISSUES)[number];

export const TECHNIQUE_ISSUE_LABELS: Record<TechniqueIssue, string> = {
  bracing: "Bracing",
  range_of_motion: "Range of motion",
  control: "Control",
  balance: "Balance",
  positioning: "Positioning",
  tempo: "Tempo",
  other: "Other technique issue",
};

export const LIMITATION_CAUSES = [
  "strength_fatigue",
  "breathing_conditioning",
  "grip",
  "mobility",
  "pain",
  "technique",
  "equipment_setup",
  "time",
  "other",
] as const;

export type LimitationCause = (typeof LIMITATION_CAUSES)[number];

export const LIMITATION_CAUSE_LABELS: Record<LimitationCause, string> = {
  strength_fatigue: "Strength or fatigue",
  breathing_conditioning: "Breathing or conditioning",
  grip: "Grip",
  mobility: "Mobility",
  pain: "Pain",
  technique: "Technique",
  equipment_setup: "Equipment or setup",
  time: "Time",
  other: "Something else",
};

export const PAIN_BODY_PARTS = [
  "shoulder",
  "knee",
  "back",
  "elbow",
  "wrist",
  "hip",
  "other",
] as const;

export type PainBodyPart = (typeof PAIN_BODY_PARTS)[number];

export type SetPainContext = {
  bodyPart: PainBodyPart;
  severity: number;
  note: string | null;
};

export type SetExceptionContext = {
  rir: number | null;
  techniqueIssue: TechniqueIssue | null;
  limitationCause: LimitationCause | null;
  pain: SetPainContext | null;
};

