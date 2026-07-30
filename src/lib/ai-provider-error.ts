import "server-only";

/**
 * Privacy boundary for AI-provider failures.
 *
 * Provider SDK errors may retain prompts, request bodies, response bodies,
 * headers, provider data, stacks, and nested causes. Logging code must consume
 * only this fixed, primitive projection and never spread or serialize the
 * original error.
 */

export type AIProviderErrorKind =
  | "provider_api"
  | "provider_request"
  | "provider_response"
  | "provider_output"
  | "provider_configuration"
  | "provider_retry"
  | "timeout"
  | "cancelled"
  | "not_configured"
  | "usage_control"
  | "unknown_error"
  | "non_error";

export type SanitizedAIProviderError = {
  errorKind: AIProviderErrorKind;
  providerStatusCode: number | null;
  providerRetryable: boolean | null;
  causeKind: AIProviderErrorKind | "cyclic" | null;
};

export type SanitizedAIFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other"
  | "unknown";

const SAFE_FINISH_REASONS = new Set<SanitizedAIFinishReason>([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
]);

export function sanitizeAIFinishReason(
  value: unknown,
): SanitizedAIFinishReason {
  return typeof value === "string" &&
    SAFE_FINISH_REASONS.has(value as SanitizedAIFinishReason)
    ? (value as SanitizedAIFinishReason)
    : "unknown";
}

const ERROR_KIND_BY_NAME: Readonly<Record<string, AIProviderErrorKind>> = {
  AI_APICallError: "provider_api",
  AI_InvalidArgumentError: "provider_request",
  AI_InvalidPromptError: "provider_request",
  AI_EmptyResponseBodyError: "provider_response",
  AI_InvalidResponseDataError: "provider_response",
  AI_JSONParseError: "provider_response",
  AI_NoContentGeneratedError: "provider_output",
  AI_NoObjectGeneratedError: "provider_output",
  AI_NoOutputGeneratedError: "provider_output",
  AI_TypeValidationError: "provider_output",
  AI_LoadAPIKeyError: "provider_configuration",
  AI_LoadSettingError: "provider_configuration",
  AI_NoSuchModelError: "provider_configuration",
  AI_NoSuchProviderError: "provider_configuration",
  AI_NoSuchProviderReferenceError: "provider_configuration",
  AI_UnsupportedFunctionalityError: "provider_configuration",
  AI_RetryError: "provider_retry",
  TimeoutError: "timeout",
  AbortError: "cancelled",
  AIUnavailableError: "not_configured",
  AIControlError: "usage_control",
};

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  );
}

function readProperty(value: unknown, key: PropertyKey): unknown {
  if (!isObject(value)) return undefined;
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function classify(value: unknown): AIProviderErrorKind {
  if (!isObject(value)) return "non_error";
  const name = readProperty(value, "name");
  return typeof name === "string"
    ? (ERROR_KIND_BY_NAME[name] ?? "unknown_error")
    : "unknown_error";
}

function safeStatusCode(value: unknown): number | null {
  const statusCode = readProperty(value, "statusCode");
  return typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 100 &&
    statusCode <= 599
    ? statusCode
    : null;
}

function safeRetryable(value: unknown): boolean | null {
  const retryable = readProperty(value, "isRetryable");
  return typeof retryable === "boolean" ? retryable : null;
}

/**
 * Returns only allowlisted classifications and primitive provider metadata.
 * It intentionally never reads messages, request/response values, headers,
 * provider data, stacks, or nested-cause content.
 */
export function sanitizeAIProviderError(
  error: unknown
): SanitizedAIProviderError {
  const cause = readProperty(error, "cause");
  return {
    errorKind: classify(error),
    providerStatusCode: safeStatusCode(error),
    providerRetryable: safeRetryable(error),
    causeKind:
      cause === undefined || cause === null
        ? null
        : cause === error
          ? "cyclic"
          : classify(cause),
  };
}
