import "server-only";

import { randomUUID } from "node:crypto";
import type {
  AIProviderErrorKind,
  SanitizedAIFinishReason,
} from "@/lib/ai-provider-error";
import { PRODUCT_VERSION } from "@/lib/product-version";

export const DIAGNOSTIC_EVENT_SCHEMA_VERSION = "diagnostic-event/1";
export const DIAGNOSTIC_REDACTION_VERSION = "diagnostic-redaction/1";
export const DIAGNOSTIC_RETENTION_HOURS = 24;
export const DIAGNOSTIC_EPISODE_MINUTES = 15;

export type DiagnosticErrorCategory =
  | "authorization"
  | "cancelled"
  | "conflict"
  | "not_found"
  | "persistence"
  | "runtime"
  | "storage"
  | "timeout"
  | "unknown"
  | "validation";

export type DiagnosticEpisode = Readonly<{
  correlationId: string;
  startedAt: string;
  expiresAt: string;
}>;

type ProviderFields = {
  errorKind: AIProviderErrorKind;
  providerStatusCode: number | null;
  providerRetryable: boolean | null;
  causeKind: AIProviderErrorKind | "cyclic" | null;
};

type ErrorFields = { errorCategory: DiagnosticErrorCategory };

export type DiagnosticEventFields = {
  "ai.coach_question_failed": ProviderFields;
  "ai.coach_review_failed": ProviderFields;
  "ai.setup_equipment_parse_failed": ProviderFields;
  "ai.setup_routine_build_failed": ProviderFields;
  "ai.structured_output_missing": { finishReason: SanitizedAIFinishReason };
  "ai.usage_failure_write_failed": ErrorFields & {
    usageOutcome: "cancelled" | "failed" | "timed_out";
  };
  "analysis_package.generation_failed": ErrorFields;
  "contextual_note.archive_failed": ErrorFields;
  "contextual_note.edit_failed": ErrorFields;
  "contextual_note.save_failed": ErrorFields;
  "equipment.inventory_pre_save_check_failed": ErrorFields;
  "equipment.inventory_preview_failed": ErrorFields;
  "equipment.inventory_save_failed": ErrorFields;
  "history.retrospective_create_failed": ErrorFields;
  "history.timing_correction_failed": ErrorFields;
  "live_coach.failure_write_failed": ErrorFields;
  "live_coach.prepared_value_failed": ProviderFields;
  "live_coach.response_failed": ProviderFields & {
    deadlineReached: boolean;
    disconnected: boolean;
  };
  "live_coach.saved_message_invalid_json": ErrorFields;
  "progression.job_failed": ErrorFields & {
    attemptCount: number;
    retryScheduled: boolean;
  };
  "record_version.restore_failed": ErrorFields;
  "routine_import.exercise_map_degraded": ProviderFields & {
    candidateCount: number;
  };
  "routine_import.parse_failed": {
    failureCategory:
      | "output_incomplete"
      | "persistence_failure"
      | "provider_failure"
      | "timeout"
      | "unknown"
      | "unsupported_rep_sequence"
      | "usage_control";
    inputCharacterCount: number;
    detectedDayCount: number;
    detectedExerciseCount: number;
    durationMs: number;
  };
  "session.render_failed": ErrorFields & {
    routeState: "confirmed_active" | "route_input";
  };
  "session.start_failed": ErrorFields & {
    failure: "unexpected_creation_failure";
  };
  "session.start_incomplete": Record<string, never>;
  "session.start_reconciled": {
    reconciliation: "exact_start_request_found";
  };
  "session.start_reconciliation_failed": ErrorFields & {
    reconciliation:
      | "active_workout_status_unknown"
      | "start_request_status_unknown";
  };
  "session.start_rejected": {
    rejection: "invalid_request" | "program_updated";
  };
  "settings.font_size_save_failed": ErrorFields;
  "settings.timezone_save_failed": ErrorFields;
  "snapshot.download_unavailable": ErrorFields;
  "snapshot.lifecycle_deletion_failed": ErrorFields & {
    objectDeleted: boolean;
  };
  "snapshot.lifecycle_orphan_delete_failed": ErrorFields;
  "snapshot.lifecycle_store_scan_failed": ErrorFields;
};

export type DiagnosticEventName = keyof DiagnosticEventFields;
type DiagnosticLevel = "error" | "warn";
type FieldValidator = (value: unknown) => boolean;
type FieldRules = Readonly<Record<string, FieldValidator>>;

type DiagnosticEventDefinition = Readonly<{
  component: string;
  level: DiagnosticLevel;
  operation: string;
  state: string;
  fields: FieldRules;
}>;

const ERROR_CATEGORIES = new Set<DiagnosticErrorCategory>([
  "authorization",
  "cancelled",
  "conflict",
  "not_found",
  "persistence",
  "runtime",
  "storage",
  "timeout",
  "unknown",
  "validation",
]);

const PROVIDER_ERROR_KINDS = new Set<AIProviderErrorKind | "cyclic">([
  "provider_api",
  "provider_request",
  "provider_response",
  "provider_output",
  "provider_configuration",
  "provider_retry",
  "timeout",
  "cancelled",
  "not_configured",
  "usage_control",
  "unknown_error",
  "non_error",
  "cyclic",
]);

const FINISH_REASONS = new Set<SanitizedAIFinishReason>([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
  "unknown",
]);

const enumRule = <Value extends string>(values: readonly Value[]) => {
  const allowed = new Set(values);
  return (value: unknown): value is Value =>
    typeof value === "string" && allowed.has(value as Value);
};

const errorCategoryRule = (value: unknown) =>
  typeof value === "string" &&
  ERROR_CATEGORIES.has(value as DiagnosticErrorCategory);
const booleanRule = (value: unknown) => typeof value === "boolean";
const boundedCountRule = (value: unknown) =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 1_000_000;
const providerStatusRule = (value: unknown) =>
  value === null ||
  (typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599);
const nullableBooleanRule = (value: unknown) =>
  value === null || typeof value === "boolean";
const providerKindRule = (value: unknown) =>
  typeof value === "string" &&
  value !== "cyclic" &&
  PROVIDER_ERROR_KINDS.has(value as AIProviderErrorKind);
const nullableCauseKindRule = (value: unknown) =>
  value === null ||
  (typeof value === "string" &&
    PROVIDER_ERROR_KINDS.has(value as AIProviderErrorKind | "cyclic"));
const finishReasonRule = (value: unknown) =>
  typeof value === "string" &&
  FINISH_REASONS.has(value as SanitizedAIFinishReason);

const ERROR_FIELDS = { errorCategory: errorCategoryRule } as const;
const PROVIDER_FIELDS = {
  causeKind: nullableCauseKindRule,
  errorKind: providerKindRule,
  providerRetryable: nullableBooleanRule,
  providerStatusCode: providerStatusRule,
} as const;

const definition = (
  component: string,
  level: DiagnosticLevel,
  operation: string,
  state: string,
  fields: FieldRules,
): DiagnosticEventDefinition => ({ component, level, operation, state, fields });

const DIAGNOSTIC_EVENT_MANIFEST = {
  "ai.coach_question_failed": definition(
    "ai",
    "error",
    "coach_question",
    "failed",
    PROVIDER_FIELDS,
  ),
  "ai.coach_review_failed": definition(
    "ai",
    "error",
    "coach_review",
    "failed",
    PROVIDER_FIELDS,
  ),
  "ai.setup_equipment_parse_failed": definition(
    "ai",
    "error",
    "setup_equipment_parse",
    "failed",
    PROVIDER_FIELDS,
  ),
  "ai.setup_routine_build_failed": definition(
    "ai",
    "error",
    "setup_routine_build",
    "failed",
    PROVIDER_FIELDS,
  ),
  "ai.structured_output_missing": definition(
    "ai",
    "error",
    "structured_output",
    "missing",
    { finishReason: finishReasonRule },
  ),
  "ai.usage_failure_write_failed": definition(
    "ai",
    "error",
    "usage_failure_write",
    "failed",
    {
      ...ERROR_FIELDS,
      usageOutcome: enumRule(["cancelled", "failed", "timed_out"]),
    },
  ),
  "analysis_package.generation_failed": definition(
    "analysis_package",
    "error",
    "generation",
    "failed",
    ERROR_FIELDS,
  ),
  "contextual_note.archive_failed": definition(
    "contextual_note",
    "error",
    "archive",
    "failed",
    ERROR_FIELDS,
  ),
  "contextual_note.edit_failed": definition(
    "contextual_note",
    "error",
    "edit",
    "failed",
    ERROR_FIELDS,
  ),
  "contextual_note.save_failed": definition(
    "contextual_note",
    "error",
    "save",
    "failed",
    ERROR_FIELDS,
  ),
  "equipment.inventory_pre_save_check_failed": definition(
    "equipment",
    "error",
    "inventory_pre_save_check",
    "failed",
    ERROR_FIELDS,
  ),
  "equipment.inventory_preview_failed": definition(
    "equipment",
    "error",
    "inventory_preview",
    "failed",
    ERROR_FIELDS,
  ),
  "equipment.inventory_save_failed": definition(
    "equipment",
    "error",
    "inventory_save",
    "failed",
    ERROR_FIELDS,
  ),
  "history.retrospective_create_failed": definition(
    "history",
    "error",
    "retrospective_create",
    "failed",
    ERROR_FIELDS,
  ),
  "history.timing_correction_failed": definition(
    "history",
    "error",
    "timing_correction",
    "failed",
    ERROR_FIELDS,
  ),
  "live_coach.failure_write_failed": definition(
    "live_coach",
    "error",
    "failure_write",
    "failed",
    ERROR_FIELDS,
  ),
  "live_coach.prepared_value_failed": definition(
    "live_coach",
    "warn",
    "prepared_value",
    "failed",
    PROVIDER_FIELDS,
  ),
  "live_coach.response_failed": definition(
    "live_coach",
    "warn",
    "response",
    "failed",
    {
      ...PROVIDER_FIELDS,
      deadlineReached: booleanRule,
      disconnected: booleanRule,
    },
  ),
  "live_coach.saved_message_invalid_json": definition(
    "live_coach",
    "warn",
    "saved_message_parse",
    "rejected",
    ERROR_FIELDS,
  ),
  "progression.job_failed": definition(
    "progression",
    "error",
    "job",
    "failed",
    {
      ...ERROR_FIELDS,
      attemptCount: boundedCountRule,
      retryScheduled: booleanRule,
    },
  ),
  "record_version.restore_failed": definition(
    "record_version",
    "error",
    "restore",
    "failed",
    ERROR_FIELDS,
  ),
  "routine_import.exercise_map_degraded": definition(
    "routine_import",
    "warn",
    "exercise_map",
    "degraded",
    { ...PROVIDER_FIELDS, candidateCount: boundedCountRule },
  ),
  "routine_import.parse_failed": definition(
    "routine_import",
    "warn",
    "parse",
    "failed",
    {
      failureCategory: enumRule([
        "output_incomplete",
        "persistence_failure",
        "provider_failure",
        "timeout",
        "unknown",
        "unsupported_rep_sequence",
        "usage_control",
      ]),
      inputCharacterCount: boundedCountRule,
      detectedDayCount: boundedCountRule,
      detectedExerciseCount: boundedCountRule,
      durationMs: boundedCountRule,
    },
  ),
  "session.render_failed": definition(
    "session",
    "error",
    "render",
    "failed",
    {
      ...ERROR_FIELDS,
      routeState: enumRule(["confirmed_active", "route_input"]),
    },
  ),
  "session.start_failed": definition(
    "session",
    "error",
    "start",
    "failed",
    {
      ...ERROR_FIELDS,
      failure: enumRule(["unexpected_creation_failure"]),
    },
  ),
  "session.start_incomplete": definition(
    "session",
    "error",
    "start",
    "incomplete",
    {},
  ),
  "session.start_reconciled": definition(
    "session",
    "warn",
    "start",
    "reconciled",
    { reconciliation: enumRule(["exact_start_request_found"]) },
  ),
  "session.start_reconciliation_failed": definition(
    "session",
    "error",
    "start_reconciliation",
    "failed",
    {
      ...ERROR_FIELDS,
      reconciliation: enumRule([
        "active_workout_status_unknown",
        "start_request_status_unknown",
      ]),
    },
  ),
  "session.start_rejected": definition(
    "session",
    "warn",
    "start",
    "rejected",
    { rejection: enumRule(["invalid_request", "program_updated"]) },
  ),
  "settings.font_size_save_failed": definition(
    "settings",
    "error",
    "font_size_save",
    "failed",
    ERROR_FIELDS,
  ),
  "settings.timezone_save_failed": definition(
    "settings",
    "error",
    "timezone_save",
    "failed",
    ERROR_FIELDS,
  ),
  "snapshot.download_unavailable": definition(
    "snapshot",
    "warn",
    "download",
    "unavailable",
    ERROR_FIELDS,
  ),
  "snapshot.lifecycle_deletion_failed": definition(
    "snapshot",
    "error",
    "lifecycle_deletion",
    "failed",
    { ...ERROR_FIELDS, objectDeleted: booleanRule },
  ),
  "snapshot.lifecycle_orphan_delete_failed": definition(
    "snapshot",
    "error",
    "lifecycle_orphan_delete",
    "failed",
    ERROR_FIELDS,
  ),
  "snapshot.lifecycle_store_scan_failed": definition(
    "snapshot",
    "error",
    "lifecycle_store_scan",
    "failed",
    ERROR_FIELDS,
  ),
} as const satisfies Record<DiagnosticEventName, DiagnosticEventDefinition>;

export const DIAGNOSTIC_EVENT_NAMES = Object.freeze(
  Object.keys(DIAGNOSTIC_EVENT_MANIFEST) as DiagnosticEventName[],
);

const ERROR_CATEGORY_BY_NAME: Readonly<
  Record<string, DiagnosticErrorCategory>
> = {
  AbortError: "cancelled",
  AccessDeniedError: "authorization",
  AuthorizationError: "authorization",
  ConflictError: "conflict",
  ConstraintError: "conflict",
  NotFoundError: "not_found",
  PermissionError: "authorization",
  StaleWorkoutTemplateError: "conflict",
  TimeoutError: "timeout",
  ValidationError: "validation",
  ZodError: "validation",
};

/** Maps an arbitrary error to a fixed category without reading message or stack. */
export function categorizeDiagnosticError(
  error: unknown,
  fallback: DiagnosticErrorCategory = "unknown",
): DiagnosticErrorCategory {
  try {
    if ((typeof error !== "object" && typeof error !== "function") || !error) {
      return fallback;
    }
    const name = Reflect.get(error, "name");
    return typeof name === "string"
      ? (ERROR_CATEGORY_BY_NAME[name] ?? fallback)
      : fallback;
  } catch {
    return fallback;
  }
}

type CreateEpisodeOptions = Readonly<{
  now?: Date;
  randomId?: () => string;
}>;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Creates a random correlation value that expires with one bounded episode. */
export function createDiagnosticEpisode(
  options: CreateEpisodeOptions = {},
): DiagnosticEpisode | null {
  try {
    const now = options.now ?? new Date();
    const correlationId = (options.randomId ?? randomUUID)();
    if (!Number.isFinite(now.getTime()) || !UUID_V4_PATTERN.test(correlationId)) {
      return null;
    }
    return Object.freeze({
      correlationId,
      startedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + DIAGNOSTIC_EPISODE_MINUTES * 60 * 1_000,
      ).toISOString(),
    });
  } catch {
    return null;
  }
}

type DiagnosticLogOptions = Readonly<{
  episode?: DiagnosticEpisode | null;
  now?: Date;
  randomId?: () => string;
}>;

export type DiagnosticLogResult = "output_failed" | "refused" | "written";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fieldsPass(
  fields: unknown,
  rules: FieldRules,
): fields is Record<string, unknown> {
  if (!isPlainRecord(fields)) return false;
  const actualKeys = Object.keys(fields).sort();
  const allowedKeys = Object.keys(rules).sort();
  if (
    actualKeys.length !== allowedKeys.length ||
    actualKeys.some((key, index) => key !== allowedKeys[index])
  ) {
    return false;
  }
  return allowedKeys.every((key) => rules[key]?.(fields[key]) === true);
}

function validEpisode(
  episode: DiagnosticEpisode | null | undefined,
  nowMs: number,
): episode is DiagnosticEpisode {
  if (!episode || !UUID_V4_PATTERN.test(episode.correlationId)) return false;
  const startedAt = Date.parse(episode.startedAt);
  const expiresAt = Date.parse(episode.expiresAt);
  return (
    Number.isFinite(startedAt) &&
    Number.isFinite(expiresAt) &&
    startedAt <= nowMs &&
    expiresAt > nowMs &&
    expiresAt - startedAt === DIAGNOSTIC_EPISODE_MINUTES * 60 * 1_000
  );
}

/**
 * Emits one closed, redacted diagnostic event without affecting application flow.
 * Unknown events, unknown fields, missing fields, and invalid values fail closed.
 */
export function logDiagnosticEvent<Name extends DiagnosticEventName>(
  event: Name,
  fields: DiagnosticEventFields[Name],
  options: DiagnosticLogOptions = {},
): DiagnosticLogResult {
  try {
    const definition = (DIAGNOSTIC_EVENT_MANIFEST as Record<
      string,
      DiagnosticEventDefinition | undefined
    >)[event];
    if (!definition || !fieldsPass(fields, definition.fields)) return "refused";

    const now = options.now ?? new Date();
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) return "refused";

    const createdEpisode =
      options.episode === undefined
        ? createDiagnosticEpisode({ now, randomId: options.randomId })
        : options.episode;
    const correlationId = validEpisode(createdEpisode, nowMs)
      ? createdEpisode.correlationId
      : null;

    const line = JSON.stringify({
      schemaVersion: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
      redactionVersion: DIAGNOSTIC_REDACTION_VERSION,
      appVersion: PRODUCT_VERSION,
      at: now.toISOString(),
      retentionClass: "ephemeral_24h",
      retentionExpiresAt: new Date(
        nowMs + DIAGNOSTIC_RETENTION_HOURS * 60 * 60 * 1_000,
      ).toISOString(),
      correlationId,
      level: definition.level,
      event,
      component: definition.component,
      operation: definition.operation,
      state: definition.state,
      durationMs: null,
      errorCategory: null,
      ...fields,
    });
    console.log(line);
    return "written";
  } catch {
    // Diagnostics must never change the behavior they observe.
    return "output_failed";
  }
}
