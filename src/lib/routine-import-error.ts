import type { AIProviderErrorKind } from "@/lib/ai-provider-error";

export type RoutineImportFailureCategory =
  | "output_incomplete"
  | "persistence_failure"
  | "provider_failure"
  | "timeout"
  | "unknown"
  | "unsupported_rep_sequence"
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
      return "Repbook parsed the routine but could not open the review. Try again." + unchanged;
    case "usage_control":
      return "AI parsing is temporarily limited. Wait, then retry, or use the canonical routine format, which works without AI." + unchanged;
    case "unsupported_rep_sequence":
      return (
        "This paste uses different rep targets for individual sets, which this importer cannot publish exactly. Rewrite each affected exercise as one exact target or range, then parse it again." +
        unchanged
      );
    case "unknown":
      return "Repbook could not safely parse this routine. Retry with canonical Day and exercise lines." + unchanged;
  }
}
