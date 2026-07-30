const SAFE_ERROR_NAMES = new Set([
  "Error",
  "AggregateError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

/** Returns one fixed diagnostic class without accepting user-controlled names. */
export function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return SAFE_ERROR_NAMES.has(error.name) ? error.name : "UnknownError";
}
