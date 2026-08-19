import { z } from "zod";

export const PLANNED_DURATION_SEMANTICS_VERSION = 1 as const;

export const PLANNED_DURATION_SOURCES = [
  "program_day_target",
  "program_day_duration_override",
] as const;

export const plannedDurationSourceSchema = z.enum(PLANNED_DURATION_SOURCES);
export type PlannedDurationSource = z.infer<
  typeof plannedDurationSourceSchema
>;

export const SESSION_COMPLETION_SEMANTICS_VERSION = 1 as const;

export const SESSION_COMPLETION_STATES = [
  "completed_without_prescription",
  "completed_as_prescribed",
  "completed_with_changes",
  "completed_with_remaining_work",
  "abandoned",
] as const;

export const sessionCompletionStateSchema = z.enum(SESSION_COMPLETION_STATES);
export type SessionCompletionState = z.infer<
  typeof sessionCompletionStateSchema
>;

/**
 * Explicit owner-selected reasons for ending a completed workout while
 * prescribed occurrences remain. Historical unknowns stay null; new writes
 * do not receive a convenient inferred default.
 */
export const INCOMPLETE_SESSION_REASONS = [
  "time_limit_reached",
  "fatigue",
  "pain_discomfort",
  "equipment_unavailable_incompatible",
  "user_choice",
  "technical_app_issue",
  "interruption",
  "program_change",
] as const;

export const incompleteSessionReasonSchema = z.enum(
  INCOMPLETE_SESSION_REASONS,
);
export type IncompleteSessionReason = z.infer<
  typeof incompleteSessionReasonSchema
>;

export const INCOMPLETE_SESSION_REASON_LABELS = {
  time_limit_reached: "Session time limit reached",
  fatigue: "Fatigue",
  pain_discomfort: "Pain or discomfort",
  equipment_unavailable_incompatible: "Equipment unavailable or incompatible",
  user_choice: "User choice",
  technical_app_issue: "Technical or app issue",
  interruption: "Interruption",
  program_change: "Program change",
} as const satisfies Record<IncompleteSessionReason, string>;

export const OCCURRENCE_RESOLUTION_SEMANTICS_VERSION = 1 as const;

export const TERMINAL_OCCURRENCE_RESOLUTION_REASONS = [
  ...INCOMPLETE_SESSION_REASONS,
  "session_completed",
] as const;

export const terminalOccurrenceResolutionReasonSchema = z.enum(
  TERMINAL_OCCURRENCE_RESOLUTION_REASONS,
);
export type TerminalOccurrenceResolutionReason = z.infer<
  typeof terminalOccurrenceResolutionReasonSchema
>;
