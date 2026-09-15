import type { SanitizedAIProviderError } from "@/lib/ai-provider-error";

export function programAIFailureMessage(error: SanitizedAIProviderError) {
  const suffix =
    " Your request is still here, and your Program was not changed.";
  if (
    error.providerStatusCode === 401 ||
    error.providerStatusCode === 403 ||
    error.errorKind === "provider_configuration" ||
    error.errorKind === "not_configured"
  )
    return "AI access needs a configuration fix before this can work." + suffix;
  if (
    error.providerStatusCode === 400 ||
    error.providerStatusCode === 404 ||
    error.errorKind === "provider_request"
  )
    return (
      "The AI service rejected the application's request. This needs an application or model-configuration fix; you do not need to rewrite your instructions." +
      suffix
    );
  if (error.providerStatusCode === 429)
    return (
      "The AI service is at its usage limit. Retry after the limit clears." +
      suffix
    );
  if (error.errorKind === "timeout" || error.errorKind === "cancelled")
    return (
      "Preparing the changes took too long. Retry the same request." + suffix
    );
  if (
    error.errorKind === "provider_api" ||
    error.errorKind === "provider_retry"
  )
    return (
      "The AI service could not complete the request. You can retry it." +
      suffix
    );
  return (
    "The proposed changes could not be safely validated. Retry the same request; if it repeats, the application needs investigation." +
    suffix
  );
}
