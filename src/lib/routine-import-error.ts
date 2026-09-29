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
    " Your current Program was not changed. Your text is still in the paste field; no failed import was kept.";
  switch (category) {
    case "timeout":
      return (
        "Reading the routine took too long. Try again, paste one day at a time, or use the example format." +
        unchanged
      );
    case "output_incomplete":
      return (
        "AI could not read the full routine. Check the formatting and try again, or use the example format without AI." +
        unchanged
      );
    case "provider_failure":
      return "AI import is unavailable right now. Try later or use the example format without AI." + unchanged;
    case "persistence_failure":
      return "Repbook parsed the routine but could not open the review. Try again." + unchanged;
    case "usage_control":
      return "AI import has reached its current limit. Try later or use the example format without AI." + unchanged;
    case "unsupported_rep_sequence":
      return (
        "This paste uses different rep targets for individual sets, which this importer cannot publish exactly. Rewrite each affected exercise as one exact target or range, then parse it again." +
        unchanged
      );
    case "unknown":
      return "Repbook could not read this routine. Try the example format." + unchanged;
  }
}
