import type { AIProviderErrorKind } from "@/lib/ai-provider-error";

export type RoutineImportFailureCategory =
  | "output_incomplete"
  | "persistence_failure"
  | "provider_failure"
  | "timeout"
  | "unknown"
  | "usage_control";

export function routineImportFailureCategory(
  errorKind: AIProviderErrorKind,
): RoutineImportFailureCategory {
  switch (errorKind) {
    case "provider_output":
    case "provider_response":
      return "output_incomplete";
    case "timeout":
    case "cancelled":
      return "timeout";
    case "provider_api":
    case "provider_request":
    case "provider_configuration":
    case "provider_retry":
    case "not_configured":
      return "provider_failure";
    case "usage_control":
      return "usage_control";
    case "unknown_error":
    case "non_error":
      return "unknown";
  }
}

export function routineImportFailureMessage(
  category: RoutineImportFailureCategory,
) {
  const unchanged =
    " Your current Program was not changed, and the failed paste was discarded.";
  switch (category) {
    case "timeout":
      return (
        "Parsing took too long. Retry once; if it repeats, paste one day at a time or use the canonical Day / exercise / sets x reps / rest format." +
        unchanged
      );
    case "output_incomplete":
      return (
        "The AI parser did not return a complete valid routine. Check any unusual notes or formatting, then retry; canonical Day and exercise lines can be parsed without AI." +
        unchanged
      );
    case "provider_failure":
      return "AI parsing is temporarily unavailable. Retry later, or use the canonical routine format, which works without AI." + unchanged;
    case "persistence_failure":
      return "Repbook could not safely stage the parsed routine for review. Retry later." + unchanged;
    case "usage_control":
      return "AI parsing is temporarily limited. Wait, then retry, or use the canonical routine format, which works without AI." + unchanged;
    case "unknown":
      return "Repbook could not safely parse this routine. Retry with canonical Day and exercise lines." + unchanged;
  }
}
